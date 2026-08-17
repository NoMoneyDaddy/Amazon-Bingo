import http from 'node:http';

const port = Number(process.env.PORT || 8080);
const sourceUrl = 'https://www.taiwanlottery.com/lotto/result/bingo_bingo/';

function cleanHtml(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function digitSum(value) {
  return value.split('').reduce((sum, digit) => sum + Number(digit), 0);
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
  return [
    { name: '梅花易數', size: seed % 2 === 0 ? '大' : '小', oddEven: seed % 3 === 0 ? '雙' : '單' },
    { name: '六爻八卦', size: Math.floor(seed / 3) % 2 === 0 ? '大' : '小', oddEven: seed % 5 === 0 ? '雙' : '單' },
    { name: '河圖洛書', size: (digitSum(snapshot.period) + Number(minute)) % 2 === 0 ? '大' : '小', oddEven: (digitSum(snapshot.period) + Number(minute)) % 2 === 0 ? '雙' : '單' },
  ].map((model) => ({ ...model, rule: '固定規則轉換，非因果預測；需以未來期數回測' }));
}

async function latest() {
  const response = await fetch(sourceUrl, { headers: { 'user-agent': 'bingo-research-api/1.0' } });
  if (!response.ok) throw new Error(`官方資料 HTTP ${response.status}`);
  const snapshot = parseOfficialPage(await response.text());
  return { ...snapshot, models: buildModels(snapshot), source: sourceUrl, fetchedAt: Date.now() };
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
