import http from 'node:http';

const port = Number(process.env.PORT || 8080);
const sourceUrl = 'https://www.taiwanlottery.com/lotto/result/bingo_bingo/';
const apiBaseUrl = 'https://api.taiwanlottery.com/TLCAPIWeB/Lottery/BingoResult';
const fallbackSources = [
  { name: 'Pilio 賓果開獎查詢', url: 'https://www.pilio.idv.tw/bingo/list.asp' },
  { name: 'Auzo 奧索樂透網', url: 'https://lotto.auzo.tw/bingobingo.php' },
];

function cleanHtml(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function digitSum(value) {
  return value.split('').reduce((sum, digit) => sum + Number(digit), 0);
}

function pickNumbers(seed, count) {
  const values = Array.from({ length: 80 }, (_, index) => index + 1);
  values.sort((a, b) => {
    const scoreA = (a * 73 + seed * 31 + (a % 7) * 17) % 997;
    const scoreB = (b * 73 + seed * 31 + (b % 7) * 17) % 997;
    return scoreA - scoreB || a - b;
  });
  return values.slice(0, count).sort((a, b) => a - b).map((n) => String(n).padStart(2, '0'));
}

function datePartsTaipei() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
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

function buildModels(snapshot) {
  const minute = snapshot.drawAt.match(/(\d{1,2}):(\d{2})/)?.[2] || '00';
  const seed = Number(snapshot.period) + digitSum(snapshot.period) + Number(minute);
  const methodSeeds = [
    { name: '梅花易數', offset: 11 },
    { name: '六爻八卦', offset: 37 },
    { name: '河圖洛書', offset: 61 },
  ];
  return methodSeeds.map((method) => {
    const modelSeed = seed + method.offset;
    const picks = pickNumbers(modelSeed, 10);
    const sumBand = ['低區', '中區', '高區'][modelSeed % 3];
    const oddEvenCount = ['單數偏多', '雙數偏多', '均衡'][modelSeed % 3];
    const highLowCount = ['小號偏多', '大號偏多', '均衡'][Math.floor(modelSeed / 3) % 3];
    return {
      name: method.name,
      rule: '固定規則轉換，非因果預測；需以未來期數回測',
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

async function fetchOfficial() {
  const dateValue = datePartsTaipei();
  const openDate = `${dateValue.year}-${dateValue.month}-${dateValue.day}`;
  const response = await fetch(`${apiBaseUrl}?openDate=${openDate}&pageNum=1&pageSize=10`, { headers: { accept: 'application/json', origin: 'https://www.taiwanlottery.com' } });
  if (!response.ok) throw new Error(`官方資料 HTTP ${response.status}`);
  const payload = await response.json();
  const item = payload?.content?.bingoQueryResult?.[0];
  if (!item?.drawTerm || !Array.isArray(item.openShowOrder) || item.openShowOrder.length !== 20) {
    throw new Error('官方 API 未回傳完整的最新 20 號資料');
  }
  const parsedNumbers = item.openShowOrder.map((n) => Number(n));
  const bigCount = parsedNumbers.filter((n) => n >= 41).length;
  const oddCount = parsedNumbers.filter((n) => n % 2 === 1).length;
  const parseItem = (record) => {
    const snapshot = deriveSnapshot(record.drawTerm, record.openShowOrder, apiBaseUrl, openDate);
    snapshot.sourceLabel = '台灣彩券官方 API';
    snapshot.superNumber = String(record.bullEyeTop || '').padStart(2, '0');
    snapshot.size = record.highLowTop && record.highLowTop !== '－' ? record.highLowTop : snapshot.size;
    snapshot.oddEven = record.oddEvenTop && record.oddEvenTop !== '－' ? record.oddEvenTop : snapshot.oddEven;
    return snapshot;
  };
  return { snapshot: parseItem(item), history: payload.content.bingoQueryResult.filter((record) => record?.drawTerm && Array.isArray(record.openShowOrder) && record.openShowOrder.length === 20).map(parseItem) };
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

async function latest() {
  const health = [];
  const attempts = [{ name: '台灣彩券官方 API', run: fetchOfficial }, ...fallbackSources.map((source) => ({ name: source.name, run: () => fetchMirror(source) }))];
  for (const attempt of attempts) {
    try {
      const result = await attempt.run();
      const snapshot = result.snapshot || result;
      health.push({ name: attempt.name, ok: true });
      const history = (result.history || [snapshot]).map((item) => ({ ...item, models: buildModels(item), fetchedAt: Date.now(), sourceHealth: health }));
      return { ...history[0], history, sourceHealth: health };
    } catch (error) {
      health.push({ name: attempt.name, ok: false, error: error instanceof Error ? error.message : '來源失敗' });
    }
  }
  throw new Error(`所有開獎來源均失敗：${health.map((item) => `${item.name}=${item.error || 'OK'}`).join('；')}`);
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': process.env.CORS_ORIGIN || '*' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, service: 'bingo-api' });
  if (req.method === 'GET' && req.url === '/api/latest') {
    try { return send(res, 200, await latest()); } catch (error) { return send(res, 502, { error: error instanceof Error ? error.message : '官方資料同步失敗' }); }
  }
  send(res, 404, { error: 'Not found' });
});

server.listen(port, '0.0.0.0', () => console.log(`bingo-api listening on ${port}`));
