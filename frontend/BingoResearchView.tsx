import { useCallback, useEffect, useMemo, useState } from 'react';
import { CustomScrollbar, PluginTopbar, Button } from '@cubelv/sdk';

const API_URL = 'https://bingo-api.zeabur.app/api/latest';
const MODEL_NAMES = ['梅花易數', '六爻八卦', '河圖洛書'];
type Evolution = Record<string, { empiricalWeight?: number; validationSamples?: number; score?: number | null; status?: string }>;
type Model = { name: string; rule: string; calculation?: { formula?: string; historySamples?: number; empiricalWeight?: number; empiricalWeights?: Record<string, number>; evolution?: Evolution }; official: { size: string; oddEven: string; superNumber: string; basic: Record<string, string[]> }; research: { numberPicks: string[]; sumBand: string; oddEvenCount: string; highLowCount: string; zones: string[] } };
type DrawSnapshot = { period: string; drawAt: string; numbers: string[]; superNumber: string; size: string; oddEven: string; source: string; sourceLabel: string; sourceHealth: Array<{ name: string; ok: boolean; error?: string }>; models: Model[]; fetchedAt?: number; history?: DrawSnapshot[]; historyDays?: number; backup?: { enabled: boolean; repo?: string; path?: string; reason?: string; error?: string } };
type Page = 'overview' | 'process' | 'history';

async function fetchLatest(days = 1): Promise<DrawSnapshot> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort('資料服務逾時'), 45_000);
    try {
      const response = await fetch(`${API_URL}?days=${days}`, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`資料服務 HTTP ${response.status}`);
      return await response.json() as DrawSnapshot;
    } catch (error) {
      lastError = error instanceof Error && /abort|signal/i.test(error.message)
        ? new Error('資料服務逾時，請稍後重試')
        : error;
      if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 800 * (attempt + 1)));
    } finally { window.clearTimeout(timeout); }
  }
  throw lastError instanceof Error ? lastError : new Error('資料服務連線失敗');
}

function getNextDraw(now: Date) {
  const taipei = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const year = taipei.getUTCFullYear(); const month = taipei.getUTCMonth(); const day = taipei.getUTCDate();
  const minute = taipei.getUTCHours() * 60 + taipei.getUTCMinutes(); const start = 425; const end = 1435;
  let targetDay = day; let targetMinutes = start;
  if (minute >= end) targetDay += 1;
  else if (minute >= start) targetMinutes = start + Math.ceil((minute - start + 1) / 5) * 5;
  return new Date(Date.UTC(year, month, targetDay, Math.floor(targetMinutes / 60), targetMinutes % 60, 0) - 8 * 60 * 60 * 1000);
}

function formatCountdown(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function parseModels(draw: DrawSnapshot): Model[] { return draw.models || []; }

function modelStats(draws: DrawSnapshot[]) {
  return MODEL_NAMES.map((model) => {
    const rows = draws.flatMap((draw) => parseModels(draw).filter((item) => item.name === model).map((item) => ({ item, draw })));
    const size = rows.filter(({ item, draw }) => item.official.size === draw.size).length;
    const oddEven = rows.filter(({ item, draw }) => item.official.oddEven === draw.oddEven).length;
    return { model, samples: rows.length, sizeRate: rows.length ? size / rows.length : null, oddEvenRate: rows.length ? oddEven / rows.length : null };
  });
}

function bestPlayStats(draws: DrawSnapshot[], latestModels: Model[]) {
  const plays = [{ key: 'size', label: '猜大小' }, { key: 'oddEven', label: '猜單雙' }, { key: 'superNumber', label: '超級獎號' }, ...Array.from({ length: 10 }, (_, i) => ({ key: `${i + 1}星`, label: `${i + 1} 星` }))];
  return plays.map((play) => {
    const candidates = MODEL_NAMES.map((model) => {
      const rows = draws.flatMap((draw) => parseModels(draw).filter((item) => item.name === model).map((item) => ({ item, draw })));
      const hits = rows.filter(({ item, draw }) => {
        if (play.key === 'size') return item.official.size === draw.size;
        if (play.key === 'oddEven') return item.official.oddEven === draw.oddEven;
        if (play.key === 'superNumber') return item.official.superNumber === draw.superNumber;
        const predicted = item.official.basic[play.key] || []; const actual = new Set(draw.numbers);
        return predicted.length > 0 && predicted.every((number) => actual.has(number));
      }).length;
      const latest = latestModels.find((item) => item.name === model);
      const prediction = play.key === 'size' ? latest?.official.size : play.key === 'oddEven' ? latest?.official.oddEven : play.key === 'superNumber' ? latest?.official.superNumber : latest?.official.basic[play.key]?.join('、');
      return { model, samples: rows.length, hits, rate: rows.length ? hits / rows.length : null, prediction: prediction || '—' };
    }).sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
    return { ...play, best: candidates[0] };
  });
}

function Rate({ value }: { value: number | null }) { return <span className="tabular-nums font-semibold">{value == null ? '—' : `${(value * 100).toFixed(1)}%`}</span>; }

export function BingoResearchView() {
  const [draws, setDraws] = useState<DrawSnapshot[]>([]);
  const sorted = useMemo(() => [...draws].sort((a, b) => Number(b.period) - Number(a.period) || b.fetchedAt - a.fetchedAt), [draws]);
  const [syncing, setSyncing] = useState(false); const [error, setError] = useState(''); const [lastSync, setLastSync] = useState<number | null>(null); const [historyDays, setHistoryDays] = useState(30); const [backup, setBackup] = useState<DrawSnapshot['backup']>(); const [now, setNow] = useState(() => new Date()); const [page, setPage] = useState<Page>('overview');
  const latest = sorted[0];
  const latestModels = useMemo(() => latest ? parseModels(latest) : [], [latest]);
  const stats = useMemo(() => modelStats(sorted), [sorted]);
  const bestPlays = useMemo(() => bestPlayStats(sorted, latestModels), [sorted, latestModels]);
  const sourceHealth = latest?.sourceHealth || [];

  const sync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true); setError('');
    try {
      const snapshot = await fetchLatest(1);
      const records = snapshot.history?.length ? snapshot.history : [snapshot];
      setDraws(records); setHistoryDays(snapshot.historyDays ?? 30); setBackup(snapshot.backup); setLastSync(Date.now());
    } catch (err) { setError(err instanceof Error ? err.message : '讀取失敗'); }
    finally { setSyncing(false); }
  }, [syncing]);

  useEffect(() => { void sync(); }, []);
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(timer); }, []);
  const nextDraw = getNextDraw(now); const taipeiTime = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', dateStyle: 'medium', timeStyle: 'medium' }).format(now);

  const pageButton = (key: Page, label: string) => <Button size="sm" variant={page === key ? 'default' : 'ghost'} onClick={() => setPage(key)}>{label}</Button>;
  const mobilePageButton = (key: Page, label: string) => <Button className="h-12 flex-1 flex-col gap-0.5 px-1 text-[11px]" size="sm" variant={page === key ? 'default' : 'ghost'} onClick={() => setPage(key)}><span>{label}</span><span className="text-[9px] opacity-70">{page === key ? '目前' : '查看'}</span></Button>;
  return <div className="h-full min-w-0 max-w-full flex flex-col min-h-0 overflow-x-hidden bg-slate-950 text-slate-100">
    <PluginTopbar title="賓果玄學研究台" rightButtons={[{ icon: syncing ? 'loader-2' : 'refresh', onClick: syncing ? undefined : () => void sync(), title: syncing ? '同步中' : '重新讀取' }]} />
    <div className="flex-1 min-h-0 min-w-0 overflow-x-hidden"><CustomScrollbar orientation="vertical"><div className="mx-auto min-w-0 max-w-4xl space-y-3 overflow-x-hidden p-3 pb-20 sm:p-4 sm:pb-4">
      <div className="rounded-2xl border border-cyan-400/30 bg-slate-900 p-3 shadow-lg shadow-cyan-950/30 sm:p-4"><div className="flex items-center justify-between gap-3"><div><div className="text-[11px] text-slate-400">下期開獎倒數</div><div className="tabular-nums text-2xl font-semibold text-cyan-300 sm:text-3xl">{formatCountdown(nextDraw.getTime() - now.getTime())}</div></div><div className="text-right"><div className="text-xs text-slate-400">台北時間</div><div className="text-xs text-slate-300">{taipeiTime}</div></div></div><div className="mt-3 hidden flex-wrap gap-1 border-t border-slate-700 pt-2 sm:flex">{pageButton('overview', '首頁')}{pageButton('process', '計算過程')}{pageButton('history', '歷史紀錄')}</div></div>
      {error && <div className="rounded-lg border border-red-400/50 bg-red-950/40 p-3 text-sm text-red-200">{error}</div>}
      {page === 'overview' && <>
        <section className="rounded-2xl border border-cyan-400/30 bg-slate-900 p-3 shadow-lg shadow-cyan-950/20 sm:p-4"><div className="flex items-center justify-between gap-2"><h2 className="font-semibold text-cyan-300">最新開獎號碼</h2><span className="shrink-0 text-lg font-semibold tabular-nums text-cyan-200">{latest ? `第 ${latest.period} 期` : '等待同步'}</span></div>{latest ? <><div className="mt-3 grid grid-cols-10 gap-1.5">{latest.numbers.map((number, index) => <span key={`${number}-${index}`} className="flex aspect-square items-center justify-center rounded-full border border-cyan-300/60 bg-gradient-to-br from-cyan-300 to-blue-700 text-[11px] font-bold tabular-nums text-white shadow-[0_2px_6px_rgba(34,211,238,0.25)] sm:text-xs">{number}</span>)}</div><div className="mt-3 flex items-center justify-between rounded-xl border border-amber-300/40 bg-amber-950/20 px-3 py-2"><span className="text-xs font-medium text-amber-200 sm:text-sm">超級獎號</span><span className="flex h-9 w-9 items-center justify-center rounded-full border border-amber-200/80 bg-gradient-to-br from-amber-300 to-orange-600 text-sm font-bold tabular-nums text-white shadow-[0_2px_8px_rgba(251,191,36,0.35)]">{latest.superNumber || '—'}</span></div></> : <p className="mt-2 text-sm text-slate-400">等待首次同步。</p>}</section>
        <section className="min-w-0 max-w-full rounded-2xl border border-amber-300/40 bg-slate-900 p-3 shadow-lg shadow-amber-950/20 sm:p-4"><h2 className="font-semibold text-amber-300">本期預測玩法與號碼</h2><div className="mt-2 min-w-0 max-w-full divide-y divide-slate-800 overflow-hidden rounded-xl border border-slate-700 bg-slate-950/50">{bestPlays.map((play) => <div key={play.key} className="grid min-w-0 max-w-full grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 px-2.5 py-2 sm:grid-cols-[6rem_minmax(0,1fr)]"><span className="shrink-0 whitespace-nowrap text-xs text-slate-300 sm:text-sm">{play.label}</span><div className="block min-w-0 max-w-full overflow-x-auto"><span className="block w-max min-w-full whitespace-nowrap text-sm font-semibold tabular-nums text-cyan-300 sm:text-base">{play.best.prediction}</span></div></div>)}</div></section>
      </>}
      {page === 'process' && <section className="rounded-2xl border border-amber-300/50 bg-slate-900 p-3 shadow-lg shadow-amber-950/20 sm:p-4"><h2 className="font-semibold text-amber-300">查看計算過程</h2><div className="mt-3 space-y-2 text-sm"><div className="rounded-xl border-l-4 border-cyan-300 bg-slate-800 p-3"><b>1. 資料收集</b><p className="mt-1 text-xs leading-5 text-slate-400">讀取持久化開獎歷史，檢查遺漏與異常值。</p></div><div className="rounded-xl border-l-4 border-cyan-300 bg-slate-800 p-3"><b>2. 特徵提取</b><p className="mt-1 text-xs leading-5 text-slate-400">梅花易數、六爻八卦與河圖洛書分別產生候選特徵。</p></div><div className="rounded-xl border-l-4 border-cyan-300 bg-slate-800 p-3"><b>3. 模型推理</b><p className="mt-1 text-xs leading-5 text-slate-400">多模型融合計算，產生各玩法與星級候選。</p></div><div className="rounded-xl border-l-4 border-amber-300 bg-slate-800 p-3"><b>4. 結果驗證與自動演化</b>{latestModels.map((model) => <div key={model.name} className="mt-3 rounded-lg border border-slate-700 bg-slate-950/60 p-2.5"><div className="font-medium text-white">{model.name}</div><div className="mt-1 text-xs leading-5 text-slate-400">{model.rule}</div><div className="mt-2 break-words text-xs leading-5 text-slate-300">{model.calculation?.formula || '舊版紀錄沒有保存公式'}{model.calculation?.historySamples != null ? ` · 前期樣本 ${model.calculation.historySamples} 期` : ''}</div><div className="mt-1 text-xs text-amber-200">各玩法／星級獨立權重：{model.calculation?.empiricalWeights ? Object.entries(model.calculation.empiricalWeights).map(([target, weight]) => `${target}=${weight}`).join(' · ') : '舊版紀錄沒有分玩法權重'}</div><div className="mt-1 break-words text-xs leading-5 text-slate-300">回測狀態：{model.calculation?.evolution ? Object.entries(model.calculation.evolution).map(([target, profile]) => `${target} ${(profile.score == null ? '—' : `${(profile.score * 100).toFixed(1)}%`)}`).join(' · ') : '舊版紀錄沒有演化資訊'}</div><div className="mt-1 break-words text-xs leading-5 text-slate-300">候選號碼：{model.research.numberPicks.join('、')} · 區間：{model.research.zones.join('、')} · 總和：{model.research.sumBand}</div></div>)}</div><div className="rounded-xl border-l-4 border-amber-300 bg-slate-800 p-3"><b>5. 輸出預測</b><p className="mt-1 font-mono text-xs leading-5 text-slate-300">勝率 = 命中期數 ÷ 有效預測期數 × 100%；回測結果不代表下一期保證。</p></div></div></section>}
      {page === 'history' && <section className="rounded-2xl border border-cyan-400/30 bg-slate-900 p-3 shadow-lg shadow-cyan-950/20 sm:p-4"><h2 className="font-semibold text-cyan-300">歷史開獎與預測</h2><p className="mt-1 text-xs text-slate-400">資料由 Zeabur PostgreSQL 提供，前端僅讀取，不在 Vault 建立、修改或刪除紀錄。</p><div className="mt-3 space-y-2">{sorted.slice(0, 50).map((draw) => <div key={draw.period} className="rounded-xl border border-slate-700 p-3"><div className="text-sm"><b className="text-white">第 {draw.period} 期</b><div className="mt-1 text-[11px] text-slate-400">開獎 {draw.drawAt || '時間未知'} · 來源 {draw.sourceLabel || '未知'}</div></div><div className="mt-2 break-words text-xs leading-5 text-slate-300">號碼：{draw.numbers.join('、')} · 大小／單雙：{draw.size || '—'}／{draw.oddEven || '—'} · 預測模型：{parseModels(draw).map((model) => model.name).join('、') || '—'}</div></div>)}{sorted.length === 0 && <p className="text-sm text-slate-400">尚無歷史紀錄。</p>}</div></section>}
      {page !== 'overview' && sourceHealth.length > 0 && <div className="text-xs text-slate-500">資料來源：{sourceHealth.filter((source) => source.ok).map((source) => source.name).join('、')} · {backup?.enabled ? `算法／權重已備份至 ${backup.repo || 'GitHub'}` : '算法／權重 GitHub 備份尚未啟用'}</div>}
    </div></CustomScrollbar></div>
    <div className="fixed inset-x-0 bottom-0 z-20 flex gap-1 border-t border-cyan-400/30 bg-slate-950/95 p-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] shadow-lg backdrop-blur sm:hidden">{mobilePageButton('overview', '總覽')}{mobilePageButton('process', '過程')}{mobilePageButton('history', '歷史')}</div>
  </div>;
}
