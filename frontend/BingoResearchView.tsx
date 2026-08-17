import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CustomScrollbar, PluginTopbar, Button, useItemsByType, useItemStore,
  useSelectedItemsStore, generateObjectID, toast,
} from '@cubelv/sdk';
import { BingoDraw } from './schemas/bingoResearchSchema';

const API_URL = 'https://bingo-api.zeabur.app/api/latest';
const MODEL_NAMES = ['梅花易數', '六爻八卦', '河圖洛書'];

type DrawSnapshot = {
  period: string; drawAt: string; numbers: string[]; superNumber: string; size: string; oddEven: string;
  models: Array<{ name: string; rule: string; official: { size: string; oddEven: string; superNumber: string; basic: Record<string, string[]> }; research: { numberPicks: string[]; sumBand: string; oddEvenCount: string; highLowCount: string; zones: string[] } }>;
};

function cleanHtml(html: string) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseOfficialPage(html: string): DrawSnapshot {
  const text = cleanHtml(html);
  const periodMatch = text.match(/第\s*(\d{7,9})\s*期/);
  const numbersMatch = text.match(/大小順序\s*開出順序\s*((?:\d{1,2}\s+){19}\d{1,2})\s+超級獎號\s*(\d{1,2})/);
  const dateMatch = text.match(/開獎日期\s*([0-9]{2,3}\/\d{1,2}\/\d{1,2}\([^)]*\)\s+\d{1,2}:\d{2})/);
  const sizeMatch = text.match(/猜大小\s*([大小])/);
  const oddEvenMatch = text.match(/猜單雙\s*([單雙－-])/);
  if (!periodMatch || !numbersMatch) throw new Error('官方頁面格式變更，尚未解析到完整期別與 20 個獎號');
  return {
    period: periodMatch[1], drawAt: dateMatch?.[1] ?? '',
    numbers: numbersMatch[1].trim().split(/\s+/).map((n) => n.padStart(2, '0')),
    superNumber: numbersMatch[2].padStart(2, '0'), size: sizeMatch?.[1] ?? '', oddEven: oddEvenMatch?.[1] ?? '',
    models: [],
  };
}

async function fetchLatest(): Promise<DrawSnapshot> {
  const response = await fetch(API_URL);
  if (!response.ok) throw new Error(`官方資料 HTTP ${response.status}`);
  return await response.json() as DrawSnapshot;
}

function evaluate(draws: BingoDraw[]) {
  const rows = draws.flatMap((draw) => {
    try {
      const models = JSON.parse(draw.modelPredictions || '[]') as Array<{ name: string; official: { size: string; oddEven: string } }>;
      return models.map((m) => ({ model: m.name, sizeHit: m.official.size === draw.size, oddEvenHit: m.official.oddEven === draw.oddEven }));
    } catch { throw new Error('研究紀錄含有無法解析的模型資料'); }
  });
  return MODEL_NAMES.map((model) => {
    const items = rows.filter((r) => r.model === model);
    const sizeHits = items.filter((r) => r.sizeHit).length;
    const oddEvenHits = items.filter((r) => r.oddEvenHit).length;
    return { model, samples: items.length, sizeRate: items.length ? sizeHits / items.length : null, oddEvenRate: items.length ? oddEvenHits / items.length : null };
  });
}

function Rate({ value }: { value: number | null }) { return <span className="tabular-nums">{value == null ? '—' : `${(value * 100).toFixed(1)}%`}</span>; }

export function BingoResearchView() {
  const draws = useItemsByType<BingoDraw>('BINGO_DRAW');
  const sorted = useMemo(() => [...draws].sort((a, b) => b.fetchedAt - a.fetchedAt), [draws]);
  const folderId = useSelectedItemsStore((s) => s.lastFolderId);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [lastSync, setLastSync] = useState<number | null>(null);
  const stats = useMemo(() => evaluate(sorted), [sorted]);

  const sync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true); setError('');
    try {
      const snapshot = await fetchLatest();
      const existing = sorted.find((d) => d.period === snapshot.period);
      await useItemStore.getState().upsertItem({
        id: existing?.id ?? generateObjectID(), itemType: 'BINGO_DRAW', name: `第${snapshot.period}期`,
        parents: existing?.parents ?? (folderId ? { [folderId]: Date.now() } : {}),
        ...snapshot, numbers: snapshot.numbers.join(','), modelPredictions: JSON.stringify(snapshot.models),
        fetchedAt: Date.now(), syncStatus: 'official-ok',
      } as unknown as BingoDraw, { needSync: true });
      setLastSync(Date.now()); toast(`已同步第 ${snapshot.period} 期`);
    } catch (err) { setError(err instanceof Error ? err.message : '同步失敗'); }
    finally { setSyncing(false); }
  }, [folderId, sorted, syncing]);

  useEffect(() => { void sync(); const timer = setInterval(() => void sync(), 60000); return () => clearInterval(timer); }, [sync]);

  const latest = sorted[0];
  const latestModels = latest ? (() => { try { return JSON.parse(latest.modelPredictions || '[]') as DrawSnapshot['models']; } catch { return []; } })() : [];

  return <div className="h-full flex flex-col min-h-0 bg-background text-foreground">
    <PluginTopbar title="賓果玄學研究台" rightButtons={[{ icon: syncing ? 'loader-2' : 'refresh', onClick: syncing ? undefined : () => void sync(), title: syncing ? '同步中' : '同步官方開獎' }]} />
    <div className="flex-1 min-h-0">
      <CustomScrollbar orientation="vertical">
        <div className="p-3 space-y-3 max-w-3xl mx-auto">
          <div className="rounded-lg border border-border bg-card p-3 text-sm">
            <div className="flex items-center justify-between gap-2"><span className="font-semibold">研究模式</span><span className="text-muted-foreground">research-only／娛樂參考</span></div>
            <p className="text-muted-foreground mt-1">玄學方法被固定成可回測規則；勝率不代表因果，也不保證下一期結果。</p>
            <p className="text-xs text-muted-foreground mt-2">來源：台灣彩券官方資料 · Zeabur API · 自動同步每 60 秒{lastSync ? ` · ${new Date(lastSync).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}` : ''}</p>
          </div>
          {error && <div className="rounded-lg border border-destructive bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
          <section className="rounded-lg border border-border bg-card p-3">
            <div className="flex items-center justify-between"><h2 className="font-semibold">最新開獎</h2><span className="text-xs text-muted-foreground">{latest?.drawAt || '尚未同步'}</span></div>
            {latest ? <><div className="mt-2 text-sm">第 <span className="font-semibold tabular-nums">{latest.period}</span> 期</div><div className="flex flex-wrap gap-1.5 mt-2">{latest.numbers.split(',').map((n) => <span key={n} className="rounded-full bg-muted px-2 py-1 text-xs tabular-nums">{n}</span>)}</div><div className="mt-3 grid grid-cols-2 gap-2 text-sm"><div>超級獎號 <b>{latest.superNumber || '—'}</b></div><div>大小／單雙 <b>{latest.size || '—'}／{latest.oddEven || '—'}</b></div></div></> : <p className="text-sm text-muted-foreground mt-2">尚無官方紀錄，請按同步。</p>}
          </section>
          <section className="rounded-lg border border-border bg-card p-3"><h2 className="font-semibold">下一期玩法預測</h2><p className="text-xs text-muted-foreground mt-1">官方玩法與研究派生玩法分開呈現；固定規則只產生研究候選，不是機率保證。</p>{latestModels.length ? <div className="mt-2 space-y-3">{latestModels.map((m) => <div key={m.name} className="rounded-md bg-muted/50 p-3 text-sm"><div className="font-semibold">{m.name}</div><div className="mt-2 grid grid-cols-2 gap-2"><span>猜大小：<b>{m.official.size}</b></span><span>猜單雙：<b>{m.official.oddEven}</b></span><span>超級獎號：<b>{m.official.superNumber}</b></span><span>基本玩法：<b>{m.official.basic['10星']?.join('、')}</b></span></div><div className="mt-2 text-xs text-muted-foreground">號碼候選：{m.research.numberPicks.join('、')}</div><div className="mt-1 text-xs text-muted-foreground">總和：{m.research.sumBand} · 單雙分布：{m.research.oddEvenCount} · 大小分布：{m.research.highLowCount} · 區間：{m.research.zones.join('、')}</div></div>)}</div> : <p className="text-sm text-muted-foreground mt-2">等待同步。</p>}</section>
          <section className="rounded-lg border border-border bg-card p-3"><h2 className="font-semibold">歷史勝率統計</h2><p className="text-xs text-muted-foreground mt-1">只計入有官方大小／單雙結果且已保存模型的紀錄；樣本不足不解讀。</p><div className="mt-2 overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-border text-left text-muted-foreground"><th className="py-2">模型</th><th>樣本</th><th>大小</th><th>單雙</th></tr></thead><tbody>{stats.map((s) => <tr key={s.model} className="border-b border-border/60"><td className="py-2">{s.model}</td><td className="tabular-nums">{s.samples}</td><td><Rate value={s.sizeRate} /></td><td><Rate value={s.oddEvenRate} /></td></tr>)}</tbody></table></div></section>
          <section className="rounded-lg border border-border bg-card p-3"><h2 className="font-semibold">同步紀錄</h2><div className="mt-2 space-y-1">{sorted.slice(0, 20).map((draw) => <div key={draw.id} className="flex items-center justify-between gap-2 border-b border-border/60 py-2 text-xs"><span>第 {draw.period} 期</span><span className="text-muted-foreground">{draw.drawAt || '時間未知'}</span><span>{draw.syncStatus === 'official-ok' ? '官方已取' : draw.syncStatus}</span><Button variant="ghost" size="sm" onClick={() => void useItemStore.getState().removeItems([draw.id], { needSync: true })}>刪除</Button></div>)}{sorted.length === 0 && <p className="text-sm text-muted-foreground">尚無紀錄。</p>}</div></section>
        </div>
      </CustomScrollbar>
    </div>
  </div>;
}
