import http from 'node:http';
import pg from 'pg';

const { Pool } = pg;

const port = Number(process.env.PORT || 8080);
const sourceUrl = 'https://www.taiwanlottery.com/lotto/result/bingo_bingo/';
const apiBaseUrl = 'https://api.taiwanlottery.com/TLCAPIWeB/Lottery/BingoResult';
const defaultHistoryDays = 30;
const maxModelHistory = 60;
const fallbackSources = [
  { name: 'Pilio 賓果開獎查詢', url: 'https://www.pilio.idv.tw/bingo/list.asp' },
  { name: 'Auzo 奧索樂透網', url: 'https://lotto.auzo.tw/bingobingo.php' },
];
const databaseUrl = process.env.DATABASE_URL || '';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 4, idleTimeoutMillis: 30_000 }) : null;
let databaseReady = false;
let lastPersistedPeriod = '';
let scheduledTimer;

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
    fetched_at BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);
  await pool.query('CREATE INDEX IF NOT EXISTS bingo_draws_updated_idx ON bingo_draws (updated_at DESC)');
  databaseReady = true;
}

async function persistSnapshots(snapshots) {
  if (!pool || !snapshots.length) return;
  await ensureDatabase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of snapshots) {
      await client.query(`INSERT INTO bingo_draws
        (period, draw_at, numbers, super_number, size, odd_even, source, source_label, source_health, models, fetched_at)
        VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)
        ON CONFLICT (period) DO UPDATE SET draw_at=EXCLUDED.draw_at, numbers=EXCLUDED.numbers,
        super_number=EXCLUDED.super_number, size=EXCLUDED.size, odd_even=EXCLUDED.odd_even,
        source=EXCLUDED.source, source_label=EXCLUDED.source_label, source_health=EXCLUDED.source_health,
        models=EXCLUDED.models, fetched_at=EXCLUDED.fetched_at, updated_at=NOW()` , [
        item.period, item.drawAt || '', JSON.stringify(item.numbers), item.superNumber || '', item.size || '', item.oddEven || '',
        item.source || '', item.sourceLabel || '', JSON.stringify(item.sourceHealth || []), JSON.stringify(item.models || []), item.fetchedAt || Date.now(),
      ]);
    }
    await client.query('COMMIT');
    lastPersistedPeriod = snapshots[0]?.period || lastPersistedPeriod;
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
    models, fetched_at AS "fetchedAt" FROM bingo_draws ORDER BY period DESC LIMIT $1`, [Math.min(10000, Math.max(1, limit))]);
  return result.rows.map((row) => ({ ...row, numbers: Array.isArray(row.numbers) ? row.numbers : [], sourceHealth: row.sourceHealth || [], models: row.models || [] }));
}

function cleanHtml(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function digitSum(value) {
  return value.split('').reduce((sum, digit) => sum + Number(digit), 0);
}

function seededRandom(seed) {
  let state = Math.abs(Math.trunc(seed)) % 2147483647 || 1;
  return () => { state = state * 16807 % 2147483647; return (state - 1) / 2147483646; };
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

function parseTaipeiParts(value) {
  const date = value ? new Date(value.replace(/\//g, '-')) : new Date();
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hour12: false }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

function meihuaCasting(snapshot) {
  const t = parseTaipeiParts(snapshot.drawAt);
  const total = t.year + t.month + t.day;
  const upper = total % 8 || 8;
  const lower = (total + t.hour) % 8 || 8;
  const moving = (total + t.hour) % 6 || 6;
  return { upper, lower, moving, formula: `上卦=(年+月+日) mod 8=${upper}；下卦=(年+月+日+時) mod 8=${lower}；動爻 mod 6=${moving}` };
}

function sixyaoCasting(snapshot) {
  const seed = Number(snapshot.period) + digitSum(snapshot.period) * 97;
  const random = seededRandom(seed);
  const lines = Array.from({ length: 6 }, () => {
    const roll = 3 + Math.floor(random() * 15);
    return { roll, value: roll % 4 === 0 ? 9 : roll % 4 === 1 ? 6 : roll % 2 === 0 ? 8 : 7, moving: roll === 6 || roll === 9 };
  });
  const binary = lines.map((line) => line.value === 6 || line.value === 8 ? 0 : 1).reverse().join('');
  return { lines, binary, formula: '以期號作固定種子模擬六次三枚硬幣；由下往上記錄陰陽與動爻' };
}

function luoshuCasting(snapshot) {
  const t = parseTaipeiParts(snapshot.drawAt);
  const luoshu = [[4, 9, 2], [3, 5, 7], [8, 1, 6]];
  const palace = (t.year + t.month + t.day + t.hour) % 9;
  const row = luoshu[Math.floor(palace / 3)];
  const center = luoshu[Math.floor(palace / 3)][palace % 3];
  return { luoshu, palace: palace + 1, center, formula: `以年月日時總和 mod 9 定洛書宮位=${palace + 1}；宮位數=${center}` };
}

function historicalFrequencies(history) {
  const counts = Array(81).fill(0);
  history.forEach((draw, index) => draw.numbers.forEach((number) => { counts[Number(number)] += 1 / (index + 1); }));
  const total = history.length || 1;
  return counts.map((count) => count / total);
}

function scoreNumbers(seed, count, tradition, history, empiricalWeight = 0.32) {
  const frequencies = historicalFrequencies(history);
  const random = seededRandom(seed);
  const values = Array.from({ length: 80 }, (_, index) => index + 1).map((number) => {
    const row = Math.floor((number - 1) / 10);
    const col = (number - 1) % 10;
    const parity = number % 2 ? 1 : -1;
    const traditional = tradition.kind === 'luoshu'
      ? (1 - Math.abs((tradition.center + row + col) % 9 - 4) / 4) * 0.55 + (number % tradition.center === 0 ? 0.2 : 0)
      : tradition.kind === 'sixyao'
        ? ((tradition.bits[(number + tradition.moving) % 6] === '1' ? 1 : -1) * parity * 0.12) + (number % 8 === tradition.lower ? 0.18 : 0)
        : ((number % 8 === tradition.upper ? 0.32 : 0) + (number % 6 === tradition.moving ? 0.16 : 0));
    const empirical = clamp(frequencies[number] / 0.25, 0, 1) * empiricalWeight;
    return { number, score: traditional * (1 - empiricalWeight) + empirical + random() * 0.06 };
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
  const oddEven = text.match(/猜單雙\s*([單雙－-])/)?.[1] || '';
  if (!period || !numbers) throw new Error('官方頁面格式變更，無法解析完整開獎資料');
  return { period, drawAt, numbers: numbers[1].trim().split(/\\s+/).map((n) => n.padStart(2, '0')), superNumber: numbers[2].padStart(2, '0'), size, oddEven };
}

function evolveProfiles(history = []) {
  const candidates = [0.12, 0.24, 0.32, 0.44, 0.56];
  const methods = ['梅花易數', '六爻八卦', '河圖洛書'];
  return Object.fromEntries(methods.map((method) => {
    if (history.length < 4) return [method, { empiricalWeight: 0.32, validationSamples: 0, score: null, status: '樣本不足，使用預設權重' }];
    const results = candidates.map((empiricalWeight) => {
      let hits = 0; let trials = 0;
      history.slice(0, 8).forEach((target, index) => {
        const training = history.slice(index + 1);
        const predicted = buildModels(target, training, { evolve: false, profiles: { [method]: { empiricalWeight } } }).find((item) => item.name === method);
        if (!predicted) return;
        if (predicted.official.size === target.size) hits += 1;
        if (predicted.official.oddEven === target.oddEven) hits += 1;
        const actual = new Set(target.numbers);
        const topThree = predicted.official.basic['3星'] || [];
        hits += topThree.filter((number) => actual.has(number)).length / 3;
        trials += 3;
      });
      return { empiricalWeight, score: trials ? hits / trials : 0, validationSamples: Math.min(8, history.length) };
    });
    const best = results.sort((a, b) => b.score - a.score || Math.abs(a.empiricalWeight - 0.32) - Math.abs(b.empiricalWeight - 0.32))[0];
    return [method, { ...best, status: 'walk-forward 自動選參數' }];
  }));
}

function buildModels(snapshot, history = [], options = {}) {
  const profiles = options.profiles || (options.evolve === false ? {} : evolveProfiles(history));
  const meihua = meihuaCasting(snapshot);
  const sixyao = sixyaoCasting(snapshot);
  const luoshu = luoshuCasting(snapshot);
  const methods = [
    { name: '梅花易數', kind: 'meihua', tradition: { kind: 'meihua', ...meihua }, seed: Number(snapshot.period) + 11, calculation: meihua },
    { name: '六爻八卦', kind: 'sixyao', tradition: { kind: 'sixyao', bits: sixyao.binary, moving: sixyao.lines.filter((line) => line.moving).length, lower: 1 }, seed: Number(snapshot.period) + 37, calculation: sixyao },
    { name: '河圖洛書', kind: 'luoshu', tradition: { kind: 'luoshu', center: luoshu.center }, seed: Number(snapshot.period) + 61, calculation: luoshu },
  ];
  return methods.map((method) => {
    const profile = profiles[method.name] || { empiricalWeight: 0.32 };
    const picks = scoreNumbers(method.seed, 10, method.tradition, history, profile.empiricalWeight);
    const modelSeed = method.seed;
    const sumBand = ['低區', '中區', '高區'][modelSeed % 3];
    const oddEvenCount = ['單數偏多', '雙數偏多', '均衡'][modelSeed % 3];
    const highLowCount = ['小號偏多', '大號偏多', '均衡'][Math.floor(modelSeed / 3) % 3];
    return {
      name: method.name,
      rule: '傳統起卦特徵＋歷史頻率先驗＋固定種子排序；非因果預測，需以未來期數回測',
      calculation: { method: method.kind, ...method.calculation, historySamples: history.length, empiricalWeight: history.length ? profile.empiricalWeight : 0, evolution: profiles[method.name] || null },
      official: {
        size: modelSeed % 2 === 0 ? '大' : '小',
        oddEven: modelSeed % 3 === 0 ? '雙' : '單',
        superNumber: picks[modelSeed % picks.length],
        basic: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`${index + 1}星`, picks.slice(0, index + 1)])),
      },
      research: {
        numberPicks: picks,
        sumBand,
        oddEvenCount,
        highLowCount,
        zones: [`${(modelSeed % 4) * 20 + 1}-${(modelSeed % 4 + 1) * 20}`],
      },
    };
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
      const response = await fetch(`${apiBaseUrl}?openDate=${openDate}&pageNum=1&pageSize=500`, { headers: { accept: 'application/json', origin: 'https://www.taiwanlottery.com' } });
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
  return deriveSnapshot(periodMatch[1], numbers, sourceName);
}

async function fetchMirror(source) {
  const response = await fetch(source.url, { headers: { accept: 'text/html', 'user-agent': 'bingo-research-api/1.0' } });
  if (!response.ok) throw new Error(`${source.name} HTTP ${response.status}`);
  return parseMirrorPage(await response.text(), source.name);
}

async function latest(daysOverride = null) {
  const health = [];
  const attempts = [{ name: '台灣彩券官方 API', run: () => fetchOfficial(daysOverride) }, ...fallbackSources.map((source) => ({ name: source.name, run: () => fetchMirror(source) }))];
  for (const attempt of attempts) {
    try {
      const result = await attempt.run();
      const snapshot = result.snapshot || result;
      health.push({ name: attempt.name, ok: true });
      const syncedAt = Date.now();
      const rawHistory = result.history || [snapshot];
      const history = rawHistory.map((item, index) => ({ ...item, drawAt: formatTaipeiDateTime(new Date(syncedAt - index * 5 * 60 * 1000)), models: index < maxModelHistory ? buildModels(item, rawHistory.slice(index + 1, index + maxModelHistory + 1)) : [], fetchedAt: syncedAt, sourceHealth: health }));
      await persistSnapshots(history);
      return { ...history[0], history, historyDays: result.historyDays || 1, sourceHealth: health };
    } catch (error) {
      health.push({ name: attempt.name, ok: false, error: error instanceof Error ? error.message : '來源失敗' });
    }
  }
  throw new Error(`所有開獎來源均失敗：${health.map((item) => `${item.name}=${item.error || 'OK'}`).join('；')}`);
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
    const persisted = await readPersisted(1);
    const requestedDays = forceRepair || !persisted.length ? 30 : 1;
    const result = await latest(requestedDays);
    if (!forceRepair && persisted[0]?.period && result.period !== persisted[0].period) await latest(30);
    console.log(JSON.stringify({ event: 'sync-ok', period: result.period, historyDays: result.historyDays, persisted: Boolean(pool) }));
  } catch (error) {
    console.error(JSON.stringify({ event: 'sync-failed', message: error instanceof Error ? error.message : '同步失敗' }));
  } finally {
    const wakeAt = nextDrawAt(new Date()).getTime() - Date.now() - 30_000;
    scheduledTimer = setTimeout(() => void scheduledSync(false), Math.max(30_000, wakeAt));
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': process.env.CORS_ORIGIN || '*' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, service: 'bingo-api' });
  if (req.method === 'GET' && req.url.startsWith('/api/latest')) {
    try {
      const requestUrl = new URL(req.url, 'http://localhost');
      const requestedDays = Number(requestUrl.searchParams.get('days'));
      const daysOverride = Number.isFinite(requestedDays) && requestedDays > 0 ? requestedDays : null;
      const persisted = await readPersisted(daysOverride && daysOverride > 1 ? 10000 : 600);
      if (persisted.length && !daysOverride) return send(res, 200, { ...persisted[0], history: persisted, historyDays: 30, sourceHealth: persisted[0].sourceHealth || [] });
      if (persisted.length && daysOverride === 1) return send(res, 200, { ...persisted[0], history: persisted, historyDays: 1, sourceHealth: persisted[0].sourceHealth || [] });
      return send(res, 200, await latest(daysOverride));
    } catch (error) { return send(res, 502, { error: error instanceof Error ? error.message : '官方資料同步失敗' }); }
  }
  send(res, 404, { error: 'Not found' });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`bingo-api listening on ${port}; database=${Boolean(pool)}`);
  void scheduledSync(true);
});
