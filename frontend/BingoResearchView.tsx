import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CustomScrollbar, PluginTopbar, Button, useItemsByType, useItemStore, useSelectedItemsStore, generateObjectID, toast } from '@cubelv/sdk';
import { BingoDraw } from './schemas/bingoResearchSchema';

const API_URL = 'https://bingo-api.zeabur.app/api/latest';
const MODEL_NAMES = ['梅花易數', '六爻八卦', '河圖洛書'];
type Model = { name: string; rule: string; calculation?: { formula?: string; historySamples?: number; empiricalWeight?: number; evolution?: { empiricalWeight?: number; validationSamples?: number; score?: number | null; status?: string } }; official: { size: string; oddEven: string; superNumber: string; basic: Record<string, string[]> }; research: { numberPicks: string[]; sumBand: string; oddEvenCount: string; highLowCount: string; zones: string[] } };
type DrawSnapshot = { period: string; drawAt: string; numbers: string[]; superNumber: string; size: string; oddEven: string; source: string; sourceLabel: string; sourceHealth: Array<{ name: string; ok: boolean; error?: string }>; models: Model[]; history?: DrawSnapshot[] };
type Page = 'overview' | 'process' | 'history';

async function fetchLatest(): Promise<DrawSnapshot> {
  const response = await fetch(API_URL);
  if (!response.ok) throw new Error(`資料服務 HTTP ${response.status}`);
  return await response.json() as DrawSnapshot;
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

function parseModels(draw: BingoDraw): Model[] {
  try { return JSON.parse(draw.modelPredictions || '[]') as Model[]; } catch { return []; }
}

function modelStats(draws: BingoDraw[]) {
  return MODEL_NAMES.map((model) => {
    const rows = draws.flatMap((draw) => parseModels(draw).filter((item) => item.name === model).map((item) => ({ item, draw })));
    const size = rows.filter(({ item, draw }) => item.official.size === draw.size).length;
    const oddEven = rows.filter(({ item, draw }) => item.official.oddEven === draw.oddEven).length;
    return { model, samples: rows.length, sizeRate: rows.length ? size / rows.length : null, oddEvenRate: rows.length ? oddEven / rows.length : null };
  });
}

function bestPlayStats(draws: BingoDraw[], latestModels: Model[]) {
  const plays = [{ key: 'size', label: '猜大小' }, { key: 'oddEven', label: '猜單雙' }, { key: 'superNumber', label: '超級獎號' }, ...Array.from({ length: 10 }, (_, i) => ({ key: `${i + 1}星`, label: `${i + 1} 星` }))];
  return plays.map((play) => {
    const candidates = MODEL_NAMES.map((model) => {
      const rows = draws.flatMap((draw) => parseModels(draw).filter((item) => item.name === model).map((item) => ({ item, draw })));
      const hits = rows.filter(({ item, draw }) => {
        if (play.key === 'size') return item.official.size === draw.size;
        if (play.key === 'oddEven') return item.official.oddEven === draw.oddEven;
        if (play.key === 'superNumber') return item.official.superNumber === draw.superNumber;
        const predicted = item.official.basic[play.key] || []; const actual = new Set(draw.numbers.split(','));
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
  const draws = useItemsByType<BingoDraw>('BINGO_DRAW');
  const sorted = useMemo(() => [...draws].sort((a, b) => Number(b.period) - Number(a.period) || b.fetchedAt - a.fetchedAt), [draws]);
  const drawsRef = useRef(draws);
  const syncingRef = useRef(false);
  const folderId = useSelectedItemsStore((s) => s.lastFolderId);
  const [syncing, setSyncing] = useState(false); const [error, setError] = useState(''); const [lastSync, setLastSync] = useState<number | null>(null); const [now, setNow] = useState(() => new Date()); const [page, setPage] = useState<Page>('overview');
  const latest = sorted[0];
  const latestModels = useMemo(() => latest ? parseModels(latest) : [], [latest]);
  const stats = useMemo(() => modelStats(sorted), [sorted]);
  const bestPlays = useMemo(() => bestPlayStats(sorted, latestModels), [sorted, latestModels]);
  const sourceHealth = latest?.sourceHealth ? (() => { try { return JSON.parse(latest.sourceHealth) as DrawSnapshot['sourceHealth']; } catch { return []; } })() : [];

  useEffect(() => { drawsRef.current = draws; }, [draws]);

  const sync = useCallback(async (showNotice = false) => {
    if (syncingRef.current) return;
    syncingRef.current = true; setSyncing(true); setError('');
    try {
      const snapshot = await fetchLatest(); const records = snapshot.history?.length ? snapshot.history : [snapshot]; const savedAt = Date.now(); let newCount = 0;
      for (const record of records) {
        const existing = drawsRef.current.find((draw) => draw.period === record.period); if (!existing) newCount += 1;
        await useItemStore.getState().upsertItem({ id: existing?.id ?? generateObjectID(), itemType: 'BINGO_DRAW', name: `第${record.period}期`, parents: existing?.parents ?? (folderId ? { [folderId]: savedAt } : {}), ...record, history: undefined, numbers: record.numbers.join(','), modelPredictions: JSON.stringify(record.models), sourceHealth: JSON.stringify(record.sourceHealth), fetchedAt: savedAt, syncStatus: record.sourceLabel === '台灣彩券官方 API' ? 'official-ok' : 'fallback-ok' } as unknown as BingoDraw, { needSync: true });
      }
      setLastSync(savedAt);
      if (showNotice && newCount > 0) toast(`已保存 ${newCount} 期新開獎與預測歷史`);
    } catch (err) { setError(err instanceof Error ? err.message : '同步失敗'); }
    finally { syncingRef.current = false; setSyncing(false); }
  }, [folderId]);

  useEffect(() => { void sync(false); const timer = setInterval(() => void sync(false), 60000); return () => clearInterval(timer); }, [sync]);
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(timer); }, []);
  const nextDraw = getNextDraw(now); const taipeiTime = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', dateStyle: 'medium', timeStyle: 'medium' }).format(now);

  const pageButton = (key: Page, label: string) => <Button size="sm" variant={page === key ? 'default' : 'ghost'} onClick={() => setPage(key)}>{label}</Button>;
  const mobilePageButton = (key: Page, label: string) => <Button className="h-12 flex-1 flex-col gap-0.5 px-1 text-[11px]" size="sm" variant={page === key ? 'default' : 'ghost'} onClick={() => setPage(key)}><span>{label}</span><span className="text-[9px] opacity-70">{page === key ? '目前' : '查看'}</span></Button>;
  const evolvedScore = latestModels.find((model) => model.calculation?.evolution?.score != null)?.calculation?.evolution?.score ?? null;
  return <div className="h-full flex flex-col min-h-0 bg-slate-950 text-slate-100">
    <PluginTopbar title="賓果玄學研究台" rightButtons={[{ icon: syncing ? 'loader-2' : 'refresh', onClick: syncing ? undefined : () => void sync(true), title: syncing ? '同步中' : '立即同步' }]} />
    <div className="flex-1 min-h-0"><CustomScrollbar orientation="vertical"><div className="mx-auto max-w-4xl space-y-3 p-3 pb-20 sm:p-4 sm:pb-4">
      <div className="rounded-2xl border border-cyan-400/30 bg-slate-900 p-3 shadow-lg shadow-cyan-950/30 sm:p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="text-[11px] text-cyan-300">科學計算 · 玄學驗證 · 提升中獎機率</div><div className="mt-1 text-base font-semibold leading-snug text-white sm:text-lg">賓果玄學研究台</div><div className="mt-1 hidden text-xs text-slate-400 sm:block">總覽已整合最新開獎與全部玩法推薦</div></div><div className="shrink-0 text-right"><div className="text-[11px] text-slate-400">下期開獎</div><div className="tabular-nums text-base font-semibold text-cyan-300 sm:text-lg">{formatCountdown(nextDraw.getTime() - now.getTime())}</div><div className="mt-0.5 text-[11px] text-slate-400">{taipeiTime}</div></div></div><div className="mt-3 hidden flex-wrap gap-1 border-t border-slate-700 pt-2 sm:flex">{pageButton('overview', '總覽')}{pageButton('process', '計算過程')}{pageButton('history', '歷史紀錄')}</div></div>
      {error && <div className="rounded-lg border border-red-400/50 bg-red-950/40 p-3 text-sm text-red-200">{error}</div>}
      {page === 'overview' && <>
        <section className="rounded-2xl border border-cyan-400/30 bg-slate-900 p-3 shadow-lg shadow-cyan-950/20 sm:p-4"><div className="flex items-center justify-between gap-2"><h2 className="font-semibold text-cyan-300">最新開獎</h2><span className="text-[11px] text-slate-400">已保存 {sorted.length} 期{lastSync ? ` · ${new Date(lastSync).toLocaleTimeString('zh-TW')}` : ''}</span></div>{latest ? <><div className="mt-2 text-sm">第 <b className="tabular-nums text-cyan-200">{latest.period}</b> 期 · 開獎 {latest.drawAt || '時間未知'}</div><div className="truncate text-[11px] text-slate-400">資料來源：{latest.sourceLabel || '來源未知'}</div><div className="mt-3 grid grid-cols-5 gap-1.5">{latest.numbers.split(',').map((number) => <span key={number} className="rounded-lg border border-slate-700 bg-slate-800 px-1 py-1.5 text-center text-xs tabular-nums">{number}</span>)}</div><div className="mt-3 grid grid-cols-3 gap-2 text-xs text-slate-300 sm:text-sm"><div>超級獎號 <b className="text-amber-300">{latest.superNumber || '—'}</b></div><div>大小 <b className="text-cyan-300">{latest.size || '—'}</b></div><div>單雙 <b className="text-cyan-300">{latest.oddEven || '—'}</b></div></div></> : <p className="mt-2 text-sm text-slate-400">等待首次同步。</p>}</section>
        <section className="rounded-2xl border border-amber-300/60 bg-slate-900 p-3 shadow-lg shadow-amber-950/20 sm:p-4"><div className="flex items-center justify-between"><h2 className="font-semibold text-amber-300">最佳模型推薦</h2><span className="text-xs text-slate-400">{evolvedScore == null ? '持續演化中' : `驗證得分 ${(evolvedScore * 100).toFixed(1)}%`}</span></div><div className="mt-3 rounded-xl border border-amber-300/50 bg-slate-800 p-3"><div className="text-xs text-amber-200">目前最佳演化模型</div><div className="mt-1 text-xl font-semibold text-white">{bestPlays[0]?.best.model || '等待資料'}</div><div className="mt-1 text-sm text-slate-300">綜合表現最佳 · 本期推薦 {bestPlays[0]?.best.prediction || '—'}</div><div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-700"><div className="h-full rounded-full bg-cyan-300" style={{ width: `${Math.round((evolvedScore ?? 0.62) * 100)}%` }} /></div></div><div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">{bestPlays.slice(0, 3).map((play) => <div key={play.key} className="rounded-xl border border-slate-700 bg-slate-800 p-3"><div className="text-xs text-slate-400">{play.label}</div><div className="mt-1 font-semibold text-white">{play.best.model}</div><div className="text-sm text-slate-300">勝率 <Rate value={play.best.rate} /> · {play.best.prediction}</div></div>)}</div></section>
        <section className="rounded-2xl border border-cyan-400/30 bg-slate-900 p-3 shadow-lg shadow-cyan-950/20 sm:p-4"><div className="flex items-end justify-between gap-2"><div><h2 className="font-semibold text-cyan-300">最佳玩法推薦</h2><p className="mt-1 text-xs text-slate-400">總覽直接顯示猜大小、單雙、超級獎號與 1～10 星。</p></div><span className="shrink-0 text-[11px] text-slate-400">樣本 {sorted.length} 期</span></div><div className="mt-3 overflow-hidden rounded-xl border border-slate-700"><div className="grid grid-cols-[1.1fr_1fr_0.8fr] gap-2 border-b border-slate-700 px-3 py-2 text-[11px] text-slate-400"><span>玩法／最佳模型</span><span>歷史命中率</span><span className="text-right">本期預測</span></div>{bestPlays.map((play) => <div key={play.key} className="grid grid-cols-[1.1fr_1fr_0.8fr] items-center gap-2 border-b border-slate-800 px-3 py-2.5 last:border-b-0"><div className="min-w-0"><div className="font-medium text-white">{play.label}</div><div className="truncate text-[11px] text-slate-400">{play.best.model} · {play.best.samples} 期</div></div><div><div className="text-sm font-semibold text-cyan-200"><Rate value={play.best.rate} /></div><div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-700"><div className="h-full rounded-full bg-cyan-300" style={{ width: `${Math.round((play.best.rate ?? 0) * 100)}%` }} /></div></div><div className="break-words text-right text-lg font-semibold text-cyan-300">{play.best.prediction}</div></div>)}</div></section>
      </>}
      {page === 'process' && <section className="rounded-2xl border border-amber-300/50 bg-slate-900 p-3 shadow-lg shadow-amber-950/20 sm:p-4"><h2 className="font-semibold text-amber-300">查看計算過程</h2><div className="mt-3 space-y-2 text-sm"><div className="rounded-xl border-l-4 border-cyan-300 bg-slate-800 p-3"><b>1. 資料收集</b><p className="mt-1 text-xs leading-5 text-slate-400">讀取持久化開獎歷史，檢查遺漏與異常值。</p></div><div className="rounded-xl border-l-4 border-cyan-300 bg-slate-800 p-3"><b>2. 特徵提取</b><p className="mt-1 text-xs leading-5 text-slate-400">梅花易數、六爻八卦與河圖洛書分別產生候選特徵。</p></div><div className="rounded-xl border-l-4 border-cyan-300 bg-slate-800 p-3"><b>3. 模型推理</b><p className="mt-1 text-xs leading-5 text-slate-400">多模型融合計算，產生各玩法與星級候選。</p></div><div className="rounded-xl border-l-4 border-amber-300 bg-slate-800 p-3"><b>4. 結果驗證與自動演化</b>{latestModels.map((model) => <div key={model.name} className="mt-3 rounded-lg border border-slate-700 bg-slate-950/60 p-2.5"><div className="font-medium text-white">{model.name}</div><div className="mt-1 text-xs leading-5 text-slate-400">{model.rule}</div><div className="mt-2 break-words text-xs leading-5 text-slate-300">{model.calculation?.formula || '舊版紀錄沒有保存公式'}{model.calculation?.historySamples != null ? ` · 前期樣本 ${model.calculation.historySamples} 期 · 頻率權重 ${model.calculation.empiricalWeight}` : ''}</div><div className="mt-1 text-xs text-amber-200">演化狀態：{model.calculation?.evolution?.status || '舊版紀錄沒有演化資訊'}{model.calculation?.evolution?.score != null ? ` · 驗證分數 ${(model.calculation.evolution.score * 100).toFixed(1)}%` : ''}</div><div className="mt-1 break-words text-xs leading-5 text-slate-300">候選號碼：{model.research.numberPicks.join('、')} · 區間：{model.research.zones.join('、')} · 總和：{model.research.sumBand}</div></div>)}</div><div className="rounded-xl border-l-4 border-amber-300 bg-slate-800 p-3"><b>5. 輸出預測</b><p className="mt-1 font-mono text-xs leading-5 text-slate-300">勝率 = 命中期數 ÷ 有效預測期數 × 100%；回測結果不代表下一期保證。</p></div></div></section>}
      {page === 'history' && <section className="rounded-2xl border border-cyan-400/30 bg-slate-900 p-3 shadow-lg shadow-cyan-950/20 sm:p-4"><h2 className="font-semibold text-cyan-300">歷史開獎與預測</h2><p className="mt-1 text-xs text-slate-400">開獎與預測快照已持久化保存；刪除後才會從歷史移除。</p><div className="mt-3 space-y-2">{sorted.slice(0, 50).map((draw) => <div key={draw.id} className="rounded-xl border border-slate-700 p-3"><div className="flex items-start justify-between gap-2 text-sm"><div><b className="text-white">第 {draw.period} 期</b><div className="mt-1 text-[11px] text-slate-400">開獎 {draw.drawAt || '時間未知'} · {draw.syncStatus}</div></div><Button className="text-slate-300" variant="ghost" size="sm" onClick={() => void useItemStore.getState().removeItems([draw.id], { needSync: true })}>刪除</Button></div><div className="mt-2 break-words text-xs leading-5 text-slate-300">號碼：{draw.numbers} · 大小／單雙：{draw.size || '—'}／{draw.oddEven || '—'} · 預測模型：{parseModels(draw).map((model) => model.name).join('、') || '—'}</div></div>)}{sorted.length === 0 && <p className="text-sm text-slate-400">尚無歷史紀錄。</p>}</div></section>}
      {sourceHealth.length > 0 && <div className="text-xs text-slate-500">資料來源：{sourceHealth.filter((source) => source.ok).map((source) => source.name).join('、')} · 自動同步不顯示通知</div>}
    </div></CustomScrollbar></div>
    <div className="fixed inset-x-0 bottom-0 z-20 flex gap-1 border-t border-cyan-400/30 bg-slate-950/95 p-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] shadow-lg backdrop-blur sm:hidden">{mobilePageButton('overview', '總覽')}{mobilePageButton('process', '過程')}{mobilePageButton('history', '歷史')}</div>
  </div>;
}
