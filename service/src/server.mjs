import http from 'node:http';
import { createHash } from 'node:crypto';
import { isMainThread, Worker } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
import pg from 'pg';

const { Pool } = pg;

const port = Number(process.env.PORT || 8080);
const sourceUrl = 'https://www.taiwanlottery.com/lotto/result/bingo_bingo/';
const apiBaseUrl = 'https://api.taiwanlottery.com/TLCAPIWeB/Lottery/BingoResult';
const defaultHistoryDays = 30;
const maxModelHistory = 300;
const profitabilityBacktestWindow = 10;
const minimumValidationSamples = 30;
const profileValidationWindow = 30;
// 資料保存至少涵蓋一個月；最新基準之外，模型回測仍維持 60 期。
const retentionDays = 31;
const persistedHistoryLimit = 6000;
const fastResponseHistoryLimit = maxModelHistory + 1;
const reproducibilityVersion = 'bingo-research-v70-walk-forward-exclusion-filters';
const profileCacheTtlMs = 5 * 60 * 1000;
const profileCache = new Map();
const singleBetCost = 25;
const superNumberAddOnCost = 25;
const basicPayouts = {
  "1星": { 1: 50 },
  "2星": { 2: 75, 1: 25 },
  "3星": { 3: 500, 2: 50 },
  "4星": { 4: 1000, 3: 100, 2: 25 },
  "5星": { 5: 7500, 4: 500, 3: 50 },
  "6星": { 6: 25000, 5: 1000, 4: 200, 3: 25 },
  "7星": { 7: 80000, 6: 3000, 5: 300, 4: 50, 3: 25 },
  "8星": { 8: 500000, 7: 20000, 6: 1000, 5: 200, 4: 25, 0: 25 },
  "9星": { 9: 1000000, 8: 100000, 7: 3000, 6: 500, 5: 100, 4: 25, 0: 25 },
  "10星": { 10: 5000000, 9: 250000, 8: 25000, 7: 2500, 6: 250, 5: 25, 0: 25 },
};
const fallbackSources = [
  { name: '台灣彩券官方網頁', url: sourceUrl, parser: 'officialPage', authority: 'official', initialRank: 100 },
  { name: 'WINWIN 樂贏', url: 'https://winwin.tw/Bingo', parser: 'winwin', authority: 'mirror', initialRank: 85 },
  { name: '168win 開獎網', url: 'https://www.168win.org/info/BingoBingo', parser: '168win', authority: 'mirror', initialRank: 80 },
  { name: 'Pilio 賓果開獎查詢', url: 'https://www.pilio.idv.tw/bingo/list.asp', parser: 'mirror', authority: 'mirror', initialRank: 70 },
  { name: 'Auzo 奧索樂透網', url: 'https://lotto.auzo.tw/bingobingo.php', parser: 'mirror', authority: 'mirror', initialRank: 60 },
  { name: '台灣彩券開獎歷史（Timetable）', url: 'https://lottery.timetable.tw/bin-guo-bin-guo', parser: 'timetable', authority: 'mirror', initialRank: 40 },
];
const databaseUrl = process.env.DATABASE_URL || '';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 8, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 3_000, query_timeout: 8_000, statement_timeout: 8_000 }) : null;
const githubToken = process.env.GITHUB_TOKEN || '';
const githubRepo = process.env.GITHUB_BACKUP_REPO || 'NoMoneyDaddy/Amazon-Bingo';
const githubBackupPath = process.env.GITHUB_BACKUP_PATH || 'backups/bingo-model-profile.json';
const upstreamTimeoutMs = 15_000;
const persistedCacheTtlMs = 5_000;
let databaseReady = false;
let lastPersistedPeriod = '';
let scheduledTimer;
let refreshInFlight = false;
const persistedCache = new Map();
const persistedReadInFlight = new Map();
const compressedPayloadCache = new Map();
const latestResponseCache = new Map();
const latestResponseCacheTtlMs = 5_000;
const sourceRuntimeStats = new Map();

function sourceStat(name) {
  if (!sourceRuntimeStats.has(name)) sourceRuntimeStats.set(name, { success: 0, failure: 0, latencyMs: null, latestPeriod: '', lastError: '' });
  return sourceRuntimeStats.get(name);
}

function updateSourceStat(name, ok, latencyMs, period = '', error = '') {
  const stat = sourceStat(name);
  if (ok) stat.success += 1;
  else stat.failure += 1;
  stat.latencyMs = stat.latencyMs == null ? latencyMs : Math.round(stat.latencyMs * 0.7 + latencyMs * 0.3);
  if (period) stat.latestPeriod = String(period);
  if (error) stat.lastError = String(error).slice(0, 180);
  return stat;
}

function sourceRankingScore(source, referencePeriod = '') {
  const stat = sourceStat(source.name);
  const total = stat.success + stat.failure;
  const stability = total ? stat.success / total : 0.5;
  const speed = stat.latencyMs == null ? 0.5 : 1 / (1 + stat.latencyMs / 1500);
  const agePeriods = referencePeriod && stat.latestPeriod ? Math.max(0, Number(referencePeriod) - Number(stat.latestPeriod)) : 3;
  const freshness = stat.latestPeriod ? Math.max(0, 1 - agePeriods / 3) : 0.2;
  const authorityBonus = source.authority === 'official' ? 1000 : 0;
  return authorityBonus + stability * 60 + speed * 25 + freshness * 15 + (source.initialRank || 0) / 100;
}

function sourceRanking(referencePeriod = '', currentHealth = []) {
  const healthByName = new Map(currentHealth.map((item) => [item.name, item]));
  const sources = [{ name: '台灣彩券官方 API', authority: 'official', initialRank: 1000 }, ...fallbackSources];
  return sources.map((source) => {
    const stat = sourceStat(source.name);
    const total = stat.success + stat.failure;
    const current = healthByName.get(source.name);
    return {
      name: source.name,
      authority: source.authority,
      ok: current?.ok ?? (total ? stat.failure === 0 : null),
      error: current?.error,
      latencyMs: current?.latencyMs ?? stat.latencyMs,
      records: current?.records,
      latestPeriod: stat.latestPeriod || '',
      lastError: stat.lastError || '',
      stability: total ? stat.success / total : null,
      freshness: stat.latestPeriod && referencePeriod ? Math.max(0, 1 - Math.max(0, Number(referencePeriod) - Number(stat.latestPeriod)) / 3) : null,
      rankScore: sourceRankingScore(source, referencePeriod),
    };
  }).sort((a, b) => b.rankScore - a.rankScore);
}

function logCombination(n, k) {
  if (!Number.isInteger(n) || !Number.isInteger(k) || k < 0 || k > n) return -Infinity;
  const r = Math.min(k, n - k);
  let value = 0;
  for (let index = 1; index <= r; index += 1) value += Math.log(n - r + index) - Math.log(index);
  return value;
}

function hypergeometricProbability(population, successes, draws, hits) {
  if (hits < 0 || hits > successes || draws - hits > population - successes || hits > draws) return 0;
  return Math.exp(logCombination(successes, hits) + logCombination(population - successes, draws - hits) - logCombination(population, draws));
}

function theoreticalRiskBaseline() {
  const rows = Object.entries(basicPayouts).map(([playtype, payoutTable]) => {
    const star = Number(playtype.replace('星', ''));
    const expectedGrossMultiple = Object.entries(payoutTable).reduce((sum, [hits, grossMultiple]) => (
      sum + hypergeometricProbability(80, 20, star, Number(hits)) * (grossMultiple / singleBetCost)
    ), 0);
    return {
      playtype,
      expectedGrossMultiple: Number(expectedGrossMultiple.toFixed(6)),
      expectedNetPerBet: Number(((expectedGrossMultiple - 1) * singleBetCost).toFixed(2)),
      houseEdgePct: Number(((1 - expectedGrossMultiple) * 100).toFixed(3)),
      recommendation: '研究用途：理論負期望，不建議下注',
    };
  });
  const pBig = Array.from({ length: 21 }, (_, hits) => hypergeometricProbability(80, 40, 20, hits))
    .slice(13).reduce((sum, value) => sum + value, 0);
  rows.push({
    playtype: '大小',
    expectedGrossMultiple: Number((pBig * 6).toFixed(6)),
    expectedNetPerBet: Number(((pBig * 6 - 1) * singleBetCost).toFixed(2)),
    houseEdgePct: Number(((1 - pBig * 6) * 100).toFixed(3)),
    recommendation: '研究用途：和局／未達門檻不計勝，不建議下注',
  });
  const superExpectedPayout = (150 + 19 * 50) / 80;
  const superCost = singleBetCost + superNumberAddOnCost;
  rows.push({
    playtype: '超級獎號（1星加購）',
    expectedGrossMultiple: Number((superExpectedPayout / superCost).toFixed(6)),
    expectedNetPerBet: Number((superExpectedPayout - superCost).toFixed(2)),
    houseEdgePct: Number(((1 - superExpectedPayout / superCost) * 100).toFixed(3)),
    recommendation: '研究用途：超級獎號必須搭配基本玩法，打平不算盈利',
  });
  rows.sort((a, b) => a.houseEdgePct - b.houseEdgePct);
  return {
    betCost: singleBetCost,
    model: '80 選 20 超幾何分布／官方派彩表',
    settlementMode: 'nominal',
    settlementNote: '此處使用名目單注派彩；官方各獎項有單期總獎金上限，均分後實領額需要同一期中獎注數，現有開獎資料無法推算。',
    rows,
    caveat: '這是玩法理論基線，不是個人化下注建議；歷史模型若看似優於基線，仍須以無洩漏樣本與信賴區間核驗。',
  };
}

function positiveProfitBaseline(target, actuals = []) {
  if (!actuals.length) return null;
  if (target === 'size' || target === 'oddEven') {
    return Array.from({ length: 21 }, (_, count) => hypergeometricProbability(80, 40, 20, count))
      .slice(13).reduce((sum, value) => sum + value, 0);
  }
  if (target === 'superNumber') return actuals.filter((item) => item.superNumber && Number(item.superNumber) >= 1 && Number(item.superNumber) <= 80).length / (actuals.length * 80);
  const star = Number(String(target).replace('星', ''));
  const payoutTable = basicPayouts[target] || {};
  return Object.entries(payoutTable).reduce((sum, [hits, gross]) => (
    gross > singleBetCost ? sum + hypergeometricProbability(80, 20, star, Number(hits)) : sum
  ), 0);
}

function betCostForTarget(target) {
  return target === 'superNumber' ? singleBetCost + superNumberAddOnCost : singleBetCost;
}

function settleSuperNumber(predicted, actual) {
  const selected = normalizeNumberValue(predicted);
  const drawn = new Set((actual.numbers || []).map(normalizeNumberValue));
  const superNumber = normalizeNumberValue(actual.superNumber);
  if (!selected || !superNumber) return { payout: 0, matches: 0, cost: betCostForTarget('superNumber') };
  if (selected === superNumber) return { payout: 150, matches: 1, cost: betCostForTarget('superNumber') };
  if (drawn.has(selected)) return { payout: 50, matches: 1, cost: betCostForTarget('superNumber') };
  return { payout: 0, matches: 0, cost: betCostForTarget('superNumber') };
}

function theoreticalNetPerBet(target) {
  if (target === 'size' || target === 'oddEven') {
    const thresholdProbability = Array.from({ length: 21 }, (_, count) => hypergeometricProbability(80, 40, 20, count))
      .slice(13).reduce((sum, value) => sum + value, 0);
    return thresholdProbability * 150 - singleBetCost;
  }
  if (target === 'superNumber') return ((150 + 19 * 50) / 80) - betCostForTarget('superNumber');
  const star = Number(String(target).replace('星', ''));
  const payoutTable = basicPayouts[target] || {};
  const expectedPayout = Object.entries(payoutTable).reduce((sum, [hits, payout]) => (
    sum + hypergeometricProbability(80, 20, star, Number(hits)) * payout
  ), 0);
  return expectedPayout - singleBetCost;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = upstreamTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function ensureDatabase() {
  if (!pool || databaseReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS bingo_draws (
    period TEXT PRIMARY KEY,
    draw_at TEXT NOT NULL DEFAULT '',
    numbers JSONB NOT NULL,
    super_number TEXT NOT NULL DEFAULT '',
    size TEXT NOT NULL DEFAULT '',
    odd_even TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    source_label TEXT NOT NULL DEFAULT '',
    source_health JSONB NOT NULL DEFAULT '[]'::jsonb,
    models JSONB NOT NULL DEFAULT '[]'::jsonb,
    prediction_target_period TEXT NOT NULL DEFAULT '',
    casting_at TEXT NOT NULL DEFAULT '',
    forecast_casting_at TEXT NOT NULL DEFAULT '',
    fetched_at BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);
  await pool.query("ALTER TABLE bingo_draws ADD COLUMN IF NOT EXISTS prediction_target_period TEXT NOT NULL DEFAULT ''");
  await pool.query("ALTER TABLE bingo_draws ADD COLUMN IF NOT EXISTS casting_at TEXT NOT NULL DEFAULT ''");
  await pool.query("ALTER TABLE bingo_draws ADD COLUMN IF NOT EXISTS forecast_casting_at TEXT NOT NULL DEFAULT ''");
  await pool.query('CREATE INDEX IF NOT EXISTS bingo_draws_updated_idx ON bingo_draws (updated_at DESC)');
  await pool.query(`CREATE TABLE IF NOT EXISTS bingo_model_backups (
    id BIGSERIAL PRIMARY KEY,
    algorithm_version TEXT NOT NULL,
    profile JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);
  databaseReady = true;
}

function algorithmVersion() { return reproducibilityVersion; }

function modelProfileFromSnapshot(snapshot) {
  return {
    algorithmVersion: algorithmVersion(),
    generatedAt: new Date().toISOString(),
    sourcePeriod: snapshot?.period || '',
    models: (snapshot?.models || []).map((model) => ({
      name: model.name,
      method: model.calculation?.method || '',
      empiricalWeight: model.calculation?.empiricalWeight ?? null,
      evolution: model.calculation?.evolution || null,
    })),
  };
}

async function persistModelProfile(profile) {
  if (!pool || !profile.models.length) return;
  await ensureDatabase();
  await pool.query('INSERT INTO bingo_model_backups (algorithm_version, profile) VALUES ($1, $2::jsonb)', [profile.algorithmVersion, JSON.stringify(profile)]);
}

async function backupModelProfileToGitHub(profile) {
  if (!githubToken || !profile.models.length) return { enabled: false, reason: '缺少 GITHUB_TOKEN' };
  const apiUrl = `https://api.github.com/repos/${githubRepo}/contents/${githubBackupPath}`;
  const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${githubToken}`, 'user-agent': 'bingo-api', 'x-github-api-version': '2022-11-28' };
  let sha;
  const existing = await fetchWithTimeout(apiUrl, { headers });
  if (existing.ok) sha = (await existing.json()).sha;
  else if (existing.status !== 404) throw new Error(`GitHub 讀取備份失敗 HTTP ${existing.status}`);
  const content = Buffer.from(`${JSON.stringify(profile, null, 2)}\n`).toString('base64');
  const response = await fetchWithTimeout(apiUrl, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ message: `備份賓果算法與權重 ${profile.sourcePeriod || 'latest'}`, content, ...(sha ? { sha } : {}) }) });
  if (!response.ok) throw new Error(`GitHub 寫入備份失敗 HTTP ${response.status}`);
  return { enabled: true, repo: githubRepo, path: githubBackupPath };
}

async function backupModelProfile(snapshot) {
  const profile = modelProfileFromSnapshot(snapshot);
  await persistModelProfile(profile);
  try { return await backupModelProfileToGitHub(profile); }
  catch (error) { return { enabled: true, error: error instanceof Error ? error.message : 'GitHub 備份失敗' }; }
}

async function persistSnapshots(snapshots) {
  if (!pool || !snapshots.length) return;
  await ensureDatabase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of snapshots) {
      await client.query(`INSERT INTO bingo_draws
        (period, draw_at, numbers, super_number, size, odd_even, source, source_label, source_health, models, prediction_target_period, casting_at, forecast_casting_at, fetched_at)
        VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14)
        ON CONFLICT (period) DO UPDATE SET draw_at=EXCLUDED.draw_at, numbers=EXCLUDED.numbers,
        super_number=EXCLUDED.super_number, size=EXCLUDED.size, odd_even=EXCLUDED.odd_even,
        source=EXCLUDED.source, source_label=EXCLUDED.source_label, source_health=EXCLUDED.source_health,
        models=EXCLUDED.models, prediction_target_period=EXCLUDED.prediction_target_period, casting_at=EXCLUDED.casting_at, forecast_casting_at=EXCLUDED.forecast_casting_at, fetched_at=EXCLUDED.fetched_at, updated_at=NOW()` , [
        item.period, item.drawAt || '', JSON.stringify(item.numbers), item.superNumber || '', item.size || '', item.oddEven || '',
        item.source || '', item.sourceLabel || '', JSON.stringify(item.sourceHealth || []), JSON.stringify(item.models || []), item.predictionTargetPeriod || '', item.castingAt || '', item.forecastCastingAt || '', item.fetchedAt || Date.now(),
      ]);
    }
    await client.query('COMMIT');
    lastPersistedPeriod = snapshots[0]?.period || lastPersistedPeriod;
    persistedCache.set(persistedHistoryLimit, { rows: snapshots, storedAt: Date.now() });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function readPersisted(limit = 6000) {
  if (!pool) return [];
  await ensureDatabase();
  const result = await pool.query(`SELECT period, draw_at AS "drawAt", numbers, super_number AS "superNumber",
    size, odd_even AS "oddEven", source, source_label AS "sourceLabel", source_health AS "sourceHealth",
    models, prediction_target_period AS "predictionTargetPeriod", casting_at AS "castingAt", forecast_casting_at AS "forecastCastingAt", fetched_at AS "fetchedAt" FROM bingo_draws ORDER BY period DESC LIMIT $1`, [Math.min(10000, Math.max(1, limit))]);
  return result.rows.map((row) => {
    const numbers = Array.isArray(row.numbers) ? row.numbers : [];
    const derived = numbers.length === 20 ? deriveSnapshot(row.period, numbers, row.source || '', row.drawAt || '') : null;
    return { ...row, numbers, size: derived?.size || row.size || '', oddEven: derived?.oddEven || row.oddEven || '', sourceHealth: row.sourceHealth || [], models: row.models || [] };
  });
}

async function readPersistedCached(limit = persistedHistoryLimit) {
  const cacheKey = limit <= persistedHistoryLimit ? persistedHistoryLimit : limit;
  const cached = persistedCache.get(cacheKey);
  if (cached && Date.now() - cached.storedAt < persistedCacheTtlMs) return cached.rows;
  const inFlight = persistedReadInFlight.get(cacheKey);
  if (inFlight) return inFlight;
  const read = readPersisted(limit)
    .then((rows) => {
      if (cacheKey === persistedHistoryLimit) persistedCache.set(cacheKey, { rows, storedAt: Date.now() });
      return rows;
    })
    .finally(() => persistedReadInFlight.delete(cacheKey));
  persistedReadInFlight.set(cacheKey, read);
  return read;
}

function cleanHtml(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function digitSum(value) {
  return value.split('').reduce((sum, digit) => sum + Number(digit), 0);
}

function seededRandom(seed) {
  const digest = createHash('sha256').update(String(seed)).digest('hex').slice(0, 16);
  let state = Number.parseInt(digest, 16) % 2147483647 || 1;
  return () => { state = state * 16807 % 2147483647; return (state - 1) / 2147483646; };
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

function parseTaipeiDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return new Date();
  // 官方資料常用民國年／未附時區；這類字串一律明確視為台北時間。
  const local = raw.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  const match = local.match(/^(\d{3,4})[\/-](\d{1,2})[\/-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (match) {
    const year = Number(match[1]) < 1911 ? Number(match[1]) + 1911 : Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6] || 0);
    return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, second));
  }
  // 已含 Z／時區偏移的 ISO 時間直接保留其絕對時刻。
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) return new Date(raw);
  const isoLocal = raw.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (isoLocal) {
    const [, year, month, day, hour = '0', minute = '0', second = '0'] = isoLocal;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 8, Number(minute), Number(second)));
  }
  return new Date(raw);
}

function reproducibleCastingAt(value, period = '') {
  const raw = String(value || '').trim();
  const fullDate = parseTaipeiDate(raw);
  if (raw && Number.isFinite(fullDate.getTime())) return fullDate.toISOString();
  const dateOnly = raw.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (dateOnly) return new Date(`${dateOnly[1]}T04:00:00.000Z`).toISOString();
  const digest = createHash('sha256').update(`casting|${period}`).digest('hex');
  const minutes = Number.parseInt(digest.slice(0, 8), 16) % (365 * 24 * 60);
  return new Date(Date.UTC(2020, 0, 1) + minutes * 60_000).toISOString();
}

function parseTaipeiParts(value) {
  const date = parseTaipeiDate(value);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hour12: false }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

function parseChineseCalendarParts(value) {
  const date = parseTaipeiDate(value);
  const parts = new Intl.DateTimeFormat('zh-TW-u-ca-chinese', { timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hour12: false }).formatToParts(date);
  const monthNames = ['正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
  const monthPart = parts.find((part) => part.type === 'month')?.value || '';
  const normalizedMonth = monthPart.replace(/^閏/, '').replace('腊', '臘');
  const month = normalizedMonth === '臘月' ? 12 : monthNames.indexOf(normalizedMonth) + 1;
  const hour24 = Number(parts.find((part) => part.type === 'hour')?.value || 0);
  const hourBranch = Math.floor(((hour24 + 1) % 24) / 2) + 1;
  return {
    year: Number(parts.find((part) => part.type === 'relatedYear')?.value || date.getUTCFullYear()),
    yearBranch: ((Number(parts.find((part) => part.type === 'relatedYear')?.value || date.getUTCFullYear()) - 4) % 12 + 12) % 12 + 1,
    month: Math.max(1, month),
    day: Number(parts.find((part) => part.type === 'day')?.value || 1),
    hour: hourBranch,
    hour24,
  };
}

function playIndex(target) {
  if (target === 'size') return 1;
  if (target === 'oddEven') return 2;
  if (target === 'superNumber') return 3;
  const star = Number(String(target).replace('星', ''));
  return Number.isFinite(star) && star > 0 ? star + 3 : 1;
}

function targetInput(snapshot, target, castingAt = reproducibleCastingAt(snapshot.castingAt || snapshot.drawAt, snapshot.period)) {
  const targetNo = playIndex(target);
  return {
    target,
    targetNo,
    period: String(snapshot.period),
    castingAt,
    question: `第 ${snapshot.period} 期／${target}`,
  };
}

function meihuaCasting(snapshot, target, castingAt) {
  const input = targetInput(snapshot, target, castingAt);
  const lunar = parseChineseCalendarParts(input.castingAt);
  const yearBranch = ((lunar.year - 4) % 12 + 12) % 12 + 1;
  const total = yearBranch + lunar.month + lunar.day;
  const upper = total % 8 || 8;
  const lower = (total + lunar.hour) % 8 || 8;
  const moving = (total + lunar.hour) % 6 || 6;
  return { input, upper, lower, moving, formula: `預測時間=${input.castingAt}；年支=${yearBranch}、農曆月=${lunar.month}、日=${lunar.day}、時=${lunar.hour}；上卦=(年支+月+日) mod 8=${upper}；下卦=(年支+月+日+時) mod 8=${lower}；動爻=(年支+月+日+時) mod 6=${moving}。同一預測時刻的時間起卦核心一致；期號與玩法僅作所問事項，各目標再獨立套用研究排序：${input.question}` };
}

function digitalYarrowLine(random, lineIndex) {
  let stalks = 49;
  const rounds = [];
  for (let round = 0; round < 3; round += 1) {
    const left = 1 + Math.floor(random() * (stalks - 1));
    const right = stalks - left - 1;
    const leftRemainder = left % 4 || 4;
    const rightRemainder = right % 4 || 4;
    const removed = leftRemainder + rightRemainder + 1;
    stalks -= removed;
    rounds.push({ left, right, removed, remaining: stalks });
  }
  const value = stalks / 4;
  return { lineIndex, value, moving: value === 6 || value === 9, rounds };
}

function sixyaoCasting(snapshot, target, castingAt) {
  const input = targetInput(snapshot, target, castingAt);
  const random = seededRandom(`digital-yarrow|${input.castingAt}|${input.period}|${target}`);
  const lines = Array.from({ length: 6 }, (_, index) => digitalYarrowLine(random, index + 1));
  const binary = lines.map((line) => line.value === 6 || line.value === 8 ? 0 : 1).reverse().join('');
  return { input, lines, binary, formula: `預測時間=${input.castingAt}；以數位蓍草模擬 49 蓍，逐爻執行分二、掛一、揲四、歸奇三變，所得 6/7/8/9 再由初爻至上爻排列。期號與玩法僅作獨立起筮標籤：${input.question}。保存每爻三變結果，可重算但不宣稱等同實體蓍草。` };
}

function luoshuCasting(snapshot, target) {
  const input = targetInput(snapshot, target);
  const time = parseChineseCalendarParts(input.castingAt);
  const timeSum = time.yearBranch + time.month + time.day + time.hour;
  const luoshu = [[4, 9, 2], [3, 5, 7], [8, 1, 6]];
  const palace = (timeSum + input.targetNo) % 9;
  const center = luoshu[Math.floor(palace / 3)][palace % 3];
  return { input, luoshu, palace: palace + 1, center, formula: `預測時間=${input.castingAt}；以農曆年支序${time.yearBranch}、月${time.month}、日${time.day}、時辰${time.hour}加玩法序號 mod 9 定洛書宮位=${palace + 1}；宮位數=${center}。期號僅作所問事項：${input.question}` };
}

function numeralGuaCasting(snapshot, target) {
  const input = targetInput(snapshot, target);
  const time = parseChineseCalendarParts(input.castingAt);
  const sourceDigits = [time.yearBranch, time.month, time.day, time.hour, input.targetNo];
  const allowed = [1, 4, 5, 6, 8, 9];
  const digits = Array.from({ length: 6 }, (_, index) => allowed[(sourceDigits[index % sourceDigits.length] + index) % allowed.length]);
  return { input, digits, formula: `預測時間=${input.castingAt}；以農曆年支序${time.yearBranch}、月${time.month}、日${time.day}、時辰${time.hour}與玩法序號建立六個可重算數字：${digits.join('、')}。期號僅作所問事項：${input.question}` };
}

function qimenCasting(snapshot, target) {
  const input = targetInput(snapshot, target);
  const time = parseChineseCalendarParts(input.castingAt);
  const timeSum = time.yearBranch + time.month + time.day + time.hour;
  const palace = (timeSum + input.targetNo) % 9 + 1;
  const star = (timeSum + time.hour + input.targetNo) % 9 + 1;
  const door = (timeSum + time.month + input.targetNo) % 8 + 1;
  return { input, palace, star, door, formula: `預測時間=${input.castingAt}；以農曆年支序${time.yearBranch}、月${time.month}、日${time.day}、時辰${time.hour}建立九宮／九星／八門研究適配=${palace}/${star}/${door}；完整奇門仍需節氣、干支排局，未宣稱完整奇門排盤。` };
}

function taiyiCasting(snapshot, target) {
  const input = targetInput(snapshot, target);
  const time = parseChineseCalendarParts(input.castingAt);
  const timeSum = time.yearBranch + time.month + time.day + time.hour;
  const palace = (timeSum + input.targetNo) % 9 + 1;
  const cycle = (timeSum + input.targetNo) % 9;
  return { input, palace, cycle, formula: `預測時間=${input.castingAt}；以農曆年支序${time.yearBranch}、月${time.month}、日${time.day}、時辰${time.hour}建立太乙行九宮研究索引=${palace}／${cycle}。完整太乙仍需積年、局數等排局資料，期號僅作所問事項：${input.question}` };
}

function statisticalCasting(snapshot, target) {
  const input = targetInput(snapshot, target);
  const time = parseChineseCalendarParts(input.castingAt);
  return {
    input,
    window: 60,
    timeKey: `農曆${time.yearBranch}-${time.month}-${time.day}-${time.hour}`,
    formula: `固定輸入=${input.castingAt}；僅使用目標期之前的歷史資料，計算熱度、遺漏、和值、奇偶與高低區特徵；窗口上限 60 期。這是統計基線，不是玄學因果。`,
  };
}

function zodiacElementCasting(snapshot, target) {
  const input = targetInput(snapshot, target);
  const lunar = parseChineseCalendarParts(input.castingAt);
  const stem = ((lunar.year - 4) % 10 + 10) % 10;
  const branch = ((lunar.year - 4) % 12 + 12) % 12;
  const elements = ['木', '木', '火', '火', '土', '土', '金', '金', '水', '水'];
  return { input, stem, branch, element: elements[stem], digits: [], formula: `固定輸入=${input.castingAt}；以農曆年干支取年元素=${elements[stem]}、生肖支序=${branch + 1}；號碼只做固定五行映射與統計排序，屬研究適配，不宣稱命理因果。` };
}

function historicalFrequencies(history) {
  const counts = Array(81).fill(0);
  // 頻率是「出現期數／期數」，不可把每期的 20 球當成 80 次獨立抽樣，
  // 也不可用未正規化的倒數時間權重冒充機率；近期性另由分段窗口處理。
  history.forEach((draw) => draw.numbers.forEach((number) => { counts[Number(number)] += 1; }));
  const total = history.length || 1;
  return counts.map((count) => count / total);
}

function windowFrequency(number, history, windowSize) {
  const window = history.slice(0, Math.min(windowSize, history.length));
  if (!window.length) return 0.25;
  let hits = 0;
  window.forEach((draw) => { if (draw.numbers.some((value) => Number(value) === number)) hits += 1; });
  return hits / window.length;
}

function windowFrequencies(history, windowSize) {
  const window = history.slice(0, Math.min(windowSize, history.length));
  const counts = Array(81).fill(0);
  if (!window.length) return counts.map(() => 0.25);
  window.forEach((draw) => draw.numbers.forEach((value) => { counts[Number(value)] += 1; }));
  return counts.map((count) => count / window.length);
}

function hypergeometricInclusion(number, history) {
  // 每期是 80 選 20 的不放回集合；以 Beta(1, 3) 收縮到理論包含率 20/80。
  const draws = history.length;
  const hits = history.reduce((sum, draw) => sum + (draw.numbers.some((value) => Number(value) === number) ? 1 : 0), 0);
  return (hits + 1) / (draws + 4);
}

function frequencyBaselinePrediction(history, count = 10) {
  const frequencies = windowFrequencies(history, Math.min(60, Math.max(1, history.length)));
  return Array.from({ length: 80 }, (_, index) => index + 1)
    .sort((a, b) => frequencies[b] - frequencies[a] || a - b)
    .slice(0, count)
    .sort((a, b) => a - b)
    .map((number) => String(number).padStart(2, '0'));
}

function betaBaselinePrediction(history, count = 10) {
  return Array.from({ length: 80 }, (_, index) => index + 1)
    .sort((a, b) => hypergeometricInclusion(b, history) - hypergeometricInclusion(a, history) || a - b)
    .slice(0, count)
    .sort((a, b) => a - b)
    .map((number) => String(number).padStart(2, '0'));
}

function deterministicBootstrap(values, seed = '') {
  if (!values.length) return { mean: null, lower: null, upper: null, samples: 0 };
  const replications = Math.min(400, Math.max(200, values.length * 20));
  const means = [];
  for (let replication = 0; replication < replications; replication += 1) {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) {
      const random = deterministicTie(`${seed}|${replication}`, index);
      total += values[Math.floor(random * values.length)];
    }
    means.push(total / values.length);
  }
  means.sort((a, b) => a - b);
  const at = (q) => means[Math.min(means.length - 1, Math.max(0, Math.floor(q * means.length)))];
  return { mean: values.reduce((sum, value) => sum + value, 0) / values.length, lower: at(0.025), upper: at(0.975), samples: replications };
}

function behaviorAudit(draws = []) {
  const valid = draws.filter((draw) => Array.isArray(draw.numbers) && draw.numbers.length === 20);
  const total = valid.length * 20;
  if (!total) return { sampleDraws: 0, birthdayShare: null, roundNumberShare: null, consecutiveShare: null, verdict: '沒有足夠資料', caveat: '這是玩家選號行為的負對照，不是開獎機率模型。' };
  let birthday = 0; let round = 0; let consecutive = 0;
  valid.forEach((draw) => {
    const values = draw.numbers.map(Number).sort((a, b) => a - b);
    values.forEach((number) => {
      if (number <= 31) birthday += 1;
      if (number % 10 === 0) round += 1;
    });
    for (let index = 1; index < values.length; index += 1) if (values[index] === values[index - 1] + 1) consecutive += 1;
  });
  const birthdayShare = birthday / total;
  const roundNumberShare = round / total;
  const consecutiveShare = consecutive / Math.max(1, total - valid.length);
  return {
    sampleDraws: valid.length,
    birthdayShare,
    roundNumberShare,
    consecutiveShare,
    verdict: valid.length < 30 ? '樣本不足，僅供觀察' : '只描述歷史號碼形狀，不代表下一期存在行為因果',
    caveat: '玩家偏好可能影響選號集中與獎金分配，但不會改變官方開獎機制；本欄不納入預測加權。',
  };
}

function leakageGuard(history = [], nextPeriod = '') {
  const checks = [];
  const horizon = Math.min(maxModelHistory, history.length - 1);
  for (let index = 0; index <= horizon; index += 1) {
    const targetPeriod = index === 0 ? String(nextPeriod) : String(history[index - 1]?.period || '');
    const training = history.slice(index + 1, index + maxModelHistory + 1);
    const targetNumber = Number(targetPeriod);
    const leaked = training.some((draw) => {
      const period = Number(draw.period);
      return targetPeriod && ((Number.isFinite(targetNumber) && Number.isFinite(period) && period >= targetNumber) || String(draw.period) === targetPeriod);
    });
    checks.push({ targetPeriod, trainingCount: training.length, leaked });
  }
  return {
    checkedTargets: checks.length,
    violations: checks.filter((check) => check.leaked).length,
    passed: checks.every((check) => !check.leaked),
    rule: '每個目標期只使用更早期數；下一期預測排除最新開獎期與所有未來期數；不重用未驗證歷史模型快取。',
  };
}

function deterministicTie(seed, number) {
  const digest = createHash('sha256').update(`${seed}|${number}`).digest('hex').slice(0, 8);
  return Number.parseInt(digest, 16) / 0xffffffff;
}

function targetAdapterSignal(number, target, tradition) {
  const targetNo = playIndex(target);
  const row = Math.floor((number - 1) / 10);
  const col = (number - 1) % 10;
  const upper = tradition.upper ?? tradition.palace ?? tradition.center ?? tradition.digits?.[0] ?? tradition.cycle ?? 1;
  const lower = tradition.lower ?? tradition.star ?? tradition.cycle ?? tradition.palace ?? 1;
  const moving = tradition.moving ?? tradition.door ?? tradition.palace ?? 1;
  if (target === 'superNumber') {
    return (number % 10 === moving % 10 ? 0.32 : 0)
      + (number % 8 === upper ? 0.24 : 0)
      + (row === lower % 8 ? 0.12 : 0);
  }
  // 星級不是另一套起卦法：它只決定候選集合大小，並用固定、可解釋的區段／位置適配。
  const zone = (upper + lower + moving + targetNo) % 4;
  const zoneHit = Math.floor((number - 1) / 20) === zone;
  const diagonal = (row + col + moving + targetNo) % 4 === 0;
  const remainder = number % (targetNo + 3) === (upper + targetNo) % (targetNo + 3);
  return (zoneHit ? 0.18 : 0) + (diagonal ? 0.08 : 0) + (remainder ? 0.12 : 0);
}

const exclusionFilterDefinitions = [
  {
    key: 'repeat-last-draw',
    label: '排除上一期重複號',
    apply: (number, prior) => (prior[0]?.numbers || []).some((value) => Number(value) === number),
  },
  {
    key: 'short-hot',
    label: '排除短窗過熱號',
    apply: (number, prior) => {
      const recent = prior.slice(0, 12);
      const count = recent.reduce((total, draw) => total + (draw.numbers || []).some((value) => Number(value) === number), 0);
      return recent.length >= 8 && count >= Math.ceil(recent.length * 0.42);
    },
  },
  {
    key: 'zone-overweight',
    label: '排除過度集中區段',
    apply: (number, prior) => {
      const recent = prior.slice(0, 20);
      if (recent.length < 12) return false;
      const zone = Math.floor((number - 1) / 20);
      const total = recent.reduce((sum, draw) => sum + (draw.numbers || []).filter((value) => Math.floor((Number(value) - 1) / 20) === zone).length, 0);
      return total / (recent.length * 20) > 0.29;
    },
  },
];

function exclusionSet(filter, prior = []) {
  return new Set(Array.from({ length: 80 }, (_, index) => index + 1).filter((number) => filter.apply(number, prior)));
}

function evaluateExclusionFilters(history = []) {
  return exclusionFilterDefinitions.map((filter) => {
    let excludedHits = 0;
    let excludedSlots = 0;
    let folds = 0;
    for (let index = 0; index < Math.min(history.length - 1, 180); index += 1) {
      const actual = history[index];
      const prior = history.slice(index + 1);
      const excluded = exclusionSet(filter, prior);
      if (!excluded.size || excluded.size > 48) continue;
      excludedHits += (actual.numbers || []).filter((value) => excluded.has(Number(value))).length;
      excludedSlots += excluded.size;
      folds += 1;
    }
    const rate = excludedSlots ? excludedHits / excludedSlots : null;
    const baseline = 20 / 80;
    const standardError = rate == null ? null : Math.sqrt(Math.max(0, baseline * (1 - baseline)) / Math.max(1, excludedSlots));
    const upperBound = rate == null ? null : rate + 1.96 * (standardError || 0);
    return {
      key: filter.key, label: filter.label, folds, excludedSlots, excludedHits, rate,
      baselineRate: baseline, upperBound,
      active: folds >= 30 && excludedSlots >= 300 && upperBound != null && upperBound < baseline && rate < baseline * 0.9,
      rule: '只用每個目標期以前資料；排除集合命中率以每個被排除號碼的實際出現率計算。',
    };
  });
}

function exclusionPrediction(seed, count, history = [], target = '10星') {
  const validation = evaluateExclusionFilters(history);
  const active = exclusionFilterDefinitions.filter((filter) => validation.find((item) => item.key === filter.key)?.active);
  const excluded = new Set();
  active.forEach((filter) => exclusionSet(filter, history).forEach((number) => excluded.add(number)));
  // 排除過多代表規則不穩定，寧可停用全部濾網，也不把剩餘小集合冒充高機率。
  const usableExcluded = excluded.size <= 48 ? excluded : new Set();
  const frequencies = historicalFrequencies(history);
  const recent = windowFrequencies(history, 12);
  const medium = windowFrequencies(history, 60);
  const candidates = Array.from({ length: 80 }, (_, index) => index + 1)
    .filter((number) => !usableExcluded.has(number))
    .map((number) => {
      const stable = recent[number] * 0.55 + medium[number] * 0.45;
      const score = stable * 0.7 + frequencies[number] * 0.3 + deterministicTie(`${seed}|exclusion|${target}`, number) * 0.000001;
      return { number, score };
    })
    .sort((a, b) => b.score - a.score || a.number - b.number);
  return {
    numbers: candidates.slice(0, count).sort((a, b) => a.number - b.number).map((item) => String(item.number).padStart(2, '0')),
    validation,
    activeFilters: active.map((filter) => filter.key),
    excludedNumbers: [...usableExcluded].sort((a, b) => a - b).map((number) => String(number).padStart(2, '0')),
  };
}

function scoreNumbers(seed, count, tradition, history, empiricalWeight = 0.32, target = '') {
  const frequencies = historicalFrequencies(history);
  const recentFrequencies = windowFrequencies(history, 12);
  const mediumFrequencies = windowFrequencies(history, 60);
  const longFrequencies = windowFrequencies(history, 300);
  const values = Array.from({ length: 80 }, (_, index) => index + 1).map((number) => {
    const traditional = tradition.kind === 'bazi'
      ? ((['木', '火', '土', '金', '水'][(number - 1) % 5] === tradition.element ? 0.38 : 0.06) + (number % 12 === tradition.branch + 1 ? 0.18 : 0))
      : tradition.kind === 'hypergeometric'
      ? hypergeometricInclusion(number, history)
      : tradition.kind === 'multiscale'
      ? (() => {
        const windows = [12, 60, 300].map((size) => windowFrequency(number, history, size));
        const baseline = 0.25;
        const normalized = windows.map((value) => value / baseline);
        const mean = normalized.reduce((sum, value) => sum + value, 0) / normalized.length;
        const spread = normalized.reduce((sum, value) => sum + Math.abs(value - mean), 0) / normalized.length;
        return (normalized[0] * 0.5 + normalized[1] * 0.3 + normalized[2] * 0.2) / (1 + spread * 0.35);
      })()
      : tradition.kind === 'bayesian'
      ? (() => {
        const recent = history.slice(0, 60);
        const seen = new Map();
        recent.forEach((draw) => draw.numbers.forEach((value) => {
          const numberValue = Number(value);
          seen.set(numberValue, (seen.get(numberValue) || 0) + 1);
        }));
        const alpha = 1;
        const denominator = recent.length * 20 + 80 * alpha;
        return ((seen.get(number) || 0) + alpha) / Math.max(1, denominator);
      })()
      : tradition.kind === 'statistics'
      ? (() => {
        const recent = history.slice(0, 60);
        const seen = new Map();
        recent.forEach((draw, drawIndex) => draw.numbers.forEach((value) => {
          const numberValue = Number(value);
          seen.set(numberValue, (seen.get(numberValue) || 0) + (1 / (drawIndex + 1)));
        }));
        const frequency = seen.get(number) || 0;
        const latestGap = recent.findIndex((draw) => draw.numbers.map(Number).includes(number));
        const omission = latestGap < 0 ? 1 : Math.min(latestGap + 1, 20) / 20;
        const parity = target === 'oddEven' ? (number % 2 ? 0.08 : 0.04) : 0;
        return clamp(frequency / Math.max(1, recent.length * 0.2), 0, 1) * 0.35 + omission * 0.25 + parity;
      })()
      : tradition.kind === 'luoshu'
      ? (1 - Math.abs((tradition.center + Math.floor((number - 1) / 10) + (number - 1) % 10) % 9 - 4) / 4) * 0.55 + (number % tradition.center === 0 ? 0.2 : 0)
      : tradition.kind === 'sixyao'
        ? ((tradition.bits[(number + tradition.moving) % 6] === '1' ? 1 : -1) * (number % 2 ? 1 : -1) * 0.12) + (number % 8 === tradition.lower ? 0.18 : 0)
        : tradition.kind === 'numeral-gua'
          ? (tradition.digits.includes(number % 10) ? 0.3 : 0) + (number % 6 === tradition.digits[number % 6] ? 0.18 : 0)
          : tradition.kind === 'qimen'
            ? (number % 9 === tradition.palace - 1 ? 0.32 : 0) + (number % 9 === tradition.star - 1 ? 0.2 : 0) + (number % 8 === tradition.door - 1 ? 0.14 : 0)
            : tradition.kind === 'taiyi'
              ? (number % 9 === tradition.palace - 1 ? 0.34 : 0) + (number % 9 === tradition.cycle ? 0.18 : 0)
              : ((number % 8 === tradition.upper ? 0.32 : 0) + (number % 6 === tradition.moving ? 0.16 : 0));
    // 新增跨窗口穩定性：短期訊號只有在 12／60／300 期方向一致時才提高權重。
    const stableRate = recentFrequencies[number] * 0.5 + mediumFrequencies[number] * 0.3 + longFrequencies[number] * 0.2;
    const spread = (Math.abs(recentFrequencies[number] - mediumFrequencies[number]) + Math.abs(mediumFrequencies[number] - longFrequencies[number])) / 2;
    const stability = clamp((stableRate / 0.25) / (1 + spread * 1.5), 0, 1);
    const empiricalSignal = clamp((frequencies[number] / 0.25) * 0.35 + stability * 0.65, 0, 1);
    const empirical = empiricalSignal * empiricalWeight;
    const adapter = targetAdapterSignal(number, target, tradition);
    const targetWeight = target === 'superNumber' ? 0.24 : 0.22;
    return { number, score: traditional * (1 - empiricalWeight) + empirical + adapter * targetWeight + deterministicTie(seed, number) * 0.000001 };
  });
  const ranked = values.sort((a, b) => b.score - a.score || a.number - b.number);
  return ranked.slice(0, count).sort((a, b) => a.number - b.number).map((item) => String(item.number).padStart(2, '0'));
}

const NUMBER_ZONES = [
  { key: 'zone-1', label: '01–20', min: 1, max: 20 },
  { key: 'zone-2', label: '21–40', min: 21, max: 40 },
  { key: 'zone-3', label: '41–60', min: 41, max: 60 },
  { key: 'zone-4', label: '61–80', min: 61, max: 80 },
];

function zonePredictionSet(seed, tradition, history, empiricalWeight, target = '10星', picksPerZone = 5) {
  const frequencies = historicalFrequencies(history);
  const recentFrequencies = windowFrequencies(history, 12);
  const mediumFrequencies = windowFrequencies(history, 60);
  const longFrequencies = windowFrequencies(history, 300);
  const ranked = Array.from({ length: 80 }, (_, index) => index + 1).map((number) => {
    const recent = recentFrequencies[number];
    const medium = mediumFrequencies[number];
    const long = longFrequencies[number];
    const stableRate = (recent * 0.5 + medium * 0.3 + long * 0.2);
    const spread = (Math.abs(recent - medium) + Math.abs(medium - long)) / 2;
    const stability = clamp((stableRate / 0.25) / (1 + spread * 1.5), 0, 1);
    const traditional = targetAdapterSignal(number, target, tradition);
    const empirical = clamp((frequencies[number] * 0.35 / 0.25) + stability * 0.65, 0, 1) * empiricalWeight;
    return { number, score: traditional * (1 - empiricalWeight) + empirical + deterministicTie(`${seed}|zone`, number) * 0.000001 };
  });
  return NUMBER_ZONES.map((zone) => ({
    key: zone.key,
    label: zone.label,
    numbers: ranked
      .filter((item) => item.number >= zone.min && item.number <= zone.max)
      .sort((a, b) => b.score - a.score || a.number - b.number)
      .slice(0, picksPerZone)
      .sort((a, b) => a.number - b.number)
      .map((item) => String(item.number).padStart(2, '0')),
  }));
}

function datePartsTaipei() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

function taipeiDateKey(daysAgo = 0) {
  const today = datePartsTaipei();
  const date = new Date(Date.UTC(Number(today.year), Number(today.month) - 1, Number(today.day) - daysAgo));
  return date.toISOString().slice(0, 10);
}

function formatTaipeiDateTime(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
}

function officialDrawDateTime(openDate, period, firstPeriod) {
  const offset = Number(period) - Number(firstPeriod);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(openDate)) || !Number.isInteger(offset) || offset < 0 || offset > 202) return '';
  const [year, month, day] = String(openDate).split('-').map(Number);
  // 官方 API 的 dDate 目前為 0001-01-01；期號序列與官方時程可重現地還原當日時間。
  // 賓果賓果每日 07:05 起，每 5 分鐘一期，最多至 23:55。
  const utcMidnightTaipei = Date.UTC(year, month - 1, day) - 8 * 60 * 60 * 1000;
  return formatTaipeiDateTime(new Date(utcMidnightTaipei + (7 * 60 + 5 + offset * 5) * 60 * 1000));
}

function deriveSnapshot(period, numbers, source, drawAt = '') {
  const parsed = numbers.map(Number);
  if (!period || parsed.length !== 20 || parsed.some((number) => number < 1 || number > 80)) throw new Error('來源未回傳完整 20 個 1–80 號碼');
  const bigCount = parsed.filter((number) => number >= 41).length;
  const oddCount = parsed.filter((number) => number % 2 === 1).length;
  const size = bigCount >= 13 ? '大' : bigCount <= 7 ? '小' : '和';
  const oddEven = oddCount >= 13 ? '單' : oddCount <= 7 ? '雙' : '和';
  return {
    period: String(period), drawAt, numbers: parsed.map((number) => String(number).padStart(2, '0')),
    superNumber: '', size, oddEven, source, sourceLabel: source,
  };
}

function normalizeSourceDrawTimes(history, fallbackDate = taipeiDateKey(0)) {
  const validDate = (value) => {
    const text = String(value || '').replaceAll('/', '-').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(text) && !text.startsWith('0001-');
  };
  const byDate = new Map();
  history.forEach((item) => {
    const date = validDate(item.drawAt) ? String(item.drawAt).replaceAll('/', '-').slice(0, 10) : fallbackDate;
    const period = Number(item.period);
    const first = byDate.get(date);
    if (Number.isFinite(period) && (!Number.isFinite(first) || period < first)) byDate.set(date, period);
  });
  return history.map((item) => {
    const date = validDate(item.drawAt) ? String(item.drawAt).replaceAll('/', '-').slice(0, 10) : fallbackDate;
    const normalized = officialDrawDateTime(date, item.period, byDate.get(date));
    return normalized ? { ...item, drawAt: normalized } : item;
  });
}

function parseOfficialPage(html) {
  const text = cleanHtml(html);
  const period = text.match(/第\s*(\d{7,9})\s*期/)?.[1];
  const numbers = text.match(/大小順序\s*開出順序\s*((?:\d{1,2}\s+){19}\d{1,2})\s+超級獎號\s*(\d{1,2})/);
  const drawAt = text.match(/開獎日期\s*([0-9]{2,3}\/\d{1,2}\/\d{1,2}\([^)]*\)\s+\d{1,2}:\d{2})/)?.[1] || '';
  const size = text.match(/猜大小\s*([大小])/)?.[1] || '';
  const oddEvenRaw = text.match(/猜單雙\s*([單雙－-])/)?.[1] || '';
  const oddEven = oddEvenRaw === '－' || oddEvenRaw === '-' ? '和' : oddEvenRaw;
  if (!period || !numbers) throw new Error('官方頁面格式變更，無法解析完整開獎資料');
  return { period, drawAt, numbers: numbers[1].trim().split(/\\s+/).map((n) => n.padStart(2, '0')), superNumber: numbers[2].padStart(2, '0'), size, oddEven };
}

function parse168WinPage(html, sourceName) {
  const period = html.match(/期號[：:]\s*(\d{7,9})/)?.[1];
  const drawAt = html.match(/開獎時間[：:]\s*(\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2})/)?.[1]?.replaceAll('/', '-') || '';
  const ballsBlock = html.match(/<div\s+class=["']balls["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || '';
  const numbers = [...ballsBlock.matchAll(/<span[^>]*class=["'][^"']*\bnumber\b[^"']*["'][^>]*>\s*(\d{1,2})\s*<\/span>/gi)].map((match) => match[1]);
  const superNumber = ballsBlock.match(/class=["'][^"']*\bspecial\b[^"']*["'][^>]*>\s*(\d{1,2})/i)?.[1] || html.match(/超級獎號[：:]\s*(\d{1,2})/)?.[1] || '';
  const summary = html.match(/猜大小：([^|<]+)\|\s*猜單雙：([^|<]+)\|\s*超級獎號：([^<]+)/)?.[0] || '';
  if (!period || numbers.length !== 20) throw new Error('168win 未回傳完整 20 個號碼');
  const snapshot = deriveSnapshot(period, numbers, sourceName, drawAt);
  return {
    ...snapshot,
    superNumber: superNumber.padStart(2, '0'),
    size: snapshot.size,
    oddEven: snapshot.oddEven,
  };
}

function parseTimetablePage(html, sourceName) {
  const events = [...html.matchAll(/"name":"賓果賓果 第 (\d{7,9}) 期開獎"[\s\S]{0,1800}?"description":"開獎號碼：([^"]+)"/g)]
    .map((match) => ({ period: match[1], numbers: match[2].split(',').map((value) => value.trim()).filter(Boolean) }))
    .filter((item) => item.numbers.length === 20)
    .sort((a, b) => Number(b.period) - Number(a.period));
  if (!events.length) throw new Error('Timetable 未找到完整開獎資料');
  const date = html.match(/"dateModified":"(\d{4}-\d{2}-\d{2})/)?.[1] || '';
  return deriveSnapshot(events[0].period, events[0].numbers, sourceName, date);
}

function parseWinwinData(payload, sourceName) {
  if (!Array.isArray(payload)) throw new Error('WINWIN 回傳格式不是陣列');
  const history = payload.map((item) => {
    const numbers = String(item?.OpenShowOrder || '').split(',').map((value) => value.trim()).filter(Boolean);
    if (!item?.No || numbers.length !== 20) return null;
    const snapshot = deriveSnapshot(item.No, numbers, sourceName, String(item.OpenDate || '').replace('T', ' '));
    snapshot.superNumber = String(item.BullEyeTop || '').padStart(2, '0');
    return snapshot;
  }).filter(Boolean).sort((a, b) => Number(b.period) - Number(a.period));
  if (!history.length) throw new Error('WINWIN 未回傳完整開獎資料');
  return { snapshot: history[0], history, historyDays: 1 };
}

const predictionTargets = ['size', 'oddEven', 'superNumber', ...Array.from({ length: 10 }, (_, index) => `${index + 1}星`)];
const modelSources = {
  '梅花易數': [{ name: '邵雍《梅花易數》數字起卦文本', url: 'https://www.diancang.xyz/xuanxuewushu/meihuayishu/37733.html' }, { name: '北京大學：周易筮法源流考略', url: 'https://ruzang.pku.edu.cn/info/1067/2156.htm' }],
  '六爻八卦': [{ name: '北京大學：周易筮法源流考略', url: 'https://ruzang.pku.edu.cn/info/1067/2156.htm' }, { name: '中國哲學書電子化計劃：周易卦變資料', url: 'https://ctext.org/datawiki.pl?if=en&res=484682' }],
  '河圖洛書': [{ name: 'Luo Shu：同行同列對角線和為 15 的研究論文', url: 'https://journals.sagepub.com/doi/10.1177/2158244015585828' }],
  '數字卦（楚簡研究版）': [{ name: '深圳大學學報：楚卜筮簡中的數字卦', url: 'https://xb.szu.edu.cn/article/2016/1000-260X-33-3-58.html' }, { name: '濟南大學學報：清華簡《筮法》研究', url: 'https://journal.ujn.edu.cn/zh/article/31373565/' }],
  '奇門遁甲（九宮研究版）': [{ name: '北海道大學：奇門遁甲的基礎研究', url: 'https://eprints.lib.hokudai.ac.jp/repo/huscap/all/44606/' }, { name: 'EASTM：中國軍事占卜史研究', url: 'https://core.ac.uk/download/pdf/228877365.pdf' }],
  '太乙九宮（研究版）': [{ name: 'Extrême-Orient：太乙、奇門遁甲與六壬研究', url: 'https://journals.openedition.org/extremeorient/pdf/270' }, { name: '柏林自由大學：中國帝制時期的認知占卜', url: 'https://refubium.fu-berlin.de/handle/fub188/154' }],
  '民俗統計基線': [{ name: '台灣彩券官方開獎時間與隨機開獎說明', url: 'https://www.taiwanlottery.com/run_lottery/schedule/' }],
  '生肖五行研究版': [{ name: '中國哲學書電子化計劃：周易與五行資料', url: 'https://ctext.org/datawiki.pl?if=en&res=484682' }],
  '貝葉斯平滑基線': [{ name: 'Predicting Winning Lottery Numbers（統計模型研究）', url: 'https://arxiv.org/abs/2403.12836' }, { name: 'Statistical auditing and randomness test of lotto k/N-type games', url: 'https://arxiv.org/abs/0806.4595' }],
  '超幾何集合基線': [{ name: 'Statistical auditing and randomness test of lotto k/N-type games', url: 'https://arxiv.org/abs/0806.4595' }],
  '多窗口穩定性基線': [{ name: 'Strictly Proper Scoring Rules, Prediction, and Estimation', url: 'https://doi.org/10.1198/016214506000001437' }, { name: 'Statistical auditing and randomness test of lotto k/N-type games', url: 'https://arxiv.org/abs/0806.4595' }],
  '排除濾網基線': [{ name: 'NIST SP 800-22 隨機性測試', url: 'https://csrc.nist.gov/pubs/sp/800/22/r1/upd1/final' }, { name: 'Statistical auditing and randomness test of lotto k/N-type games', url: 'https://arxiv.org/abs/0806.4595' }],
  '機器學習負對照': [{ name: '序列式機率預測與評估', url: 'https://arxiv.org/abs/0905.1673' }, { name: 'Strictly Proper Scoring Rules, Prediction, and Estimation', url: 'https://doi.org/10.1198/016214506000001437' }],
};
const researchEvidenceRegistry = [
  { name: '西洋占星（負對照）', status: '不納入號碼預測；以雙盲研究作為反向驗證與限制說明', source: 'Nature 318（Carlson, 1985）', url: 'https://www.nature.com/articles/318419a0.pdf' },
  { name: '賭徒謬誤與熱手效應', status: '只用來檢查熱號／冷號敘事，不當作開獎訊號', source: 'NBER Working Paper 3769', url: 'https://www.nber.org/papers/w3769' },
  { name: '彩票隨機性審計', status: '頻率、序列相關與游程檢查；低 p 值只代表需複核', source: 'Lottery k/N statistical audit', url: 'https://arxiv.org/abs/0806.4595' },
  { name: '預測校準與適當評分', status: '以 Brier／對數損失檢查信心是否與實際頻率一致', source: 'Gneiting & Raftery, 2007', url: 'https://doi.org/10.1198/016214506000001437' },
  { name: '熱手與賭徒謬誤行為', status: '玩家偏誤負對照；不把玩家選號偏好當成開獎訊號', source: 'Management Science, 2018', url: 'https://pubsonline.informs.org/doi/10.1287/mnsc.2018.3233' },
  { name: 'NIST 隨機性測試套件', status: '採用頻率、游程、區塊頻率與近似熵的研究前置檢查；不作預測證明', source: 'NIST SP 800-22 Rev. 1a', url: 'https://csrc.nist.gov/pubs/sp/800/22/r1/upd1/final' },
  { name: '多重假設校正', status: '對同時檢查的 p 值做 Bonferroni 保守校正，降低偶然顯著', source: 'Multiple comparisons control', url: 'https://doi.org/10.1111/j.2517-6161.1995.tb02031.x' },
  { name: '序列式機率校準', status: '每個目標期只用更早折的結果估計信心，避免時間序列回看未來', source: 'Prequential probability forecasting', url: 'https://arxiv.org/abs/0905.1673' },
];

function targetProfile(profiles, methodName, target) {
  const profile = profiles?.[methodName] || {};
  return profile.targets?.[target] || profile[target] || profile;
}

function categoryPrediction(seed, traditional, history, field, empiricalWeight) {
  const allowed = field === 'size' ? new Set(['大', '小']) : new Set(['單', '雙']);
  const fallback = allowed.has(traditional) ? traditional : [...allowed][seed % allowed.size];
  if (!history.length || empiricalWeight < 0.4) return fallback;
  const counts = new Map();
  history.forEach((item, index) => {
    const value = normalizeDrawCategory(item[field], field);
    if (allowed.has(value)) counts.set(value, (counts.get(value) || 0) + 1 / (index + 1));
  });
  const empirical = [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0];
  return empirical || fallback;
}

function validPredictionCategory(value, field) {
  const normalized = normalizeDrawCategory(value, field);
  const allowed = field === 'size' ? new Set(['大', '小']) : new Set(['單', '雙']);
  return allowed.has(normalized) ? normalized : '';
}

function normalizeDrawCategory(value, field = '') {
  const text = String(value || '').trim().replace(/[\s:：]/g, '');
  if (field === 'size') {
    if (/^(大|大號|大數|猜大)$/.test(text)) return '大';
    if (/^(小|小號|小數|猜小)$/.test(text)) return '小';
  }
  if (field === 'oddEven') {
    if (/^(單|單數|猜單)$/.test(text)) return '單';
    if (/^(雙|雙數|猜雙)$/.test(text)) return '雙';
  }
  return text === '－' || text === '-' || text === '和局' ? '和' : text;
}

function categoryPayout(target, predicted, actual) {
  const field = target === 'size' ? 'size' : 'oddEven';
  const allowed = target === 'size' ? new Set(['大', '小']) : new Set(['單', '雙']);
  const expected = normalizeDrawCategory(predicted, field);
  const observed = normalizeDrawCategory(actual?.[field], field);
  // 「和」是未達任一投注門檻，不是可投注或可派彩的第三種選項。
  if (!allowed.has(expected) || !allowed.has(observed)) return 0;
  return expected === observed ? 150 : 0;
}

function hasPositiveProfit(target, predicted, actual) {
  let payout = 0;
  if (target === 'size' || target === 'oddEven') payout = categoryPayout(target, predicted, actual);
  else if (target === 'superNumber') payout = settleSuperNumber(predicted, actual).payout;
  else {
    const actualNumbers = new Set((actual.numbers || []).map(normalizeNumberValue));
    const matches = (predicted || []).filter((number) => actualNumbers.has(normalizeNumberValue(number))).length;
    payout = basicPayouts[target]?.[matches] || 0;
  }
  return payout - betCostForTarget(target) > 0;
}

function normalizeNumberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number).padStart(2, '0') : '';
}

function randomPrediction(target, seed) {
  const random = seededRandom(seed);
  if (target === 'size') return random() < 0.5 ? '大' : '小';
  if (target === 'oddEven') return random() < 0.5 ? '單' : '雙';
  if (target === 'superNumber') return String(1 + Math.floor(random() * 80)).padStart(2, '0');
  const count = Number(String(target).replace('星', '')) || 10;
  const values = Array.from({ length: 80 }, (_, index) => index + 1);
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [values[index], values[swap]] = [values[swap], values[index]];
  }
  return values.slice(0, count).sort((a, b) => a - b).map((value) => String(value).padStart(2, '0'));
}

function evaluationModelFor(actual, name, prior, includeNumbers = true) {
  const saved = actual.models?.find((model) => model.name === name);
  if (saved || name !== '機器學習負對照') return saved;
  // 舊保存期數可能沒有新模型；只用該目標期以前的資料即時補算。
  return buildMlNegativeControl(actual, prior, reproducibleCastingAt(actual.drawAt, actual.period), { includeNumbers });
}

function prequentialCategoryProbability(target, modelName, prior = []) {
  let wins = 0;
  let trials = 0;
  for (let index = 0; index < prior.length; index += 1) {
    const past = prior[index];
    const pastModel = evaluationModelFor(past, modelName, prior.slice(index + 1), false);
    if (!pastModel) continue;
    const predicted = target === 'size' ? pastModel.official?.size : pastModel.official?.oddEven;
    const actualValue = target === 'size' ? past.size : past.oddEven;
    wins += normalizeDrawCategory(predicted, target) === normalizeDrawCategory(actualValue, target) ? 1 : 0;
    trials += 1;
  }
  return { probability: (wins + 1) / (trials + 2), trials };
}

function forecastEvaluation(history = []) {
  const records = history.slice(1, maxModelHistory + 1).filter((item) => Array.isArray(item.models) && item.models.length);
  const modelNames = [...new Set(records.flatMap((item) => item.models.map((model) => model.name)).filter((name) => name !== '多模型聚合'))];
  if (records.length && !modelNames.includes('機器學習負對照')) modelNames.push('機器學習負對照');
  const byModel = new Map();
  records.forEach((actual, recordIndex) => {
    const prior = records.slice(recordIndex + 1);
    modelNames.forEach((name) => {
    const model = evaluationModelFor(actual, name, prior, true);
    if (!model) return;
    const result = byModel.get(model.name) || {
      name: model.name,
      samples: 0,
      size: { brier: 0, logLoss: 0, randomBrier: 0.25, randomLogLoss: Math.log(2), wins: 0, randomWins: 0 },
      oddEven: { brier: 0, logLoss: 0, randomBrier: 0.25, randomLogLoss: Math.log(2), wins: 0, randomWins: 0 },
      tenStar: { meanMatches: 0, randomMeanMatches: 0, frequencyMeanMatches: 0, betaMeanMatches: 0, positiveProfitRate: 0, randomPositiveProfitRate: 0, wins: 0, randomWins: 0 },
      deltas: { sizeBrier: [], oddEvenBrier: [], tenStarRandom: [], tenStarFrequency: [], tenStarBeta: [] },
    };
    result.samples += 1;
    ['size', 'oddEven'].forEach((target) => {
      const predicted = target === 'size' ? model.official.size : model.official.oddEven;
      const actualValue = target === 'size' ? actual.size : actual.oddEven;
      const correct = normalizeDrawCategory(predicted, target) === normalizeDrawCategory(actualValue, target);
      const probability = prequentialCategoryProbability(target, model.name, prior).probability;
      // 真值必須由目標期實際結果決定；舊版把每期 outcome 固定成 1，
      // 會讓未命中的 Brier／Log Loss 也被當成命中。
      const outcome = correct ? 1 : 0;
      result[target].brier += (probability - outcome) ** 2;
      result[target].logLoss += -Math.log(outcome ? probability : 1 - probability);
      result.deltas[target === 'size' ? 'sizeBrier' : 'oddEvenBrier'].push((probability - outcome) ** 2 - (0.5 - outcome) ** 2);
      result[target].wins += correct ? 1 : 0;
      const randomValue = randomPrediction(target, `random-baseline|${model.name}|${target}|${actual.period}|${recordIndex}`);
      const randomCorrect = normalizeDrawCategory(randomValue, target) === normalizeDrawCategory(actualValue, target);
      result[target].randomWins += randomCorrect ? 1 : 0;
    });
    const predictedNumbers = model.official.basic?.['10星'] || [];
    const actualNumbers = new Set(actual.numbers);
    const randomNumbers = randomPrediction('10星', `random-baseline|${model.name}|10星|${actual.period}|${recordIndex}`);
    const frequencyNumbers = frequencyBaselinePrediction(prior, 10);
    const betaNumbers = betaBaselinePrediction(prior, 10);
    result.tenStar.meanMatches += predictedNumbers.filter((number) => actualNumbers.has(number)).length;
    result.tenStar.randomMeanMatches += randomNumbers.filter((number) => actualNumbers.has(number)).length;
    result.tenStar.frequencyMeanMatches = (result.tenStar.frequencyMeanMatches || 0) + frequencyNumbers.filter((number) => actualNumbers.has(number)).length;
    result.tenStar.betaMeanMatches = (result.tenStar.betaMeanMatches || 0) + betaNumbers.filter((number) => actualNumbers.has(number)).length;
    result.deltas.tenStarRandom.push(predictedNumbers.filter((number) => actualNumbers.has(number)).length - randomNumbers.filter((number) => actualNumbers.has(number)).length);
    result.deltas.tenStarFrequency.push(predictedNumbers.filter((number) => actualNumbers.has(number)).length - frequencyNumbers.filter((number) => actualNumbers.has(number)).length);
    result.deltas.tenStarBeta.push(predictedNumbers.filter((number) => actualNumbers.has(number)).length - betaNumbers.filter((number) => actualNumbers.has(number)).length);
    result.tenStar.wins += hasPositiveProfit('10星', predictedNumbers, actual) ? 1 : 0;
    result.tenStar.randomWins += hasPositiveProfit('10星', randomNumbers, actual) ? 1 : 0;
    byModel.set(model.name, result);
    });
  });
  return [...byModel.values()].map((result) => {
    const samples = Math.max(1, result.samples);
    return {
      name: result.name,
      samples: result.samples,
      size: { brier: result.size.brier / samples, logLoss: result.size.logLoss / samples, randomBrier: result.size.randomBrier, randomLogLoss: result.size.randomLogLoss, winRate: result.size.wins / samples, randomWinRate: result.size.randomWins / samples },
      oddEven: { brier: result.oddEven.brier / samples, logLoss: result.oddEven.logLoss / samples, randomBrier: result.oddEven.randomBrier, randomLogLoss: result.oddEven.randomLogLoss, winRate: result.oddEven.wins / samples, randomWinRate: result.oddEven.randomWins / samples },
      tenStar: { meanMatches: result.tenStar.meanMatches / samples, randomMeanMatches: result.tenStar.randomMeanMatches / samples, frequencyMeanMatches: (result.tenStar.frequencyMeanMatches || 0) / samples, betaMeanMatches: (result.tenStar.betaMeanMatches || 0) / samples, positiveProfitRate: result.tenStar.wins / samples, randomPositiveProfitRate: result.tenStar.randomWins / samples },
      uncertainty: {
        sizeBrierDeltaVsUniform: deterministicBootstrap(result.deltas.sizeBrier, `${result.name}|size-brier`),
        oddEvenBrierDeltaVsUniform: deterministicBootstrap(result.deltas.oddEvenBrier, `${result.name}|odd-even-brier`),
        tenStarMatchesDeltaVsRandom: deterministicBootstrap(result.deltas.tenStarRandom, `${result.name}|10-star-random`),
        tenStarMatchesDeltaVsFrequency: deterministicBootstrap(result.deltas.tenStarFrequency, `${result.name}|10-star-frequency`),
        tenStarMatchesDeltaVsBayes: deterministicBootstrap(result.deltas.tenStarBeta, `${result.name}|10-star-bayes`),
      },
      caveat: '機率由目標期以前的 prequential 命中率以 Beta(1,1) 平滑估計；不使用當期結果倒推信心，仍不代表下一期具有可預測性。',
    };
  });
}

function calibratedProbabilityEvaluation(history = []) {
  const records = history.slice(1, maxModelHistory + 1).filter((item) => Array.isArray(item.models) && item.models.length);
  const modelNames = [...new Set(records.flatMap((item) => item.models.map((model) => model.name)).filter((name) => name !== '多模型聚合'))];
  if (records.length && !modelNames.includes('機器學習負對照')) modelNames.push('機器學習負對照');
  return modelNames.map((name) => {
    const metrics = { size: { brier: 0, logLoss: 0, count: 0, nextProbability: 0.5, bins: new Map() }, oddEven: { brier: 0, logLoss: 0, count: 0, nextProbability: 0.5, bins: new Map() } };
    records.forEach((actual, recordIndex) => {
      const model = evaluationModelFor(actual, name, records.slice(recordIndex + 1), false);
      if (!model) return;
      const older = records.slice(recordIndex + 1);
      ['size', 'oddEven'].forEach((target) => {
        let wins = 0; let trials = 0;
        older.forEach((past, olderIndex) => {
          const pastModel = evaluationModelFor(past, name, records.slice(recordIndex + olderIndex + 2), false);
          if (!pastModel) return;
          const predicted = target === 'size' ? pastModel.official.size : pastModel.official.oddEven;
          const actualValue = target === 'size' ? past.size : past.oddEven;
          wins += normalizeDrawCategory(predicted, target) === normalizeDrawCategory(actualValue, target) ? 1 : 0;
          trials += 1;
        });
        const probability = (wins + 1) / (trials + 2);
        const predicted = target === 'size' ? model.official.size : model.official.oddEven;
        const actualValue = target === 'size' ? actual.size : actual.oddEven;
        const outcome = normalizeDrawCategory(predicted, target) === normalizeDrawCategory(actualValue, target) ? 1 : 0;
        const metric = metrics[target];
        metric.brier += (probability - outcome) ** 2;
        metric.logLoss += -Math.log(outcome ? probability : 1 - probability);
        metric.count += 1;
        const bin = Math.min(9, Math.floor(probability * 10));
        const bucket = metric.bins.get(bin) || { probability: 0, observed: 0, count: 0 };
        bucket.probability += probability;
        bucket.observed += outcome;
        bucket.count += 1;
        metric.bins.set(bin, bucket);
      });
    });
    ['size', 'oddEven'].forEach((target) => {
      let wins = 0; let trials = 0;
      records.forEach((past, pastIndex) => {
        const pastModel = evaluationModelFor(past, name, records.slice(pastIndex + 1), false);
        if (!pastModel) return;
        const predicted = target === 'size' ? pastModel.official.size : pastModel.official.oddEven;
        const actualValue = target === 'size' ? past.size : past.oddEven;
        wins += normalizeDrawCategory(predicted, target) === normalizeDrawCategory(actualValue, target) ? 1 : 0;
        trials += 1;
      });
      metrics[target].nextProbability = (wins + 1) / (trials + 2);
    });
    const summarize = (metric) => ({
      brier: metric.count ? metric.brier / metric.count : null,
      logLoss: metric.count ? metric.logLoss / metric.count : null,
      nextProbability: metric.nextProbability,
      reliability: [...metric.bins.values()].map((bucket) => ({ probability: bucket.probability / bucket.count, observed: bucket.observed / bucket.count, samples: bucket.count })),
    });
    return { name, size: summarize(metrics.size), oddEven: summarize(metrics.oddEven), baselineBrier: 0.25, baselineLogLoss: Math.log(2), caveat: '機率由更早歷史折的 Beta(1,1) 平滑命中率估計；當期結果不參與當期信心估計。' };
  });
}

function backtestPayout(target, predicted, actual) {
  if (target === 'size' || target === 'oddEven') return categoryPayout(target, predicted, actual);
  if (target === 'superNumber') return settleSuperNumber(predicted, actual).payout;
  const actualNumbers = new Set((actual.numbers || []).map(normalizeNumberValue));
  const matches = (Array.isArray(predicted) ? predicted : []).filter((number) => actualNumbers.has(normalizeNumberValue(number))).length;
  return basicPayouts[target]?.[matches] || 0;
}

function rebuildEvaluationModel(sourceModel, actual, training) {
  if (!sourceModel?.name || sourceModel.name === '多模型聚合') return null;
  const weights = sourceModel.calculation?.empiricalWeights || {};
  const targets = Object.fromEntries(predictionTargets.map((target) => [target, {
    empiricalWeight: Number.isFinite(Number(weights[target])) ? Number(weights[target]) : 0,
  }]));
  const rebuilt = buildModels(actual, training, {
    evolve: false,
    onlyMethod: sourceModel.name,
    profiles: { [sourceModel.name]: { targets } },
    castingAt: reproducibleCastingAt(actual.drawAt, actual.period),
  });
  return rebuilt.find((model) => model.name === sourceModel.name) || null;
}

function profitabilityEvaluation(history = []) {
  const plays = [
    { key: 'size', label: '猜大小' },
    { key: 'oddEven', label: '猜單雙' },
    { key: 'superNumber', label: '超級獎號' },
    ...Array.from({ length: 10 }, (_, index) => ({ key: `${index + 1}星`, label: `${index + 1} 星` })),
  ];
  const anchor = history[profitabilityBacktestWindow];
  const selectionModels = anchor?.models || [];
  const currentModels = history[0]?.models || [];
  return plays.map((play) => {
    const evaluate = (currentModel, mode) => {
      const rows = [];
      for (let index = 0; index < profitabilityBacktestWindow; index += 1) {
        const actual = history[index];
        const training = history.slice(index + 1);
        if (!actual || !training.length) continue;
        // fixed：凍結錨點時已選定的模型與權重，但每個目標期都重新計算預測；
        // follow：採用該目標期前一棒的模型權重，同樣只看更早資料。
        const source = mode === 'fixed'
          ? currentModel
          : history[index + 1]?.models?.find((item) => item.name === currentModel.name);
        const model = rebuildEvaluationModel(source, actual, training);
        if (model) rows.push({ actual, model });
      }
      let wins = 0; let trials = 0; let profit = 0; let payoutTotal = 0; let matches = 0; let targetCount = 0;
      const periodResults = [];
      rows.forEach(({ actual, model }) => {
        const predicted = play.key === 'size'
          ? model.official?.size
          : play.key === 'oddEven'
            ? model.official?.oddEven
            : play.key === 'superNumber'
              ? model.official?.superNumber
              : model.official?.basic?.[play.key] || [];
        const payout = backtestPayout(play.key, predicted, actual);
        const cost = betCostForTarget(play.key);
        const net = payout - cost;
        periodResults.push({ period: String(actual.period || ''), drawAt: actual.drawAt || '', payout, net, profitable: net > 0 });
        wins += net > 0 ? 1 : 0;
        payoutTotal += payout;
        profit += net;
        if (Array.isArray(predicted)) {
          const actualNumbers = new Set(actual.numbers || []);
          matches += predicted.filter((number) => actualNumbers.has(String(number).padStart(2, '0'))).length;
          targetCount += predicted.length;
        } else { matches += payout > 0 ? 1 : 0; targetCount += 1; }
        trials += 1;
      });
      const selectionModel = selectionModels.find((item) => item.name === currentModel.name) || currentModel;
      const evolution = selectionModel.calculation?.evolution?.[play.key];
      // 回測統計使用歷史模型；畫面「預測號碼」必須使用目前最新模型，不能顯示回測錨點的舊號碼。
      const predictionSource = currentModels.find((item) => item.name === currentModel.name) || currentModel;
      const prediction = play.key === 'size'
        ? predictionSource.official?.size
        : play.key === 'oddEven'
          ? predictionSource.official?.oddEven
          : play.key === 'superNumber'
            ? predictionSource.official?.superNumber
            : predictionSource.official?.basic?.[play.key]?.join('、');
      const profitRate = trials ? wins / trials : null;
      const averageProfit = trials ? profit / trials : null;
      return {
        mode, model: currentModel.name, samples: trials, wins, profit, payoutTotal, costTotal: trials * betCostForTarget(play.key),
        matches, targetCount, averageProfit, positiveExpected: averageProfit != null && averageProfit > 0,
        profitRate, estimatedRate: evolution?.estimatedRate ?? null,
        confidence: evolution?.confidence ?? -1, prediction: prediction || '—', periodResults,
      };
    };
    // 模型必須在回測視窗開始前決定；不能看完這 10 期結果再挑最高盈利者。
    const rank = (a, b) => (b.confidence ?? -1) - (a.confidence ?? -1)
      || (b.estimatedRate ?? -1) - (a.estimatedRate ?? -1)
      || String(a.model).localeCompare(String(b.model));
    const empty = (mode) => ({ mode, model: '—', samples: 0, wins: 0, profit: 0, payoutTotal: 0, costTotal: 0, matches: 0, targetCount: 0, averageProfit: null, positiveExpected: false, profitRate: null, estimatedRate: null, confidence: -1, prediction: '—', periodResults: [] });
    const candidateModels = (selectionModels.length ? selectionModels : currentModels).filter((model) => model.name !== '多模型聚合');
    const fixed = candidateModels.map((model) => evaluate(model, 'fixed')).sort(rank)[0] || empty('fixed');
    const follow = candidateModels.map((model) => evaluate(model, 'follow')).sort(rank)[0] || empty('follow');
    return { ...play, best: fixed, fixed, follow, metricLabel: '盈利機率' };
  });
}

function zoneProfitabilityEvaluation(history = []) {
  const horizon = profitabilityBacktestWindow;
  const currentModels = history[0]?.models || [];
  const candidates = currentModels.filter((model) => model?.research?.zonePredictions?.length);
  const evaluate = (currentModel, mode) => {
    const rows = mode === 'fixed'
      ? (() => {
        const model = history[horizon]?.models?.find((item) => item.name === currentModel.name);
        return model ? history.slice(0, horizon).map((actual) => ({ actual, model })) : [];
      })()
      : history.slice(0, horizon).flatMap((actual, index) => {
        const model = history[index + 1]?.models?.find((item) => item.name === currentModel.name);
        return model ? [{ actual, model }] : [];
      });
    const zones = new Map();
    let profit = 0; let payoutTotal = 0; let costTotal = 0; let wins = 0; let trials = 0;
    rows.forEach(({ actual, model }) => {
      (model.research.zonePredictions || []).forEach((zone) => {
        const predicted = Array.isArray(zone.numbers) ? zone.numbers : [];
        const payout = backtestPayout('5星', predicted, actual);
        const cost = singleBetCost;
        const net = payout - cost;
        const state = zones.get(zone.key) || { key: zone.key, label: zone.label, samples: 0, wins: 0, matches: 0, payout: 0, profit: 0, periodResults: [] };
        const actualNumbers = new Set((actual.numbers || []).map(normalizeNumberValue));
        state.samples += 1;
        state.wins += net > 0 ? 1 : 0;
        state.matches += predicted.filter((number) => actualNumbers.has(normalizeNumberValue(number))).length;
        state.payout += payout;
        state.profit += net;
        state.periodResults.push({ period: String(actual.period || ''), net, profitable: net > 0 });
        zones.set(zone.key, state);
        trials += 1;
        wins += net > 0 ? 1 : 0;
        payoutTotal += payout;
        profit += net;
        costTotal += cost;
      });
    });
    return { mode, model: currentModel.name, samples: trials, wins, profit, payoutTotal, costTotal, profitRate: trials ? wins / trials : null, zones: [...zones.values()] };
  };
  return candidates.flatMap((model) => ['fixed', 'follow'].map((mode) => evaluate(model, mode)));
}

async function hydrateEvaluationModels(history = []) {
  const lastIndex = Math.min(history.length - 1, profitabilityBacktestWindow + 1);
  for (let index = 1; index <= lastIndex; index += 1) {
    if (Array.isArray(history[index]?.models) && history[index].models.length) continue;
    const item = history[index];
    if (!item) continue;
    const modelHistory = history.slice(index + 1, index + maxModelHistory + 1)
      .map(({ period, numbers, superNumber, size, oddEven, drawAt }) => ({ period, numbers, superNumber, size, oddEven, drawAt }));
    history[index].models = await buildModelsInWorker(item, modelHistory, {
      evolve: false,
      castingAt: reproducibleCastingAt(item.castingAt || item.drawAt, item.period),
    });
  }
  return history;
}

function technicalAnalysis(history = []) {
  const draws = history.slice(0, 30);
  const frequency = new Map();
  draws.forEach((draw) => (draw.numbers || []).forEach((number) => { const key = String(number).padStart(2, '0'); frequency.set(key, (frequency.get(key) || 0) + 1); }));
  const zones = [0, 0, 0, 0];
  draws.forEach((draw) => (draw.numbers || []).forEach((number) => { zones[Math.min(3, Math.floor((Number(number) - 1) / 20))] += 1; }));
  const countBy = (field) => draws.reduce((result, draw) => { const key = normalizeDrawCategory(draw[field] || '', field); result[key] = (result[key] || 0) + 1; return result; }, {});
  const sizeCounts = countBy('size'); const oddEvenCounts = countBy('oddEven');
  const superNumbers = new Map();
  draws.forEach((draw) => { const key = String(draw.superNumber || '').padStart(2, '0'); if (key !== '00') superNumbers.set(key, (superNumbers.get(key) || 0) + 1); });
  const sums = draws.map((draw) => (draw.numbers || []).reduce((total, number) => total + Number(number), 0)).filter(Number.isFinite);
  const averageSum = sums.length ? sums.reduce((total, value) => total + value, 0) / sums.length : null;
  const variance = averageSum == null ? null : sums.reduce((total, value) => total + (value - averageSum) ** 2, 0) / sums.length;
  const repeats = draws.slice(0, -1).reduce((total, draw, index) => total + (draw.numbers || []).filter((number) => new Set(draws[index + 1]?.numbers || []).has(number)).length, 0);
  const consecutive = draws.filter((draw) => { const values = (draw.numbers || []).map(Number).sort((a, b) => a - b); return values.some((value, index) => index > 0 && value === values[index - 1] + 1); }).length;
  const allNumbers = Array.from({ length: 80 }, (_, index) => String(index + 1).padStart(2, '0')).map((number) => { const lastSeen = draws.findIndex((draw) => (draw.numbers || []).map((value) => String(value).padStart(2, '0')).includes(number)); return { number, count: frequency.get(number) || 0, omission: lastSeen < 0 ? draws.length : lastSeen }; });
  const short = draws.slice(0, 10); const prior = draws.slice(10, 30); const countWindow = (window) => { const result = new Map(); window.forEach((draw) => (draw.numbers || []).forEach((number) => { const key = String(number).padStart(2, '0'); result.set(key, (result.get(key) || 0) + 1); })); return result; };
  const shortFrequency = countWindow(short); const priorFrequency = countWindow(prior);
  const trendNumbers = allNumbers.map((item) => ({ ...item, change: (shortFrequency.get(item.number) || 0) / Math.max(1, short.length) - (priorFrequency.get(item.number) || 0) / Math.max(1, prior.length) })).sort((a, b) => b.change - a.change || b.count - a.count).slice(0, 8);
  const percentage = (value, total) => total ? `${(value / total * 100).toFixed(1)}%` : '—';
  const sizeTotal = Object.values(sizeCounts).reduce((total, value) => total + value, 0); const oddEvenTotal = Object.values(oddEvenCounts).reduce((total, value) => total + value, 0);
  return {
    sampleSize: draws.length,
    hotNumbers: [...frequency.entries()].sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0])).slice(0, 10),
    zones, sizeCounts, oddEvenCounts,
    topSuper: [...superNumbers.entries()].sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0])).slice(0, 5),
    averageSum, sumMinimum: sums.length ? Math.min(...sums) : null, sumMaximum: sums.length ? Math.max(...sums) : null,
    sumStandardDeviation: variance == null ? null : Math.sqrt(variance),
    rangeAverage: draws.length ? draws.reduce((total, draw) => { const values = (draw.numbers || []).map(Number); return total + Math.max(...values) - Math.min(...values); }, 0) / draws.length : null,
    repeatAverage: draws.length > 1 ? repeats / (draws.length - 1) : null,
    consecutiveRate: draws.length ? consecutive / draws.length : null,
    omissionNumbers: allNumbers.sort((a, b) => b.omission - a.omission || a.count - b.count || Number(a.number) - Number(b.number)).slice(0, 10),
    trendNumbers,
    sizePercentages: Object.fromEntries(Object.entries(sizeCounts).map(([key, value]) => [key, percentage(value, sizeTotal)])),
    oddEvenPercentages: Object.fromEntries(Object.entries(oddEvenCounts).map(([key, value]) => [key, percentage(value, oddEvenTotal)])),
  };
}

function lowerConfidenceBound(rate, samples) {
  if (!samples) return 0;
  const z = 1.96;
  const denominator = 1 + (z * z) / samples;
  const centre = rate + (z * z) / (2 * samples);
  const margin = z * Math.sqrt((rate * (1 - rate)) / samples + (z * z) / (4 * samples * samples));
  return (centre - margin) / denominator;
}

function erf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const polynomial = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - polynomial * Math.exp(-x * x));
}

function normalCdf(value) { return 0.5 * (1 + erf(value / Math.sqrt(2))); }

// Wilson–Hilferty 近似只用於研究看板的篩查，不把 p 值當成「隨機性證明」。
function chiSquareUpperTail(statistic, degreesOfFreedom) {
  if (!Number.isFinite(statistic) || degreesOfFreedom <= 0) return null;
  const transformed = Math.pow(Math.max(0, statistic / degreesOfFreedom), 1 / 3);
  const z = (transformed - (1 - 2 / (9 * degreesOfFreedom))) / Math.sqrt(2 / (9 * degreesOfFreedom));
  return Math.max(0, Math.min(1, 1 - normalCdf(z)));
}

function binaryApproximateEntropy(bits, blockLength = 2) {
  const n = bits.length;
  if (n < blockLength + 2) return null;
  const phi = (length) => {
    const counts = new Map();
    for (let index = 0; index < n; index += 1) {
      let pattern = '';
      for (let offset = 0; offset < length; offset += 1) pattern += bits[(index + offset) % n];
      counts.set(pattern, (counts.get(pattern) || 0) + 1);
    }
    return [...counts.values()].reduce((sum, count) => {
      const probability = count / n;
      return sum + probability * Math.log(probability);
    }, 0);
  };
  const value = phi(blockLength) - phi(blockLength + 1);
  return { blockLength, value, normalized: Math.max(0, Math.min(1, value / Math.log(2))) };
}

function blockFrequencySummary(bits, blockSize = 20) {
  if (bits.length < blockSize) return { blockSize, blocks: 0, mean: null, meanAbsoluteDeviation: null, maxDeviation: null };
  const proportions = [];
  for (let start = 0; start + blockSize <= bits.length; start += blockSize) {
    const block = bits.slice(start, start + blockSize);
    proportions.push(block.reduce((sum, value) => sum + value, 0) / block.length);
  }
  const mean = proportions.reduce((sum, value) => sum + value, 0) / proportions.length;
  return {
    blockSize,
    blocks: proportions.length,
    mean,
    meanAbsoluteDeviation: proportions.reduce((sum, value) => sum + Math.abs(value - 0.5), 0) / proportions.length,
    maxDeviation: Math.max(...proportions.map((value) => Math.abs(value - 0.5))),
  };
}

function researchAudit(draws = []) {
  const valid = draws.filter((draw) => Array.isArray(draw.numbers) && draw.numbers.length === 20);
  const counts = Array(81).fill(0);
  valid.forEach((draw) => draw.numbers.forEach((number) => {
    const value = Number(number);
    if (value >= 1 && value <= 80) counts[value] += 1;
  }));
  const expected = valid.length * 20 / 80;
  const chiSquare = expected ? counts.slice(1).reduce((sum, count) => sum + ((count - expected) ** 2) / expected, 0) : null;
  const frequencyPValue = chiSquare == null ? null : chiSquareUpperTail(chiSquare, 79);
  const sums = valid.map((draw) => draw.numbers.reduce((sum, number) => sum + Number(number), 0)).reverse();
  const mean = sums.length ? sums.reduce((sum, value) => sum + value, 0) / sums.length : 0;
  const variance = sums.length > 1 ? sums.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (sums.length - 1) : 0;
  const lagPairs = sums.slice(1).map((value, index) => [sums[index], value]);
  const covariance = lagPairs.length ? lagPairs.reduce((sum, pair) => sum + (pair[0] - mean) * (pair[1] - mean), 0) / lagPairs.length : 0;
  const serialCorrelation = variance ? covariance / variance : null;
  const median = sums.length ? [...sums].sort((a, b) => a - b)[Math.floor(sums.length / 2)] : 0;
  const binary = sums.map((value) => value >= median ? 1 : 0);
  let runs = binary.length ? 1 : 0;
  for (let index = 1; index < binary.length; index += 1) if (binary[index] !== binary[index - 1]) runs += 1;
  const ones = binary.filter(Boolean).length;
  const zeros = binary.length - ones;
  const expectedRuns = binary.length && ones && zeros ? 1 + (2 * ones * zeros) / binary.length : null;
  const runVariance = binary.length && ones && zeros ? (2 * ones * zeros * (2 * ones * zeros - binary.length)) / (binary.length ** 2 * (binary.length - 1)) : null;
  const runsZ = expectedRuns != null && runVariance > 0 ? (runs - expectedRuns) / Math.sqrt(runVariance) : null;
  const runsPValue = runsZ == null ? null : Math.max(0, Math.min(1, 2 * (1 - normalCdf(Math.abs(runsZ)))));
  const pValues = [frequencyPValue, runsPValue].filter((value) => value != null);
  const adjustedPValues = pValues.map((value) => Math.min(1, value * pValues.length));
  const parityBits = valid.flatMap((draw) => draw.numbers.map((number) => Number(number) % 2));
  const blockFrequency = blockFrequencySummary(parityBits);
  const approximateEntropy = binaryApproximateEntropy(binary);
  const suspicious = adjustedPValues.some((value) => value < 0.01);
  return {
    sampleDraws: valid.length,
    numberUniverse: 80,
    numbersPerDraw: 20,
    expectedFrequencyPerNumber: expected || null,
    frequencyChiSquare: chiSquare,
    frequencyPValue,
    sumSerialCorrelation: serialCorrelation,
    runs: { observed: runs || null, expected: expectedRuns, z: runsZ, pValue: runsPValue },
    multipleTesting: { method: 'Bonferroni', tests: pValues.length, rawPValues: pValues, adjustedPValues },
    blockFrequency,
    approximateEntropy,
    verdict: valid.length < 30 ? '樣本不足，暫不判定' : suspicious ? '出現需複核的統計偏離' : '目前未見明顯偏離；不等於證明完全隨機',
    caveat: '檢驗只能辨識樣本與模型的偏離；p 值已做保守的多重檢驗校正，但仍不能證明下一期可預測，也不能單憑低 p 值指稱開獎不公。',
  };
}

function evolveProfiles(history = []) {
  // 0 是純基線；其餘只允許小幅候選，避免人工權重跳躍造成過擬合。
  const candidates = [0, 0.12, 0.24, 0.32];
  // 參數調校維持 30 期快取 walk-forward，避免同步延遲；長期 300 期評估另行執行。
  const validationWindow = Math.min(profileValidationWindow, Math.max(0, history.length - 1));
  // 所有玩法都使用同一套 walk-forward + Wilson 下限規則，不讓 4～10 星退回固定權重。
  const tunableTargets = ['size', 'oddEven', 'superNumber', ...Array.from({ length: 10 }, (_, index) => `${index + 1}星`)];
  const methods = ['梅花易數', '六爻八卦', '河圖洛書', '數字卦（楚簡研究版）', '奇門遁甲（九宮研究版）', '太乙九宮（研究版）', '生肖五行研究版', '民俗統計基線', '貝葉斯平滑基線', '超幾何集合基線', '多窗口穩定性基線'];
  if (history.length < minimumValidationSamples + 1) {
    return Object.fromEntries(methods.map((method) => [method, { targets: Object.fromEntries(tunableTargets.map((target) => [target, { empiricalWeight: 0, validationSamples: validationWindow, score: null, baselineRate: null, eligible: false, status: `樣本不足（至少需要 ${minimumValidationSamples} 期），不納入聚合權重` }])) }]));
  }
  // 批次化 walk-forward：每個方法／權重／折只建一次模型，並由外層快取避免同一歷史重複計算。
  const scores = Object.fromEntries(methods.map((method) => [method, Object.fromEntries(tunableTargets.map((target) => [target, []]))]));
  methods.forEach((method) => candidates.forEach((empiricalWeight) => {
    const profileTargets = Object.fromEntries(tunableTargets.map((target) => [target, { empiricalWeight }]));
    history.slice(0, validationWindow).forEach((actual, index) => {
      const training = history.slice(index + 1);
      const predicted = buildModels(actual, training, { evolve: false, onlyMethod: method, profiles: { [method]: { targets: profileTargets } } }).find((item) => item.name === method);
      if (!predicted) return;
      tunableTargets.forEach((target) => {
        const prediction = target === 'size' ? predicted.official.size : target === 'oddEven' ? predicted.official.oddEven : target === 'superNumber' ? predicted.official.superNumber : predicted.official.basic[target] || [];
        const bucket = scores[method][target].find((item) => item.empiricalWeight === empiricalWeight) || { empiricalWeight, wins: 0, trials: 0, payout: 0, profit: 0, baselineSum: 0, baselineTrials: 0 };
        bucket.wins += hasPositiveProfit(target, prediction, actual) ? 1 : 0;
        bucket.trials += 1;
        const payout = backtestPayout(target, prediction, actual);
        bucket.payout += payout;
        bucket.profit += payout - betCostForTarget(target);
        const baselineRate = positiveProfitBaseline(target, training);
        if (baselineRate != null) {
          bucket.baselineSum += baselineRate;
          bucket.baselineTrials += 1;
        }
        if (!scores[method][target].includes(bucket)) scores[method][target].push(bucket);
      });
    });
  }));
  return Object.fromEntries(methods.map((method) => [method, { targets: Object.fromEntries(tunableTargets.map((target) => {
    const results = scores[method][target].map((item) => {
      const rate = item.trials ? item.wins / item.trials : 0;
      const baselineRate = item.baselineTrials ? item.baselineSum / item.baselineTrials : null;
      const targetCost = betCostForTarget(target);
      const cost = item.trials * targetCost;
      const roi = cost ? item.profit / cost : null;
      const baselineNetPerBet = theoreticalNetPerBet(target);
      const baselineRoi = baselineNetPerBet / targetCost;
      return { ...item, score: rate, estimatedRate: item.trials ? (item.wins + 2) / (item.trials + 4) : 0, confidence: lowerConfidenceBound(rate, item.trials), baselineRate, baselineNetPerBet, baselineRoi, averageProfit: item.trials ? item.profit / item.trials : null, roi, validationSamples: item.trials };
    });
    const best = results.sort((a, b) => (b.roi ?? -Infinity) - (a.roi ?? -Infinity) || b.confidence - a.confidence || Math.abs(a.empiricalWeight - 0.32) - Math.abs(b.empiricalWeight - 0.32))[0] || { empiricalWeight: 0, wins: 0, trials: 0, score: null, baselineRate: null, estimatedRate: 0, confidence: 0, roi: null, baselineRoi: null, validationSamples: 0 };
    const eligible = best.roi != null && best.baselineRoi != null && best.roi > best.baselineRoi && best.profit > 0 && best.confidence > (best.baselineRate ?? 0);
    const evidenceShrink = eligible ? clamp((best.validationSamples - 10) / 30, 0.25, 1) : 0;
    const effectiveWeight = eligible ? Number((best.empiricalWeight * evidenceShrink).toFixed(4)) : 0;
    return [target, { ...best, empiricalWeight: effectiveWeight, selectedWeight: best.empiricalWeight, evidenceShrink, eligible, status: eligible ? `walk-forward ${validationWindow} 期／ROI ${(best.roi * 100).toFixed(1)}%，證據收縮 ${(evidenceShrink * 100).toFixed(0)}%，納入有限權重` : `walk-forward ${validationWindow} 期／淨利／ROI 未可靠超過理論基線，不納入權重` }];
  })) }]));
}

function profileCacheKey(history = []) {
  return createHash('sha1').update(JSON.stringify(history.slice(0, maxModelHistory).map((item) => ({ period: item.period, numbers: item.numbers, superNumber: item.superNumber, size: item.size, oddEven: item.oddEven })))).digest('hex');
}

function evolveProfilesCached(history = []) {
  const key = profileCacheKey(history);
  const cached = profileCache.get(key);
  if (cached && Date.now() - cached.createdAt < profileCacheTtlMs) return cached.profiles;
  const profiles = evolveProfiles(history);
  profileCache.set(key, { createdAt: Date.now(), profiles });
  while (profileCache.size > 3) profileCache.delete(profileCache.keys().next().value);
  return profiles;
}

function castingFor(kind, snapshot, target, castingAt) {
  if (kind === 'meihua') return meihuaCasting(snapshot, target, castingAt);
  if (kind === 'sixyao') return sixyaoCasting(snapshot, target, castingAt);
  if (kind === 'luoshu') return luoshuCasting(snapshot, target);
  if (kind === 'numeral-gua') return numeralGuaCasting(snapshot, target);
  if (kind === 'qimen') return qimenCasting(snapshot, target);
  if (kind === 'statistics') return statisticalCasting(snapshot, target);
  if (kind === 'bayesian') return statisticalCasting(snapshot, target);
  if (kind === 'hypergeometric') return statisticalCasting(snapshot, target);
  if (kind === 'multiscale') return statisticalCasting(snapshot, target);
  if (kind === 'bazi') return zodiacElementCasting(snapshot, target);
  return taiyiCasting(snapshot, target);
}

function traditionFor(kind, casting) {
  if (kind === 'meihua') return { kind, upper: casting.upper, lower: casting.lower, moving: casting.moving };
  if (kind === 'sixyao') return { kind, bits: casting.binary, moving: casting.lines.filter((line) => line.moving).length, lower: 1 };
  if (kind === 'luoshu') return { kind, center: casting.center };
  if (kind === 'numeral-gua') return { kind, digits: casting.digits };
  if (kind === 'statistics') return { kind, window: casting.window };
  if (kind === 'bayesian') return { kind, window: casting.window };
  if (kind === 'hypergeometric') return { kind, window: casting.window };
  if (kind === 'multiscale') return { kind, window: casting.window };
  if (kind === 'bazi') return { kind, element: casting.element, branch: casting.branch };
  return { kind, palace: casting.palace, star: casting.star, door: casting.door, cycle: casting.cycle };
}

function targetTraditionalCategory(casting, target, seed) {
  const values = [casting.upper, casting.lower, casting.moving, casting.palace, casting.center, casting.digits?.[0], casting.cycle].filter(Number.isFinite);
  const value = values.reduce((sum, item) => sum + item, 0) || seed;
  if (target === 'size') return value % 2 === 0 ? '大' : '小';
  return (value + (casting.moving || 0)) % 2 === 0 ? '雙' : '單';
}

function targetRule(target) {
  if (target === 'size') return '二分類適配：以共同卦數與動爻映射大／小，再與歷史大小比例融合；不是把大小當號碼集合。';
  if (target === 'oddEven') return '二分類適配：以共同卦數與動爻映射單／雙，再與歷史單雙比例融合；和局保留為未知／不偏。';
  if (target === 'superNumber') return '單號適配：以卦數、動爻與位置特徵排序 1 個候選，另以歷史超級號碼作獨立權重。';
  const count = Number(String(target).replace('星', ''));
  return `${count} 星適配：共同卦象只提供排序特徵，依固定區段、位置與歷史頻率排序，取 ${count} 個候選；不宣稱卦象直接推出號碼。`;
}

function summarizePick(numbers) {
  const parsed = numbers.map(Number).filter(Number.isFinite);
  if (!parsed.length) return { sumBand: '—', oddEvenCount: '—', highLowCount: '—', zones: [] };
  const sum = parsed.reduce((total, number) => total + number, 0);
  const odd = parsed.filter((number) => number % 2 === 1).length;
  const high = parsed.filter((number) => number >= 41).length;
  const zones = [...new Set(parsed.map((number) => `${Math.floor((number - 1) / 20) * 20 + 1}-${Math.floor((number - 1) / 20) * 20 + 20}`))];
  return {
    sumBand: sum / parsed.length < 27 ? '低區' : sum / parsed.length > 54 ? '高區' : '中區',
    oddEvenCount: odd > parsed.length / 2 ? '單數偏多' : odd < parsed.length / 2 ? '雙數偏多' : '均衡',
    highLowCount: high > parsed.length / 2 ? '大號偏多' : high < parsed.length / 2 ? '小號偏多' : '均衡',
    zones,
  };
}

function featureVectorFromPrior(prior = []) {
  const summarize = (windowSize) => {
    const window = prior.slice(0, Math.min(windowSize, prior.length));
    if (!window.length) return [0.5, 0.5, 0.5];
    const big = window.reduce((sum, draw) => sum + draw.numbers.filter((number) => Number(number) >= 41).length / 20, 0) / window.length;
    const odd = window.reduce((sum, draw) => sum + draw.numbers.filter((number) => Number(number) % 2 === 1).length / 20, 0) / window.length;
    const total = window.reduce((sum, draw) => sum + draw.numbers.reduce((inner, number) => inner + Number(number), 0) / 1600, 0) / window.length;
    return [big, odd, total];
  };
  const recent = summarize(12);
  const medium = summarize(60);
  return [...recent, ...medium, prior[0] ? Number(prior[0].numbers.filter((number) => Number(number) >= 41).length) / 20 : 0.5, prior[0] ? Number(prior[0].numbers.filter((number) => Number(number) % 2 === 1).length) / 20 : 0.5];
}

function trainLogistic(samples, labels, iterations = 80, learningRate = 0.08, l2 = 0.35) {
  if (!samples.length || samples.length !== labels.length) return { weights: [], bias: 0 };
  const weights = Array(samples[0].length).fill(0);
  let bias = 0;
  const sigmoid = (value) => 1 / (1 + Math.exp(-clamp(value, -30, 30)));
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const gradients = Array(weights.length).fill(0);
    let biasGradient = 0;
    samples.forEach((sample, index) => {
      const probability = sigmoid(bias + sample.reduce((sum, value, featureIndex) => sum + value * weights[featureIndex], 0));
      const error = probability - labels[index];
      biasGradient += error;
      sample.forEach((value, featureIndex) => { gradients[featureIndex] += error * value; });
    });
    const scale = 1 / samples.length;
    weights.forEach((_, featureIndex) => { weights[featureIndex] -= learningRate * (gradients[featureIndex] * scale + l2 * weights[featureIndex]); });
    bias -= learningRate * biasGradient * scale;
  }
  return { weights, bias };
}

function logisticProbability(model, sample) {
  if (!model.weights.length) return 0.5;
  return 1 / (1 + Math.exp(-clamp(model.bias + sample.reduce((sum, value, index) => sum + value * model.weights[index], 0), -30, 30)));
}

function buildMlNegativeControl(snapshot, history, castingAt, options = {}) {
  const includeNumbers = options.includeNumbers !== false;
  const samples = []; const sizeLabels = []; const oddEvenLabels = [];
  const trainingLimit = Math.min(48, Math.max(0, history.length - 1));
  for (let index = 0; index < trainingLimit; index += 1) {
    const actual = history[index];
    const prior = history.slice(index + 1, index + 61);
    const size = normalizeDrawCategory(actual.size, 'size');
    const oddEven = normalizeDrawCategory(actual.oddEven, 'oddEven');
    if (!prior.length || !['大', '小'].includes(size) || !['單', '雙'].includes(oddEven)) continue;
    samples.push(featureVectorFromPrior(prior));
    sizeLabels.push(size === '大' ? 1 : 0);
    oddEvenLabels.push(oddEven === '單' ? 1 : 0);
  }
  const currentFeatures = featureVectorFromPrior(history);
  const sizeModel = trainLogistic(samples, sizeLabels);
  const oddEvenModel = trainLogistic(samples, oddEvenLabels);
  const sizeProbability = logisticProbability(sizeModel, currentFeatures);
  const oddEvenProbability = logisticProbability(oddEvenModel, currentFeatures);
  const scores = includeNumbers ? Array.from({ length: 80 }, (_, index) => {
    const number = index + 1;
    const numberSamples = []; const numberLabels = [];
    for (let sampleIndex = 0; sampleIndex < trainingLimit; sampleIndex += 1) {
      const prior = history.slice(sampleIndex + 1, sampleIndex + 61);
      if (!prior.length) continue;
      numberSamples.push(featureVectorFromPrior(prior));
      numberLabels.push(history[sampleIndex].numbers.some((value) => Number(value) === number) ? 1 : 0);
    }
    return { number, score: logisticProbability(trainLogistic(numberSamples, numberLabels, 40, 0.06, 0.5), currentFeatures) };
  }).sort((a, b) => b.score - a.score || a.number - b.number) : [];
  const picks = (count) => scores.slice(0, count).sort((a, b) => a.number - b.number).map((item) => String(item.number).padStart(2, '0'));
  const basic = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`${index + 1}星`, picks(index + 1)]));
  const superNumber = picks(1)[0] || '';
  return {
    name: '機器學習負對照',
    status: '正則化 Logistic 特徵模型；只作負對照，不納入多模型聚合',
    rule: '以近 12／60 期大小、單雙、和值窗口特徵訓練簡單 Logistic；每個號碼使用獨立包含率模型，禁止使用目標期資料。',
    sources: modelSources['機器學習負對照'] || [],
    calculation: {
      algorithmVersion: algorithmVersion(), method: 'logistic-negative-control', evidenceTier: '可重現機器學習負對照', predictionEligible: false,
      castingSource: 'prequential-history-only', castingAt, historySamples: history.length,
      featureNames: ['近12期大號率', '近12期單數率', '近12期和值率', '近60期大號率', '近60期單數率', '近60期和值率', '最新大號率', '最新單數率'],
      probabilities: { size: sizeProbability, oddEven: oddEvenProbability },
      trainingSamples: samples.length, regularization: 0.35,
    },
    official: { size: sizeProbability >= 0.5 ? '大' : '小', oddEven: oddEvenProbability >= 0.5 ? '單' : '雙', superNumber, basic },
    research: { numberPicks: basic['10星'], numberPicks20: scores.slice(0, 20).sort((a, b) => a.number - b.number).map((item) => String(item.number).padStart(2, '0')), sumBand: '由模型候選另行統計', oddEvenCount: '由模型候選另行統計', highLowCount: '由模型候選另行統計', zones: ['機器學習負對照'], targetResearch: {} },
  };
}

function aggregateModel(models, history) {
  const eligibleModels = models.filter((model) => model.calculation?.predictionEligible !== false);
  const hasValidatedWeight = eligibleModels.some((model) => predictionTargets.some((target) => {
    const evolution = model.calculation?.evolution?.[target];
    return evolution?.eligible === true && Number(evolution?.empiricalWeight) > 0;
  }));
  const weightFor = (model, target) => {
    const evolution = model.calculation?.evolution?.[target];
    const score = evolution?.score;
    const baselineRate = evolution?.baselineRate;
    const confidence = evolution?.confidence;
    const roi = evolution?.roi;
    const baselineRoi = evolution?.baselineRoi;
    // 沒有任何模型通過驗證時，只保留超幾何模型作透明 fallback；不把文化規則硬湊成共識。
    if (!hasValidatedWeight && model.calculation?.method === 'hypergeometric') return 1;
    if (evolution?.eligible !== true || score == null || baselineRate == null || confidence == null || roi == null || baselineRoi == null || roi <= baselineRoi || confidence <= baselineRate) return 0;
    // 聚合權重以 ROI 超額為主，再用命中率信賴下限與樣本量收縮，避免短樣本高派彩偶然主導共識。
    const roiUplift = Math.max(0, Math.min(1, roi - baselineRoi));
    const confidenceUplift = Math.max(0, Math.min(1, confidence - baselineRate));
    const samples = evolution?.trials || evolution?.validationSamples || 0;
    const sampleFactor = clamp(samples / profileValidationWindow, 0.25, 1);
    return roiUplift * confidenceUplift * sampleFactor;
  };
  const weightedCategory = (target) => {
    const totals = new Map();
    const field = target === 'size' ? 'size' : 'oddEven';
    eligibleModels.forEach((model) => {
      // 「和」只代表開獎後未達投注門檻，禁止進入預測投票。
      const value = validPredictionCategory(model.official?.[field], field);
      const weight = weightFor(model, target);
      if (value && weight > 0) totals.set(value, (totals.get(value) || 0) + weight);
    });
    return [...totals.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0] || '';
  };
  const weightedNumbers = (target) => {
    const size = Number(String(target).replace('星', ''));
    const totals = new Map();
    eligibleModels.forEach((model) => {
      const weight = weightFor(model, target);
      if (weight <= 0) return;
      (model.official.basic[target] || []).forEach((number) => totals.set(number, (totals.get(number) || 0) + weight));
    });
    return [...totals.entries()].sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0])).slice(0, size).map(([number]) => number);
  };
  const superVotes = new Map();
  eligibleModels.forEach((model) => {
    const number = model.official.superNumber;
    const weight = weightFor(model, 'superNumber');
    if (number && weight > 0) superVotes.set(number, (superVotes.get(number) || 0) + weight);
  });
  const superNumber = [...superVotes.entries()].sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))[0]?.[0] || '';
  const basic = Object.fromEntries(Array.from({ length: 10 }, (_, index) => {
    const target = `${index + 1}星`;
    return [target, weightedNumbers(target)];
  }));
  const zonePredictions = NUMBER_ZONES.map((zone) => {
    const totals = new Map();
    eligibleModels.forEach((model) => {
      const weight = weightFor(model, '10星');
      const zoneResult = model.research?.zonePredictions?.find((item) => item.key === zone.key);
      if (weight <= 0 || !zoneResult) return;
      (zoneResult.numbers || []).forEach((number) => totals.set(number, (totals.get(number) || 0) + weight));
    });
    return { ...zone, numbers: [...totals.entries()].sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0])).slice(0, 5).map(([number]) => number) };
  });
  const weightedModelCount = eligibleModels.filter((model) => predictionTargets.some((target) => weightFor(model, target) > 0)).length;
  return {
    name: '多模型聚合',
    status: '依各模型 walk-forward 表現加權的共識模型',
    rule: '多模型聚合；依各模型歷史回測表現加權投票，不保證提升下一期命中。',
    sources: [],
    calculation: {
      algorithmVersion: algorithmVersion(),
      method: 'ensemble',
      castingSource: 'weighted-model-consensus',
      castingAt: models[0]?.calculation?.castingAt || '',
      historySamples: history.length,
      aggregation: '只有 walk-forward 勝率嚴格高於同玩法隨機基線的模型才有權重；其餘模型權重為 0',
      weightedModelCount,
      commonCasting: '多模型聚合不另起卦；它整合各子模型在同一固定輸入下的結果。',
      commonCastingValue: '多模型加權整合',
      targetRules: Object.fromEntries(predictionTargets.map((target) => [target, '依各子模型同一玩法的回測權重加權投票，不產生獨立卦象。'])),
    },
    official: { size: weightedCategory('size'), oddEven: weightedCategory('oddEven'), superNumber, basic },
    research: {
      numberPicks: basic['10星'] || [],
      sumBand: '由共識號碼另行統計',
      oddEvenCount: '由共識號碼另行統計',
      highLowCount: '由共識號碼另行統計',
      zones: zonePredictions.map((zone) => zone.label),
      zonePredictions,
    },
  };
}

export function buildModels(snapshot, history = [], options = {}) {
  const profiles = options.profiles || (options.evolve === false ? {} : evolveProfilesCached(history));
  const castingAt = reproducibleCastingAt(options.castingAt || snapshot.castingAt || snapshot.drawAt, snapshot.period);
  const methods = [
    { name: '梅花易數', kind: 'meihua', status: '經典時間起卦公式＋各目標獨立研究排序', seedOffset: 11 },
    { name: '六爻八卦', kind: 'sixyao', status: '正統大衍筮法結構＋數位蓍草適配', seedOffset: 37 },
    { name: '河圖洛書', kind: 'luoshu', status: '洛書九宮核心＋目標玩法適配', seedOffset: 61 },
    { name: '數字卦（楚簡研究版）', kind: 'numeral-gua', status: '文獻數字結構＋目標玩法研究適配，非完整復原', seedOffset: 73 },
    { name: '奇門遁甲（九宮研究版）', kind: 'qimen', status: '九宮／九星／八門核心＋目標玩法適配，非完整排局', seedOffset: 89 },
    { name: '太乙九宮（研究版）', kind: 'taiyi', status: '行九宮核心＋目標玩法適配，非完整太乙排局', seedOffset: 97 },
    { name: '民俗統計基線', kind: 'statistics', status: '熱度／遺漏／和值／奇偶／區間統計基線，非因果預測', seedOffset: 113 },
    { name: '生肖五行研究版', kind: 'bazi', status: '農曆年干支／五行固定映射＋統計適配，非完整八字排盤', seedOffset: 127 },
    { name: '貝葉斯平滑基線', kind: 'bayesian', status: 'Beta／Dirichlet 平滑頻率基線；可重算但不主張改變隨機機率', seedOffset: 149 },
    { name: '超幾何集合基線', kind: 'hypergeometric', status: '80 選 20 不放回抽樣；用集合包含率與精確抽樣假設做基線', seedOffset: 163 },
    { name: '多窗口穩定性基線', kind: 'multiscale', status: '近 12／60／300 期多時間窗；對短期訊號施加穩定性懲罰', seedOffset: 179 },
    { name: '排除濾網基線', kind: 'exclusion', status: 'walk-forward 排除驗證；只啟用樣本外顯著低於 25% 基準的濾網', seedOffset: 191 },
  ].filter((method) => !options.onlyMethod || method.name === options.onlyMethod);
  const baseModels = methods.map((method) => {
    const profilesForMethod = profiles[method.name] || {};
    const weights = Object.fromEntries(predictionTargets.map((target) => [target, targetProfile(profiles, method.name, target).empiricalWeight ?? 0.32]));
    // 起卦只做一次。玩法／星級是下游適配器，不再重複製造看似不同的起卦結果。
    const commonCasting = castingFor(method.kind, snapshot, '10星', castingAt);
    const targetCastings = Object.fromEntries(predictionTargets.map((target) => [target, commonCasting]));
    const picksByTarget = Object.fromEntries(predictionTargets.filter((target) => target !== 'size' && target !== 'oddEven').map((target) => {
      const casting = targetCastings[target];
      const seed = `${castingAt}|${snapshot.period}|${method.kind}|${target}|${method.seedOffset}`;
      const targetCount = target === 'superNumber' ? 1 : Number(String(target).replace('星', '')) || 10;
      return [target, method.kind === 'exclusion'
        ? exclusionPrediction(seed, targetCount, history, target).numbers
        : scoreNumbers(seed, targetCount, traditionFor(method.kind, casting), history, weights[target], target)];
    }));
    const exclusionDetails = method.kind === 'exclusion' ? exclusionPrediction(`${castingAt}|${snapshot.period}`, 10, history, '10星') : null;
    const picks = picksByTarget['10星'] || (exclusionDetails?.numbers || scoreNumbers(`${castingAt}|${snapshot.period}|${method.kind}|10星`, 10, traditionFor(method.kind, targetCastings['10星']), history, weights['10星'], '10星'));
    const zonePredictions = zonePredictionSet(`${castingAt}|${snapshot.period}|${method.kind}|10星|${method.seedOffset}`, traditionFor(method.kind, commonCasting), history, weights['10星']);
    const modelSeed = playIndex('10星') + method.seedOffset;
    const pickSummary = summarizePick(picks);
    const { sumBand, oddEvenCount, highLowCount } = pickSummary;
    const targetResearch = Object.fromEntries(predictionTargets.map((target) => {
      const targetPicks = picksByTarget[target] || [];
      const targetSummary = summarizePick(targetPicks);
      return [target, {
        numberPicks: targetPicks,
        sumBand: targetSummary.sumBand,
        oddEvenCount: targetSummary.oddEvenCount,
        highLowCount: targetSummary.highLowCount,
        zones: targetSummary.zones,
      }];
    }));
    return {
      name: method.name,
      status: method.status,
      rule: `${method.status}；歷史資料只允許用於目標期以前的排序與回測，不宣稱因果預測`,
      sources: modelSources[method.name] || [],
      calculation: { algorithmVersion: algorithmVersion(), method: method.kind, evidenceTier: ['bayesian', 'statistics', 'hypergeometric', 'multiscale', 'exclusion'].includes(method.kind) ? '可檢驗統計基線' : '文化／文本特徵適配，非已證實預測法', predictionEligible: true, castingSource: 'prediction-time-common', castingAt, historySamples: history.length, empiricalWeight: history.length ? weights['10星'] : 0, empiricalWeights: weights, evolution: profilesForMethod.targets || null, exclusionFilters: exclusionDetails, commonCasting: commonCasting.formula, commonCastingValue: method.kind === 'meihua' ? `上卦${commonCasting.upper}／下卦${commonCasting.lower}／動爻${commonCasting.moving}` : method.kind === 'sixyao' ? commonCasting.lines.map((line) => line.value).join('、') : method.kind === 'qimen' ? `九宮${commonCasting.palace}／九星${commonCasting.star}／八門${commonCasting.door}` : method.kind === 'taiyi' ? `行宮${commonCasting.palace}／循環${commonCasting.cycle}` : method.kind === 'luoshu' ? `宮位${commonCasting.palace}／數${commonCasting.center}` : method.kind === 'statistics' ? '統計基線：熱度／遺漏／和值／奇偶／區間' : method.kind === 'bayesian' ? 'Beta／Dirichlet 平滑：避免零頻率與過度追逐短期波動' : method.kind === 'hypergeometric' ? '超幾何集合：每期 80 選 20、不放回，不把號碼誤當獨立抽樣' : method.kind === 'multiscale' ? '多窗口頻率：12／60／300 期加權，偏離穩定性時降權' : method.kind === 'exclusion' ? '排除濾網：逐濾網 walk-forward 驗證，低於 25% 基準且樣本足夠才啟用' : commonCasting.digits.join('、'), targetRules: Object.fromEntries(predictionTargets.map((target) => [target, targetRule(target)])), targetCastings: Object.fromEntries(predictionTargets.map((target) => [target, targetCastings[target].formula])), targetCastingValues: Object.fromEntries(predictionTargets.map((target) => {
        const casting = targetCastings[target];
        if (method.kind === 'sixyao') return [target, casting.lines.map((line) => line.value).join('、')];
        if (method.kind === 'meihua') return [target, `共同卦象：上卦${casting.upper}／下卦${casting.lower}／動爻${casting.moving}`];
        if (method.kind === 'qimen') return [target, `九宮${casting.palace}／九星${casting.star}／八門${casting.door}`];
        if (method.kind === 'taiyi') return [target, `行宮${casting.palace}／循環${casting.cycle}`];
        if (method.kind === 'statistics') return [target, '固定統計窗口 60 期／目標期前資料'];
        if (method.kind === 'bayesian') return [target, 'Beta／Dirichlet 平滑窗口 60 期／目標期前資料'];
        if (method.kind === 'hypergeometric') return [target, '80 選 20 不放回集合包含率／目標期前資料'];
        if (method.kind === 'multiscale') return [target, '12／60／300 期頻率與跨窗口穩定性／目標期前資料'];
        if (method.kind === 'bazi') return [target, `年元素${casting.element}／生肖支序${casting.branch + 1}`];
        if (method.kind === 'luoshu') return [target, `宮位${casting.palace}／數${casting.center}`];
        return [target, casting.digits.join('、')];
      })) },
      official: {
        size: validPredictionCategory(categoryPrediction(modelSeed, targetTraditionalCategory(targetCastings.size, 'size', modelSeed), history, 'size', weights.size), 'size'),
        oddEven: validPredictionCategory(categoryPrediction(modelSeed, targetTraditionalCategory(targetCastings.oddEven, 'oddEven', modelSeed), history, 'oddEven', weights.oddEven), 'oddEven'),
        superNumber: (picksByTarget.superNumber || picks)[modelSeed % (picksByTarget.superNumber || picks).length],
        basic: Object.fromEntries(Array.from({ length: 10 }, (_, index) => {
          const target = `${index + 1}星`;
          const targetPicks = picksByTarget[target] || picks;
          return [target, targetPicks.slice(0, index + 1)];
        })),
      },
      research: {
        numberPicks: picks,
        numberPicks20: scoreNumbers(`${castingAt}|${snapshot.period}|${method.kind}|20號研究母體|${method.seedOffset}`, 20, traditionFor(method.kind, commonCasting), history, weights['10星'], '10星'),
        sumBand,
        oddEvenCount,
        highLowCount,
        zones: zonePredictions.map((zone) => zone.label),
        zonePredictions,
        targetResearch,
      },
    };
  });
  const negativeControl = options.onlyMethod && options.onlyMethod !== '機器學習負對照'
    ? []
    : [buildMlNegativeControl(snapshot, history, castingAt)];
  const allModels = [...baseModels, ...negativeControl];
  return [...allModels, aggregateModel(allModels, history)];
}

let modelWorker;
let modelRequestId = 0;
const pendingModelRequests = new Map();

function ensureModelWorker() {
  if (modelWorker) return modelWorker;
  modelWorker = new Worker(new URL('./model-worker.mjs', import.meta.url));
  modelWorker.on('message', (message) => {
    const pending = pendingModelRequests.get(message?.requestId);
    if (!pending) return;
    pendingModelRequests.delete(message.requestId);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.models || []);
  });
  const failPending = (error) => {
    for (const pending of pendingModelRequests.values()) pending.reject(error);
    pendingModelRequests.clear();
    modelWorker = undefined;
  };
  modelWorker.on('error', (error) => failPending(error));
  modelWorker.on('exit', (code) => {
    if (code !== 0) failPending(new Error(`模型 Worker 結束碼 ${code}`));
    else modelWorker = undefined;
  });
  return modelWorker;
}

function buildModelsInWorker(snapshot, history = [], options = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++modelRequestId;
    pendingModelRequests.set(requestId, { resolve, reject });
    ensureModelWorker().postMessage({ requestId, snapshot, history, options });
  });
}

async function fetchOfficial(daysOverride = null) {
  const requestedDays = daysOverride ?? Number(process.env.HISTORY_DAYS || defaultHistoryDays);
  const historyDays = daysOverride != null
    ? Math.min(retentionDays, Math.max(1, daysOverride))
    : Math.min(retentionDays, Math.max(10, Number.isFinite(requestedDays) ? requestedDays : defaultHistoryDays));
  const openDates = Array.from({ length: historyDays }, (_, index) => taipeiDateKey(index));
  const dailyResults = await Promise.all(openDates.map(async (openDate) => {
    try {
      const response = await fetchWithTimeout(`${apiBaseUrl}?openDate=${openDate}&pageNum=1&pageSize=500`, { headers: { accept: 'application/json', origin: 'https://www.taiwanlottery.com' } });
      if (!response.ok) return [];
      const payload = await response.json();
      return (payload?.content?.bingoQueryResult || []).filter((record) => record?.drawTerm && Array.isArray(record.openShowOrder) && record.openShowOrder.length === 20).map((record) => ({ record, openDate }));
    } catch {
      return [];
    }
  }));
  const records = dailyResults.flat().sort((a, b) => Number(b.record.drawTerm) - Number(a.record.drawTerm));
  if (!records.length) throw new Error('官方 API 未回傳指定期間的完整開獎資料');
  const firstPeriodByDate = new Map();
  for (const item of records) {
    const period = Number(item.record.drawTerm);
    const current = firstPeriodByDate.get(item.openDate);
    if (Number.isFinite(period) && (!Number.isFinite(current) || period < current)) firstPeriodByDate.set(item.openDate, period);
  }
  const parseItem = ({ record, openDate }) => {
    const drawAt = officialDrawDateTime(openDate, record.drawTerm, firstPeriodByDate.get(openDate)) || openDate;
    const snapshot = deriveSnapshot(record.drawTerm, record.openShowOrder, apiBaseUrl, drawAt);
    snapshot.sourceLabel = '台灣彩券官方 API';
    snapshot.superNumber = String(record.bullEyeTop || '').padStart(2, '0');
    return snapshot;
  };
  const history = records.map(parseItem);
  return { snapshot: history[0], history, historyDays };
}

function parseMirrorPage(html, sourceName) {
  const text = cleanHtml(html);
  const periodMatch = text.match(/(?:期別|期數)\s*[:：]?\s*(\d{7,9})/);
  if (!periodMatch) throw new Error('未找到期別');
  const start = periodMatch.index + periodMatch[0].length;
  const tail = text.slice(start, start + 1200);
  const values = [...tail.matchAll(/(?:^|[^0-9])(\d{1,2})(?=[^0-9]|$)/g)].map((match) => Number(match[1])).filter((number) => number >= 1 && number <= 80);
  const numbers = [];
  for (const number of values) { if (!numbers.includes(number)) numbers.push(number); if (numbers.length === 20) break; }
  const snapshot = deriveSnapshot(periodMatch[1], numbers, sourceName);
  const superNumber = tail.match(/超級獎號\s*[:：]?\s*(\d{1,2})/)?.[1];
  const size = tail.match(/(?:猜)?大小\s*[:：]?\s*([大小和])/)?.[1];
  const oddEvenRaw = tail.match(/(?:猜)?單雙\s*[:：]?\s*([單雙和－-])/)?.[1];
  return {
    ...snapshot,
    superNumber: superNumber ? superNumber.padStart(2, '0') : snapshot.superNumber,
    size: normalizeDrawCategory(size || snapshot.size, 'size'),
    oddEven: normalizeDrawCategory(oddEvenRaw || snapshot.oddEven, 'oddEven'),
  };
}

async function fetchMirror(source) {
  const url = source.parser === 'winwin' ? `${source.url}/GetBingoData?date=${taipeiDateKey(0)}` : source.url;
  const response = await fetchWithTimeout(url, { headers: { accept: source.parser === 'winwin' ? 'application/json' : 'text/html', 'user-agent': 'bingo-research-api/1.0' } });
  if (!response.ok) throw new Error(`${source.name} HTTP ${response.status}`);
  if (source.parser === 'winwin') return parseWinwinData(await response.json(), source.name);
  const html = await response.text();
  if (source.parser === 'officialPage') return parseOfficialPage(html);
  if (source.parser === '168win') return parse168WinPage(html, source.name);
  if (source.parser === 'timetable') return parseTimetablePage(html, source.name);
  return parseMirrorPage(html, source.name);
}

function nextPredictionPeriod(period) {
  const numeric = Number(period);
  return Number.isFinite(numeric) ? String(numeric + 1) : `${period}-next`;
}

function selectRecentHistory(history, days = retentionDays) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const recent = history.filter((item) => {
    const parsed = parseTaipeiDate(item.drawAt);
    return Number.isFinite(parsed.getTime()) && parsed.getTime() >= cutoff;
  });
  return recent.length ? recent : history.slice(0, fastResponseHistoryLimit);
}

function hasRetentionCoverage(history, days = retentionDays) {
  if (!history.length) return false;
  const oldest = history[history.length - 1];
  const parsed = parseTaipeiDate(oldest.drawAt);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return Number.isFinite(parsed.getTime()) && parsed.getTime() <= cutoff + 24 * 60 * 60 * 1000;
}

function compactHistoryForResponse(history) {
  return history.map((item, index) => {
    if (index === 0) return item;
    const { models, ...compact } = item;
    return compact;
  });
}

function requestedCastingTime(value) {
  const parsed = new Date(String(value || ''));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '';
}

async function latest(daysOverride = null, existingHistory = [], requestedCastingAt = '', options = {}) {
  const health = [];
  const apiSource = { name: '台灣彩券官方 API', authority: 'official', initialRank: 1000 };
  const attempts = [{ ...apiSource, run: () => fetchOfficial(daysOverride) }, ...fallbackSources
    .slice()
    .sort((a, b) => sourceRankingScore(b, existingHistory[0]?.period) - sourceRankingScore(a, existingHistory[0]?.period))
    .map((source) => ({ ...source, run: () => fetchMirror(source) }))];
  for (const attempt of attempts) {
    const startedAt = Date.now();
    try {
      const result = await attempt.run();
      const snapshot = result.snapshot || result;
      const latencyMs = Date.now() - startedAt;
      const stat = updateSourceStat(attempt.name, true, latencyMs, snapshot.period);
      health.push({ name: attempt.name, ok: true, latencyMs, records: (result.history || [snapshot]).length, latestPeriod: snapshot.period, stability: stat.success / (stat.success + stat.failure) });
      const syncedAt = Date.now();
      const fetchedHistory = normalizeSourceDrawTimes(result.history || [snapshot]);
      const historyByPeriod = new Map(existingHistory.map((item) => [String(item.period), item]));
      fetchedHistory.forEach((item) => {
        const previous = historyByPeriod.get(String(item.period));
        historyByPeriod.set(String(item.period), previous
          ? { ...previous, ...item, superNumber: item.superNumber || previous.superNumber, size: item.size || previous.size, oddEven: item.oddEven || previous.oddEven }
          : item);
      });
      const allHistory = normalizeSourceDrawTimes(
        [...historyByPeriod.values()].sort((a, b) => Number(b.period) - Number(a.period)),
      );
      // 同步與模型只處理最近 31 日；更早資料已存在資料庫，不必每次重新計算。
      const rawHistory = selectRecentHistory(allHistory, retentionDays);
      const nextPeriod = nextPredictionPeriod(rawHistory[0]?.period || snapshot.period);
      // 歷史模型的起卦輸入以實際開獎時間為準；舊資料若曾保存錯誤 castingAt，不再優先採用。
      const previousCastingAt = reproducibleCastingAt(rawHistory[0]?.drawAt || rawHistory[0]?.castingAt, rawHistory[0]?.period);
      // 下一期固定輸入永遠以目前計算出的下一個台北開獎時刻為準，不沿用已過期的保存值。
      // 當期期號的資料只用來計算下一期期號；起卦時間是本次實際計算當下，
      // 不是下一次開獎時間。下一次開獎時間只供倒數與目標期判定使用。
      const predictionCastingAt = requestedCastingTime(requestedCastingAt) || new Date().toISOString();
      const history = [];
      for (let index = 0; index < rawHistory.length; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        const item = rawHistory[index];
        const drawAt = item.drawAt || formatTaipeiDateTime(new Date(syncedAt - index * 5 * 60 * 1000));
        const castingAt = isFinite(index) ? reproducibleCastingAt(drawAt, item.period) : previousCastingAt;
        const isNextPrediction = index === 0;
        const modelCastingAt = isNextPrediction ? predictionCastingAt : castingAt;
        const modelSnapshot = isNextPrediction ? { ...item, period: nextPeriod, drawAt, castingAt: modelCastingAt } : { ...item, castingAt };
        const modelHistory = rawHistory.slice(index + 1, index + maxModelHistory + 1).map(({ period, numbers, superNumber, size, oddEven, drawAt }) => ({ period, numbers, superNumber, size, oddEven, drawAt }));
        // 同步只重新計算最新一期的「當期 → 下一期」模型。
        // 舊歷史模型若已存在就保留；同步歷史資料不應逐期重新啟動 worker，否則 31 日查詢會阻塞首屏。
        const previous = historyByPeriod.get(String(item.period));
        const models = isNextPrediction
          ? options.deferLatestModel
            ? []
            : await buildModelsInWorker(modelSnapshot, modelHistory, { evolve: true, castingAt: modelCastingAt })
          : previous?.models || item.models || [];
        history.push({
          ...item,
          drawAt,
          castingAt: modelCastingAt,
          forecastCastingAt: isNextPrediction ? predictionCastingAt : item.forecastCastingAt,
          predictionTargetPeriod: isNextPrediction ? nextPeriod : item.period,
          models: index <= maxModelHistory ? models : [],
          fetchedAt: syncedAt,
          sourceHealth: health,
        });
      }
      // 首屏快速路徑只確認最新開獎資料；模型補建與 GitHub 備份交給背景同步，
      // 不得因慢來源、worker 或備份服務讓 /api/latest?days=1 長時間沒有回應。
      if (!options.deferLatestModel) await hydrateEvaluationModels(history);
      await persistSnapshots(history);
      const backup = options.deferLatestModel
        ? { enabled: Boolean(githubToken), repo: githubRepo, path: githubBackupPath, deferred: true }
        : await backupModelProfile(history[0]);
      const responseHistory = daysOverride && daysOverride > 1
        ? compactHistoryForResponse(selectRecentHistory(history, retentionDays))
        : compactHistoryForResponse(history.slice(0, fastResponseHistoryLimit));
      return { ...history[0], history: responseHistory, historyDays: retentionDays, sourceHealth: health, sourceRanking: sourceRanking(history[0].period, health), audit: researchAudit(rawHistory), behaviorAudit: behaviorAudit(rawHistory), backtestIntegrity: leakageGuard(rawHistory, nextPeriod), forecastEvaluation: forecastEvaluation(history), calibratedProbabilityEvaluation: calibratedProbabilityEvaluation(history), profitabilityEvaluation: profitabilityEvaluation(history), zoneProfitabilityEvaluation: zoneProfitabilityEvaluation(history), technicalAnalysis: technicalAnalysis(history), theoreticalRiskBaseline: theoreticalRiskBaseline(), researchEvidence: researchEvidenceRegistry, backup };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const errorMessage = error instanceof Error ? error.message : '來源失敗';
      const stat = updateSourceStat(attempt.name, false, latencyMs, '', errorMessage);
      health.push({ name: attempt.name, ok: false, latencyMs, error: errorMessage, stability: stat.success / (stat.success + stat.failure) });
    }
  }
  throw new Error(`所有開獎來源均失敗：${health.map((item) => `${item.name}=${item.error || 'OK'}`).join('；')}`);
}

async function persistedResponse(persisted, requestedCastingAt = '') {
  if (!persisted.length) return null;
  const visible = persisted.slice(0, fastResponseHistoryLimit);
  const current = visible[0];
  const targetPeriod = nextPredictionPeriod(current.period);
  // 快取路徑同樣採「當期 → 下期」；重新計算時以現在時間起卦，不沿用下期開獎時刻。
  const predictionCastingAt = requestedCastingTime(requestedCastingAt) || new Date().toISOString();
  const modelHistory = visible.slice(1, maxModelHistory + 1).map(({ period, numbers, superNumber, size, oddEven, drawAt }) => ({ period, numbers, superNumber, size, oddEven, drawAt }));
  const modelSnapshot = {
    ...current,
    period: targetPeriod,
    drawAt: formatTaipeiDateTime(new Date(predictionCastingAt)),
    castingAt: predictionCastingAt,
  };
  // 快取只提供開獎資料；模型仍須重新執行 walk-forward 基線評估，不能用舊模型權重或跳過 baseline gate。
  let models = current.models || [];
  try {
    models = await buildModelsInWorker(modelSnapshot, modelHistory, { evolve: true, castingAt: predictionCastingAt });
  } catch (error) {
    console.error(JSON.stringify({ event: 'cached-prediction-recompute-failed', message: error instanceof Error ? error.message : String(error) }));
  }
  const history = [{
    ...current,
    models,
    forecastCastingAt: predictionCastingAt,
    predictionTargetPeriod: targetPeriod,
  }, ...visible.slice(1)];
  await hydrateEvaluationModels(history);
  return {
    ...history[0],
    history: compactHistoryForResponse(history),
    historyDays: retentionDays,
    sourceHealth: current.sourceHealth || [],
    audit: researchAudit(visible.slice(1)),
    behaviorAudit: behaviorAudit(visible.slice(1)),
    backtestIntegrity: leakageGuard(visible, targetPeriod),
    forecastEvaluation: forecastEvaluation([{ ...current, models }, ...visible.slice(1)]),
    calibratedProbabilityEvaluation: calibratedProbabilityEvaluation([{ ...current, models }, ...visible.slice(1)]),
    profitabilityEvaluation: profitabilityEvaluation([{ ...current, models }, ...visible.slice(1)]),
    zoneProfitabilityEvaluation: zoneProfitabilityEvaluation([{ ...current, models }, ...visible.slice(1)]),
    technicalAnalysis: technicalAnalysis([{ ...current, models }, ...visible.slice(1)]),
    theoreticalRiskBaseline: theoreticalRiskBaseline(),
    researchEvidence: researchEvidenceRegistry,
    backup: { enabled: Boolean(githubToken), repo: githubRepo, path: githubBackupPath },
  };
}

function refreshInBackground(persisted, days = 1) {
  if (refreshInFlight) return;
  refreshInFlight = true;
  void latest(days, persisted)
    .catch((error) => console.error(JSON.stringify({ event: 'background-sync-failed', message: error instanceof Error ? error.message : '背景同步失敗' })))
    .finally(() => { refreshInFlight = false; });
}

function readLatestResponseCache(key) {
  const cached = latestResponseCache.get(key);
  if (!cached || Date.now() - cached.storedAt > latestResponseCacheTtlMs) {
    latestResponseCache.delete(key);
    return null;
  }
  return cached.body;
}

function writeLatestResponseCache(key, body) {
  latestResponseCache.set(key, { storedAt: Date.now(), body });
  if (latestResponseCache.size > 4) latestResponseCache.delete(latestResponseCache.keys().next().value);
  return body;
}

function nextDrawAt(now = new Date()) {
  const taipei = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const year = taipei.getUTCFullYear(); const month = taipei.getUTCMonth(); const day = taipei.getUTCDate();
  const minute = taipei.getUTCHours() * 60 + taipei.getUTCMinutes(); const start = 425; const end = 1435;
  let targetDay = day; let targetMinutes = start;
  if (minute >= end) targetDay += 1;
  else if (minute >= start) targetMinutes = start + Math.ceil((minute - start + 1) / 5) * 5;
  return new Date(Date.UTC(year, month, targetDay, Math.floor(targetMinutes / 60), targetMinutes % 60, 0) - 8 * 60 * 60 * 1000);
}

async function scheduledSync(forceRepair = false) {
  try {
    const persisted = await readPersistedCached(persistedHistoryLimit);
    const requestedDays = forceRepair || !persisted.length || !hasRetentionCoverage(persisted, retentionDays) ? retentionDays : 1;
    const refreshDays = requestedDays === 1 && persisted.length < persistedHistoryLimit ? 30 : requestedDays;
    const result = await latest(refreshDays, persisted);
    console.log(JSON.stringify({ event: 'sync-ok', period: result.period, historyDays: result.historyDays, persisted: Boolean(pool) }));
  } catch (error) {
    console.error(JSON.stringify({ event: 'sync-failed', message: error instanceof Error ? error.message : '同步失敗' }));
  } finally {
    const wakeAt = nextDrawAt(new Date()).getTime() - Date.now() - 30_000;
    scheduledTimer = setTimeout(() => void scheduledSync(false), Math.max(30_000, wakeAt));
  }
}

function send(res, status, body, req = null) {
  const json = JSON.stringify(body);
  const etag = `"${createHash('sha1').update(json).digest('hex')}"`;
  if (req?.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'access-control-allow-origin': process.env.CORS_ORIGIN || '*' });
    res.end();
    return;
  }
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': process.env.CORS_ORIGIN || '*',
    etag,
    vary: 'Accept-Encoding',
    'cache-control': req?.url?.startsWith('/api/latest') ? 'public, max-age=2, stale-while-revalidate=10' : 'no-store',
  };
  if (json.length > 512 && /gzip/i.test(String(req?.headers['accept-encoding'] || ''))) {
    let compressed = compressedPayloadCache.get(etag);
    if (!compressed) {
      compressed = gzipSync(json);
      compressedPayloadCache.set(etag, compressed);
      if (compressedPayloadCache.size > 8) compressedPayloadCache.delete(compressedPayloadCache.keys().next().value);
    }
    headers['content-encoding'] = 'gzip';
    res.writeHead(status, headers);
    res.end(compressed);
    return;
  }
  res.writeHead(status, headers);
  res.end(json);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, service: 'bingo-api' });
  if (req.method === 'GET' && req.url.startsWith('/api/latest')) {
    try {
      const requestUrl = new URL(req.url, 'http://localhost');
      const requestedDays = Number(requestUrl.searchParams.get('days'));
      const daysOverride = Number.isFinite(requestedDays) && requestedDays > 0 ? requestedDays : null;
      const castingAt = requestedCastingTime(requestUrl.searchParams.get('castingAt'));
      const responseCacheKey = daysOverride === 1 ? 'latest-1' : '';
      if (responseCacheKey) {
        const cachedResponse = readLatestResponseCache(responseCacheKey);
        if (cachedResponse) return send(res, 200, cachedResponse, req);
      }
      const persisted = await readPersistedCached(daysOverride && daysOverride > 1 ? 10000 : persistedHistoryLimit);
      const cachedForecast = persisted[0]?.forecastCastingAt
        ? reproducibleCastingAt(persisted[0].forecastCastingAt, persisted[0].predictionTargetPeriod || '')
        : '';
      const forecastFresh = Boolean(cachedForecast) && Date.parse(cachedForecast) > Date.now();
      // days=1 是最新開獎讀取，必須即時確認官方期號；歷史查詢才可使用保存快取。
      if (persisted.length && daysOverride === 1) {
        // 最新開獎不可先回傳保存快取；否則新一期出現後畫面必然延遲一期。
        // 只有歷史查詢允許背景更新，days=1 必須先向官方來源確認最新期號。
        const fresh = await latest(1, persisted, castingAt, { deferLatestModel: true });
        refreshInBackground(persisted, 1);
        return send(res, 200, writeLatestResponseCache(responseCacheKey, fresh), req);
      }
      // 冷啟動先查最新一期，完整 31 日資料與建庫交給背景工作，避免首屏等待歷史同步。
      if (!persisted.length && daysOverride === 1) {
        const fresh = await latest(1, [], castingAt, { deferLatestModel: true });
        refreshInBackground([], retentionDays);
        return send(res, 200, writeLatestResponseCache(responseCacheKey, fresh), req);
      }
      // 月份查詢優先使用已保存的近期資料；官方補同步在背景執行，避免 6000 筆保存集阻塞首屏。
      if (persisted.length && daysOverride && daysOverride > 1) {
        const recent = selectRecentHistory(persisted, retentionDays);
        if (recent.length > fastResponseHistoryLimit) {
          const cached = await persistedResponse(recent.slice(0, fastResponseHistoryLimit), castingAt);
          refreshInBackground(persisted, hasRetentionCoverage(recent, retentionDays) ? 1 : retentionDays);
          return send(res, 200, { ...cached, history: compactHistoryForResponse(recent), historyDays: retentionDays }, req);
        }
      }
      const hasNextPrediction = persisted.length && persisted[0].predictionTargetPeriod && persisted[0].predictionTargetPeriod !== persisted[0].period;
      const hasUsableHistory = persisted.length >= persistedHistoryLimit;
      if (persisted.length && !daysOverride && hasNextPrediction && hasUsableHistory && forecastFresh) {
        const cached = await persistedResponse(persisted, castingAt);
        return send(res, 200, { ...cached, history: selectRecentHistory(persisted, retentionDays), historyDays: retentionDays });
      }
      const refreshDays = daysOverride === 1 && !hasUsableHistory ? 1 : daysOverride;
      const fresh = await latest(refreshDays, persisted, castingAt);
      return send(res, 200, responseCacheKey ? writeLatestResponseCache(responseCacheKey, fresh) : fresh, req);
    } catch (error) { return send(res, 502, { error: error instanceof Error ? error.message : '官方資料同步失敗' }, req); }
  }
  send(res, 404, { error: 'Not found' });
});

if (isMainThread) {
  server.listen(port, '0.0.0.0', () => {
    console.log(`bingo-api listening on ${port}; database=${Boolean(pool)}`);
    const firstWakeAt = nextDrawAt(new Date()).getTime() - Date.now() - 30_000;
    scheduledTimer = setTimeout(() => void scheduledSync(false), Math.max(60_000, firstWakeAt));
    // 啟動後立即補齊月份缺口；若官方來源逾時，下一次排程仍會重試。
    void scheduledSync(false);
  });
}
