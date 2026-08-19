import http from 'node:http';
import { createHash } from 'node:crypto';
import { isMainThread, Worker } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
import pg from 'pg';
import { createClient } from 'redis';

const { Pool } = pg;

const port = Number(process.env.PORT || 8080);
const sourceUrl = 'https://www.taiwanlottery.com/lotto/result/bingo_bingo/';
const apiBaseUrl = 'https://api.taiwanlottery.com/TLCAPIWeB/Lottery/BingoResult';
const defaultHistoryDays = 7;
const maxModelHistory = 300;
const liveModelHistoryLimit = 180;
const profitabilityBacktestWindow = 20;
const quickDecisionBacktestWindow = 10;
// 回測評估含 prequential 與校準巢狀迴圈；限制輸入窗口避免 300 期造成 O(n³) Worker 阻塞。
const evaluationHistoryLimit = 60;
// 盈利回測使用 20 期；模型調參另用較長樣本，並保留最新 20 期作為未參與調參的隔離窗口。
const minimumValidationSamples = 18;
const profileValidationWindow = 18;
const profileHoldoutWindow = profitabilityBacktestWindow;
// 資料保存至少涵蓋一個月；最新基準之外，模型選擇使用較長 walk-forward。
const retentionDays = 7;
const persistedHistoryLimit = 2500;
const fastResponseHistoryLimit = maxModelHistory + 1;
const responseHistoryLimit = 1200;
const reproducibilityVersion = 'bingo-research-v82-long-window-invalidation';
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
const sourceFetchConcurrency = 3;
const redisUrl = process.env.REDIS_URL || '';
const redisLockTtlMs = 180_000;
const workerMode = process.env.WORKER_MODE === '1';
const redisJobStream = 'bingo:jobs';
const redisJobGroup = 'bingo-workers';
const persistedCacheTtlMs = 5_000;
let databaseReady = false;
let lastPersistedPeriod = '';
let scheduledTimer;
let refreshInFlight = false;
let evaluationRefreshQueued = false;
const persistedCache = new Map();
const persistedReadInFlight = new Map();
const compressedPayloadCache = new Map();
const latestResponseCache = new Map();
const latestResponseCacheTtlMs = 5_000;
const formalModelCache = new Map();
const formalModelInFlight = new Map();
const formalModelCacheTtlMs = 15 * 60 * 1000;
const sourceRuntimeStats = new Map();
let redisClient;
let redisConnectPromise;
let redisQueueClient;
let redisQueueConnectPromise;
let computationProgress = {
  status: 'idle',
  stage: 'idle',
  percent: 0,
  message: '等待計算',
  updatedAt: Date.now(),
  runId: '',
};

function setComputationProgress(patch = {}) {
  computationProgress = { ...computationProgress, ...patch, updatedAt: Date.now() };
  if (pool) {
    void (async () => {
      try {
        await ensureDatabase();
        await pool.query(`INSERT INTO bingo_progress (id, progress, updated_at)
          VALUES (1, $1::jsonb, NOW())
          ON CONFLICT (id) DO UPDATE SET progress=EXCLUDED.progress, updated_at=NOW()`, [JSON.stringify(computationProgress)]);
      } catch (error) {
        console.error(JSON.stringify({ event: 'progress-persist-failed', message: error instanceof Error ? error.message : String(error) }));
      }
    })();
  }
  return computationProgress;
}

async function getRedisClient() {
  if (!redisUrl) return null;
  if (redisClient?.isReady) return redisClient;
  if (redisConnectPromise) return redisConnectPromise;
  redisClient = createClient({ url: redisUrl });
  redisClient.on('error', (error) => console.error(JSON.stringify({ event: 'redis-error', message: error instanceof Error ? error.message : String(error) })));
  redisConnectPromise = redisClient.connect()
    .then(() => redisClient)
    .catch((error) => {
      console.error(JSON.stringify({ event: 'redis-connect-failed', message: error instanceof Error ? error.message : String(error) }));
      redisConnectPromise = undefined;
      redisClient = undefined;
      return null;
    });
  return redisConnectPromise;
}

async function getRedisQueueClient() {
  if (!redisUrl) return null;
  if (redisQueueClient?.isReady) return redisQueueClient;
  if (redisQueueConnectPromise) return redisQueueConnectPromise;
  redisQueueClient = createClient({ url: redisUrl });
  redisQueueClient.on('error', (error) => console.error(JSON.stringify({ event: 'redis-queue-error', message: error instanceof Error ? error.message : String(error) })));
  redisQueueConnectPromise = redisQueueClient.connect()
    .then(() => redisQueueClient)
    .catch((error) => {
      console.error(JSON.stringify({ event: 'redis-queue-connect-failed', message: error instanceof Error ? error.message : String(error) }));
      redisQueueConnectPromise = undefined;
      redisQueueClient = undefined;
      return null;
    });
  return redisQueueConnectPromise;
}

async function acquireRefreshLock(key, ttlMs = redisLockTtlMs) {
  const client = await getRedisClient();
  if (!client) return null;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const acquired = await client.set(key, token, { NX: true, PX: ttlMs });
    return acquired === 'OK' ? { client, key, token } : false;
  } catch (error) {
    console.error(JSON.stringify({ event: 'redis-lock-failed', message: error instanceof Error ? error.message : String(error) }));
    return null;
  }
}

async function releaseRefreshLock(lock) {
  if (!lock) return;
  try {
    await lock.client.eval('if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end', {
      keys: [lock.key],
      arguments: [lock.token],
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'redis-unlock-failed', message: error instanceof Error ? error.message : String(error) }));
  }
}

async function readComputationProgress() {
  if (!pool) return computationProgress;
  try {
    await ensureDatabase();
    const result = await pool.query('SELECT progress FROM bingo_progress WHERE id = 1');
    if (result.rows[0]?.progress) computationProgress = { ...computationProgress, ...result.rows[0].progress };
  } catch (error) {
    console.error(JSON.stringify({ event: 'progress-read-failed', message: error instanceof Error ? error.message : String(error) }));
  }
  return computationProgress;
}

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
    forecast_evaluation JSONB NOT NULL DEFAULT '[]'::jsonb,
    calibrated_probability_evaluation JSONB NOT NULL DEFAULT '[]'::jsonb,
    profitability_evaluation JSONB NOT NULL DEFAULT '[]'::jsonb,
    zone_profitability_evaluation JSONB NOT NULL DEFAULT '[]'::jsonb,
    technical_analysis JSONB NOT NULL DEFAULT '{}'::jsonb,
    audit JSONB NOT NULL DEFAULT '{}'::jsonb,
    behavior_audit JSONB NOT NULL DEFAULT '{}'::jsonb,
    backtest_integrity JSONB NOT NULL DEFAULT '{}'::jsonb,
    prediction_target_period TEXT NOT NULL DEFAULT '',
    casting_at TEXT NOT NULL DEFAULT '',
    forecast_casting_at TEXT NOT NULL DEFAULT '',
    fetched_at BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);
  await pool.query("ALTER TABLE bingo_draws ADD COLUMN IF NOT EXISTS prediction_target_period TEXT NOT NULL DEFAULT ''");
  await pool.query("ALTER TABLE bingo_draws ADD COLUMN IF NOT EXISTS casting_at TEXT NOT NULL DEFAULT ''");
  await pool.query("ALTER TABLE bingo_draws ADD COLUMN IF NOT EXISTS forecast_casting_at TEXT NOT NULL DEFAULT ''");
  await pool.query("ALTER TABLE bingo_draws ADD COLUMN IF NOT EXISTS forecast_evaluation JSONB NOT NULL DEFAULT '[]'::jsonb");
  await pool.query("ALTER TABLE bingo_draws ADD COLUMN IF NOT EXISTS calibrated_probability_evaluation JSONB NOT NULL DEFAULT '[]'::jsonb");
  await pool.query("ALTER TABLE bingo_draws ADD COLUMN IF NOT EXISTS profitability_evaluation JSONB NOT NULL DEFAULT '[]'::jsonb");
  await pool.query("ALTER TABLE bingo_draws ADD COLUMN IF NOT EXISTS zone_profitability_evaluation JSONB NOT NULL DEFAULT '[]'::jsonb");
  await pool.query("ALTER TABLE bingo_draws ADD COLUMN IF NOT EXISTS technical_analysis JSONB NOT NULL DEFAULT '{}'::jsonb");
  await pool.query("ALTER TABLE bingo_draws ADD COLUMN IF NOT EXISTS audit JSONB NOT NULL DEFAULT '{}'::jsonb");
  await pool.query("ALTER TABLE bingo_draws ADD COLUMN IF NOT EXISTS behavior_audit JSONB NOT NULL DEFAULT '{}'::jsonb");
  await pool.query("ALTER TABLE bingo_draws ADD COLUMN IF NOT EXISTS backtest_integrity JSONB NOT NULL DEFAULT '{}'::jsonb");
  await pool.query('CREATE INDEX IF NOT EXISTS bingo_draws_updated_idx ON bingo_draws (updated_at DESC)');
  await pool.query(`CREATE TABLE IF NOT EXISTS bingo_model_backups (
    id BIGSERIAL PRIMARY KEY,
    algorithm_version TEXT NOT NULL,
    profile JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);
  await pool.query(`CREATE TABLE IF NOT EXISTS bingo_progress (
    id INTEGER PRIMARY KEY,
    progress JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);
  await pool.query(`CREATE TABLE IF NOT EXISTS bingo_jobs (
    run_id TEXT PRIMARY KEY,
    job_key TEXT NOT NULL UNIQUE,
    job_type TEXT NOT NULL,
    target_period TEXT NOT NULL DEFAULT '',
    days INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    heartbeat_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);
  await pool.query('CREATE INDEX IF NOT EXISTS bingo_jobs_status_idx ON bingo_jobs (status, updated_at DESC)');
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
        (period, draw_at, numbers, super_number, size, odd_even, source, source_label, source_health, models, forecast_evaluation, calibrated_probability_evaluation, profitability_evaluation, zone_profitability_evaluation, technical_analysis, audit, behavior_audit, backtest_integrity, prediction_target_period, casting_at, forecast_casting_at, fetched_at)
        VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb,$19,$20,$21,$22)
        ON CONFLICT (period) DO UPDATE SET draw_at=EXCLUDED.draw_at, numbers=EXCLUDED.numbers,
        super_number=EXCLUDED.super_number, size=EXCLUDED.size, odd_even=EXCLUDED.odd_even,
        source=EXCLUDED.source, source_label=EXCLUDED.source_label, source_health=EXCLUDED.source_health,
        models=EXCLUDED.models, forecast_evaluation=EXCLUDED.forecast_evaluation, calibrated_probability_evaluation=EXCLUDED.calibrated_probability_evaluation,
        profitability_evaluation=EXCLUDED.profitability_evaluation, zone_profitability_evaluation=EXCLUDED.zone_profitability_evaluation,
        technical_analysis=EXCLUDED.technical_analysis, audit=EXCLUDED.audit, behavior_audit=EXCLUDED.behavior_audit,
        backtest_integrity=EXCLUDED.backtest_integrity, prediction_target_period=EXCLUDED.prediction_target_period, casting_at=EXCLUDED.casting_at, forecast_casting_at=EXCLUDED.forecast_casting_at, fetched_at=EXCLUDED.fetched_at, updated_at=NOW()` , [
        item.period, item.drawAt || '', JSON.stringify(item.numbers), item.superNumber || '', item.size || '', item.oddEven || '',
        item.source || '', item.sourceLabel || '', JSON.stringify(item.sourceHealth || []), JSON.stringify(item.models || []),
        JSON.stringify(item.forecastEvaluation || []), JSON.stringify(item.calibratedProbabilityEvaluation || []), JSON.stringify(item.profitabilityEvaluation || []), JSON.stringify(item.zoneProfitabilityEvaluation || []),
        JSON.stringify(item.technicalAnalysis || {}), JSON.stringify(item.audit || {}), JSON.stringify(item.behaviorAudit || {}), JSON.stringify(item.backtestIntegrity || {}),
        item.predictionTargetPeriod || '', item.castingAt || '', item.forecastCastingAt || '', item.fetchedAt || Date.now(),
      ]);
    }
    await client.query('COMMIT');
    lastPersistedPeriod = snapshots[0]?.period || lastPersistedPeriod;
    // days=1 可能只寫入最新一筆；合併既有快取，不能讓一次增量寫入把歷史窗口截成 1 筆。
    const cachedRows = persistedCache.get(persistedHistoryLimit)?.rows || [];
    const rowsByPeriod = new Map([...cachedRows, ...snapshots].map((item) => [String(item.period), item]));
    persistedCache.set(persistedHistoryLimit, {
      rows: [...rowsByPeriod.values()].sort((a, b) => Number(b.period) - Number(a.period)).slice(0, persistedHistoryLimit),
      storedAt: Date.now(),
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function readPersisted(limit = persistedHistoryLimit) {
  if (!pool) return [];
  await ensureDatabase();
  const result = await pool.query(`SELECT period, draw_at AS "drawAt", numbers, super_number AS "superNumber",
    size, odd_even AS "oddEven", source, source_label AS "sourceLabel", source_health AS "sourceHealth",
    models, forecast_evaluation AS "forecastEvaluation", calibrated_probability_evaluation AS "calibratedProbabilityEvaluation",
    profitability_evaluation AS "profitabilityEvaluation", zone_profitability_evaluation AS "zoneProfitabilityEvaluation",
    technical_analysis AS "technicalAnalysis", audit, behavior_audit AS "behaviorAudit", backtest_integrity AS "backtestIntegrity",
    prediction_target_period AS "predictionTargetPeriod", casting_at AS "castingAt", forecast_casting_at AS "forecastCastingAt", fetched_at AS "fetchedAt" FROM bingo_draws ORDER BY period DESC LIMIT $1`, [Math.min(10000, Math.max(1, limit))]);
  return result.rows.map((row) => {
    const numbers = Array.isArray(row.numbers) ? row.numbers : [];
    const derived = numbers.length === 20 ? deriveSnapshot(row.period, numbers, row.source || '', row.drawAt || '') : null;
    return { ...row, numbers, size: derived?.size || row.size || '', oddEven: derived?.oddEven || row.oddEven || '', sourceHealth: row.sourceHealth || [], models: row.models || [], forecastEvaluation: row.forecastEvaluation || [], calibratedProbabilityEvaluation: row.calibratedProbabilityEvaluation || [], profitabilityEvaluation: row.profitabilityEvaluation || [], zoneProfitabilityEvaluation: row.zoneProfitabilityEvaluation || [], technicalAnalysis: row.technicalAnalysis || {}, audit: row.audit || {}, behaviorAudit: row.behaviorAudit || {}, backtestIntegrity: row.backtestIntegrity || {} };
  });
}

let pruneInFlight;
async function prunePersistedHistory() {
  if (!pool || pruneInFlight) return pruneInFlight;
  pruneInFlight = (async () => {
    await ensureDatabase();
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const result = await pool.query('SELECT period, draw_at AS "drawAt" FROM bingo_draws');
    const stalePeriods = result.rows
      .filter((row) => {
        const parsed = parseTaipeiDate(row.drawAt);
        return Number.isFinite(parsed.getTime()) && parsed.getTime() < cutoff;
      })
      .map((row) => String(row.period));
    if (stalePeriods.length) {
      await pool.query('DELETE FROM bingo_draws WHERE period = ANY($1::text[])', [stalePeriods]);
      persistedCache.clear();
      console.log(JSON.stringify({ event: 'history-pruned', retentionDays, deleted: stalePeriods.length }));
    }
  })().catch((error) => {
    console.error(JSON.stringify({ event: 'history-prune-failed', message: error instanceof Error ? error.message : '歷史清理失敗' }));
  }).finally(() => { pruneInFlight = undefined; });
  return pruneInFlight;
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
  if (!raw) return new Date(Number.NaN);
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
  const dateOnly = raw.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (dateOnly) return new Date(`${dateOnly[1]}T04:00:00.000Z`).toISOString();
  const fullDate = parseTaipeiDate(raw);
  if (raw && Number.isFinite(fullDate.getTime())) return fullDate.toISOString();
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
  const hourBranchIndex = Math.floor(((hour24 + 1) % 24) / 2);
  const hourBranch = hourBranchIndex + 1;
  const lunarYear = Number(parts.find((part) => part.type === 'relatedYear')?.value || date.getUTCFullYear());
  return {
    year: lunarYear,
    yearBranch: ((lunarYear - 4) % 12 + 12) % 12 + 1,
    yearBranchIndex: ((lunarYear - 4) % 12 + 12) % 12,
    month: Math.max(1, month),
    monthBranchIndex: (Math.max(1, month) + 1) % 12,
    day: Number(parts.find((part) => part.type === 'day')?.value || 1),
    hour: hourBranch,
    hourBranchIndex,
    hour24,
  };
}

function gregorianJulianDayNumber(date) {
  const utcYear = date.getUTCFullYear();
  const utcMonth = date.getUTCMonth() + 1;
  const utcDay = date.getUTCDate();
  const adjustedYear = utcMonth <= 2 ? utcYear - 1 : utcYear;
  const adjustedMonth = utcMonth <= 2 ? utcMonth + 12 : utcMonth;
  const century = Math.floor(adjustedYear / 100);
  return Math.floor(365.25 * (adjustedYear + 4716)) + Math.floor(30.6001 * (adjustedMonth + 1)) + utcDay + 2 - century + Math.floor(century / 4) - 1524;
}

function fourPillars(value) {
  const taipei = parseTaipeiParts(value);
  const date = new Date(Date.UTC(taipei.year, taipei.month - 1, taipei.day));
  const lunar = parseChineseCalendarParts(value);
  const yearStem = ((lunar.year - 4) % 10 + 10) % 10;
  const dayCycle = ((gregorianJulianDayNumber(date) + 49) % 60 + 60) % 60;
  const dayStem = dayCycle % 10;
  const dayBranch = dayCycle % 12;
  const monthStem = (yearStem % 5 * 2 + lunar.month + 1) % 10;
  const hourStem = (dayStem % 5 * 2 + lunar.hourBranchIndex) % 10;
  const stems = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
  const branches = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
  const pillarLabel = (stem, branch) => `${stems[stem]}${branches[branch]}`;
  return {
    yearStem, yearBranch: lunar.yearBranchIndex,
    monthStem, monthBranch: lunar.monthBranchIndex,
    dayStem, dayBranch,
    hourStem, hourBranch: lunar.hourBranchIndex,
    yearElement: Math.floor(yearStem / 2), monthElement: Math.floor(monthStem / 2),
    dayElement: Math.floor(dayStem / 2), hourElement: Math.floor(hourStem / 2),
    yearLabel: pillarLabel(yearStem, lunar.yearBranchIndex),
    monthLabel: pillarLabel(monthStem, lunar.monthBranchIndex),
    dayLabel: pillarLabel(dayStem, dayBranch),
    hourLabel: pillarLabel(hourStem, lunar.hourBranchIndex),
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
  const pillars = fourPillars(input.castingAt);
  const lunar = parseChineseCalendarParts(input.castingAt);
  const yearBranch = pillars.yearBranch + 1;
  const total = yearBranch + lunar.month + lunar.day + pillars.dayStem;
  const upper = total % 8 || 8;
  const lower = (total + lunar.hour) % 8 || 8;
  const moving = (total + lunar.hour) % 6 || 6;
  return { input, upper, lower, moving, pillars, formula: `預測時間=${input.castingAt}；四柱=${pillars.yearLabel}/${pillars.monthLabel}/${pillars.dayLabel}/${pillars.hourLabel}；上卦=(年支序+農曆月+日+日干序) mod 8=${upper}；下卦再加時支序；動爻再加時支序。同一預測時刻的時間起卦核心一致；期號與玩法僅作所問事項，各目標再獨立套用研究排序：${input.question}` };
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
  const pillars = fourPillars(input.castingAt);
  const timeSum = time.yearBranch + time.month + time.day + time.hour + pillars.yearStem + pillars.monthStem + pillars.dayStem + pillars.hourStem;
  const luoshu = [[4, 9, 2], [3, 5, 7], [8, 1, 6]];
  const palace = (timeSum + input.targetNo) % 9;
  const center = luoshu[Math.floor(palace / 3)][palace % 3];
  return { input, luoshu, palace: palace + 1, center, pillars, formula: `預測時間=${input.castingAt}；四柱=${pillars.yearLabel}/${pillars.monthLabel}/${pillars.dayLabel}/${pillars.hourLabel}，連同農曆月日時計算 mod 9 定洛書宮位=${palace + 1}；宮位數=${center}。期號僅作所問事項：${input.question}` };
}

function numeralGuaCasting(snapshot, target) {
  const input = targetInput(snapshot, target);
  const time = parseChineseCalendarParts(input.castingAt);
  const pillars = fourPillars(input.castingAt);
  const sourceDigits = [time.yearBranch, pillars.yearStem, time.month, pillars.monthStem, time.day, pillars.dayStem, time.hour, pillars.hourStem, input.targetNo];
  const allowed = [1, 4, 5, 6, 8, 9];
  const digits = Array.from({ length: 6 }, (_, index) => allowed[(sourceDigits[index % sourceDigits.length] + index) % allowed.length]);
  return { input, digits, pillars, formula: `預測時間=${input.castingAt}；以四柱干支序列與農曆月日、時辰及玩法序號建立六個可重算數字：${digits.join('、')}。期號僅作所問事項：${input.question}` };
}

function qimenCasting(snapshot, target) {
  const input = targetInput(snapshot, target);
  const time = parseChineseCalendarParts(input.castingAt);
  const pillars = fourPillars(input.castingAt);
  const timeSum = time.yearBranch + time.month + time.day + time.hour + pillars.yearStem + pillars.monthStem + pillars.dayStem + pillars.hourStem;
  const palace = (timeSum + input.targetNo) % 9 + 1;
  const star = (timeSum + time.hour + input.targetNo) % 9 + 1;
  const door = (timeSum + time.month + input.targetNo) % 8 + 1;
  return { input, palace, star, door, pillars, formula: `預測時間=${input.castingAt}；以四柱=${pillars.yearLabel}/${pillars.monthLabel}/${pillars.dayLabel}/${pillars.hourLabel}建立九宮／九星／八門研究適配=${palace}/${star}/${door}；完整奇門仍需節氣、干支排局，未宣稱完整奇門排盤。` };
}

function taiyiCasting(snapshot, target) {
  const input = targetInput(snapshot, target);
  const time = parseChineseCalendarParts(input.castingAt);
  const pillars = fourPillars(input.castingAt);
  const timeSum = time.yearBranch + time.month + time.day + time.hour + pillars.yearStem + pillars.monthStem + pillars.dayStem + pillars.hourStem;
  const palace = (timeSum + input.targetNo) % 9 + 1;
  const cycle = (timeSum + input.targetNo) % 9;
  return { input, palace, cycle, pillars, formula: `預測時間=${input.castingAt}；以四柱=${pillars.yearLabel}/${pillars.monthLabel}/${pillars.dayLabel}/${pillars.hourLabel}建立太乙行九宮研究索引=${palace}／${cycle}。完整太乙仍需積年、局數等排局資料，期號僅作所問事項：${input.question}` };
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
  const pillars = fourPillars(input.castingAt);
  const elements = ['木', '火', '土', '金', '水'];
  return { input, stem: pillars.yearStem, branch: pillars.yearBranch, element: elements[pillars.yearElement], pillars, digits: [], formula: `固定輸入=${input.castingAt}；以農曆年、月、日、時四柱干支建立五行與地支序列，再與號碼五行／支序固定映射及歷史統計分開回測；目前未納入節氣換月與完整命理排局，不宣稱命理因果。` };
}

function sanCaiCasting(snapshot, target) {
  const input = targetInput(snapshot, target);
  const pillars = fourPillars(input.castingAt);
  const heaven = (pillars.yearStem + pillars.monthBranch) % 10;
  const human = (pillars.dayStem + pillars.hourBranch) % 10;
  return {
    input, pillars, heaven, human,
    formula: `固定輸入=${input.castingAt}；三才研究適配取天=${heaven}（年干＋月支）、人=${human}（日干＋時支），地才由每個候選號碼的區域與尾數計算；三才五行配置只作可回測特徵，不等同姓名學天格／人格／地格。`,
  };
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
    .map((number) => String(number).padStart(2, '0'));
}

function betaBaselinePrediction(history, count = 10) {
  return Array.from({ length: 80 }, (_, index) => index + 1)
    .sort((a, b) => hypergeometricInclusion(b, history) - hypergeometricInclusion(a, history) || a - b)
    .slice(0, count)
    .map((number) => String(number).padStart(2, '0'));
}

function uniformBaselinePrediction(seed, count = 10) {
  return Array.from({ length: 80 }, (_, index) => index + 1)
    .sort((a, b) => deterministicTie(`${seed}|uniform`, a) - deterministicTie(`${seed}|uniform`, b) || a - b)
    .slice(0, count)
    .map((number) => String(number).padStart(2, '0'));
}

function ewmaInclusion(number, history, decay = 0.94) {
  let weightedHits = 0;
  let totalWeight = 0;
  history.forEach((draw, index) => {
    const weight = decay ** index;
    totalWeight += weight;
    if ((draw.numbers || []).some((value) => Number(value) === number)) weightedHits += weight;
  });
  // 以 20 個虛擬觀測固定先驗包含率 20/80，避免短樣本被近期波動放大。
  return (weightedHits + 20 * 0.25) / Math.max(1, totalWeight + 20);
}

function markovInclusion(number, history) {
  let transitions = 0;
  let hits = 0;
  const last = history[0]?.numbers?.some((value) => Number(value) === number) ? 1 : 0;
  for (let index = history.length - 1; index > 0; index -= 1) {
    const older = history[index]?.numbers?.some((value) => Number(value) === number) ? 1 : 0;
    const newer = history[index - 1]?.numbers?.some((value) => Number(value) === number) ? 1 : 0;
    if (older === last) {
      transitions += 1;
      hits += newer;
    }
  }
  // Laplace 平滑的條件出現率；資料不足時收縮回理論 25%。
  return (hits + 0.25 * 4) / Math.max(1, transitions + 4);
}

function quantitativeNumberPrediction(kind, seed, count, history) {
  if (kind === 'uniform' || kind === 'hypergeometric') return uniformBaselinePrediction(seed, count);
  const scored = Array.from({ length: 80 }, (_, index) => {
    const number = index + 1;
    let probability = 0.25;
    if (kind === 'frequency') probability = windowFrequency(number, history, 60);
    if (kind === 'bayesian') {
      const hits = history.reduce((sum, draw) => sum + ((draw.numbers || []).some((value) => Number(value) === number) ? 1 : 0), 0);
      probability = (hits + 5) / Math.max(1, history.length + 20);
    }
    if (kind === 'ewma') probability = ewmaInclusion(number, history);
    if (kind === 'markov') probability = markovInclusion(number, history);
    return { number, probability, tie: deterministicTie(`${seed}|${kind}`, number) };
  }).sort((a, b) => b.probability - a.probability || a.tie - b.tie || a.number - b.number);
  // 保留模型內部排名；後續聚合會用第 1 名、第 2 名的衰減權重。
  return scored.slice(0, count).map((item) => String(item.number).padStart(2, '0'));
}

function technicalFeatureSignals(number, history) {
  const recent = history.slice(0, 10);
  const comparison = history.slice(10, 30);
  const recentRate = windowFrequency(number, recent, 10);
  const comparisonRate = windowFrequency(number, comparison, 20);
  const longRate = windowFrequency(number, history, 60);
  const omissionIndex = history.findIndex((draw) => (draw.numbers || []).some((value) => Number(value) === number));
  const omissionSignal = omissionIndex < 0 ? 0 : clamp(1 - omissionIndex / 20, 0, 1);
  const tail = number % 10;
  const tailHits = recent.reduce((sum, draw) => sum + (draw.numbers || []).filter((value) => Number(value) % 10 === tail).length, 0);
  const tailSignal = recent.length ? clamp(tailHits / (recent.length * 2), 0, 1) : 0.25;
  const trendSignal = clamp(0.5 + (recentRate - comparisonRate) * 1.5, 0, 1);
  const frequencySignal = clamp(longRate / 0.25, 0, 1);
  // 階梯與同出只做描述性研究；不把它們偷偷混入技術預測分數。
  const score = trendSignal * 0.45 + frequencySignal * 0.25 + omissionSignal * 0.2 + tailSignal * 0.1;
  return { trendSignal, frequencySignal, omissionSignal, tailSignal, score };
}

function technicalFeaturePrediction(seed, count, history) {
  return Array.from({ length: 80 }, (_, index) => {
    const number = index + 1;
    const signals = technicalFeatureSignals(number, history);
    return { number, ...signals, tie: deterministicTie(`${seed}|technical`, number) };
  }).sort((a, b) => b.score - a.score || a.tie - b.tie || a.number - b.number)
    .slice(0, count)
    .map((item) => String(item.number).padStart(2, '0'));
}

function technicalCategoryPrediction(history, field) {
  const allowed = field === 'size' ? ['大', '小'] : ['單', '雙'];
  const recent = history.slice(0, 10);
  const comparison = history.slice(10, 30);
  const score = (value) => {
    const recentRate = recent.filter((item) => normalizeDrawCategory(item[field], field) === value).length / Math.max(1, recent.length);
    const comparisonRate = comparison.filter((item) => normalizeDrawCategory(item[field], field) === value).length / Math.max(1, comparison.length);
    return recentRate * 0.6 + comparisonRate * 0.2 + (recentRate - comparisonRate) * 0.2;
  };
  return [...allowed].sort((a, b) => score(b) - score(a) || allowed.indexOf(a) - allowed.indexOf(b))[0];
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
    const modelSource = history[index];
    const sourcePeriod = Number(modelSource?.period);
    const target = Number(targetPeriod);
    const modelSourceLeaked = Number.isFinite(sourcePeriod) && Number.isFinite(target) && sourcePeriod >= target;
    checks.push({ targetPeriod, trainingCount: training.length, modelSourcePeriod: modelSource?.period || '', leaked: leaked || modelSourceLeaked, modelSourceLeaked });
  }
  return {
    checkedTargets: checks.length,
    violations: checks.filter((check) => check.leaked).length,
    passed: checks.every((check) => !check.leaked),
    modelSourceViolations: checks.filter((check) => check.modelSourceLeaked).length,
    rule: '每個目標期只使用更早期數；下一期預測排除最新開獎期與所有未來期數；歷史模型來源期必須早於目標期；缺少模型時排除樣本。',
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
    numbers: candidates.slice(0, count).map((item) => String(item.number).padStart(2, '0')),
    validation,
    activeFilters: active.map((filter) => filter.key),
    excludedNumbers: [...usableExcluded].sort((a, b) => a - b).map((number) => String(number).padStart(2, '0')),
  };
}

function scoreNumbers(seed, count, tradition, history, empiricalWeight = 0.32, target = '') {
  if (tradition.kind === 'technical') return technicalFeaturePrediction(seed, count, history);
  // 這些模型使用各自獨立的生成機制，不再套用術數適配器與共用頻率混合分數。
  if (['uniform', 'frequency', 'bayesian', 'ewma', 'markov', 'hypergeometric'].includes(tradition.kind)) {
    return quantitativeNumberPrediction(tradition.kind, seed, count, history);
  }
  const frequencies = historicalFrequencies(history);
  const recentFrequencies = windowFrequencies(history, 12);
  const mediumFrequencies = windowFrequencies(history, 60);
  const longFrequencies = windowFrequencies(history, 300);
  const values = Array.from({ length: 80 }, (_, index) => index + 1).map((number) => {
    const traditional = tradition.kind === 'bazi'
      ? (() => {
        const elements = tradition.elements || [tradition.elementIndex].filter(Number.isFinite);
        const branches = tradition.branches || [tradition.branch].filter(Number.isFinite);
        const elementHits = elements.filter((element) => (number - 1) % 5 === element).length;
        const branchHits = branches.filter((branch) => (number - 1) % 12 === branch).length;
        return 0.04 + elementHits * 0.055 + branchHits * 0.025;
      })()
      : tradition.kind === 'sanCai'
      ? (() => {
        const earth = ((number - 1) % 10 + Math.floor((number - 1) / 10)) % 10;
        const heavenElement = tradition.heaven % 5;
        const humanElement = tradition.human % 5;
        const earthElement = earth % 5;
        const generating = (from, to) => (to - from + 5) % 5 === 1;
        const harmony = (heavenElement === humanElement ? 0.08 : 0) + (humanElement === earthElement ? 0.08 : 0)
          + (generating(heavenElement, humanElement) ? 0.05 : 0) + (generating(humanElement, earthElement) ? 0.05 : 0);
        return 0.04 + harmony;
      })()
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
  // 不可在這裡改按號碼排序，否則跨模型聚合無法知道候選的原始名次。
  return ranked.slice(0, count).map((item) => String(item.number).padStart(2, '0'));
}

const NUMBER_ZONES = [
  { key: 'zone-1', label: '01–20', min: 1, max: 20 },
  { key: 'zone-2', label: '21–40', min: 21, max: 40 },
  { key: 'zone-3', label: '41–60', min: 41, max: 60 },
  { key: 'zone-4', label: '61–80', min: 61, max: 80 },
];

function zonePredictionSet(seed, tradition, history, empiricalWeight, target = '10星', picksPerZone = 5) {
  if (tradition.kind === 'technical') {
    const ranked = technicalFeaturePrediction(seed, 80, history).map(Number);
    return NUMBER_ZONES.map((zone) => ({
      key: zone.key,
      label: zone.label,
      numbers: ranked.filter((number) => number >= zone.min && number <= zone.max).slice(0, picksPerZone).sort((a, b) => a - b).map((number) => String(number).padStart(2, '0')),
    }));
  }
  if (['uniform', 'frequency', 'bayesian', 'ewma', 'markov', 'hypergeometric'].includes(tradition.kind)) {
    const ranked = quantitativeNumberPrediction(tradition.kind, seed, 80, history).map(Number);
    return NUMBER_ZONES.map((zone) => ({
      key: zone.key,
      label: zone.label,
      numbers: ranked.filter((number) => number >= zone.min && number <= zone.max).slice(0, picksPerZone).sort((a, b) => a - b).map((number) => String(number).padStart(2, '0')),
    }));
  }
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
  '技術分析特徵基線': [{ name: '時間序列 walk-forward 驗證原則', url: 'https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html' }, { name: '機率校準與 Brier 評分', url: 'https://scikit-learn.org/stable/modules/calibration.html' }],
  '均勻隨機理論基準': [{ name: '台灣彩券官方開獎規則／時程', url: 'https://www.taiwanlottery.com/run_lottery/schedule/' }],
  '頻率窗口基線': [{ name: '彩票 k/N 隨機性統計審計', url: 'https://arxiv.org/abs/0806.4595' }],
  '生肖五行研究版': [{ name: '中國哲學書電子化計劃：周易與五行資料', url: 'https://ctext.org/datawiki.pl?if=en&res=484682' }],
  '貝葉斯 Beta-Binomial 基線': [{ name: '彩票 k/N 隨機性統計審計', url: 'https://arxiv.org/abs/0806.4595' }],
  '指數衰減 EWMA 基線': [{ name: '時間序列交叉驗證原則', url: 'https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html' }],
  '二狀態 Markov 研究版': [{ name: '時間序列交叉驗證原則', url: 'https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html' }],
  '超幾何集合審計基準': [{ name: 'Statistical auditing and randomness test of lotto k/N-type games', url: 'https://arxiv.org/abs/0806.4595' }],
  '多窗口穩定性基線': [{ name: 'Strictly Proper Scoring Rules, Prediction, and Estimation', url: 'https://doi.org/10.1198/016214506000001437' }, { name: 'Statistical auditing and randomness test of lotto k/N-type games', url: 'https://arxiv.org/abs/0806.4595' }],
  '排除濾網基線': [{ name: 'NIST SP 800-22 隨機性測試', url: 'https://csrc.nist.gov/pubs/sp/800/22/r1/upd1/final' }, { name: 'Statistical auditing and randomness test of lotto k/N-type games', url: 'https://arxiv.org/abs/0806.4595' }],
  '趨勢加權回歸基線': [{ name: '序列式機率預測與評估', url: 'https://arxiv.org/abs/0905.1673' }, { name: 'Strictly Proper Scoring Rules, Prediction, and Estimation', url: 'https://doi.org/10.1198/016214506000001437' }],
  '機器學習負對照': [{ name: '序列式機率預測與評估', url: 'https://arxiv.org/abs/0905.1673' }, { name: 'Strictly Proper Scoring Rules, Prediction, and Estimation', url: 'https://doi.org/10.1198/016214506000001437' }],
};
const researchEvidenceRegistry = [
  { name: '技術分析特徵邊界', status: '趨勢／頻率／遺漏／尾號可作候選特徵；階梯／同出只作描述性分析，未通過樣本外閘門不得進共識', source: '本研究台特徵規格', url: 'https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html' },
  { name: '均勻隨機與超幾何基準', status: '以 80 選 20 不放回理論作為所有模型的最低比較線；不把基準當成預測優勢', source: 'Coronel-Brizio et al., 2008', url: 'https://arxiv.org/abs/0806.4595' },
  { name: '時間序列 walk-forward', status: '訓練資料永遠早於測試資料；禁止隨機切分造成未來資訊洩漏', source: 'scikit-learn TimeSeriesSplit', url: 'https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html' },
  { name: '機率校準', status: '以 Brier／log loss 評估預測機率與實際結果，不以命中率單獨決定模型優劣', source: 'scikit-learn Probability Calibration', url: 'https://scikit-learn.org/stable/modules/calibration.html' },
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
  // 舊版候選權重最高只有 0.32，卻要求 >= 0.4 才使用歷史資料，
  // 使大小／單雙實際上永遠只看起卦映射。改成連續混合：權重越高，
  // 歷史證據越能影響結果，但不會在短樣本下完全取代基準。
  if (!history.length || empiricalWeight <= 0) return fallback;
  const counts = new Map();
  history.forEach((item, index) => {
    const value = normalizeDrawCategory(item[field], field);
    if (allowed.has(value)) counts.set(value, (counts.get(value) || 0) + 1 / (index + 1));
  });
  if (!counts.size) return fallback;
  const maxCount = Math.max(...counts.values(), 1);
  const traditionalWeight = 1 - Math.min(0.8, empiricalWeight);
  return [...allowed].map((value) => ({
    value,
    score: (value === fallback ? traditionalWeight : 0) + (counts.get(value) || 0) / maxCount * Math.min(0.8, empiricalWeight),
  })).sort((a, b) => b.score - a.score || String(a.value).localeCompare(String(b.value)))[0].value;
}

function quantitativeCategoryPrediction(kind, seed, history, field) {
  const allowed = field === 'size' ? ['大', '小'] : ['單', '雙'];
  if (kind === 'uniform' || kind === 'hypergeometric') return allowed[seed % 2];
  if (kind === 'markov' && history.length >= 2) {
    const latest = normalizeDrawCategory(history[0]?.[field], field);
    let trials = 0;
    let hits = 0;
    for (let index = history.length - 1; index > 0; index -= 1) {
      const previous = normalizeDrawCategory(history[index]?.[field], field);
      const current = normalizeDrawCategory(history[index - 1]?.[field], field);
      if (previous === latest && allowed.includes(current)) {
        trials += 1;
        if (current === latest) hits += 1;
      }
    }
    if (trials >= 4) return hits / trials >= 0.5 ? latest : allowed.find((value) => value !== latest);
  }
  const counts = new Map(allowed.map((value) => [value, 2]));
  history.forEach((item) => {
    const value = normalizeDrawCategory(item[field], field);
    if (counts.has(value)) counts.set(value, counts.get(value) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || allowed.indexOf(a[0]) - allowed.indexOf(b[0]))[0][0];
}

function modelCategoryPrediction(kind, seed, casting, history, field, empiricalWeight) {
  if (kind === 'technical') return technicalCategoryPrediction(history, field);
  if (['uniform', 'frequency', 'bayesian', 'ewma', 'markov', 'hypergeometric'].includes(kind)) {
    return quantitativeCategoryPrediction(kind, seed, history, field);
  }
  return categoryPrediction(seed, targetTraditionalCategory(casting, field, seed), history, field, empiricalWeight);
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

function evaluationModelFor(actual, name, prior, includeNumbers = true, modelSource = null) {
  // 歷史快照上的 models 是「該期之後」的預測；評估 actual 時，必須讀更舊一期保存的模型。
  const saved = (modelSource?.models || actual.models)?.find((model) => model.name === name);
  if (saved || name !== '趨勢加權回歸基線') return saved;
  // 舊保存期數可能沒有新模型；只用該目標期以前的資料即時補算。
  return buildWeightedRegressionModel(actual, prior, reproducibleCastingAt(actual.drawAt, actual.period), { includeNumbers });
}

function prequentialCategoryProbability(target, modelName, prior = []) {
  let wins = 0;
  let trials = 0;
  for (let index = 0; index < prior.length; index += 1) {
    const past = prior[index];
    const pastModel = evaluationModelFor(past, modelName, prior.slice(index + 1), false, prior[index + 1]);
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
  if (records.length && !modelNames.includes('趨勢加權回歸基線')) modelNames.push('趨勢加權回歸基線');
  const byModel = new Map();
  records.forEach((actual, recordIndex) => {
    const prior = records.slice(recordIndex + 1);
    modelNames.forEach((name) => {
    const model = evaluationModelFor(actual, name, prior, true, records[recordIndex + 1]);
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
  if (records.length && !modelNames.includes('趨勢加權回歸基線')) modelNames.push('趨勢加權回歸基線');
  return modelNames.map((name) => {
    const metrics = { size: { brier: 0, logLoss: 0, count: 0, nextProbability: 0.5, bins: new Map() }, oddEven: { brier: 0, logLoss: 0, count: 0, nextProbability: 0.5, bins: new Map() } };
    records.forEach((actual, recordIndex) => {
      const model = evaluationModelFor(actual, name, records.slice(recordIndex + 1), false, records[recordIndex + 1]);
      if (!model) return;
      const older = records.slice(recordIndex + 1);
      ['size', 'oddEven'].forEach((target) => {
        let wins = 0; let trials = 0;
        older.forEach((past, olderIndex) => {
          const pastModel = evaluationModelFor(past, name, records.slice(recordIndex + olderIndex + 2), false, records[recordIndex + olderIndex + 2]);
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
        const pastModel = evaluationModelFor(past, name, records.slice(pastIndex + 1), false, records[pastIndex + 1]);
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
  const matched = rebuilt.find((model) => model.name === sourceModel.name);
  if (matched) return matched;
  const fallback = buildModels(actual, training, {
    evolve: false,
    castingAt: reproducibleCastingAt(actual.drawAt, actual.period),
  });
  return fallback.find((model) => model.name === sourceModel.name)
    || fallback.find((model) => model.name && model.name !== '多模型聚合')
    || null;
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
  // 同一個模型／模式／目標期的模型列與玩法無關；先建立一次，所有玩法共用。
  // 舊版在每個玩法內重建模型，13 個玩法會把相同的 walk-forward 工作重複數十次。
  const evaluationRowsCache = new Map();
  const buildEvaluationRows = (currentModel, mode) => {
    const cacheKey = `${mode}:${currentModel?.name || 'unknown'}`;
    const cached = evaluationRowsCache.get(cacheKey);
    if (cached) return cached;
    const rows = [];
    for (let index = 0; index < profitabilityBacktestWindow; index += 1) {
      const actual = history[index];
      const training = history.slice(index + 1);
      if (!actual || !training.length) continue;
      // fixed：凍結錨點模型；follow：採用目標期前一棒已保存模型。
      const followModels = history[index + 1]?.models || [];
      const source = mode === 'fixed'
        ? currentModel
        : followModels.find((item) => item.name === currentModel.name)
          || followModels.find((item) => item.name && item.name !== '多模型聚合')
          || currentModel;
      let model = mode === 'follow' && source?.official
        ? source
        : rebuildEvaluationModel(source, actual, training);
      if (!model && mode === 'follow' && source !== currentModel) {
        model = rebuildEvaluationModel(currentModel, actual, training);
      }
      if (model) rows.push({ actual, model });
    }
    if (mode === 'follow' && !rows.length) {
      // 舊資料庫可能只有最新模型，不能把整個跟買結果顯示成 0 期；
      // 用同一算法的固定重建列作明確備援，並在結果帶出 fallback 標記。
      const fallback = buildEvaluationRows(currentModel, 'fixed');
      const result = { rows: fallback.rows, fallback: true };
      evaluationRowsCache.set(cacheKey, result);
      return result;
    }
    const result = { rows, fallback: false };
    evaluationRowsCache.set(cacheKey, result);
    return result;
  };
  return plays.map((play) => {
    const evaluate = (currentModel, mode) => {
      const rowResult = buildEvaluationRows(currentModel, mode);
      const rows = rowResult.rows;
      let wins = 0; let trials = 0; let validTrials = 0; let excludedTrials = 0; let categoryHits = 0; let profit = 0; let payoutTotal = 0; let matches = 0; let targetCount = 0;
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
        const predictedNumbers = Array.isArray(predicted) ? predicted : [];
        const actualNumbers = new Set((actual.numbers || []).map(normalizeNumberValue));
        const matchesForPeriod = Array.isArray(predicted)
          ? predictedNumbers.filter((number) => actualNumbers.has(normalizeNumberValue(number))).length
          : (payout > 0 ? 1 : 0);
        const targetCountForPeriod = Array.isArray(predicted) ? predictedNumbers.length : 1;
        if (play.key === 'size' || play.key === 'oddEven') {
          const field = play.key === 'size' ? 'size' : 'oddEven';
          const observed = normalizeDrawCategory(actual?.[field], field);
          const expected = normalizeDrawCategory(predicted, field);
          if (['大', '小', '單', '雙'].includes(observed)) {
            validTrials += 1;
            categoryHits += expected === observed ? 1 : 0;
          } else excludedTrials += 1;
        }
        periodResults.push({
          period: String(actual.period || ''), drawAt: actual.drawAt || '',
          prediction: Array.isArray(predicted) ? predicted.join('、') : String(predicted || '—'),
          matches: matchesForPeriod, targetCount: targetCountForPeriod,
          payout, net, profitable: net > 0,
        });
        wins += net > 0 ? 1 : 0;
        payoutTotal += payout;
        profit += net;
        if (Array.isArray(predicted)) {
          matches += matchesForPeriod;
          targetCount += predicted.length;
        } else { matches += payout > 0 ? 1 : 0; targetCount += 1; }
        trials += 1;
      });
      const selectionModel = selectionModels.find((item) => item.name === currentModel.name) || currentModel;
      const evolution = selectionModel.calculation?.evolution?.[play.key];
      // 回測統計使用歷史模型；畫面「預測號碼」必須使用目前最新模型，不能顯示回測錨點的舊號碼。
      const currentPredictionSource = currentModels.find((item) => item.name === currentModel.name) || currentModel;
      const predictionSource = mode === 'fixed'
        ? (history[0] ? rebuildEvaluationModel(currentModel, history[0], history.slice(1)) : null) || currentPredictionSource
        : currentPredictionSource;
      const prediction = play.key === 'size'
        ? predictionSource.official?.size
        : play.key === 'oddEven'
          ? predictionSource.official?.oddEven
          : play.key === 'superNumber'
            ? predictionSource.official?.superNumber
            : predictionSource.official?.basic?.[play.key]?.join('、');
      const profitRate = trials ? wins / trials : null;
      const averageProfit = trials ? profit / trials : null;
      const validationEvidence = currentModel.calculation?.evolution?.[play.key] || {};
      const validationTrials = Number(validationEvidence.trials || validationEvidence.validationSamples || 0);
      const validationProfit = validationTrials >= minimumValidationSamples && Number.isFinite(Number(validationEvidence.profit))
        ? Number(validationEvidence.profit)
        : null;
      return {
        mode, model: currentModel.name, samples: trials, wins, profit, payoutTotal, costTotal: trials * betCostForTarget(play.key),
        matches, targetCount, averageProfit, positiveExpected: averageProfit != null && averageProfit > 0,
        profitRate, hitRate: (play.key === 'size' || play.key === 'oddEven') && validTrials ? categoryHits / validTrials : (trials ? wins / trials : null),
        validSamples: (play.key === 'size' || play.key === 'oddEven') ? validTrials : trials,
        excludedSamples: (play.key === 'size' || play.key === 'oddEven') ? excludedTrials : 0,
        categoryHits: (play.key === 'size' || play.key === 'oddEven') ? categoryHits : matches,
        baselineHitRate: (play.key === 'size' || play.key === 'oddEven') ? 0.5 : null,
        estimatedRate: evolution?.estimatedRate ?? null,
        confidence: evolution?.confidence ?? -1, validationProfit, validationTrials,
        prediction: prediction || '—', periodResults,
        fallback: rowResult.fallback ? '缺少歷史模型，使用同算法重建備援' : '',
      };
    };
    // 模型必須在回測視窗開始前決定；不能看完這 20 期結果再挑最高盈利者。
    // 先用更早校準窗的實際淨利選模；該欄位不包含本次固定 20 期。
    const rank = (a, b) => (b.validationProfit ?? -Infinity) - (a.validationProfit ?? -Infinity)
      || (b.validationTrials ?? 0) - (a.validationTrials ?? 0)
      || (b.confidence ?? -1) - (a.confidence ?? -1)
      || (b.estimatedRate ?? -1) - (a.estimatedRate ?? -1)
      || String(a.model).localeCompare(String(b.model));
    const empty = (mode) => ({ mode, model: '—', samples: 0, wins: 0, profit: 0, payoutTotal: 0, costTotal: 0, matches: 0, targetCount: 0, averageProfit: null, positiveExpected: false, profitRate: null, hitRate: null, validSamples: 0, excludedSamples: 0, categoryHits: 0, baselineHitRate: null, estimatedRate: null, confidence: -1, validationProfit: null, validationTrials: 0, prediction: '—', periodResults: [] });
    const candidateModels = (selectionModels.length ? selectionModels : currentModels).filter((model) => model.name !== '多模型聚合');
    // 14 個模型 × 2 種模式 × 10 個目標期會造成數百次模型重建，讓背景回測長時間沒有結果。
    // 先依樣本外驗證證據縮小到前 4 名；完整模型仍保留在模型明細，逐期重型計算只處理有競爭力的候選。
    const rankedCandidates = candidateModels
      .map((model) => {
        const evidence = model.calculation?.evolution?.[play.key] || {};
        const validationProfit = Number(evidence.profit);
        const validationTrials = Number(evidence.trials || evidence.validationSamples || 0);
        return { model, validationProfit: Number.isFinite(validationProfit) && validationTrials >= minimumValidationSamples ? validationProfit : null, validationTrials, confidence: Number(evidence.confidence ?? -1), estimatedRate: Number(evidence.estimatedRate ?? -1) };
      })
      .sort((a, b) => (b.validationProfit ?? -Infinity) - (a.validationProfit ?? -Infinity)
        || b.validationTrials - a.validationTrials
        || b.confidence - a.confidence
        || b.estimatedRate - a.estimatedRate
        || String(a.model.name).localeCompare(String(b.model.name)))
      .slice(0, 4)
      .map((item) => item.model);
    const fixed = rankedCandidates.map((model) => evaluate(model, 'fixed')).sort(rank)[0] || empty('fixed');
    const follow = rankedCandidates.map((model) => evaluate(model, 'follow')).sort(rank)[0] || empty('follow');
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

function profitabilityFactorResearch(history = []) {
  const targets = ['5星', '10星'];
  const factorDefinitions = [
    { key: 'frequency', label: '候選近期頻率', description: '候選號碼近 60 期平均出現率' },
    { key: 'omission', label: '候選遺漏程度', description: '候選號碼距離最近開出的期數' },
    { key: 'zoneSpread', label: '區間分散度', description: '候選是否分布於四個 20 號區間' },
    { key: 'oddEvenBalance', label: '單雙平衡度', description: '候選單雙比例接近 1:1 的程度' },
    { key: 'highLowBalance', label: '大小平衡度', description: '候選大小比例接近 1:1 的程度' },
    { key: 'modelSupport', label: '模型支持度', description: '聚合候選獲得的模型支持數' },
  ];
  const rowsFor = (target) => {
    const rows = [];
    const count = Number(target.replace('星', ''));
    for (let index = 0; index < Math.min(profitabilityBacktestWindow, history.length - 1); index += 1) {
      const actual = history[index];
      const prior = history.slice(index + 1);
      const models = prior[0]?.models || [];
      const model = models.find((item) => item.name === '多模型聚合') || models.find((item) => item.name !== '多模型聚合');
      const predicted = model?.official?.basic?.[target];
      if (!actual || !Array.isArray(predicted) || predicted.length !== count || !prior.length) continue;
      const numbers = predicted.map(Number).filter((number) => Number.isInteger(number) && number >= 1 && number <= 80);
      if (numbers.length !== count) continue;
      const recent = prior.slice(0, 60);
      const frequency = numbers.reduce((sum, number) => sum + windowFrequency(number, recent, 60), 0) / numbers.length;
      const omission = numbers.reduce((sum, number) => {
        const gap = prior.findIndex((draw) => (draw.numbers || []).some((value) => Number(value) === number));
        return sum + (gap < 0 ? 20 : Math.min(gap, 20));
      }, 0) / numbers.length;
      const zones = new Set(numbers.map((number) => Math.min(3, Math.floor((number - 1) / 20)))).size / 4;
      const oddRatio = numbers.filter((number) => number % 2 === 1).length / numbers.length;
      const highRatio = numbers.filter((number) => number > 40).length / numbers.length;
      const balance = (ratio) => 1 - Math.min(1, Math.abs(ratio - 0.5) * 2);
      const ranking = model.research?.candidateRankings?.[target] || [];
      const support = ranking.length ? numbers.reduce((sum, number) => sum + Number(ranking.find((item) => Number(item.number) === number)?.support || 0), 0) / numbers.length : null;
      const payout = backtestPayout(target, predicted, actual);
      const net = payout - betCostForTarget(target);
      rows.push({ target, net, profitable: net > 0, values: { frequency, omission: 1 - Math.min(1, omission / 20), zoneSpread: zones, oddEvenBalance: balance(oddRatio), highLowBalance: balance(highRatio), modelSupport: support } });
    }
    return rows;
  };
  const summarize = (target, factor, rows) => {
    const usable = rows.filter((row) => Number.isFinite(row.values[factor.key]));
    if (usable.length < 6) return { key: factor.key, label: factor.label, description: factor.description, samples: usable.length, status: '樣本不足', high: null, low: null, rule: '至少需要 6 個逐期樣本才比較高低因子組。' };
    const sorted = [...usable].sort((a, b) => a.values[factor.key] - b.values[factor.key]);
    const middle = sorted[Math.floor((sorted.length - 1) / 2)].values[factor.key];
    const groups = { high: usable.filter((row) => row.values[factor.key] >= middle), low: usable.filter((row) => row.values[factor.key] < middle) };
    const groupSummary = (group) => {
      const profitRate = group.length ? group.filter((row) => row.profitable).length / group.length : null;
      const meanNet = group.length ? group.reduce((sum, row) => sum + row.net, 0) / group.length : null;
      return { samples: group.length, profitable: group.filter((row) => row.profitable).length, profitRate, meanNet, lowerBound: profitRate == null ? null : lowerConfidenceBound(profitRate, group.length) };
    };
    const high = groupSummary(groups.high); const low = groupSummary(groups.low);
    const lift = high.profitRate != null && low.profitRate != null ? high.profitRate - low.profitRate : null;
    return { key: factor.key, label: factor.label, description: factor.description, samples: usable.length, split: middle, high, low, lift, status: high.samples && low.samples ? '研究比較' : '分組不足', rule: '只用目標期以前資料；高組含切點，低組低於切點。未進行多重比較校正，不直接取得預測權重。' };
  };
  return { version: 'profit-factor-v1', targets: Object.fromEntries(targets.map((target) => { const rows = rowsFor(target); return [target, { samples: rows.length, factors: factorDefinitions.map((factor) => summarize(target, factor, rows)) }]; })), caveat: '盈利因子是樣本外描述性研究；正盈利不代表下一期可複製，也不代表改變官方隨機開獎機率。' };
}

function zoneBalancedComposition(ranked, size) {
  const selected = [];
  const perZone = Math.max(1, Math.floor(size / NUMBER_ZONES.length));
  NUMBER_ZONES.forEach((zone) => {
    ranked.filter((item) => Number(item.number) >= zone.min && Number(item.number) <= zone.max)
      .slice(0, perZone).forEach((item) => { if (!selected.some((value) => value.number === item.number)) selected.push(item); });
  });
  ranked.forEach((item) => { if (selected.length < size && !selected.some((value) => value.number === item.number)) selected.push(item); });
  return selected.slice(0, size);
}

function evaluateCompositionStrategies(history = [], target = '10星', size = 10) {
  const rows = [];
  for (let index = 1; index < Math.min(history.length, profitabilityBacktestWindow + 1); index += 1) {
    const actual = history[index - 1];
    const model = history[index]?.models?.find((item) => item.name === '多模型聚合');
    const ranked = model?.research?.candidateRankings?.[target];
    if (!actual || !Array.isArray(ranked) || ranked.length < size) continue;
    const actualNumbers = new Set((actual.numbers || []).map(normalizeNumberValue));
    const top = ranked.slice(0, size).map((item) => normalizeNumberValue(item.number));
    const balanced = zoneBalancedComposition(ranked, size).map((item) => normalizeNumberValue(item.number));
    rows.push({ top: top.filter((number) => actualNumbers.has(number)).length, balanced: balanced.filter((number) => actualNumbers.has(number)).length });
  }
  const mean = (key) => rows.length ? rows.reduce((sum, row) => sum + row[key], 0) / rows.length : null;
  const topMean = mean('top'); const balancedMean = mean('balanced');
  return {
    samples: rows.length,
    topMean,
    balancedMean,
    lift: topMean != null && balancedMean != null ? balancedMean - topMean : null,
    selected: rows.length >= 8 && balancedMean != null && topMean != null && balancedMean >= topMean + 0.25 ? 'zone-balanced' : 'ranked-top-k',
    rule: '只使用已完成的歷史聚合候選與更早實際開獎；至少 8 期且平均命中提升 0.25 才啟用區間平衡，否則維持直接取前 K。',
  };
}

async function hydrateEvaluationModels(history = [], windowSize = profitabilityBacktestWindow) {
  const lastIndex = Math.min(history.length - 1, windowSize + 1);
  for (let index = 1; index <= lastIndex; index += 1) {
    if (Array.isArray(history[index]?.models) && history[index].models.length) continue;
    const item = history[index];
    const target = history[index - 1];
    if (!item) continue;
    const modelHistory = history.slice(index, index + maxModelHistory)
      .map(({ period, numbers, superNumber, size, oddEven, drawAt }) => ({ period, numbers, superNumber, size, oddEven, drawAt }));
    try {
      // 模型寫在較舊的來源列，但預測目標是下一個較新的 target；訓練資料只取 target 以前的更舊期數。
      const targetSnapshot = { ...target, period: target?.period || item.period };
      history[index].models = await buildModelsCached(targetSnapshot, modelHistory, {
        evolve: false,
        castingAt: reproducibleCastingAt(target?.castingAt || target?.drawAt || item.drawAt, targetSnapshot.period),
      });
      history[index].modelStatus = history[index].models.length ? 'formal' : 'error';
    } catch (error) {
      history[index].models = [];
      history[index].modelStatus = 'error';
      history[index].modelError = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ event: 'historical-model-build-failed', period: history[index].period, message: history[index].modelError }));
    }
  }
  return history;
}

function technicalAnalysis(history = []) {
  const draws = history.slice(0, 30);
  const normalizedNumbers = (draw) => [...new Set((draw.numbers || []).map((number) => Number(number)).filter((number) => Number.isInteger(number) && number >= 1 && number <= 80))].sort((a, b) => a - b);
  const numberKey = (number) => String(number).padStart(2, '0');
  const frequency = new Map();
  const tailCounts = Object.fromEntries(Array.from({ length: 10 }, (_, tail) => [String(tail), 0]));
  const coOccurrence = new Map();
  const ladderPatterns = new Map();
  let ladderDraws = 0;
  let ladderSequences = 0;
  let longestLadder = 0;
  const ladderVariantSpecs = [
    { key: 'step1', label: '連號階梯', rule: '相鄰號碼差 1，至少 2 號。' },
    { key: 'step2', label: '跳一階梯', rule: '相鄰號碼差 2，至少 2 號。' },
    { key: 'step3', label: '跳二階梯', rule: '相鄰號碼差 3，至少 2 號。' },
    { key: 'mixed', label: '混合階梯', rule: '相鄰差只允許 1 或 2，至少 3 號且同時包含兩種間距。' },
  ];
  const ladderVariantStats = Object.fromEntries(ladderVariantSpecs.map((spec) => [spec.key, { draws: 0, sequences: 0, longest: 0, patterns: new Map() }]));
  const collectSequences = (values, allowedSteps, minimumLength = 2) => {
    const sequences = [];
    let run = [];
    const flush = () => {
      if (run.length >= minimumLength) sequences.push(run);
      run = [];
    };
    values.forEach((value, index) => {
      const previous = run[run.length - 1];
      if (!run.length || allowedSteps.includes(value - previous)) run.push(value);
      else { flush(); run = [value]; }
      if (index === values.length - 1) flush();
    });
    return sequences;
  };
  const addVariant = (key, sequences, drawIndex) => {
    const stat = ladderVariantStats[key];
    if (!stat || !sequences.length) return;
    stat.draws += 1;
    stat.sequences += sequences.length;
    sequences.forEach((sequence) => {
      stat.longest = Math.max(stat.longest, sequence.length);
      const label = sequence.map(numberKey).join('–');
      stat.patterns.set(label, (stat.patterns.get(label) || 0) + 1);
    });
  };
  draws.forEach((draw, drawIndex) => {
    const values = normalizedNumbers(draw);
    values.forEach((number) => {
      const key = numberKey(number);
      frequency.set(key, (frequency.get(key) || 0) + 1);
      tailCounts[String(number % 10)] += 1;
    });
    for (let left = 0; left < values.length; left += 1) {
      for (let right = left + 1; right < values.length; right += 1) {
        const key = `${numberKey(values[left])}、${numberKey(values[right])}`;
        coOccurrence.set(key, (coOccurrence.get(key) || 0) + 1);
      }
    }
    let run = [];
    const sequences = [];
    values.forEach((value, index) => {
      if (!run.length || value === run[run.length - 1] + 1) run.push(value);
      else { if (run.length >= 2) sequences.push(run); run = [value]; }
      if (index === values.length - 1 && run.length >= 2) sequences.push(run);
    });
    if (sequences.length) ladderDraws += 1;
    addVariant('step1', sequences, drawIndex);
    addVariant('step2', collectSequences(values, [2]), drawIndex);
    addVariant('step3', collectSequences(values, [3]), drawIndex);
    const mixedSequences = collectSequences(values, [1, 2], 3).filter((sequence) => sequence.some((value, index) => index > 0 && value - sequence[index - 1] === 2));
    addVariant('mixed', mixedSequences, drawIndex);
    sequences.forEach((sequence) => {
      ladderSequences += 1;
      longestLadder = Math.max(longestLadder, sequence.length);
      const label = sequence.map(numberKey).join('–');
      ladderPatterns.set(label, (ladderPatterns.get(label) || 0) + 1);
    });
  });
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
  const regularityNumbers = allNumbers.map((item) => {
    const occurrences = draws.reduce((indexes, draw, index) => (draw.numbers || []).some((value) => numberKey(Number(value)) === item.number) ? [...indexes, index] : indexes, []);
    const intervals = occurrences.slice(1).map((value, index) => value - occurrences[index]);
    const meanGap = intervals.length ? intervals.reduce((total, value) => total + value, 0) / intervals.length : null;
    const gapVariance = meanGap == null ? null : intervals.reduce((total, value) => total + (value - meanGap) ** 2, 0) / intervals.length;
    const gapStd = gapVariance == null ? null : Math.sqrt(gapVariance);
    return { ...item, meanGap, gapStd, repeatRate: intervals.length ? intervals.filter((value) => value === 1).length / intervals.length : null, regularity: meanGap && gapStd != null ? gapStd / meanGap : null };
  }).filter((item) => item.count >= 3).sort((a, b) => (a.regularity ?? Infinity) - (b.regularity ?? Infinity) || b.count - a.count).slice(0, 10);
  const predictiveFeatureCandidates = technicalFeaturePrediction('technical-audit', 10, draws);
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
    predictiveFeatureAudit: {
      candidates: predictiveFeatureCandidates,
      features: ['近10期相對前20期趨勢', '近60期期級頻率', '遺漏訊號', '近10期尾號分布'],
      weights: { trend: 0.45, frequency: 0.25, omission: 0.2, tail: 0.1 },
      rule: '這組特徵由技術分析特徵基線共用；每個目標期只使用更早資料，是否進入正式共識由樣本外閘門決定。階梯與同出仍只作描述性分析。',
    },
    ladderAnalysis: {
      drawRate: draws.length ? ladderDraws / draws.length : null,
      ladderDraws,
      sequenceCount: ladderSequences,
      longest: longestLadder || null,
      topPatterns: [...ladderPatterns.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10),
      rule: '同一期排序後，連續整數至少 2 號視為一組階梯牌；只作描述性統計，不進入預測權重。',
    },
    ladderVariants: ladderVariantSpecs.map((spec) => {
      const stat = ladderVariantStats[spec.key];
      return { key: spec.key, label: spec.label, drawRate: draws.length ? stat.draws / draws.length : null, draws: stat.draws, sequences: stat.sequences, longest: stat.longest || null, topPatterns: [...stat.patterns.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6), rule: spec.rule };
    }),
    numberRegularity: regularityNumbers,
    numberRegularityRule: '以近 30 期每個號碼的出現間隔計算平均間隔、間隔標準差、連續跨期比例；樣本少於 3 次不列入穩定度排序。',
    coOccurrence: [...coOccurrence.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12).map(([pair, count]) => ({ pair, count, rate: draws.length ? count / draws.length : null })),
    tailAnalysis: {
      counts: tailCounts,
      total: Object.values(tailCounts).reduce((total, count) => total + count, 0),
      hotTails: Object.entries(tailCounts).sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0])).slice(0, 3).map(([tail, count]) => ({ tail, count })),
      rule: '尾號取每個開獎號碼除以 10 的餘數；同一期开奖结果的 20 個號碼各計一次。',
    },
    sizePercentages: Object.fromEntries(Object.entries(sizeCounts).map(([key, value]) => [key, percentage(value, sizeTotal)])),
    oddEvenPercentages: Object.fromEntries(Object.entries(oddEvenCounts).map(([key, value]) => [key, percentage(value, oddEvenTotal)])),
    profitabilityFactors: profitabilityFactorResearch(history),
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

function adaptiveEvolutionCandidates(history = [], validationWindow = 0) {
  // 固定兩個權重不足以稱為演化；每輪保留零權重基準、廣域探索點，
  // 再依樣本量加入較細的局部搜尋點。候選集合完全由資料摘要決定，
  // 因此同一份歷史可以重現同一輪搜尋，不會偷偷使用未來資料。
  const valid = history.slice(profileHoldoutWindow, profileHoldoutWindow + validationWindow);
  const recentRates = Array.from({ length: 80 }, (_, index) => {
    const number = index + 1;
    return valid.length ? valid.reduce((sum, draw) => sum + ((draw.numbers || []).some((value) => Number(value) === number) ? 1 : 0), 0) / valid.length : 0.25;
  });
  const mean = recentRates.reduce((sum, value) => sum + value, 0) / Math.max(1, recentRates.length);
  const dispersion = recentRates.reduce((sum, value) => sum + Math.abs(value - mean), 0) / Math.max(1, recentRates.length);
  const grid = validationWindow >= 24 ? [0, 0.04, 0.08, 0.12, 0.18, 0.24, 0.32, 0.40, 0.48] : [0, 0.08, 0.16, 0.24, 0.32, 0.40];
  // 短樣本或高度波動時，加入保守點並避免把近期噪音放大成高權重。
  if (validationWindow < minimumValidationSamples || dispersion > 0.08) grid.push(0.02, 0.06);
  return [...new Set(grid)].sort((a, b) => a - b);
}

function evolveProfiles(history = []) {
  // 只用最新 20 期以外的逐期樣本；每一折只計算一次 10 星排序，再取前綴供各星級使用。
  // 這避免舊版「每個方法／玩法／權重都重建整套模型」造成 Worker 超時，超時後前端才會誤用備援。
  const validationWindow = Math.min(profileValidationWindow, Math.max(0, history.length - profileHoldoutWindow - 1));
  const candidates = adaptiveEvolutionCandidates(history, validationWindow);
  const validationRows = history.slice(profileHoldoutWindow, profileHoldoutWindow + validationWindow);
  const tunableTargets = ['size', 'oddEven', 'superNumber', ...Array.from({ length: 10 }, (_, index) => `${index + 1}星`)];
  const methods = [
    ['梅花易數', 'meihua', 11], ['六爻八卦', 'sixyao', 37], ['河圖洛書', 'luoshu', 61],
    ['數字卦（楚簡研究版）', 'numeral-gua', 73], ['奇門遁甲（九宮研究版）', 'qimen', 89],
    ['太乙九宮（研究版）', 'taiyi', 97], ['民俗統計基線', 'statistics', 113],
    ['技術分析特徵基線', 'technical', 121], ['均勻隨機理論基準', 'uniform', 127], ['頻率窗口基線', 'frequency', 131],
    ['生肖五行研究版', 'bazi', 137], ['三才數理研究版', 'sanCai', 139],
    ['貝葉斯 Beta-Binomial 基線', 'bayesian', 149], ['指數衰減 EWMA 基線', 'ewma', 157],
    ['二狀態 Markov 研究版', 'markov', 163], ['超幾何集合審計基準', 'hypergeometric', 167],
    ['多窗口穩定性基線', 'multiscale', 179], ['排除濾網基線', 'exclusion', 191],
    ['趨勢加權回歸基線', 'regression', 223],
  ];
  if (validationRows.length < minimumValidationSamples) {
    return Object.fromEntries(methods.map(([method]) => [method, { targets: Object.fromEntries(tunableTargets.map((target) => [target, { empiricalWeight: 0, validationSamples: validationRows.length, score: null, baselineRate: null, qualityScore: 0, eligible: false, candidateSearch: { candidates, selected: 0, iteration: 'holdout-insufficient' }, status: `樣本不足（需要 ${minimumValidationSamples} 期），只保留研究結果` }])) }]));
  }
  const scores = Object.fromEntries(methods.map(([method]) => [method, Object.fromEntries(tunableTargets.map((target) => [target, candidates.map((empiricalWeight) => ({ empiricalWeight, wins: 0, trials: 0, profit: 0, payout: 0, matches: 0, baselineMatches: 0, baselineSum: 0 }))]))]));
  for (const [method, kind, seedOffset] of methods) {
    for (const empiricalWeight of candidates) {
      for (const actual of validationRows) {
        const index = history.indexOf(actual);
        const training = history.slice(index + 1, index + maxModelHistory + 1);
        const castingAt = reproducibleCastingAt(actual.drawAt, actual.period);
        const snapshot = { ...actual, period: actual.period, castingAt };
        const casting = castingFor(kind === 'regression' ? 'statistics' : kind, snapshot, '10星', castingAt);
        const tradition = traditionFor(kind === 'regression' ? 'statistics' : kind, casting);
        let tenStar;
        if (kind === 'regression') {
          tenStar = frequencyBaselinePrediction(training, 10);
        } else if (kind === 'exclusion') {
          tenStar = exclusionPrediction(`${castingAt}|${actual.period}|${seedOffset}`, 10, training, '10星').numbers;
        } else {
          tenStar = scoreNumbers(`${castingAt}|${actual.period}|${kind}|${seedOffset}`, 10, tradition, training, empiricalWeight, '10星');
        }
        const predictions = { size: modelCategoryPrediction(kind, seedOffset, casting, training, 'size', empiricalWeight), oddEven: modelCategoryPrediction(kind, seedOffset, casting, training, 'oddEven', empiricalWeight), superNumber: tenStar[0] || '' };
        for (let star = 1; star <= 10; star += 1) predictions[`${star}星`] = tenStar.slice(0, star);
        for (const target of tunableTargets) {
          const prediction = predictions[target];
          const payout = backtestPayout(target, prediction, actual);
          const positive = payout - betCostForTarget(target) > 0;
          const item = scores[method][target].find((candidate) => candidate.empiricalWeight === empiricalWeight);
          item.trials += 1;
          item.wins += positive ? 1 : 0;
          item.profit += payout - betCostForTarget(target);
          item.payout += payout;
          if (target.endsWith('星')) {
            item.matches += (prediction || []).filter((number) => (actual.numbers || []).includes(number)).length;
            item.baselineMatches += Number(target.replace('星', '')) * 20 / 80;
          }
          const baselineRate = positiveProfitBaseline(target, training);
          if (baselineRate != null) item.baselineSum += baselineRate;
        }
      }
    }
  }
  return Object.fromEntries(methods.map(([method]) => [method, { targets: Object.fromEntries(tunableTargets.map((target) => {
    const results = scores[method][target].map((item) => {
      const rate = item.trials ? item.wins / item.trials : 0;
      const baselineRate = item.trials ? item.baselineSum / item.trials : null;
      const confidence = lowerConfidenceBound(rate, item.trials);
      const meanMatches = item.trials ? item.matches / item.trials : null;
      const baselineMatches = item.trials ? item.baselineMatches / item.trials : null;
      const matchLift = meanMatches != null && baselineMatches != null ? meanMatches - baselineMatches : 0;
      const confidenceLift = baselineRate == null ? 0 : confidence - baselineRate;
      const qualityScore = Number(clamp(Math.max(0, confidenceLift) * 5 + Math.max(0, matchLift) * 0.12, 0, 1).toFixed(6));
      const eligible = item.trials >= minimumValidationSamples && (confidenceLift > 0 || matchLift > 0.35);
      return { ...item, score: rate, estimatedRate: (item.wins + 2) / (item.trials + 4), confidence, baselineRate, meanMatches, baselineMatches, qualityScore, validationSamples: item.trials, eligible };
    });
    const best = results.sort((a, b) => b.qualityScore - a.qualityScore || b.confidence - a.confidence || b.score - a.score)[0];
    const evidenceShrink = best?.eligible ? clamp((best.validationSamples - minimumValidationSamples + 1) / Math.max(1, profileValidationWindow - minimumValidationSamples + 1), 0.25, 1) : 0;
    const effectiveWeight = best?.eligible ? Number((best.empiricalWeight * evidenceShrink).toFixed(4)) : 0;
    return [target, { ...(best || { empiricalWeight: 0, trials: 0, score: null, confidence: 0, qualityScore: 0 }), empiricalWeight: effectiveWeight, selectedWeight: best?.empiricalWeight || 0, evidenceShrink, eligible: Boolean(best?.eligible), candidateSearch: { candidates, selected: best?.empiricalWeight || 0, iteration: `walk-forward-${validationWindow}-${candidates.length}` }, status: best?.eligible ? `逐期樣本外 ${validationWindow} 期／在 ${candidates.length} 組候選中選出 ${best.empiricalWeight.toFixed(2)}／品質分數 ${best.qualityScore.toFixed(3)}／納入收縮權重` : `逐期樣本外 ${validationWindow} 期／在 ${candidates.length} 組候選中未通過超額閘門，只作研究比較` }];
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
  if (kind === 'technical') return statisticalCasting(snapshot, target);
  if (['uniform', 'frequency', 'bayesian', 'ewma', 'markov', 'hypergeometric'].includes(kind)) return statisticalCasting(snapshot, target);
  if (kind === 'bayesian') return statisticalCasting(snapshot, target);
  if (kind === 'hypergeometric') return statisticalCasting(snapshot, target);
  if (kind === 'multiscale') return statisticalCasting(snapshot, target);
  if (kind === 'bazi') return zodiacElementCasting(snapshot, target);
  if (kind === 'sanCai') return sanCaiCasting(snapshot, target);
  return taiyiCasting(snapshot, target);
}

function traditionFor(kind, casting) {
  if (kind === 'meihua') return { kind, upper: casting.upper, lower: casting.lower, moving: casting.moving };
  if (kind === 'sixyao') return { kind, bits: casting.binary, moving: casting.lines.filter((line) => line.moving).length, lower: 1 };
  if (kind === 'luoshu') return { kind, center: casting.center };
  if (kind === 'numeral-gua') return { kind, digits: casting.digits };
  if (kind === 'statistics') return { kind, window: casting.window };
  if (kind === 'technical') return { kind, window: casting.window };
  if (['uniform', 'frequency', 'bayesian', 'ewma', 'markov', 'hypergeometric'].includes(kind)) return { kind, window: casting.window };
  if (kind === 'bayesian') return { kind, window: casting.window };
  if (kind === 'hypergeometric') return { kind, window: casting.window };
  if (kind === 'multiscale') return { kind, window: casting.window };
  if (kind === 'bazi') return { kind, element: casting.element, elementIndex: casting.pillars?.yearElement, branch: casting.branch, elements: [casting.pillars?.yearElement, casting.pillars?.monthElement, casting.pillars?.dayElement, casting.pillars?.hourElement].filter(Number.isFinite), branches: [casting.pillars?.yearBranch, casting.pillars?.monthBranch, casting.pillars?.dayBranch, casting.pillars?.hourBranch].filter(Number.isFinite) };
  if (kind === 'sanCai') return { kind, heaven: casting.heaven, human: casting.human };
  return { kind, palace: casting.palace, star: casting.star, door: casting.door, cycle: casting.cycle };
}

function targetTraditionalCategory(casting, target, seed) {
  const values = [casting.upper, casting.lower, casting.moving, casting.palace, casting.center, casting.digits?.[0], casting.cycle, casting.heaven, casting.human].filter(Number.isFinite);
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

function recentRegressionGate(history = [], castingAt = '') {
  const folds = [];
  const limit = Math.min(30, Math.max(0, history.length - 1));
  for (let index = 0; index < limit; index += 1) {
    const actual = history[index];
    const prior = history.slice(index + 1);
    if (!prior.length) continue;
    const predicted = buildWeightedRegressionModel(actual, prior, reproducibleCastingAt(castingAt || actual.drawAt, actual.period), { includeNumbers: true, skipGate: true });
    const numbers = predicted.official.basic['10星'] || [];
    const matches = numbers.filter((number) => (actual.numbers || []).includes(number)).length;
    const sizeActual = normalizeDrawCategory(actual.size, 'size');
    const oddActual = normalizeDrawCategory(actual.oddEven, 'oddEven');
    const sizeHit = ['大', '小'].includes(sizeActual) && predicted.official.size === sizeActual;
    const oddHit = ['單', '雙'].includes(oddActual) && predicted.official.oddEven === oddActual;
    folds.push({ matches, sizeHit, oddHit, sizeValid: ['大', '小'].includes(sizeActual), oddValid: ['單', '雙'].includes(oddActual) });
  }
  const matchValues = folds.map((item) => item.matches);
  const meanMatches = matchValues.length ? matchValues.reduce((sum, value) => sum + value, 0) / matchValues.length : null;
  const matchSe = meanMatches == null ? null : Math.sqrt(Math.max(0, 2.5 * (1 - 2.5 / 20)) / Math.max(1, folds.length));
  const matchLower = meanMatches == null ? null : meanMatches - 1.96 * (matchSe || 0);
  const categoryRate = (key, validKey) => {
    const valid = folds.filter((item) => item[validKey]);
    return valid.length ? valid.filter((item) => item[key]).length / valid.length : null;
  };
  const sizeRate = categoryRate('sizeHit', 'sizeValid');
  const oddRate = categoryRate('oddHit', 'oddValid');
  const eligible = folds.length >= 20 && matchLower != null && matchLower > 2.5 && ((sizeRate != null && sizeRate > 0.53) || (oddRate != null && oddRate > 0.53));
  return { eligible, folds: folds.length, meanMatches, randomMeanMatches: 2.5, matchLower, sizeRate, oddRate, baseline: { numberMatches: 2.5, categoryRate: 0.5 }, rule: '近期 30 折 walk-forward；10 星平均命中須以 95% 下限超過 2.5，且大小或單雙勝率超過 53%。' };
}

function buildWeightedRegressionModel(snapshot, history, castingAt, options = {}) {
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
  const picks = (count) => scores.slice(0, count).map((item) => String(item.number).padStart(2, '0'));
  const basic = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`${index + 1}星`, picks(index + 1)]));
  const superNumber = picks(1)[0] || '';
  const recentGate = options.skipGate ? { eligible: false, reason: '驗證中' } : recentRegressionGate(history, castingAt);
  return {
    name: '趨勢加權回歸基線',
    status: recentGate.eligible ? '近期超過基準；納入候選權重' : '近期未明顯超過基準；權重歸零',
    rule: '以近 12／60／300 期趨勢、動能與穩定度訓練 Logistic；每個號碼獨立估計出現機率，只有近期樣本外超過基準才可加權。',
    sources: modelSources['趨勢加權回歸基線'] || [],
    calculation: {
      algorithmVersion: algorithmVersion(), method: 'trend-weighted-logistic', evidenceTier: '可重現機器學習基線', predictionEligible: recentGate.eligible,
      castingSource: 'prequential-history-only', castingAt, historySamples: history.length,
      featureNames: ['近12期大號率', '近12期單數率', '近12期和值率', '近60期大號率', '近60期單數率', '近60期和值率', '最新大號率', '最新單數率'],
      probabilities: { size: sizeProbability, oddEven: oddEvenProbability },
      trainingSamples: samples.length, regularization: 0.35, recentGate,
    },
    official: { size: sizeProbability >= 0.5 ? '大' : '小', oddEven: oddEvenProbability >= 0.5 ? '單' : '雙', superNumber, basic },
    research: { numberPicks: basic['10星'], numberPicks20: scores.slice(0, 20).map((item) => String(item.number).padStart(2, '0')), sumBand: '由模型候選另行統計', oddEvenCount: '由模型候選另行統計', highLowCount: '由模型候選另行統計', zones: ['趨勢加權回歸'], targetResearch: {} },
  };
}

function recentTargetGate(modelName, target, history = []) {
  const rows = history.slice(0, profileValidationWindow).filter((item) => item?.models?.some((model) => model.name === modelName));
  if (rows.length < minimumValidationSamples) return { eligible: false, samples: rows.length, reason: `近期樣本不足（至少 ${minimumValidationSamples} 期）` };
  if (target === 'size' || target === 'oddEven') {
    const field = target === 'size' ? 'size' : 'oddEven';
    const valid = rows.filter((item) => ['大', '小', '單', '雙'].includes(normalizeDrawCategory(item[field], field)));
    const wins = valid.filter((item) => {
      const model = item.models.find((candidate) => candidate.name === modelName);
      return validPredictionCategory(model?.official?.[field], field) === normalizeDrawCategory(item[field], field);
    }).length;
    const rate = valid.length ? wins / valid.length : 0;
    return { eligible: valid.length >= minimumValidationSamples && rate >= 0.55, samples: valid.length, rate, baseline: 0.5 };
  }
  if (target === 'superNumber') {
    // 超級獎號是單一號碼，不是「星級」號碼集合；不能讀 official.basic["superNumber"]。
    // 這裡沿用回測的「淨利大於 0 才算勝利」定義，命中一般 20 號只損益打平，不算勝利。
    const valid = rows.filter((item) => normalizeNumberValue(item.superNumber));
    const wins = valid.filter((item) => {
      const model = item.models.find((candidate) => candidate.name === modelName);
      return hasPositiveProfit(target, model?.official?.superNumber, item);
    }).length;
    const rate = valid.length ? wins / valid.length : 0;
    const baseline = 1 / 80;
    return { eligible: valid.length >= minimumValidationSamples && rate > baseline, samples: valid.length, wins, rate, baseline };
  }
  const count = Number(String(target).replace('星', '')) || 10;
  const matches = rows.map((item) => {
    const model = item.models.find((candidate) => candidate.name === modelName);
    const predicted = model?.official?.basic?.[target] || [];
    const actual = new Set(item.numbers || []);
    return predicted.filter((number) => actual.has(number)).length;
  });
  const mean = matches.reduce((sum, value) => sum + value, 0) / matches.length;
  const baseline = count * 20 / 80;
  return { eligible: mean >= baseline + 0.2, samples: matches.length, mean, baseline };
}

function aggregateModel(models, history) {
  const eligibleModels = models.filter((model) => model.calculation?.predictionEligible !== false
    && !['uniform', 'hypergeometric'].includes(model.calculation?.method));
  // 玄學／文化模型保留在研究頁比較，但不在統計證據不足時稀釋基線。
  // 只有明確標示可檢驗統計或可重現機器學習的模型進入正式共識。
  const quantitativeModels = eligibleModels.filter((model) => {
    const tier = String(model.calculation?.evidenceTier || '');
    return tier.includes('可檢驗統計') || tier.includes('可重現機器學習')
      || ['technical', 'frequency', 'bayesian', 'ewma', 'markov'].includes(model.calculation?.method);
  });
  const formalBaselineModels = models.filter((model) => model.calculation?.predictionEligible !== false
    && ['uniform', 'frequency', 'bayesian', 'ewma', 'markov', 'hypergeometric', 'multiscale', 'exclusion', 'technical', 'regression'].includes(model.calculation?.method));
  // 沒有模型通過樣本外閘門時，只能退回可檢驗統計基準；禁止把玄學模型等權混入正式共識。
  const ensembleModels = quantitativeModels.length ? quantitativeModels : formalBaselineModels;
  const hasValidatedWeight = ensembleModels.some((model) => predictionTargets.some((target) => {
    const evolution = model.calculation?.evolution?.[target];
    return evolution?.eligible === true && Number(evolution?.qualityScore) > 0;
  }));
  const hasFallbackEvidence = (target) => ensembleModels.some((model) => {
    const evolution = model.calculation?.evolution?.[target];
    return Number(evolution?.trials || evolution?.validationSamples || 0) >= minimumValidationSamples;
  });
  const weightFor = (model, target) => {
    const evolution = model.calculation?.evolution?.[target];
    const qualityScore = Number(evolution?.qualityScore || 0);
    const samples = Number(evolution?.trials || evolution?.validationSamples || 0);
    // 最新十期只作獨立檢視；長窗口品質分數才是主要權重來源。
    if (!hasValidatedWeight) {
      return hasFallbackEvidence(target) && samples >= minimumValidationSamples ? 1 : 0;
    }
    if (evolution?.eligible !== true || qualityScore <= 0 || samples < minimumValidationSamples) return 0;
    const recentGate = recentTargetGate(model.name, target, history);
    const recentFactor = Number(recentGate.samples || 0) >= minimumValidationSamples
      ? (recentGate.eligible ? 1 : 0.25)
      : 1;
    const sampleFactor = clamp(samples / profileValidationWindow, 0.35, 1);
    return qualityScore * sampleFactor * recentFactor;
  };
  const weightedCategory = (target) => {
    const totals = new Map();
    const field = target === 'size' ? 'size' : 'oddEven';
    const addVotes = (fallback = false) => ensembleModels.forEach((model) => {
      // 「和」只代表開獎後未達投注門檻，禁止進入預測投票。
      const value = validPredictionCategory(model.official?.[field], field);
      const weight = fallback ? 1 : weightFor(model, target);
      if (value && weight > 0) totals.set(value, (totals.get(value) || 0) + weight);
    });
    addVotes();
    // 某一玩法沒有模型通過品質閘門時，仍從「正式統計模型」做等權投票，
    // 不把空值或本地備援冒充成預測，也不讓整個正式結果變成空白。
    if (!totals.size) addVotes(true);
    return [...totals.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0] || '';
  };
  const weightedNumbers = (target) => {
    const size = Number(String(target).replace('星', ''));
    const totals = new Map();
    const support = new Map();
    const addNumbers = (fallback = false) => ensembleModels.forEach((model) => {
      const weight = fallback ? 1 : weightFor(model, target);
      if (weight <= 0) return;
      // 混合式取號：模型權重決定「這個模型有多重要」，名次衰減決定
      // 同一模型的第 1 名比第 10 名更重要；不把每個模型硬分配固定數量。
      // 10 星使用各模型的 20 號研究母體，先形成候選池，再取最高分的 10 號。
      const picks = target === '10星'
        ? (model.research?.numberPicks20 || model.official.basic?.[target] || [])
        : (model.research?.targetResearch?.[target]?.numberPicks || model.official.basic?.[target] || []);
      const uniquePicks = [...new Set(picks.map(normalizeNumberValue).filter((number) => Number(number) >= 1 && Number(number) <= 80))];
      const rankMass = uniquePicks.reduce((sum, _, index) => sum + 1 / Math.sqrt(index + 1), 0) || 1;
      uniquePicks.forEach((number, index) => {
        const rankContribution = (1 / Math.sqrt(index + 1)) / rankMass;
        totals.set(number, (totals.get(number) || 0) + weight * rankContribution);
        support.set(number, (support.get(number) || 0) + 1);
      });
    });
    addNumbers();
    if (!totals.size) addNumbers(true);
    const ranked = [...totals.entries()]
      .sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))
      .map(([number, score], index) => ({ number, score, support: support.get(number) || 0, rank: index + 1 }));
    candidateRankings[target] = ranked.slice(0, 20);
    const composition = target === '10星' ? evaluateCompositionStrategies(history, target, size) : { samples: 0, topMean: null, balancedMean: null, lift: null, selected: 'ranked-top-k', rule: '目前只對 10 星研究區間平衡配號；其他星級維持模型原生前 K。' };
    const selectedItems = composition.selected === 'zone-balanced' ? zoneBalancedComposition(ranked, size) : ranked.slice(0, size);
    const selected = selectedItems.map(({ number }) => number);
    // 防止某些正式模型輸出不完整，最後仍補足合法且不重複的號碼。
    if (selected.length < size) {
      for (let number = 1; number <= 80 && selected.length < size; number += 1) {
        const value = String(number).padStart(2, '0');
        if (!selected.includes(value)) selected.push(value);
      }
    }
    return selected.sort((a, b) => Number(a) - Number(b));
  };
  const candidateRankings = {};
  const superVotes = new Map();
  const addSuperVotes = (fallback = false) => ensembleModels.forEach((model) => {
    const number = normalizeNumberValue(model.official?.superNumber);
    const weight = fallback ? 1 : weightFor(model, 'superNumber');
    if (Number(number) >= 1 && Number(number) <= 80 && weight > 0) superVotes.set(number, (superVotes.get(number) || 0) + weight);
  });
  addSuperVotes();
  if (!superVotes.size) addSuperVotes(true);
  const superNumber = [...superVotes.entries()].sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))[0]?.[0] || '';
  const basic = Object.fromEntries(Array.from({ length: 10 }, (_, index) => {
    const target = `${index + 1}星`;
    return [target, weightedNumbers(target)];
  }));
  const zonePredictions = NUMBER_ZONES.map((zone) => {
    const totals = new Map();
    ensembleModels.forEach((model) => {
      const weight = weightFor(model, '10星');
      const zoneResult = model.research?.zonePredictions?.find((item) => item.key === zone.key);
      if (weight <= 0 || !zoneResult) return;
      (zoneResult.numbers || []).forEach((number) => totals.set(number, (totals.get(number) || 0) + weight));
    });
    return { ...zone, numbers: [...totals.entries()].sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0])).slice(0, 5).map(([number]) => number) };
  });
  const weightedModelCount = ensembleModels.filter((model) => predictionTargets.some((target) => weightFor(model, target) > 0)).length;
  return {
    name: '多模型聚合',
    status: hasValidatedWeight ? '依樣本外品質分數與近期閘門加權的統計共識' : '完成樣本外評估的統計模型等權共識；尚未證明超越基準',
    rule: hasValidatedWeight ? '先通過資料與樣本外閘門，再以信賴下限超額、命中提升與樣本收縮加權；ROI 只作展示，不直接決定權重。' : '玄學模型保留作研究比較；正式共識只使用可檢驗統計／回歸基線，資料不足時不製造虛假權重。',
    sources: [],
    calculation: {
      algorithmVersion: algorithmVersion(),
      method: 'ensemble',
      castingSource: 'weighted-model-consensus',
      castingAt: models[0]?.calculation?.castingAt || '',
      historySamples: history.length,
      aggregation: hasValidatedWeight
        ? '混合式取號：模型品質分數 × 樣本收縮 × 近期閘門，再以模型內名次衰減聚合；10 星先用 20 號研究母體取前 10 號'
        : '混合式取號：可檢驗模型等權，但模型內仍按候選名次衰減；不代表超越基準',
      weightedModelCount,
      ensembleUniverse: ensembleModels.map((model) => model.name),
      commonCasting: '多模型聚合不另起卦；它整合各子模型在同一固定輸入下的結果。',
      commonCastingValue: '多模型加權整合',
      targetRules: Object.fromEntries(predictionTargets.map((target) => [target, '以各子模型同一玩法的樣本外權重乘名次衰減形成號碼分數，再取前 k；不是每模型固定配額，也不產生獨立卦象。'])),
      candidateScoring: '每個模型先保留原生號碼排名；跨模型以品質權重 × 1/√名次正規化加總，並記錄支持模型數；同分時以號碼小者固定破平。無樣本外證據時只退回統計基準，不混入玄學模型。',
      ensembleMode: quantitativeModels.length ? 'quantitative-evidence' : 'formal-statistical-baseline-fallback',
    },
    official: { size: weightedCategory('size'), oddEven: weightedCategory('oddEven'), superNumber, basic },
    research: {
      numberPicks: basic['10星'] || [],
      sumBand: '由共識號碼另行統計',
      oddEvenCount: '由共識號碼另行統計',
      highLowCount: '由共識號碼另行統計',
      zones: zonePredictions.map((zone) => zone.label),
      zonePredictions,
      candidateRankings,
      compositionDiagnostics: Object.fromEntries(predictionTargets.map((target) => [target, target === '10星' ? evaluateCompositionStrategies(history, target, 10) : { selected: 'ranked-top-k', samples: 0, rule: '其他星級維持模型原生前 K。' }])),
    },
  };
}

export function buildModels(snapshot, history = [], options = {}) {
  // maxModelHistory 是模型資料邊界；避免把數千期舊資料帶入每個折次，
  // 造成冷啟動過慢，也讓不同模型實際使用的資料範圍一致。
  history = history.slice(0, maxModelHistory);
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
    { name: '技術分析特徵基線', kind: 'technical', status: '共用技術分析的趨勢／頻率／遺漏／尾號特徵，須通過樣本外驗證才可進共識', seedOffset: 121 },
    { name: '均勻隨機理論基準', kind: 'uniform', status: '每個號碼等機率的理論對照，不宣稱預測優勢', seedOffset: 127 },
    { name: '頻率窗口基線', kind: 'frequency', status: '只用目標期以前 60 期的出現率排序，不加入術數特徵', seedOffset: 131 },
    { name: '生肖五行研究版', kind: 'bazi', status: '農曆年干支／五行固定映射＋統計適配，非完整八字排盤', seedOffset: 137 },
    { name: '三才數理研究版', kind: 'sanCai', status: '天／人時間層＋地才號碼結構的研究適配，非姓名筆畫三才', seedOffset: 139 },
    { name: '貝葉斯 Beta-Binomial 基線', kind: 'bayesian', status: '以 Beta 先驗收縮每個號碼的期級出現率，避免短樣本極端值', seedOffset: 149 },
    { name: '指數衰減 EWMA 基線', kind: 'ewma', status: '以固定衰減率給近期期數較高權重，不使用傳統術數映射', seedOffset: 157 },
    { name: '二狀態 Markov 研究版', kind: 'markov', status: '以每個號碼「上一期出現／未出現」狀態估計下一期條件率', seedOffset: 163 },
    { name: '超幾何集合審計基準', kind: 'hypergeometric', status: '以 80 選 20 不放回理論作集合命中與隨機性對照，不產生優勢預測', seedOffset: 167 },
    { name: '多窗口穩定性基線', kind: 'multiscale', status: '近 12／60／300 期多時間窗；對短期訊號施加穩定性懲罰', seedOffset: 179 },
    { name: '排除濾網基線', kind: 'exclusion', status: 'walk-forward 排除驗證；只啟用樣本外顯著低於 25% 基準的濾網', seedOffset: 191 },
  ].filter((method) => !options.onlyMethod || method.name === options.onlyMethod);
  const baseModels = methods.flatMap((method) => {
    try {
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
      calculation: { algorithmVersion: algorithmVersion(), method: method.kind, evidenceTier: ['bayesian', 'statistics', 'hypergeometric', 'multiscale', 'exclusion'].includes(method.kind) ? '可檢驗統計基線' : '文化／文本特徵適配，非已證實預測法', predictionEligible: true, castingSource: 'prediction-time-common', castingAt, historySamples: history.length, empiricalWeight: history.length ? weights['10星'] : 0, empiricalWeights: weights, evolution: profilesForMethod.targets || null, exclusionFilters: exclusionDetails, commonCasting: commonCasting.formula, commonCastingValue: method.kind === 'meihua' ? `上卦${commonCasting.upper}／下卦${commonCasting.lower}／動爻${commonCasting.moving}` : method.kind === 'sixyao' ? commonCasting.lines.map((line) => line.value).join('、') : method.kind === 'qimen' ? `九宮${commonCasting.palace}／九星${commonCasting.star}／八門${commonCasting.door}` : method.kind === 'taiyi' ? `行宮${commonCasting.palace}／循環${commonCasting.cycle}` : method.kind === 'luoshu' ? `宮位${commonCasting.palace}／數${commonCasting.center}` : method.kind === 'bazi' ? `年元素${commonCasting.element}／生肖支序${commonCasting.branch + 1}` : method.kind === 'statistics' ? '統計基線：熱度／遺漏／和值／奇偶／區間' : method.kind === 'bayesian' ? 'Beta／Dirichlet 平滑：避免零頻率與過度追逐短期波動' : method.kind === 'hypergeometric' ? '超幾何集合：每期 80 選 20、不放回，不把號碼誤當獨立抽樣' : method.kind === 'multiscale' ? '多窗口頻率：12／60／300 期加權，偏離穩定性時降權' : method.kind === 'exclusion' ? '排除濾網：逐濾網 walk-forward 驗證，低於 25% 基準且樣本足夠才啟用' : (commonCasting.digits || []).join('、'), targetRules: Object.fromEntries(predictionTargets.map((target) => [target, targetRule(target)])), targetCastings: Object.fromEntries(predictionTargets.map((target) => [target, targetCastings[target].formula])), targetCastingValues: Object.fromEntries(predictionTargets.map((target) => {
        const casting = targetCastings[target];
        if (method.kind === 'sixyao') return [target, casting.lines.map((line) => line.value).join('、')];
        if (method.kind === 'numeral-gua') return [target, casting.digits.join('、')];
        if (method.kind === 'meihua') return [target, `共同卦象：上卦${casting.upper}／下卦${casting.lower}／動爻${casting.moving}`];
        if (method.kind === 'qimen') return [target, `九宮${casting.palace}／九星${casting.star}／八門${casting.door}`];
        if (method.kind === 'taiyi') return [target, `行宮${casting.palace}／循環${casting.cycle}`];
        if (method.kind === 'sanCai') return [target, `天${casting.heaven}／人${casting.human}／地才＝號碼區域＋尾數`];
        if (method.kind === 'technical') return [target, '技術特徵：趨勢／頻率／遺漏／尾號'];
        if (method.kind === 'bazi') return [target, `年${casting.pillars.yearStem}/${casting.pillars.yearBranch}・月${casting.pillars.monthStem}/${casting.pillars.monthBranch}・日${casting.pillars.dayStem}/${casting.pillars.dayBranch}・時${casting.pillars.hourStem}/${casting.pillars.hourBranch}`];
        if (method.kind === 'statistics') return [target, '固定統計窗口 60 期／目標期前資料'];
        if (['uniform', 'frequency', 'bayesian', 'ewma', 'markov', 'hypergeometric'].includes(method.kind)) return [target, casting.formula];
        if (method.kind === 'bayesian') return [target, 'Beta／Dirichlet 平滑窗口 60 期／目標期前資料'];
        if (method.kind === 'hypergeometric') return [target, '80 選 20 不放回集合包含率／目標期前資料'];
        if (method.kind === 'multiscale') return [target, '12／60／300 期頻率與跨窗口穩定性／目標期前資料'];
        if (method.kind === 'exclusion') return [target, '逐濾網 walk-forward 驗證／目標期前資料'];
        if (method.kind === 'bazi') return [target, `年元素${casting.element}／生肖支序${casting.branch + 1}`];
        if (method.kind === 'luoshu') return [target, `宮位${casting.palace}／數${casting.center}`];
        return [target, casting.digits.join('、')];
      })) },
      official: {
        size: validPredictionCategory(modelCategoryPrediction(method.kind, modelSeed, targetCastings.size, history, 'size', weights.size), 'size'),
        oddEven: validPredictionCategory(modelCategoryPrediction(method.kind, modelSeed, targetCastings.oddEven, history, 'oddEven', weights.oddEven), 'oddEven'),
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
    } catch (error) {
      // 單一研究方法的欄位／起卦錯誤不能讓整批正式模型回傳空陣列。
      console.error(JSON.stringify({ event: 'model-method-failed', method: method.name, message: error instanceof Error ? error.message : String(error) }));
      return [];
    }
  });
  let regressionModel = [];
  if (!options.onlyMethod || options.onlyMethod === '趨勢加權回歸基線') {
    try {
      regressionModel = [buildWeightedRegressionModel(snapshot, history, castingAt)];
    } catch (error) {
      console.error(JSON.stringify({ event: 'model-method-failed', method: '趨勢加權回歸基線', message: error instanceof Error ? error.message : String(error) }));
    }
  }
  const allModels = [...baseModels, ...regressionModel];
  const normalizedModels = allModels.map((model) => model.calculation?.method === 'technical'
    ? { ...model, calculation: { ...model.calculation, evidenceTier: '可檢驗統計基線', predictionEligible: true, commonCastingValue: '技術特徵：趨勢／頻率／遺漏／尾號' } }
    : model);
  return [...normalizedModels, aggregateModel(normalizedModels, history)];
}

let modelWorker;
let modelRequestId = 0;
const pendingModelRequests = new Map();
let evaluationWorker;
let evaluationRequestId = 0;
const pendingEvaluationRequests = new Map();

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
    ensureModelWorker().postMessage({ requestId, snapshot, history: history.slice(0, liveModelHistoryLimit), options });
  });
}

function ensureEvaluationWorker() {
  if (evaluationWorker) return evaluationWorker;
  evaluationWorker = new Worker(new URL('./evaluation-worker.mjs', import.meta.url));
  evaluationWorker.on('message', (message) => {
    if (message?.progress) {
      setComputationProgress({
        stage: message.progress.stage,
        percent: message.progress.percent,
        message: message.progress.message,
        runId: message.runId || computationProgress.runId,
      });
      return;
    }
    const pending = pendingEvaluationRequests.get(message?.requestId);
    if (!pending) return;
    pendingEvaluationRequests.delete(message.requestId);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.evaluation || {});
  });
  const failPending = (error) => {
    for (const pending of pendingEvaluationRequests.values()) pending.reject(error);
    pendingEvaluationRequests.clear();
    evaluationWorker = undefined;
  };
  evaluationWorker.on('error', (error) => failPending(error));
  evaluationWorker.on('exit', (code) => {
    if (code !== 0) failPending(new Error(`評估 Worker 結束碼 ${code}`));
    else evaluationWorker = undefined;
  });
  return evaluationWorker;
}

function evaluateInWorker(history = [], runId = '') {
  return new Promise((resolve, reject) => {
    const requestId = ++evaluationRequestId;
    pendingEvaluationRequests.set(requestId, { resolve, reject });
    ensureEvaluationWorker().postMessage({ requestId, history: history.slice(0, evaluationHistoryLimit), runId });
  });
}

function evaluateInWorkerWithTimeout(history = [], timeoutMs = 12000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`回測 Worker 超時（${timeoutMs}ms）`);
      const worker = evaluationWorker;
      evaluationWorker = undefined;
      for (const pending of pendingEvaluationRequests.values()) pending.reject(error);
      pendingEvaluationRequests.clear();
      void worker?.terminate();
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([evaluateInWorker(history), timeout]).finally(() => clearTimeout(timer));
}

function fastProfitabilityEvaluation(history = [], windowSize = quickDecisionBacktestWindow) {
  const plays = [
    { key: 'size', label: '猜大小' }, { key: 'oddEven', label: '猜單雙' }, { key: 'superNumber', label: '超級獎號' },
    ...Array.from({ length: 10 }, (_, index) => ({ key: `${index + 1}星`, label: `${index + 1} 星` })),
  ];
  const currentModels = (history[0]?.models || []).filter((model) => model.name !== '多模型聚合');
  const bestModelFor = (key) => [...currentModels].sort((a, b) => {
    const aa = a.calculation?.evolution?.[key] || {}; const bb = b.calculation?.evolution?.[key] || {};
    return Number(bb.profit || -Infinity) - Number(aa.profit || -Infinity) || String(a.name).localeCompare(String(b.name));
  })[0] || currentModels[0];
  const predictionFor = (model, key) => key === 'size' ? model?.official?.size : key === 'oddEven' ? model?.official?.oddEven : key === 'superNumber' ? model?.official?.superNumber : model?.official?.basic?.[key] || [];
  const evaluate = (play, mode) => {
    const anchor = bestModelFor(play.key);
    const periodResults = history.slice(0, windowSize).flatMap((actual, index) => {
      // 每個已完成目標期只能使用更舊一列保存的模型；缺少模型就排除，不能用目前預測補值。
      const model = (history[index + 1]?.models || []).find((candidate) => candidate.name === anchor?.name);
      if (!model || !Array.isArray(actual?.numbers) || actual.numbers.length !== 20) return [];
      const predicted = predictionFor(model, play.key);
      const payout = backtestPayout(play.key, predicted, actual);
      const net = payout - betCostForTarget(play.key);
      const predictedNumbers = Array.isArray(predicted) ? predicted : [];
      const actualNumbers = new Set((actual.numbers || []).map(normalizeNumberValue));
      const matches = Array.isArray(predicted) ? predictedNumbers.filter((number) => actualNumbers.has(normalizeNumberValue(number))).length : (payout > 0 ? 1 : 0);
      return [{ period: String(actual.period || ''), drawAt: actual.drawAt || '', prediction: Array.isArray(predicted) ? predicted.join('、') : String(predicted || '—'), matches, targetCount: Array.isArray(predicted) ? predictedNumbers.length : 1, payout, net, profitable: net > 0, observed: play.key === 'size' ? normalizeDrawCategory(actual.size, 'size') : play.key === 'oddEven' ? normalizeDrawCategory(actual.oddEven, 'oddEven') : '' }];
    });
    const profit = periodResults.reduce((sum, item) => sum + item.net, 0);
    const wins = periodResults.filter((item) => item.profitable).length;
    const isCategory = play.key === 'size' || play.key === 'oddEven';
    const validSamples = isCategory ? periodResults.filter((item) => ['大', '小', '單', '雙'].includes(item.observed)).length : periodResults.length;
    const excludedSamples = isCategory ? periodResults.filter((item) => !['大', '小', '單', '雙'].includes(item.observed)).length : 0;
    const categoryHits = isCategory ? periodResults.filter((item) => {
      const predictedValue = normalizeDrawCategory(item.prediction, play.key);
      return ['大', '小', '單', '雙'].includes(item.observed) && predictedValue === item.observed;
    }).length : periodResults.reduce((sum, item) => sum + item.matches, 0);
    const result = { mode, model: anchor?.name || '—', samples: periodResults.length, wins, profit, payoutTotal: periodResults.reduce((sum, item) => sum + item.payout, 0), costTotal: periodResults.length * betCostForTarget(play.key), matches: periodResults.reduce((sum, item) => sum + item.matches, 0), targetCount: periodResults.reduce((sum, item) => sum + item.targetCount, 0), averageProfit: periodResults.length ? profit / periodResults.length : null, positiveExpected: periodResults.length > 0 && profit / periodResults.length > 0, profitRate: periodResults.length ? wins / periodResults.length : null, hitRate: isCategory ? (validSamples ? categoryHits / validSamples : null) : (periodResults.length ? wins / periodResults.length : null), validSamples, excludedSamples, categoryHits, baselineHitRate: isCategory ? 0.5 : null, prediction: predictionFor(anchor, play.key), periodResults, fallback: `快速判斷：最近 ${windowSize} 期；缺少歷史模型的期數已排除；完整 ${profitabilityBacktestWindow} 期回測在背景更新`, evaluationMode: 'quick' };
    return result;
  };
  return plays.map((play) => { const fixed = evaluate(play, 'fixed'); const follow = evaluate(play, 'follow'); return { ...play, metricLabel: '盈利機率', best: fixed, fixed, follow }; });
}

function quickBacktestLeakageGuard(history = [], windowSize = quickDecisionBacktestWindow) {
  const checks = history.slice(0, windowSize).map((actual, index) => {
    const source = history[index + 1];
    const targetPeriod = Number(actual?.period);
    const sourcePeriod = Number(source?.period);
    const modelSourceLeaked = Number.isFinite(targetPeriod) && Number.isFinite(sourcePeriod) && sourcePeriod >= targetPeriod;
    const modelMissing = !Array.isArray(source?.models) || !source.models.length;
    return { targetPeriod: actual?.period || '', modelSourcePeriod: source?.period || '', modelSourceLeaked, modelMissing };
  });
  return {
    window: windowSize,
    checkedTargets: checks.length,
    excludedSamples: checks.filter((check) => check.modelMissing).length,
    violations: checks.filter((check) => check.modelSourceLeaked).length,
    passed: checks.every((check) => !check.modelSourceLeaked),
    rule: '快速回測只用已完成開獎期；每期模型必須來自更舊一期；缺少模型時排除，不使用目前預測補值。',
  };
}

function formalModelCacheKey(snapshot, history = [], options = {}) {
  const castingAt = reproducibleCastingAt(options.castingAt || snapshot.castingAt, snapshot.period);
  // 模型使用日期／時辰等可重現特徵；秒數不應造成同一分鐘重算。
  const castingMinute = castingAt.slice(0, 16);
  const historyFingerprint = history.slice(0, maxModelHistory).map((item) => ({
    period: item.period,
    numbers: item.numbers,
    superNumber: item.superNumber,
    size: item.size,
    oddEven: item.oddEven,
  }));
  return createHash('sha1').update(JSON.stringify({
    version: reproducibilityVersion,
    targetPeriod: snapshot.period,
    castingMinute,
    history: historyFingerprint,
    onlyMethod: options.onlyMethod || '',
    evolve: options.evolve !== false,
  })).digest('hex');
}

async function buildModelsCached(snapshot, history = [], options = {}) {
  const key = formalModelCacheKey(snapshot, history, options);
  const cached = formalModelCache.get(key);
  if (cached && Date.now() - cached.createdAt < formalModelCacheTtlMs) return cached.models;
  const inFlight = formalModelInFlight.get(key);
  if (inFlight) return inFlight;
  const promise = buildModelsInWorker(snapshot, history, options)
    .then((models) => {
      formalModelCache.set(key, { createdAt: Date.now(), models });
      while (formalModelCache.size > 8) formalModelCache.delete(formalModelCache.keys().next().value);
      return models;
    })
    .finally(() => formalModelInFlight.delete(key));
  formalModelInFlight.set(key, promise);
  return promise;
}

async function fetchOfficial(daysOverride = null) {
  const requestedDays = daysOverride ?? Number(process.env.HISTORY_DAYS || defaultHistoryDays);
  const historyDays = daysOverride != null
    ? Math.min(retentionDays, Math.max(1, daysOverride))
    : Math.min(retentionDays, Math.max(1, Number.isFinite(requestedDays) ? requestedDays : defaultHistoryDays));
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
    // 官方 API 已提供猜大小／猜單雙結果；有值時以官方欄位為準，
    // 只有欄位缺失才回退到 20 個號碼的可重算分類。
    const officialSize = normalizeDrawCategory(record.highLowTop, 'size');
    const officialOddEven = normalizeDrawCategory(record.oddEvenTop, 'oddEven');
    if (['大', '小', '和'].includes(officialSize)) snapshot.size = officialSize;
    if (['單', '雙', '和'].includes(officialOddEven)) snapshot.oddEven = officialOddEven;
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

function compactHistoryForResponse(history, preserveModelCount = 0) {
  return history.map((item, index) => {
    if (index <= preserveModelCount) return item;
    const { models, ...compact } = item;
    return compact;
  });
}

function hydrateStoredPeriodMatches(profitability, history) {
  if (!Array.isArray(profitability) || !profitability.length) return profitability || [];
  const byPeriod = new Map((history || []).map((draw) => [String(draw.period || ''), draw]));
  return profitability.map((play) => {
    const best = play?.best;
    if (!best || !Array.isArray(best.periodResults)) return play;
    const periodResults = best.periodResults.map((item) => {
      if (Number.isFinite(Number(item.matches)) && Number.isFinite(Number(item.targetCount))) return item;
      const actual = byPeriod.get(String(item.period || ''));
      if (!actual) return item;
      const prediction = String(item.prediction || '').trim();
      let matches = 0;
      let targetCount = 1;
      if (play.key === 'size' || play.key === 'oddEven') {
        const field = play.key === 'size' ? 'size' : 'oddEven';
        matches = prediction === String(actual[field] || '') ? 1 : 0;
      } else if (play.key === 'superNumber') {
        const selected = normalizeNumberValue(prediction);
        const drawn = new Set((actual.numbers || []).map(normalizeNumberValue));
        targetCount = 1;
        matches = selected && (selected === normalizeNumberValue(actual.superNumber) || drawn.has(selected)) ? 1 : 0;
      } else {
        const predicted = prediction.split('、').map(normalizeNumberValue).filter(Boolean);
        const drawn = new Set((actual.numbers || []).map(normalizeNumberValue));
        targetCount = predicted.length;
        matches = predicted.filter((number) => drawn.has(number)).length;
      }
      return { ...item, matches, targetCount };
    });
    return { ...play, best: { ...best, periodResults } };
  });
}

function hasCompleteProfitabilityEvaluation(profitability) {
  return Array.isArray(profitability)
    && profitability.length > 0
    && profitability.every((play) => ['best', 'fixed', 'follow'].every((mode) => {
      const result = play?.[mode];
      return Number(result?.samples || 0) >= Math.min(profitabilityBacktestWindow, 20)
        && Array.isArray(result?.periodResults)
        && result.periodResults.length > 0;
    }));
}

function ensureFollowBacktestVisible(profitability) {
  if (!Array.isArray(profitability)) return [];
  return profitability.map((play) => {
    if (Number(play?.follow?.samples || 0) > 0 && play?.follow?.periodResults?.length) return play;
    const fixed = play?.fixed;
    if (!fixed || Number(fixed.samples || 0) <= 0 || !fixed.periodResults?.length) return play;
    return {
      ...play,
      follow: {
        ...fixed,
        mode: 'follow',
        fallback: '缺少歷史模型，使用同算法固定重建備援',
      },
    };
  });
}

function requestedCastingTime(value) {
  const parsed = new Date(String(value || ''));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '';
}

async function fetchSourcesConcurrently(attempts, concurrency = sourceFetchConcurrency) {
  const results = [];
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < attempts.length) {
      const index = nextIndex;
      nextIndex += 1;
      const attempt = attempts[index];
      const startedAt = Date.now();
      try {
        const result = await attempt.run();
        results.push({ attempt, result, latencyMs: Date.now() - startedAt, error: '' });
      } catch (error) {
        results.push({ attempt, result: null, latencyMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, attempts.length) }, () => worker()));
  return results;
}

async function updateJobState(runId, patch = {}) {
  if (!pool || !runId) return;
  await ensureDatabase();
  const fields = [];
  const values = [runId];
  const add = (column, value) => { values.push(value); fields.push(`${column}=$${values.length}`); };
  if (patch.status) add('status', patch.status);
  if (patch.attempts != null) add('attempts', patch.attempts);
  if (patch.error != null) add('error', String(patch.error).slice(0, 1000));
  if (patch.started) fields.push('started_at=COALESCE(started_at,NOW())');
  if (patch.heartbeat) fields.push('heartbeat_at=NOW()');
  if (patch.finished) fields.push('finished_at=NOW()');
  if (!fields.length) return;
  fields.push('updated_at=NOW()');
  await pool.query(`UPDATE bingo_jobs SET ${fields.join(', ')} WHERE run_id=$1`, values);
}

async function enqueueRefreshJob(persisted = [], days = 1) {
  const client = await getRedisQueueClient();
  if (!client) return false;
  try {
    try { await client.xGroupCreate(redisJobStream, redisJobGroup, '0', { MKSTREAM: true }); }
    catch (error) { if (!String(error?.message || error).includes('BUSYGROUP')) throw error; }
    const targetPeriod = String(persisted[0]?.period || 'latest');
    const jobKey = `refresh:${targetPeriod}:${days}`;
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dedupe = await client.set(`bingo:job:${jobKey}`, runId, { NX: true, PX: redisLockTtlMs });
    if (dedupe !== 'OK') return true;
    if (pool) {
      await ensureDatabase();
      await pool.query(`INSERT INTO bingo_jobs (run_id, job_key, job_type, target_period, days, status, payload)
        VALUES ($1,$2,'refresh',$3,$4,'queued',$5::jsonb)
        ON CONFLICT (job_key) DO NOTHING`, [runId, jobKey, targetPeriod, days, JSON.stringify({ targetPeriod, days })]);
    }
    await client.xAdd(redisJobStream, '*', { runId, jobType: 'refresh', targetPeriod, days: String(days), jobKey });
    return true;
  } catch (error) {
    console.error(JSON.stringify({ event: 'redis-enqueue-failed', message: error instanceof Error ? error.message : String(error) }));
    return false;
  }
}

async function latest(daysOverride = null, existingHistory = [], requestedCastingAt = '', options = {}) {
  const runId = options.runId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  setComputationProgress({ status: 'running', stage: 'source-sync', percent: 5, message: '併發同步官方與備援資料', runId });
  const health = [];
  const apiSource = { name: '台灣彩券官方 API', authority: 'official', initialRank: 1000 };
  const attempts = [{ ...apiSource, run: () => fetchOfficial(daysOverride) }, ...fallbackSources
    .slice()
    .sort((a, b) => sourceRankingScore(b, existingHistory[0]?.period) - sourceRankingScore(a, existingHistory[0]?.period))
    .map((source) => ({ ...source, run: () => fetchMirror(source) }))];
  const sourceResults = await fetchSourcesConcurrently(attempts, sourceFetchConcurrency);
  sourceResults.forEach(({ attempt, result, error, latencyMs }) => {
    const snapshot = result?.snapshot || result;
    const stat = updateSourceStat(attempt.name, Boolean(result), latencyMs, snapshot?.period || '', error);
    health.push({
      name: attempt.name,
      ok: Boolean(result),
      latencyMs,
      records: result ? (result.history || [snapshot]).length : undefined,
      latestPeriod: snapshot?.period || '',
      error: error ? String(error) : undefined,
      stability: stat.success / (stat.success + stat.failure),
    });
  });
  const successfulSources = sourceResults
    .filter((item) => item.result)
    .sort((a, b) => {
      const aSnapshot = a.result.snapshot || a.result;
      const bSnapshot = b.result.snapshot || b.result;
      return Number(bSnapshot?.period || 0) - Number(aSnapshot?.period || 0)
        || (b.attempt.authority === 'official' ? 1 : 0) - (a.attempt.authority === 'official' ? 1 : 0)
        || a.latencyMs - b.latencyMs;
    });
  for (const candidate of successfulSources) {
    const attempt = candidate.attempt;
    const startedAt = Date.now() - candidate.latencyMs;
    try {
      const result = candidate.result;
      const snapshot = result.snapshot || result;
      const previousLatest = existingHistory[0];
      const latestDrawChanged = !previousLatest
        || String(previousLatest.period || '') !== String(snapshot.period || '')
        || (previousLatest.numbers || []).map(normalizeNumberValue).join(',') !== (snapshot.numbers || []).map(normalizeNumberValue).join(',')
        || normalizeNumberValue(previousLatest.superNumber) !== normalizeNumberValue(snapshot.superNumber)
        || normalizeDrawCategory(previousLatest.size, 'size') !== normalizeDrawCategory(snapshot.size, 'size')
        || normalizeDrawCategory(previousLatest.oddEven, 'oddEven') !== normalizeDrawCategory(snapshot.oddEven, 'oddEven');
      setComputationProgress({ stage: 'source-normalize', percent: 20, message: `已取得第 ${snapshot.period} 期，整理併發來源結果`, runId });
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
      // days=1 是首屏即時增量：只整理來源本次帶回的最新日資料，
      // 不把已存在資料庫的整個 31 日窗口再次逐筆寫回；完整窗口由背景同步負責。
      const rawHistory = daysOverride === 1
        ? selectRecentHistory(allHistory, 1)
        : selectRecentHistory(allHistory, retentionDays);
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
        const previous = historyByPeriod.get(String(item.period));
        // 官方增量資料通常只帶開獎欄位；保留同期期號已保存的模型／回測，
        // 否則 deferEvaluationModels 會把完整快照誤降級成空白評估。
        const enrichedItem = previous
          ? { ...previous, ...item, models: previous.models?.length ? previous.models : item.models,
            forecastEvaluation: previous.forecastEvaluation?.length ? previous.forecastEvaluation : item.forecastEvaluation,
            calibratedProbabilityEvaluation: previous.calibratedProbabilityEvaluation?.length ? previous.calibratedProbabilityEvaluation : item.calibratedProbabilityEvaluation,
            profitabilityEvaluation: previous.profitabilityEvaluation?.length ? previous.profitabilityEvaluation : item.profitabilityEvaluation,
            zoneProfitabilityEvaluation: previous.zoneProfitabilityEvaluation?.length ? previous.zoneProfitabilityEvaluation : item.zoneProfitabilityEvaluation,
            technicalAnalysis: Object.keys(previous.technicalAnalysis || {}).length ? previous.technicalAnalysis : item.technicalAnalysis }
          : item;
        const modelSnapshot = isNextPrediction ? { ...enrichedItem, period: nextPeriod, drawAt, castingAt: modelCastingAt } : { ...enrichedItem, castingAt };
        const modelHistory = rawHistory.slice(index + 1, index + liveModelHistoryLimit + 1).map(({ period, numbers, superNumber, size, oddEven, drawAt }) => ({ period, numbers, superNumber, size, oddEven, drawAt }));
        // 同步只重新計算最新一期的「當期 → 下一期」模型。
        // 舊歷史模型若已存在就保留；同步歷史資料不應逐期重新啟動 worker，否則 31 日查詢會阻塞首屏。
        let models = previous?.models || item.models || [];
        let modelError = '';
        if (isNextPrediction && !options.deferLatestModel) {
          setComputationProgress({ stage: 'model-build', percent: 35, message: '建立多模型預測', runId });
          try {
            models = await buildModelsCached(modelSnapshot, modelHistory, { evolve: true, castingAt: modelCastingAt });
            setComputationProgress({ stage: 'model-build', percent: 60, message: `完成 ${models.length} 個模型`, runId });
          } catch (error) {
            modelError = error instanceof Error ? error.message : String(error);
            models = [];
            console.error(JSON.stringify({ event: 'formal-model-build-failed', message: modelError }));
          }
        } else if (isNextPrediction && options.deferLatestModel) {
          // 優先同步只延後新模型計算；同期期號仍沿用已保存模型，避免首頁短暫變成空白。
          // 新期號也沿用上一期正式模型作暫時預測，背景完成後再替換為新模型。
          models = previous?.models || item.models || existingHistory.find((candidate) => candidate.models?.length)?.models || [];
        }
        history.push({
          ...enrichedItem,
          drawAt,
          castingAt: modelCastingAt,
          forecastCastingAt: isNextPrediction ? predictionCastingAt : item.forecastCastingAt,
          predictionTargetPeriod: isNextPrediction ? nextPeriod : item.period,
          models: index <= maxModelHistory ? models : [],
          modelStatus: isNextPrediction ? (models.length ? 'formal' : options.deferLatestModel ? 'queued' : 'error') : (models.length ? 'formal' : 'unavailable'),
          modelError: isNextPrediction ? modelError : '',
          fetchedAt: syncedAt,
          sourceHealth: health,
        });
      }
      // 首屏快速路徑只確認最新開獎資料；模型補建與 GitHub 備份交給背景同步，
      // 不得因慢來源、worker 或備份服務讓 /api/latest?days=1 長時間沒有回應。
      // deferEvaluationModels 是即時同步的硬邊界：新期號也不能在 HTTP／排程路徑同步等待回測。
      // 回測由 refreshInBackground 統一補寫，避免同一批資料被多個路徑重算。
      const shouldComputeEvaluation = !options.deferEvaluationModels
        && (latestDrawChanged || !hasCompleteProfitabilityEvaluation(existingHistory[0]?.profitabilityEvaluation));
      if (shouldComputeEvaluation && history.slice(1, profitabilityBacktestWindow + 1).some((item) => !Array.isArray(item.models) || !item.models.length)) {
        setComputationProgress({ stage: 'historical-models', percent: 64, message: '補建回測所需的歷史模型', runId });
        await hydrateEvaluationModels(history);
      }
      const evaluation = !shouldComputeEvaluation
        ? {
          forecastEvaluation: history[0]?.forecastEvaluation || [],
          calibratedProbabilityEvaluation: history[0]?.calibratedProbabilityEvaluation || [],
          profitabilityEvaluation: history[0]?.profitabilityEvaluation || [],
          zoneProfitabilityEvaluation: history[0]?.zoneProfitabilityEvaluation || [],
          technicalAnalysis: history[0]?.technicalAnalysis || {},
        }
        : await (async () => {
          setComputationProgress({ stage: 'backtest', percent: 72, message: '執行樣本外回測與機率校準', runId });
          const result = await evaluateInWorker(history, runId);
          return result;
        })();
      // 模型、預測、回測與技術摘要必須同一批寫入，避免重開後只剩開獎資料或號碼。
      const audit = researchAudit(rawHistory);
      const behaviorAuditResult = behaviorAudit(rawHistory);
      const backtestIntegrity = leakageGuard(rawHistory, nextPeriod);
      history[0] = { ...history[0], ...evaluation, audit, behaviorAudit: behaviorAuditResult, backtestIntegrity };
      // days=1 只需要保存最新快照；整個歷史窗口由 days>1 的同步路徑定期補齊。
      // 這可避免每次即時輪詢都把數百筆模型 JSON 重寫進 PostgreSQL。
      const snapshotsToPersist = daysOverride === 1 ? history.slice(0, 1) : history;
      setComputationProgress({ stage: 'persist', percent: 94, message: '保存模型與分析結果', runId });
      await persistSnapshots(snapshotsToPersist);
      const backup = options.deferLatestModel
        ? { enabled: Boolean(githubToken), repo: githubRepo, path: githubBackupPath, deferred: true }
        : await backupModelProfile(history[0]);
      const responseHistory = daysOverride && daysOverride > 1
        ? compactHistoryForResponse(selectRecentHistory(history, retentionDays).slice(0, responseHistoryLimit))
        : compactHistoryForResponse(history.slice(0, fastResponseHistoryLimit), Number(options.quickModelHistoryCount || 0));
      setComputationProgress({ status: 'complete', stage: 'complete', percent: 100, message: '計算完成', runId });
      return { ...history[0], history: responseHistory, historyDays: retentionDays, modelStatus: history[0].modelStatus, modelError: history[0].modelError, sourceHealth: health, sourceRanking: sourceRanking(history[0].period, health), audit, behaviorAudit: behaviorAuditResult, backtestIntegrity, ...evaluation, theoreticalRiskBaseline: theoreticalRiskBaseline(), researchEvidence: researchEvidenceRegistry, backup, quickBacktestIntegrity: quickBacktestLeakageGuard(responseHistory, quickDecisionBacktestWindow) };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const errorMessage = error instanceof Error ? error.message : '來源失敗';
      const stat = updateSourceStat(attempt.name, false, latencyMs, '', errorMessage);
      health.push({ name: attempt.name, ok: false, latencyMs, error: errorMessage, stability: stat.success / (stat.success + stat.failure) });
    }
  }
  setComputationProgress({ status: 'error', stage: 'error', percent: 100, message: '所有資料來源均失敗', runId });
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
  // 有正式持久化結果時直接提供；背景同步會負責在新一期出現後刷新。
  // 只有冷資料沒有模型時才補算，避免歷史查詢每次重跑 worker。
  let models = current.models || [];
  let modelError = '';
  if (!models.length) {
    try {
      models = await buildModelsCached(modelSnapshot, modelHistory, { evolve: true, castingAt: predictionCastingAt });
    } catch (error) {
      modelError = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ event: 'cached-prediction-recompute-failed', message: error instanceof Error ? error.message : String(error) }));
    }
  }
  const history = [{
    ...current,
    models,
    forecastCastingAt: predictionCastingAt,
    predictionTargetPeriod: targetPeriod,
  }, ...visible.slice(1)];
  if ((!current.models?.length || !current.forecastEvaluation?.length || !hasCompleteProfitabilityEvaluation(current.profitabilityEvaluation))
    && history.slice(1, profitabilityBacktestWindow + 1).some((item) => !Array.isArray(item.models) || !item.models.length)) {
    await hydrateEvaluationModels(history);
  }
  const evaluationHistory = history;
  const hasStoredEvaluation = Boolean(current.forecastEvaluation?.length
    && current.calibratedProbabilityEvaluation?.length
    && hasCompleteProfitabilityEvaluation(current.profitabilityEvaluation)
    && current.zoneProfitabilityEvaluation?.length
    && Object.keys(current.technicalAnalysis || {}).length);
  let computedEvaluation = null;
  if (!hasStoredEvaluation) {
    try {
      computedEvaluation = await evaluateInWorkerWithTimeout(evaluationHistory, 12000);
    } catch (error) {
      console.error(JSON.stringify({ event: 'evaluation-timeout-fast-fallback', message: error instanceof Error ? error.message : '回測 Worker 超時' }));
      computedEvaluation = {
        forecastEvaluation: [],
        calibratedProbabilityEvaluation: [],
        profitabilityEvaluation: fastProfitabilityEvaluation(evaluationHistory),
        zoneProfitabilityEvaluation: [],
        technicalAnalysis: technicalAnalysis(evaluationHistory),
      };
    }
  }
  const storedForecast = current.forecastEvaluation?.length ? current.forecastEvaluation : computedEvaluation.forecastEvaluation;
  const storedCalibrated = current.calibratedProbabilityEvaluation?.length ? current.calibratedProbabilityEvaluation : computedEvaluation.calibratedProbabilityEvaluation;
  const hydratedProfitability = hydrateStoredPeriodMatches(current.profitabilityEvaluation, visible);
  const storedProfitabilityReady = hasCompleteProfitabilityEvaluation(hydratedProfitability)
    && hydratedProfitability.every((play) => play.best.periodResults.every((item) => Number.isFinite(Number(item.matches)) && Number.isFinite(Number(item.targetCount))));
  const storedProfitability = ensureFollowBacktestVisible(
    storedProfitabilityReady ? hydratedProfitability : computedEvaluation.profitabilityEvaluation,
  );
  const storedZone = current.zoneProfitabilityEvaluation?.length ? current.zoneProfitabilityEvaluation : computedEvaluation.zoneProfitabilityEvaluation;
  const storedTechnical = Object.keys(current.technicalAnalysis || {}).length ? current.technicalAnalysis : computedEvaluation.technicalAnalysis;
  return {
    ...history[0],
    history: compactHistoryForResponse(history.slice(0, responseHistoryLimit)),
    historyDays: retentionDays,
    sourceHealth: current.sourceHealth || [],
    audit: researchAudit(visible.slice(1)),
    behaviorAudit: behaviorAudit(visible.slice(1)),
    backtestIntegrity: leakageGuard(visible, targetPeriod),
    quickBacktestIntegrity: quickBacktestLeakageGuard(history, quickDecisionBacktestWindow),
    forecastEvaluation: storedForecast,
    calibratedProbabilityEvaluation: storedCalibrated,
    profitabilityEvaluation: storedProfitability,
    zoneProfitabilityEvaluation: storedZone,
    technicalAnalysis: storedTechnical,
    theoreticalRiskBaseline: theoreticalRiskBaseline(),
    researchEvidence: researchEvidenceRegistry,
    modelStatus: models.length ? 'formal' : 'error',
    modelError,
    backup: { enabled: Boolean(githubToken), repo: githubRepo, path: githubBackupPath },
  };
}

async function executeRefreshJob(persisted, days = 1, runId = '') {
  const lockKey = `bingo:refresh:${persisted[0]?.period || 'latest'}:${days}`;
  const lock = await acquireRefreshLock(lockKey);
  if (lock === false) return { skipped: true };
  try {
    await updateJobState(runId, { status: 'running', started: true, heartbeat: true });
    const probe = await latest(1, persisted, '', { deferLatestModel: true, deferEvaluationModels: true, runId });
    const complete = Boolean(probe?.models?.length) && hasCompleteProfitabilityEvaluation(probe?.profitabilityEvaluation);
    const changed = String(probe?.predictionTargetPeriod || '') !== String(persisted[0]?.predictionTargetPeriod || '')
      || String(probe?.period || '') !== String(persisted[0]?.period || '');
    if (!complete || changed || days > 1) {
      const refreshed = await readPersistedCached(persistedHistoryLimit);
      const result = await precomputeLatestSnapshot(refreshed, runId);
      const lightweight = { ...result, history: compactHistoryForResponse(result.history?.slice(0, fastResponseHistoryLimit) || [], quickDecisionBacktestWindow) };
      writeLatestResponseCache('latest-1', lightweight);
      return lightweight;
    }
    writeLatestResponseCache('latest-1', probe);
    return probe;
  } finally {
    await releaseRefreshLock(lock);
  }
}

function refreshInBackground(persisted, days = 1) {
  if (refreshInFlight) {
    evaluationRefreshQueued = true;
    return;
  }
  refreshInFlight = true;
  if (redisUrl) {
    void enqueueRefreshJob(persisted, days)
      .then((queued) => {
        if (!queued) return executeRefreshJob(persisted, days);
        return null;
      })
      .catch((error) => console.error(JSON.stringify({ event: 'background-enqueue-failed', message: error instanceof Error ? error.message : String(error) })))
      .finally(() => { refreshInFlight = false; });
    return;
  }
  void executeRefreshJob(persisted, days)
    .catch((error) => console.error(JSON.stringify({ event: 'background-sync-failed', message: error instanceof Error ? error.message : '背景同步失敗' })))
    .finally(() => {
      refreshInFlight = false;
      if (evaluationRefreshQueued) { evaluationRefreshQueued = false; setImmediate(() => refreshInBackground(persisted, 1)); }
    });
}

async function runRedisWorker() {
  const client = await getRedisQueueClient();
  if (!client) throw new Error('WORKER_MODE 需要 REDIS_URL');
  try { await client.xGroupCreate(redisJobStream, redisJobGroup, '0', { MKSTREAM: true }); }
  catch (error) { if (!String(error?.message || error).includes('BUSYGROUP')) throw error; }
  const consumer = `${process.env.HOSTNAME || 'bingo-worker'}-${process.pid}`;
  console.log(JSON.stringify({ event: 'worker-ready', stream: redisJobStream, group: redisJobGroup, consumer }));
  while (true) {
    const batches = await client.xReadGroup(redisJobGroup, consumer, [{ key: redisJobStream, id: '>' }], { COUNT: 1, BLOCK: 5000 });
    if (!batches?.length) continue;
    for (const message of batches[0].messages || []) {
      const values = message.message || {};
      const runId = values.runId || message.id;
      const days = Number(values.days || 1);
      const attempts = Number(values.attempts || 0);
      try {
        await updateJobState(runId, { status: 'running', started: true, heartbeat: true });
        const heartbeat = setInterval(() => { void updateJobState(runId, { heartbeat: true }); }, 10_000);
        try {
          const persisted = await readPersistedCached(persistedHistoryLimit);
          await executeRefreshJob(persisted, days, runId);
          await updateJobState(runId, { status: 'completed', finished: true, heartbeat: true });
        } finally { clearInterval(heartbeat); }
        await client.xAck(redisJobStream, redisJobGroup, message.id);
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        if (attempts < 2) {
          await client.xAdd(redisJobStream, '*', { ...values, attempts: String(attempts + 1) });
          await updateJobState(runId, { status: 'queued', attempts: attempts + 1, error: messageText, heartbeat: true });
        } else {
          await updateJobState(runId, { status: 'failed', attempts: attempts + 1, error: messageText, finished: true });
        }
        console.error(JSON.stringify({ event: 'worker-job-failed', runId, attempts: attempts + 1, message: messageText }));
        await client.xAck(redisJobStream, redisJobGroup, message.id);
      }
    }
  }
}

async function precomputeLatestSnapshot(persisted = [], runId = '') {
  // 預計算至少抓完整保存窗口，確保模型與 walk-forward 回測有共同、足夠的歷史資料。
  const refreshDays = retentionDays;
  const result = await latest(refreshDays, persisted, '', { runId });
  if (!result?.models?.length || !hasCompleteProfitabilityEvaluation(result.profitabilityEvaluation)) {
    throw new Error('預計算未產生完整模型與回測快照');
  }
  return result;
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
    refreshInBackground(persisted, retentionDays);
    console.log(JSON.stringify({ event: 'sync-enqueued', period: persisted[0]?.period || '', historyDays: retentionDays, persisted: Boolean(pool) }));
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
  if (req.method === 'GET' && req.url.startsWith('/api/progress')) {
    const progress = await readComputationProgress();
    return send(res, 200, progress, req);
  }
  if (req.method === 'GET' && req.url.startsWith('/api/latest')) {
    try {
      const requestUrl = new URL(req.url, 'http://localhost');
      const requestedDays = Number(requestUrl.searchParams.get('days'));
      const daysOverride = Number.isFinite(requestedDays) && requestedDays > 0 ? requestedDays : null;
      const castingAt = requestedCastingTime(requestUrl.searchParams.get('castingAt'));
      const priorityRefresh = requestUrl.searchParams.get('priority') === '1';
      const responseCacheKey = daysOverride === 1 ? 'latest-1' : '';
      if (priorityRefresh && daysOverride === 1) {
        const persistedForPriority = await readPersistedCached(persistedHistoryLimit);
        const hasAnySavedModels = persistedForPriority.some((item) => item.models?.length);
        const prioritySnapshot = await latest(1, persistedForPriority, castingAt, {
          // 冷啟動只在整個保存集都沒有模型時建立；有歷史模型就先沿用，避免首頁等待數十秒。
          deferLatestModel: hasAnySavedModels,
          deferEvaluationModels: true,
          quickModelHistoryCount: quickDecisionBacktestWindow,
        });
        const quickHistory = prioritySnapshot.history || [prioritySnapshot];
        let quickIntegrity = quickBacktestLeakageGuard(quickHistory, quickDecisionBacktestWindow);
        if (quickIntegrity.excludedSamples > 0) {
          // 快速回測必須固定完成 10 個目標期；只補建缺少的歷史模型，
          // 並沿用每期「目標期以前」的資料，不能以目前模型代替。
          await hydrateEvaluationModels(quickHistory, quickDecisionBacktestWindow);
          quickIntegrity = quickBacktestLeakageGuard(quickHistory, quickDecisionBacktestWindow);
        }
        void readPersistedCached(persistedHistoryLimit)
          .then((rows) => refreshInBackground(rows, 1))
          .catch(() => undefined);
        // 臨場判斷不等待完整回測：先回傳模型與最近 10 期快速比較，20 期完整研究交給背景更新。
        const quickEvaluation = fastProfitabilityEvaluation(quickHistory, quickDecisionBacktestWindow);
        return send(res, 200, {
          ...prioritySnapshot,
          history: quickHistory,
          profitabilityEvaluation: quickEvaluation,
          quickBacktestIntegrity: quickIntegrity,
          evaluationMode: 'quick',
          modelStatus: prioritySnapshot.models?.length ? 'formal' : 'queued',
        }, req);
      }
      if (responseCacheKey) {
        const cachedResponse = readLatestResponseCache(responseCacheKey);
        if (cachedResponse) return send(res, 200, cachedResponse, req);
      }
      const persisted = await readPersistedCached(persistedHistoryLimit);
      const evaluationIncomplete = persisted.length > 0
        && !hasCompleteProfitabilityEvaluation(persisted[0]?.profitabilityEvaluation);
      const cachedForecast = persisted[0]?.forecastCastingAt
        ? reproducibleCastingAt(persisted[0].forecastCastingAt, persisted[0].predictionTargetPeriod || '')
        : '';
      const forecastFresh = Boolean(cachedForecast) && Date.parse(cachedForecast) > Date.now();
      // days=1 是最新開獎讀取，必須即時確認官方期號；歷史查詢才可使用保存快取。
      if (persisted.length && daysOverride === 1) {
        // 先回傳最近一次已保存的結果，官方期號確認與模型重算在背景執行；
        // 避免官方來源短暫逾時時，前端完全拿不到正式預測。
        const cached = {
          ...persisted[0],
          profitabilityEvaluation: ensureFollowBacktestVisible(persisted[0].profitabilityEvaluation),
          // 即時輪詢只供首頁刷新；限制歷史筆數，避免前端每次輪詢都解析與合併 1200 筆資料。
          history: compactHistoryForResponse(selectRecentHistory(persisted, retentionDays).slice(0, fastResponseHistoryLimit), quickDecisionBacktestWindow),
          historyDays: retentionDays,
          modelStatus: persisted[0].models?.length && !evaluationIncomplete ? 'formal' : 'queued',
        };
        // 每次快取到期後都要在背景確認官方最新期號；正式模型存在不代表開獎資料已更新。
        refreshInBackground(persisted, 1);
        return send(res, 200, writeLatestResponseCache(responseCacheKey, cached), req);
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
        if (recent.length) {
          const cached = {
            ...recent[0],
            history: compactHistoryForResponse(recent.slice(0, responseHistoryLimit)),
            historyDays: retentionDays,
            modelStatus: recent[0].models?.length ? 'formal' : 'queued',
          };
          refreshInBackground(persisted, hasRetentionCoverage(recent, retentionDays) ? 1 : retentionDays);
          return send(res, 200, cached, req);
        }
      }
      const hasNextPrediction = persisted.length && persisted[0].predictionTargetPeriod && persisted[0].predictionTargetPeriod !== persisted[0].period;
      const hasUsableHistory = persisted.length >= persistedHistoryLimit;
      if (persisted.length && !daysOverride && hasNextPrediction && hasUsableHistory && forecastFresh) {
        const cached = await persistedResponse(persisted, castingAt);
        return send(res, 200, { ...cached, history: selectRecentHistory(persisted, retentionDays), historyDays: retentionDays });
      }
      const refreshDays = daysOverride === 1 && !hasUsableHistory ? 1 : daysOverride;
      const fresh = await latest(refreshDays, persisted, castingAt, { deferEvaluationModels: Boolean(daysOverride && daysOverride > 1) });
      return send(res, 200, responseCacheKey ? writeLatestResponseCache(responseCacheKey, fresh) : fresh, req);
    } catch (error) { return send(res, 502, { error: error instanceof Error ? error.message : '官方資料同步失敗' }, req); }
  }
  send(res, 404, { error: 'Not found' });
});

if (isMainThread && workerMode) {
  void runRedisWorker().catch((error) => {
    console.error(JSON.stringify({ event: 'worker-fatal', message: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  });
} else if (isMainThread) {
  server.listen(port, '0.0.0.0', () => {
    console.log(`bingo-api listening on ${port}; database=${Boolean(pool)}`);
    void prunePersistedHistory();
    // 啟動後在背景預熱完整快照；HTTP 請求不負責首次建模，避免前端成為計算觸發器。
    setImmediate(() => void scheduledSync(false));
  });
}

export {
  forecastEvaluation,
  calibratedProbabilityEvaluation,
  profitabilityEvaluation,
  zoneProfitabilityEvaluation,
  technicalAnalysis,
};
