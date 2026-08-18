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
const maxModelHistory = 60;
const singleBetCost = 25;
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
  { name: 'Pilio 賓果開獎查詢', url: 'https://www.pilio.idv.tw/bingo/list.asp' },
  { name: 'Auzo 奧索樂透網', url: 'https://lotto.auzo.tw/bingobingo.php' },
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
    fetched_at BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);
  await pool.query("ALTER TABLE bingo_draws ADD COLUMN IF NOT EXISTS prediction_target_period TEXT NOT NULL DEFAULT ''");
  await pool.query('CREATE INDEX IF NOT EXISTS bingo_draws_updated_idx ON bingo_draws (updated_at DESC)');
  await pool.query(`CREATE TABLE IF NOT EXISTS bingo_model_backups (
    id BIGSERIAL PRIMARY KEY,
    algorithm_version TEXT NOT NULL,
    profile JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);
  databaseReady = true;
}

function algorithmVersion() { return 'bingo-models-v3-target-casting'; }

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
        (period, draw_at, numbers, super_number, size, odd_even, source, source_label, source_health, models, prediction_target_period, fetched_at)
        VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12)
        ON CONFLICT (period) DO UPDATE SET draw_at=EXCLUDED.draw_at, numbers=EXCLUDED.numbers,
        super_number=EXCLUDED.super_number, size=EXCLUDED.size, odd_even=EXCLUDED.odd_even,
        source=EXCLUDED.source, source_label=EXCLUDED.source_label, source_health=EXCLUDED.source_health,
        models=EXCLUDED.models, prediction_target_period=EXCLUDED.prediction_target_period, fetched_at=EXCLUDED.fetched_at, updated_at=NOW()` , [
        item.period, item.drawAt || '', JSON.stringify(item.numbers), item.superNumber || '', item.size || '', item.oddEven || '',
        item.source || '', item.sourceLabel || '', JSON.stringify(item.sourceHealth || []), JSON.stringify(item.models || []), item.predictionTargetPeriod || '', item.fetchedAt || Date.now(),
      ]);
    }
    await client.query('COMMIT');
    lastPersistedPeriod = snapshots[0]?.period || lastPersistedPeriod;
    persistedCache.set(maxModelHistory, { rows: snapshots, storedAt: Date.now() });
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
    models, prediction_target_period AS "predictionTargetPeriod", fetched_at AS "fetchedAt" FROM bingo_draws ORDER BY period DESC LIMIT $1`, [Math.min(10000, Math.max(1, limit))]);
  return result.rows.map((row) => ({ ...row, numbers: Array.isArray(row.numbers) ? row.numbers : [], sourceHealth: row.sourceHealth || [], models: row.models || [] }));
}

async function readPersistedCached(limit = maxModelHistory) {
  const cacheKey = limit <= maxModelHistory ? maxModelHistory : limit;
  const cached = persistedCache.get(cacheKey);
  if (cached && Date.now() - cached.storedAt < persistedCacheTtlMs) return cached.rows;
  const inFlight = persistedReadInFlight.get(cacheKey);
  if (inFlight) return inFlight;
  const read = readPersisted(limit)
    .then((rows) => {
      if (cacheKey === maxModelHistory) persistedCache.set(cacheKey, { rows, storedAt: Date.now() });
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

function parseTaipeiParts(value) {
  const date = value ? new Date(value.replace(/\//g, '-')) : new Date();
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hour12: false }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

function parseChineseCalendarParts(value) {
  const date = value ? new Date(value.replace(/\//g, '-')) : new Date();
  const parts = new Intl.DateTimeFormat('zh-TW-u-ca-chinese', { timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hour12: false }).formatToParts(date);
  const monthNames = ['正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
  const monthPart = parts.find((part) => part.type === 'month')?.value || '';
  const normalizedMonth = monthPart.replace(/^閏/, '').replace('腊', '臘');
  const month = normalizedMonth === '臘月' ? 12 : monthNames.indexOf(normalizedMonth) + 1;
  return {
    year: Number(parts.find((part) => part.type === 'relatedYear')?.value || date.getUTCFullYear()),
    month: Math.max(1, month),
    day: Number(parts.find((part) => part.type === 'day')?.value || 1),
    hour: Number(parts.find((part) => part.type === 'hour')?.value || 0),
  };
}

function playIndex(target) {
  if (target === 'size') return 1;
  if (target === 'oddEven') return 2;
  if (target === 'superNumber') return 3;
  const star = Number(String(target).replace('星', ''));
  return Number.isFinite(star) && star > 0 ? star + 3 : 1;
}

function targetInput(snapshot, target, castingAt = snapshot.drawAt || new Date().toISOString()) {
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
  const time = parseTaipeiParts(input.castingAt);
  const timeSum = time.year + time.month + time.day + time.hour;
  const luoshu = [[4, 9, 2], [3, 5, 7], [8, 1, 6]];
  const palace = (timeSum + input.targetNo) % 9;
  const center = luoshu[Math.floor(palace / 3)][palace % 3];
  return { input, luoshu, palace: palace + 1, center, formula: `預測時間=${input.castingAt}、玩法序號=${input.targetNo}；以年月日時總和+玩法序號 mod 9 定洛書宮位=${palace + 1}；宮位數=${center}。期號僅作所問事項：${input.question}` };
}

function numeralGuaCasting(snapshot, target) {
  const input = targetInput(snapshot, target);
  const time = parseTaipeiParts(input.castingAt);
  const sourceDigits = [time.year, time.month, time.day, time.hour, input.targetNo];
  const allowed = [1, 4, 5, 6, 8, 9];
  const digits = Array.from({ length: 6 }, (_, index) => allowed[(sourceDigits[index % sourceDigits.length] + index) % allowed.length]);
  return { input, digits, formula: `預測時間=${input.castingAt}、玩法序號=${input.targetNo}；依數字卦文獻使用的數字集合 ${allowed.join('、')}，以時間欄位建立六個可重算數字：${digits.join('、')}。期號僅作所問事項：${input.question}` };
}

function qimenCasting(snapshot, target) {
  const input = targetInput(snapshot, target);
  const time = parseTaipeiParts(input.castingAt);
  const timeSum = time.year + time.month + time.day + time.hour;
  const palace = (timeSum + input.targetNo) % 9 + 1;
  const star = (timeSum + time.hour + input.targetNo) % 9 + 1;
  const door = (timeSum + time.month + input.targetNo) % 8 + 1;
  return { input, palace, star, door, formula: `預測時間=${input.castingAt}、玩法序號=${input.targetNo}；以節氣／干支完整排局應定九宮、九星、八門；目前只保留時間結構適配=${palace}/${star}/${door}，未宣稱完整奇門排盤。` };
}

function taiyiCasting(snapshot, target) {
  const input = targetInput(snapshot, target);
  const time = parseTaipeiParts(input.castingAt);
  const timeSum = time.year + time.month + time.day + time.hour;
  const palace = (timeSum + input.targetNo) % 9 + 1;
  const cycle = (timeSum + input.targetNo) % 9;
  return { input, palace, cycle, formula: `預測時間=${input.castingAt}、玩法序號=${input.targetNo}；依太乙行九宮結構建立時間索引=${palace}／${cycle}。完整太乙仍需積年、局數等排局資料，期號僅作所問事項：${input.question}` };
}

function historicalFrequencies(history) {
  const counts = Array(81).fill(0);
  history.forEach((draw, index) => draw.numbers.forEach((number) => { counts[Number(number)] += 1 / (index + 1); }));
  const total = history.length || 1;
  return counts.map((count) => count / total);
}

function scoreNumbers(seed, count, tradition, history, empiricalWeight = 0.32, target = '') {
  const frequencies = historicalFrequencies(history);
  const random = seededRandom(seed);
  const targetNo = playIndex(target);
  const values = Array.from({ length: 80 }, (_, index) => index + 1).map((number) => {
    const row = Math.floor((number - 1) / 10);
    const col = (number - 1) % 10;
    const parity = number % 2 ? 1 : -1;
    const traditional = tradition.kind === 'luoshu'
      ? (1 - Math.abs((tradition.center + row + col) % 9 - 4) / 4) * 0.55 + (number % tradition.center === 0 ? 0.2 : 0)
      : tradition.kind === 'sixyao'
        ? ((tradition.bits[(number + tradition.moving) % 6] === '1' ? 1 : -1) * parity * 0.12) + (number % 8 === tradition.lower ? 0.18 : 0)
        : tradition.kind === 'numeral-gua'
          ? (tradition.digits.includes(number % 10) ? 0.3 : 0) + (number % 6 === tradition.digits[number % 6] ? 0.18 : 0)
          : tradition.kind === 'qimen'
            ? (number % 9 === tradition.palace - 1 ? 0.32 : 0) + (number % 9 === tradition.star - 1 ? 0.2 : 0) + (number % 8 === tradition.door - 1 ? 0.14 : 0)
            : tradition.kind === 'taiyi'
              ? (number % 9 === tradition.palace - 1 ? 0.34 : 0) + (number % 9 === tradition.cycle ? 0.18 : 0)
              : ((number % 8 === tradition.upper ? 0.32 : 0) + (number % 6 === tradition.moving ? 0.16 : 0));
    const empirical = clamp(frequencies[number] / 0.25, 0, 1) * empiricalWeight;
    // 玩法適配訊號：同一模型在不同星級／目標使用不同的數字排列特徵，避免所有玩法只共用一份排序。
    const targetPulse = ((number * (targetNo + 3) + row * 5 + col * 7) % 19) / 19;
    const targetWeight = target === 'superNumber' ? 0.2 : targetNo > 3 ? 0.14 : 0.1;
    return { number, score: traditional * (1 - empiricalWeight) + empirical + targetPulse * targetWeight + random() * 0.04 };
  });
  return values.sort((a, b) => b.score - a.score || a.number - b.number).slice(0, count).sort((a, b) => a.number - b.number).map((item) => String(item.number).padStart(2, '0'));
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

function deriveSnapshot(period, numbers, source, drawAt = '') {
  const parsed = numbers.map(Number);
  if (!period || parsed.length !== 20 || parsed.some((number) => number < 1 || number > 80)) throw new Error('來源未回傳完整 20 個 1–80 號碼');
  const bigCount = parsed.filter((number) => number >= 41).length;
  const oddCount = parsed.filter((number) => number % 2 === 1).length;
  return {
    period: String(period), drawAt, numbers: parsed.map((number) => String(number).padStart(2, '0')),
    superNumber: '', size: bigCount > 10 ? '大' : bigCount < 10 ? '小' : '和',
    oddEven: oddCount > 10 ? '單' : oddCount < 10 ? '雙' : '和', source, sourceLabel: source,
  };
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

const predictionTargets = ['size', 'oddEven', 'superNumber', ...Array.from({ length: 10 }, (_, index) => `${index + 1}星`)];
const modelSources = {
  '梅花易數': [{ name: '邵雍《梅花易數》數字起卦文本', url: 'https://www.diancang.xyz/xuanxuewushu/meihuayishu/37733.html' }, { name: '北京大學：周易筮法源流考略', url: 'https://ruzang.pku.edu.cn/info/1067/2156.htm' }],
  '六爻八卦': [{ name: '北京大學：周易筮法源流考略', url: 'https://ruzang.pku.edu.cn/info/1067/2156.htm' }, { name: '中國哲學書電子化計劃：周易卦變資料', url: 'https://ctext.org/datawiki.pl?if=en&res=484682' }],
  '河圖洛書': [{ name: 'Luo Shu：同行同列對角線和為 15 的研究論文', url: 'https://journals.sagepub.com/doi/10.1177/2158244015585828' }],
  '數字卦（楚簡研究版）': [{ name: '深圳大學學報：楚卜筮簡中的數字卦', url: 'https://xb.szu.edu.cn/article/2016/1000-260X-33-3-58.html' }, { name: '濟南大學學報：清華簡《筮法》研究', url: 'https://journal.ujn.edu.cn/zh/article/31373565/' }],
  '奇門遁甲（九宮研究版）': [{ name: '北海道大學：奇門遁甲的基礎研究', url: 'https://eprints.lib.hokudai.ac.jp/repo/huscap/all/44606/' }, { name: 'EASTM：中國軍事占卜史研究', url: 'https://core.ac.uk/download/pdf/228877365.pdf' }],
  '太乙九宮（研究版）': [{ name: 'Extrême-Orient：太乙、奇門遁甲與六壬研究', url: 'https://journals.openedition.org/extremeorient/pdf/270' }, { name: '柏林自由大學：中國帝制時期的認知占卜', url: 'https://refubium.fu-berlin.de/handle/fub188/154' }],
};

function targetProfile(profiles, methodName, target) {
  const profile = profiles?.[methodName] || {};
  return profile.targets?.[target] || profile[target] || profile;
}

function categoryPrediction(seed, traditional, history, field, empiricalWeight) {
  if (!history.length || empiricalWeight < 0.4) return traditional;
  const counts = new Map();
  history.forEach((item, index) => counts.set(item[field], (counts.get(item[field]) || 0) + 1 / (index + 1)));
  const empirical = [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0];
  return empirical || traditional;
}

function hasPositiveProfit(target, predicted, actual) {
  let payout = 0;
  if (target === 'size') payout = predicted === actual.size ? 150 : 0;
  else if (target === 'oddEven') payout = predicted === actual.oddEven ? 150 : 0;
  else if (target === 'superNumber') payout = predicted === actual.superNumber ? 1200 : 0;
  else {
    const actualNumbers = new Set(actual.numbers);
    const matches = (predicted || []).filter((number) => actualNumbers.has(number)).length;
    payout = basicPayouts[target]?.[matches] || 0;
  }
  return payout - singleBetCost > 0;
}

function evolveProfiles(history = []) {
  const candidates = [0.16, 0.24, 0.32, 0.40, 0.48];
  const validationWindow = Math.min(12, Math.max(0, history.length - 1));
  const methods = ['梅花易數', '六爻八卦', '河圖洛書', '數字卦（楚簡研究版）', '奇門遁甲（九宮研究版）', '太乙九宮（研究版）'];
  return Object.fromEntries(methods.map((method) => {
    const targets = Object.fromEntries(predictionTargets.map((target) => {
      if (history.length < 8) return [target, { empiricalWeight: 0.32, validationSamples: validationWindow, score: null, status: '樣本不足，使用預設權重' }];
      const results = candidates.map((empiricalWeight) => {
        let weightedHits = 0; let totalWeight = 0; let trials = 0;
        history.slice(0, validationWindow).forEach((actual, index) => {
          const training = history.slice(index + 1);
          const predicted = buildModels(actual, training, { evolve: false, profiles: { [method]: { targets: { [target]: { empiricalWeight } } } } }).find((item) => item.name === method);
          if (!predicted) return;
          const foldWeight = 1 / (index + 1);
          const prediction = target === 'size'
            ? predicted.official.size
            : target === 'oddEven'
              ? predicted.official.oddEven
              : target === 'superNumber'
                ? predicted.official.superNumber
                : predicted.official.basic[target] || [];
          const foldScore = hasPositiveProfit(target, prediction, actual) ? 1 : 0;
          weightedHits += foldScore * foldWeight;
          totalWeight += foldWeight;
          trials += 1;
        });
        return { empiricalWeight, score: totalWeight ? weightedHits / totalWeight : 0, validationSamples: trials };
      });
      const best = results.sort((a, b) => b.score - a.score || Math.abs(a.empiricalWeight - 0.32) - Math.abs(b.empiricalWeight - 0.32))[0];
      return [target, { ...best, status: `walk-forward ${validationWindow} 期／分玩法自動選參數` }];
    }));
    return [method, { targets }];
  }));
}

function castingFor(kind, snapshot, target, castingAt) {
  if (kind === 'meihua') return meihuaCasting(snapshot, target, castingAt);
  if (kind === 'sixyao') return sixyaoCasting(snapshot, target, castingAt);
  if (kind === 'luoshu') return luoshuCasting(snapshot, target);
  if (kind === 'numeral-gua') return numeralGuaCasting(snapshot, target);
  if (kind === 'qimen') return qimenCasting(snapshot, target);
  return taiyiCasting(snapshot, target);
}

function traditionFor(kind, casting) {
  if (kind === 'meihua') return { kind, upper: casting.upper, lower: casting.lower, moving: casting.moving };
  if (kind === 'sixyao') return { kind, bits: casting.binary, moving: casting.lines.filter((line) => line.moving).length, lower: 1 };
  if (kind === 'luoshu') return { kind, center: casting.center };
  if (kind === 'numeral-gua') return { kind, digits: casting.digits };
  return { kind, palace: casting.palace, star: casting.star, door: casting.door, cycle: casting.cycle };
}

function targetTraditionalCategory(casting, target, seed) {
  const value = casting.upper || casting.palace || casting.center || casting.digits?.[0] || casting.cycle || seed;
  if (target === 'size') return value % 2 === 0 ? '大' : '小';
  return value % 2 === 0 ? '雙' : '單';
}

function aggregateModel(models, history) {
  const weightFor = (model, target) => {
    const score = model.calculation?.evolution?.[target]?.score;
    return score == null ? 1 : Math.max(0.25, 0.5 + score);
  };
  const weightedCategory = (target) => {
    const totals = new Map();
    models.forEach((model) => {
      const value = target === 'size' ? model.official.size : model.official.oddEven;
      if (value) totals.set(value, (totals.get(value) || 0) + weightFor(model, target));
    });
    return [...totals.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0] || '';
  };
  const weightedNumbers = (target) => {
    const size = Number(String(target).replace('星', ''));
    const totals = new Map();
    models.forEach((model) => {
      const weight = weightFor(model, target);
      (model.official.basic[target] || []).forEach((number) => totals.set(number, (totals.get(number) || 0) + weight));
    });
    return [...totals.entries()].sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0])).slice(0, size).map(([number]) => number);
  };
  const superVotes = new Map();
  models.forEach((model) => {
    const number = model.official.superNumber;
    if (number) superVotes.set(number, (superVotes.get(number) || 0) + weightFor(model, 'superNumber'));
  });
  const superNumber = [...superVotes.entries()].sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))[0]?.[0] || '';
  const basic = Object.fromEntries(Array.from({ length: 10 }, (_, index) => {
    const target = `${index + 1}星`;
    return [target, weightedNumbers(target)];
  }));
  return {
    name: '多模型聚合',
    status: '依各模型 walk-forward 表現加權的共識模型',
    rule: '多模型聚合；依各模型歷史回測表現加權投票，不保證提升下一期命中。',
    sources: [],
    calculation: {
      method: 'ensemble',
      castingSource: 'weighted-model-consensus',
      historySamples: history.length,
      aggregation: '依各模型各玩法回測分數加權；無回測分數時採等權重',
    },
    official: { size: weightedCategory('size'), oddEven: weightedCategory('oddEven'), superNumber, basic },
    research: {
      numberPicks: basic['10星'] || [],
      sumBand: '由共識號碼另行統計',
      oddEvenCount: '由共識號碼另行統計',
      highLowCount: '由共識號碼另行統計',
      zones: ['多模型加權共識'],
    },
  };
}

export function buildModels(snapshot, history = [], options = {}) {
  const profiles = options.profiles || (options.evolve === false ? {} : evolveProfiles(history));
  const castingAt = options.castingAt || snapshot.castingAt || snapshot.drawAt || new Date().toISOString();
  const methods = [
    { name: '梅花易數', kind: 'meihua', status: '經典時間起卦公式＋各目標獨立研究排序', seedOffset: 11 },
    { name: '六爻八卦', kind: 'sixyao', status: '正統大衍筮法結構＋數位蓍草適配', seedOffset: 37 },
    { name: '河圖洛書', kind: 'luoshu', status: '洛書九宮核心＋目標玩法適配', seedOffset: 61 },
    { name: '數字卦（楚簡研究版）', kind: 'numeral-gua', status: '文獻數字結構＋目標玩法研究適配，非完整復原', seedOffset: 73 },
    { name: '奇門遁甲（九宮研究版）', kind: 'qimen', status: '九宮／九星／八門核心＋目標玩法適配，非完整排局', seedOffset: 89 },
    { name: '太乙九宮（研究版）', kind: 'taiyi', status: '行九宮核心＋目標玩法適配，非完整太乙排局', seedOffset: 97 },
  ];
  const baseModels = methods.map((method) => {
    const profilesForMethod = profiles[method.name] || {};
    const weights = Object.fromEntries(predictionTargets.map((target) => [target, targetProfile(profiles, method.name, target).empiricalWeight ?? 0.32]));
    const targetCastings = Object.fromEntries(predictionTargets.map((target) => [target, castingFor(method.kind, snapshot, target, castingAt)]));
    const picksByTarget = Object.fromEntries(predictionTargets.filter((target) => target !== 'size' && target !== 'oddEven').map((target) => {
      const casting = targetCastings[target];
      const seed = `${castingAt}|${snapshot.period}|${method.kind}|${target}|${method.seedOffset}`;
      const targetCount = target === 'superNumber' ? 1 : Number(String(target).replace('星', '')) || 10;
      return [target, scoreNumbers(seed, targetCount, traditionFor(method.kind, casting), history, weights[target], target)];
    }));
    const picks = picksByTarget['10星'] || scoreNumbers(`${castingAt}|${snapshot.period}|${method.kind}|10星`, 10, traditionFor(method.kind, targetCastings['10星']), history, weights['10星'], '10星');
    const modelSeed = playIndex('10星') + method.seedOffset;
    const sumBand = ['低區', '中區', '高區'][modelSeed % 3];
    const oddEvenCount = ['單數偏多', '雙數偏多', '均衡'][modelSeed % 3];
    const highLowCount = ['小號偏多', '大號偏多', '均衡'][Math.floor(modelSeed / 3) % 3];
    const targetResearch = Object.fromEntries(predictionTargets.map((target) => {
      const targetSeed = playIndex(target) + method.seedOffset;
      const targetPicks = picksByTarget[target] || [];
      return [target, {
        numberPicks: targetPicks,
        sumBand: ['低區', '中區', '高區'][targetSeed % 3],
        oddEvenCount: ['單數偏多', '雙數偏多', '均衡'][targetSeed % 3],
        highLowCount: ['小號偏多', '大號偏多', '均衡'][Math.floor(targetSeed / 3) % 3],
        zones: [`${(targetSeed % 4) * 20 + 1}-${(targetSeed % 4 + 1) * 20}`],
      }];
    }));
    return {
      name: method.name,
      status: method.status,
      rule: `${method.status}；歷史頻率只做獨立統計排序，不修改傳統規則，不宣稱因果預測`,
      sources: modelSources[method.name] || [],
      calculation: { method: method.kind, castingSource: 'prediction-time', historySamples: history.length, empiricalWeight: history.length ? weights['10星'] : 0, empiricalWeights: weights, evolution: profilesForMethod.targets || null, targetCastings: Object.fromEntries(predictionTargets.map((target) => [target, targetCastings[target].formula])), targetCastingValues: Object.fromEntries(predictionTargets.map((target) => {
        const casting = targetCastings[target];
        if (method.kind === 'sixyao') return [target, casting.lines.map((line) => line.value).join('、')];
        if (method.kind === 'meihua') return [target, `上卦${casting.upper}／下卦${casting.lower}／動爻${casting.moving}`];
        if (method.kind === 'qimen') return [target, `九宮${casting.palace}／九星${casting.star}／八門${casting.door}`];
        if (method.kind === 'taiyi') return [target, `行宮${casting.palace}／循環${casting.cycle}`];
        if (method.kind === 'luoshu') return [target, `宮位${casting.palace}／數${casting.center}`];
        return [target, casting.digits.join('、')];
      })) },
      official: {
        size: categoryPrediction(modelSeed, targetTraditionalCategory(targetCastings.size, 'size', modelSeed), history, 'size', weights.size),
        oddEven: categoryPrediction(modelSeed, targetTraditionalCategory(targetCastings.oddEven, 'oddEven', modelSeed), history, 'oddEven', weights.oddEven),
        superNumber: (picksByTarget.superNumber || picks)[modelSeed % (picksByTarget.superNumber || picks).length],
        basic: Object.fromEntries(Array.from({ length: 10 }, (_, index) => {
          const target = `${index + 1}星`;
          const targetPicks = picksByTarget[target] || picks;
          return [target, targetPicks.slice(0, index + 1)];
        })),
      },
      research: {
        numberPicks: picks,
        sumBand,
        oddEvenCount,
        highLowCount,
        zones: [`${(modelSeed % 4) * 20 + 1}-${(modelSeed % 4 + 1) * 20}`],
        targetResearch,
      },
    };
  });
  return [...baseModels, aggregateModel(baseModels, history)];
}

function buildModelsInWorker(snapshot, history = [], options = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./model-worker.mjs', import.meta.url), {
      workerData: { snapshot, history, options },
    });
    worker.once('message', (message) => {
      if (message?.error) reject(new Error(message.error));
      else resolve(message.models || []);
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`模型 Worker 結束碼 ${code}`));
    });
  });
}

async function fetchOfficial(daysOverride = null) {
  const requestedDays = daysOverride ?? Number(process.env.HISTORY_DAYS || defaultHistoryDays);
  const historyDays = daysOverride != null
    ? Math.min(30, Math.max(1, daysOverride))
    : Math.min(30, Math.max(10, Number.isFinite(requestedDays) ? requestedDays : defaultHistoryDays));
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
  const parseItem = ({ record, openDate }) => {
    const snapshot = deriveSnapshot(record.drawTerm, record.openShowOrder, apiBaseUrl, openDate);
    snapshot.sourceLabel = '台灣彩券官方 API';
    snapshot.superNumber = String(record.bullEyeTop || '').padStart(2, '0');
    snapshot.size = record.highLowTop && record.highLowTop !== '－' ? record.highLowTop : snapshot.size;
    snapshot.oddEven = record.oddEvenTop && record.oddEvenTop !== '－' ? record.oddEvenTop : snapshot.oddEven;
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
    size: size || snapshot.size,
    oddEven: oddEvenRaw === '－' || oddEvenRaw === '-' ? '和' : oddEvenRaw || snapshot.oddEven,
  };
}

async function fetchMirror(source) {
  const response = await fetchWithTimeout(source.url, { headers: { accept: 'text/html', 'user-agent': 'bingo-research-api/1.0' } });
  if (!response.ok) throw new Error(`${source.name} HTTP ${response.status}`);
  return parseMirrorPage(await response.text(), source.name);
}

function nextPredictionPeriod(period) {
  const numeric = Number(period);
  return Number.isFinite(numeric) ? String(numeric + 1) : `${period}-next`;
}

async function latest(daysOverride = null, existingHistory = []) {
  const health = [];
  const attempts = [{ name: '台灣彩券官方 API', run: () => fetchOfficial(daysOverride) }, ...fallbackSources.map((source) => ({ name: source.name, run: () => fetchMirror(source) }))];
  for (const attempt of attempts) {
    try {
      const result = await attempt.run();
      const snapshot = result.snapshot || result;
      health.push({ name: attempt.name, ok: true });
      const syncedAt = Date.now();
      const fetchedHistory = result.history || [snapshot];
      const historyByPeriod = new Map(existingHistory.map((item) => [String(item.period), item]));
      fetchedHistory.forEach((item) => {
        const previous = historyByPeriod.get(String(item.period));
        historyByPeriod.set(String(item.period), previous
          ? { ...previous, ...item, superNumber: item.superNumber || previous.superNumber, size: item.size || previous.size, oddEven: item.oddEven || previous.oddEven }
          : item);
      });
      const rawHistory = [...historyByPeriod.values()].sort((a, b) => Number(b.period) - Number(a.period));
      const nextPeriod = nextPredictionPeriod(rawHistory[0]?.period || snapshot.period);
      const history = [];
      for (let index = 0; index < rawHistory.length; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        const item = rawHistory[index];
        const drawAt = formatTaipeiDateTime(new Date(syncedAt - index * 5 * 60 * 1000));
        const isNextPrediction = index === 0;
        const modelSnapshot = isNextPrediction ? { ...item, period: nextPeriod, drawAt } : item;
        const modelHistory = rawHistory.slice(index + 1, index + maxModelHistory + 1).map(({ period, numbers, superNumber, size, oddEven, drawAt }) => ({ period, numbers, superNumber, size, oddEven, drawAt }));
        const models = index > 0 && item.models?.length
          ? item.models
          : await buildModelsInWorker(modelSnapshot, modelHistory, { evolve: isNextPrediction, castingAt: new Date(syncedAt - index * 5 * 60 * 1000).toISOString() });
        history.push({
          ...item,
          drawAt,
          predictionTargetPeriod: isNextPrediction ? nextPeriod : item.period,
          models: index < maxModelHistory ? models : [],
          fetchedAt: syncedAt,
          sourceHealth: health,
        });
      }
      await persistSnapshots(history);
      const backup = await backupModelProfile(history[0]);
      return { ...history[0], history, historyDays: Math.max(result.historyDays || 1, existingHistory.length ? 30 : 1), sourceHealth: health, backup };
    } catch (error) {
      health.push({ name: attempt.name, ok: false, error: error instanceof Error ? error.message : '來源失敗' });
    }
  }
  throw new Error(`所有開獎來源均失敗：${health.map((item) => `${item.name}=${item.error || 'OK'}`).join('；')}`);
}

function persistedResponse(persisted) {
  if (!persisted.length) return null;
  return {
    ...persisted[0],
    history: persisted,
    historyDays: Math.max(30, persisted.length),
    sourceHealth: persisted[0].sourceHealth || [],
    backup: { enabled: Boolean(githubToken), repo: githubRepo, path: githubBackupPath },
  };
}

function refreshInBackground(persisted) {
  if (refreshInFlight) return;
  refreshInFlight = true;
  void latest(1, persisted)
    .catch((error) => console.error(JSON.stringify({ event: 'background-sync-failed', message: error instanceof Error ? error.message : '背景同步失敗' })))
    .finally(() => { refreshInFlight = false; });
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
    const persisted = await readPersistedCached(maxModelHistory);
    const requestedDays = forceRepair || !persisted.length ? 30 : 1;
    const refreshDays = requestedDays === 1 && persisted.length < maxModelHistory ? 30 : requestedDays;
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
      const persisted = await readPersistedCached(daysOverride && daysOverride > 1 ? 10000 : maxModelHistory);
      // 非開獎時段不應被官方 API 的空回應或逾時清空畫面；先回傳最近一筆已確認開獎資料，更新在背景完成。
      if (persisted.length && daysOverride === 1) {
        const cached = persistedResponse(persisted);
        refreshInBackground(persisted);
        return send(res, 200, cached, req);
      }
      const hasNextPrediction = persisted.length && persisted[0].predictionTargetPeriod && persisted[0].predictionTargetPeriod !== persisted[0].period;
      const hasUsableHistory = persisted.length >= maxModelHistory;
      if (persisted.length && !daysOverride && hasNextPrediction && hasUsableHistory) return send(res, 200, { ...persisted[0], history: persisted, historyDays: 30, sourceHealth: persisted[0].sourceHealth || [], backup: { enabled: Boolean(githubToken), repo: githubRepo, path: githubBackupPath } });
      const refreshDays = daysOverride === 1 && !hasUsableHistory ? 30 : daysOverride;
      return send(res, 200, await latest(refreshDays, persisted), req);
    } catch (error) { return send(res, 502, { error: error instanceof Error ? error.message : '官方資料同步失敗' }, req); }
  }
  send(res, 404, { error: 'Not found' });
});

if (isMainThread) {
  server.listen(port, '0.0.0.0', () => {
    console.log(`bingo-api listening on ${port}; database=${Boolean(pool)}`);
    const firstWakeAt = nextDrawAt(new Date()).getTime() - Date.now() - 30_000;
    scheduledTimer = setTimeout(() => void scheduledSync(false), Math.max(60_000, firstWakeAt));
  });
}
