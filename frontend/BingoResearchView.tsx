import { useCallback, useEffect, useMemo, useState } from 'react';
import { CustomScrollbar, PluginTopbar, Button, useItemsByType, useItemStore, useSelectedItemsStore, generateObjectID, toast } from '@cubelv/sdk';
import { BingoDraw } from './schemas/bingoResearchSchema';

const API_URL = 'https://bingo-api.zeabur.app/api/latest';
const MODEL_NAMES = ['梅花易數', '六爻八卦', '河圖洛書'];
type Model = { name: string; rule: string; official: { size: string; oddEven: string; superNumber: string; basic: Record<string, string[]> }; research: { numberPicks: string[]; sumBand: string; oddEvenCount: string; highLowCount: string; zones: string[] } };
type DrawSnapshot = { period: string; drawAt: string; numbers: string[]; superNumber: string; size: string; oddEven: string; source: string; sourceLabel: string; sourceHealth: Array<{ name: string; ok: boolean; error?: string }>; models: Model[]; history?: DrawSnapshot[] };
type Page = 'overview' | 'plays' | 'process' | 'history';

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
  const sorted = useMemo(() => [...draws].sort((a, b) => b.fetchedAt - a.fetchedAt), [draws]);
  const folderId = useSelectedItemsStore((s) => s.lastFolderId);
  const [syncing, setSyncing] = useState(false); const [error, setError] = useState(''); const [lastSync, setLastSync] = useState<number | null>(null); const [now, setNow] = useState(() => new Date()); const [page, setPage] = useState<Page>('overview');
  const latest = sorted[0];
  const latestModels = useMemo(() => latest ? parseModels(latest) : [], [latest]);
  const stats = useMemo(() => modelStats(sorted), [sorted]);
  const bestPlays = useMemo(() => bestPlayStats(sorted, latestModels), [sorted, latestModels]);
  const sourceHealth = latest?.sourceHealth ? (() => { try { return JSON.parse(latest.sourceHealth) as DrawSnapshot['sourceHealth']; } catch { return []; } })() : [];

  const sync = useCallback(async (showNotice = false) => {
    if (syncing) return;
    setSyncing(true); setError('');
    try {
      const snapshot = await fetchLatest(); const records = snapshot.history?.length ? snapshot.history : [snapshot]; const savedAt = Date.now(); let newCount = 0;
      for (const record of records) {
        const existing = sorted.find((draw) => draw.period === record.period); if (!existing) newCount += 1;
        await useItemStore.getState().upsertItem({ id: existing?.id ?? generateObjectID(), itemType: 'BINGO_DRAW', name: `第${record.period}期`, parents: existing?.parents ?? (folderId ? { [folderId]: savedAt } : {}), ...record, history: undefined, numbers: record.numbers.join(','), modelPredictions: JSON.stringify(record.models), sourceHealth: JSON.stringify(record.sourceHealth), fetchedAt: savedAt, syncStatus: record.sourceLabel === '台灣彩券官方 API' ? 'official-ok' : 'fallback-ok' } as unknown as BingoDraw, { needSync: true });
      }
      setLastSync(savedAt);
      if (showNotice && newCount > 0) toast(`已保存 ${newCount} 期新開獎與預測歷史`);
    } catch (err) { setError(err instanceof Error ? err.message : '同步失敗'); }
    finally { setSyncing(false); }
  }, [folderId, sorted, syncing]);

  useEffect(() => { void sync(false); const timer = setInterval(() => void sync(false), 60000); return () => clearInterval(timer); }, [sync]);
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(timer); }, []);
  const nextDraw = getNextDraw(now); const taipeiTime = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', dateStyle: 'medium', timeStyle: 'medium' }).format(now);

  const pageButton = (key: Page, label: string) => <Button size="sm" variant={page === key ? 'default' : 'ghost'} onClick={() => setPage(key)}>{label}</Button>;
  return <div className="h-full flex flex-col min-h-0 bg-background text-foreground">
    <PluginTopbar title="賓果玄學研究台" rightButtons={[{ icon: syncing ? 'loader-2' : 'refresh', onClick: syncing ? undefined : () => void sync(true), title: syncing ? '同步中' : '立即同步' }]} />
    <div className="flex-1 min-h-0"><CustomScrollbar orientation="vertical"><div className="p-3 space-y-3 max-w-4xl mx-auto">
      <div className="rounded-xl border border-border bg-card p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><div className="text-xs text-muted-foreground">研究模式 · 僅供回測與娛樂</div><div className="mt-1 text-lg font-semibold">只顯示各玩法目前勝率最高模型</div></div><div className="text-right"><div className="text-xs text-muted-foreground">台北時間</div><div className="tabular-nums font-semibold">{taipeiTime}</div><div className="text-xs text-muted-foreground">下期 {formatCountdown(nextDraw.getTime() - now.getTime())}</div></div></div><div className="mt-3 flex flex-wrap gap-1 border-t border-border pt-2">{pageButton('overview', '總覽')}{pageButton('plays', '最佳玩法')}{pageButton('process', '計算過程')}{pageButton('history', '歷史紀錄')}</div></div>
      {error && <div className="rounded-lg border border-destructive bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
      {page === 'overview' && <>
        <section className="rounded-xl border border-border bg-card p-4"><div className="flex items-center justify-between"><h2 className="font-semibold">最新開獎</h2><span className="text-xs text-muted-foreground">已保存 {sorted.length} 期{lastSync ? ` · ${new Date(lastSync).toLocaleTimeString('zh-TW')}` : ''}</span></div>{latest ? <><div className="mt-2 text-sm">第 <b className="tabular-nums">{latest.period}</b> 期 · 開獎 {latest.drawAt || '時間未知'}</div><div className="text-xs text-muted-foreground">資料來源：{latest.sourceLabel || '來源未知'}</div><div className="mt-3 flex flex-wrap gap-1.5">{latest.numbers.split(',').map((number) => <span key={number} className="rounded-md bg-muted px-2 py-1 text-xs tabular-nums">{number}</span>)}</div><div className="mt-3 grid grid-cols-3 gap-2 text-sm"><div>超級獎號 <b>{latest.superNumber || '—'}</b></div><div>大小 <b>{latest.size || '—'}</b></div><div>單雙 <b>{latest.oddEven || '—'}</b></div></div></> : <p className="mt-2 text-sm text-muted-foreground">等待首次同步。</p>}</section>
        <section className="rounded-xl border border-border bg-card p-4"><h2 className="font-semibold">最佳模型摘要</h2><div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">{bestPlays.slice(0, 3).map((play) => <div key={play.key} className="rounded-lg bg-muted/50 p-3"><div className="text-xs text-muted-foreground">{play.label}</div><div className="mt-1 font-semibold">{play.best.model}</div><div className="text-sm">勝率 <Rate value={play.best.rate} /> · {play.best.prediction}</div></div>)}</div><Button className="mt-3" variant="outline" size="sm" onClick={() => setPage('plays')}>查看全部玩法</Button></section>
      </>}
      {page === 'plays' && <section className="rounded-xl border border-border bg-card p-4"><div className="flex items-end justify-between"><div><h2 className="font-semibold">各玩法最佳模型</h2><p className="mt-1 text-xs text-muted-foreground">依保存歷史逐一計算，平手時採模型排列優先順序。</p></div><span className="text-xs text-muted-foreground">樣本 {sorted.length} 期</span></div><div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">{bestPlays.map((play) => <div key={play.key} className="rounded-lg border border-border/70 p-3"><div className="flex items-center justify-between"><span className="font-medium">{play.label}</span><Rate value={play.best.rate} /></div><div className="mt-1 text-sm">最佳：<b>{play.best.model}</b> · 命中 {play.best.hits}/{play.best.samples}</div><div className="mt-2 rounded-md bg-muted/50 p-2 text-sm">本期預測：<b>{play.best.prediction}</b></div></div>)}</div></section>}
      {page === 'process' && <section className="rounded-xl border border-border bg-card p-4"><h2 className="font-semibold">計算過程</h2><div className="mt-3 space-y-3 text-sm"><div className="rounded-lg bg-muted/50 p-3"><b>1. 資料保存</b><p className="mt-1 text-muted-foreground">每期開獎的 20 個號碼、大小、單雙、超級獎號與當期三組模型預測，一起保存為一筆 BINGO_DRAW 歷史紀錄。</p></div><div className="rounded-lg bg-muted/50 p-3"><b>2. 星級玩法命中定義</b><p className="mt-1 text-muted-foreground">N 星視為命中：模型提出的 N 個號碼全部出現在該期 20 個開獎號碼內；不是只中其中一部分。</p></div><div className="rounded-lg bg-muted/50 p-3"><b>3. 勝率公式</b><p className="mt-1 font-mono text-xs">勝率 = 命中期數 ÷ 有效預測期數 × 100%</p></div><div className="rounded-lg bg-muted/50 p-3"><b>4. 模型如何產生預測</b>{latestModels.map((model) => <div key={model.name} className="mt-2 border-t border-border/60 pt-2"><div className="font-medium">{model.name}</div><div className="mt-1 text-xs text-muted-foreground">{model.rule}</div><div className="mt-1 text-xs">候選號碼：{model.research.numberPicks.join('、')} · 區間：{model.research.zones.join('、')} · 總和：{model.research.sumBand}</div></div>)}</div></div></section>}
      {page === 'history' && <section className="rounded-xl border border-border bg-card p-4"><h2 className="font-semibold">歷史開獎與預測</h2><p className="mt-1 text-xs text-muted-foreground">開獎與預測快照已持久化保存；刪除後才會從歷史移除。</p><div className="mt-3 space-y-2">{sorted.slice(0, 50).map((draw) => <div key={draw.id} className="rounded-lg border border-border/70 p-3"><div className="flex flex-wrap items-center justify-between gap-2 text-sm"><b>第 {draw.period} 期</b><span className="text-xs text-muted-foreground">開獎 {draw.drawAt || '時間未知'} · {draw.syncStatus}</span><Button variant="ghost" size="sm" onClick={() => void useItemStore.getState().removeItems([draw.id], { needSync: true })}>刪除</Button></div><div className="mt-2 text-xs">號碼：{draw.numbers} · 大小／單雙：{draw.size || '—'}／{draw.oddEven || '—'} · 預測模型：{parseModels(draw).map((model) => model.name).join('、') || '—'}</div></div>)}{sorted.length === 0 && <p className="text-sm text-muted-foreground">尚無歷史紀錄。</p>}</div></section>}
      {sourceHealth.length > 0 && <div className="text-xs text-muted-foreground">資料來源：{sourceHealth.filter((source) => source.ok).map((source) => source.name).join('、')} · 自動同步不顯示通知</div>}
    </div></CustomScrollbar></div>
  </div>;
}
