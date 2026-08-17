import { useCallback, useEffect, useMemo, useState } from "react";
import { CustomScrollbar, PluginTopbar, Button } from "@cubelv/sdk";

const API_URL = "https://bingo-api.zeabur.app/api/latest";
const MODEL_NAMES = [
  "梅花易數",
  "六爻八卦",
  "河圖洛書",
  "數字卦（楚簡研究版）",
  "奇門遁甲（九宮研究版）",
  "太乙九宮（研究版）",
  "多模型聚合",
];
type Evolution = Record<
  string,
  {
    empiricalWeight?: number;
    castingSource?: string;
    validationSamples?: number;
    score?: number | null;
    status?: string;
  }
>;
type Model = {
  name: string;
  status?: string;
  rule: string;
  sources?: Array<{ name: string; url: string }>;
  calculation?: {
    formula?: string;
    historySamples?: number;
    empiricalWeight?: number;
    empiricalWeights?: Record<string, number>;
    evolution?: Evolution;
    targetCastings?: Record<string, string>;
    targetCastingValues?: Record<string, string>;
  };
  official: {
    size: string;
    oddEven: string;
    superNumber: string;
    basic: Record<string, string[]>;
  };
  research: {
    numberPicks: string[];
    sumBand: string;
    oddEvenCount: string;
    highLowCount: string;
    zones: string[];
    targetResearch?: Record<string, {
      numberPicks: string[];
      sumBand: string;
      oddEvenCount: string;
      highLowCount: string;
      zones: string[];
    }>;
  };
};
type DrawSnapshot = {
  period: string;
  drawAt: string;
  numbers: string[];
  superNumber: string;
  size: string;
  oddEven: string;
  source: string;
  sourceLabel: string;
  sourceHealth: Array<{ name: string; ok: boolean; error?: string }>;
  models: Model[];
  fetchedAt?: number;
  history?: DrawSnapshot[];
  historyDays?: number;
  backup?: {
    enabled: boolean;
    repo?: string;
    path?: string;
    reason?: string;
    error?: string;
  };
};
type Page = "overview" | "process" | "history";

function normalizeNumber(value: string | number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? String(parsed).padStart(2, "0") : String(value);
}

function normalizeCategory(value: string) {
  return value === "－" || value === "-" ? "和" : value;
}

async function fetchLatest(days = 1): Promise<DrawSnapshot> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort("資料服務逾時"),
      45_000,
    );
    try {
      const response = await fetch(`${API_URL}?days=${days}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("資料暫時無法更新");
      return (await response.json()) as DrawSnapshot;
    } catch (error) {
      lastError = new Error(
        error instanceof Error && /abort|signal/i.test(error.message)
          ? "資料更新逾時，請稍後重試"
          : "資料暫時無法更新，請稍後重試",
      );
      if (attempt < 2)
        await new Promise((resolve) =>
          window.setTimeout(resolve, 800 * (attempt + 1)),
        );
    } finally {
      window.clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("資料暫時無法更新");
}

function getNextDraw(now: Date) {
  const taipei = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const year = taipei.getUTCFullYear();
  const month = taipei.getUTCMonth();
  const day = taipei.getUTCDate();
  const minute = taipei.getUTCHours() * 60 + taipei.getUTCMinutes();
  const start = 425;
  const end = 1435;
  let targetDay = day;
  let targetMinutes = start;
  if (minute >= end) targetDay += 1;
  else if (minute >= start)
    targetMinutes = start + Math.ceil((minute - start + 1) / 5) * 5;
  return new Date(
    Date.UTC(
      year,
      month,
      targetDay,
      Math.floor(targetMinutes / 60),
      targetMinutes % 60,
      0,
    ) -
      8 * 60 * 60 * 1000,
  );
}

function formatCountdown(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function recentNumberStats(draws: DrawSnapshot[]) {
  const sample = draws.slice(0, 30);
  const normalizedDraws = sample.map((draw) => draw.numbers.map(normalizeNumber));
  const stats = Array.from({ length: 80 }, (_, index) => ({
    number: String(index + 1).padStart(2, "0"),
    count: 0,
    currentOpen: 0,
  }));
  normalizedDraws.forEach((numbers) =>
    numbers.forEach((number) => {
      const item = stats[Number(number) - 1];
      if (item) item.count += 1;
    }),
  );
  stats.forEach((item) => {
    for (const numbers of normalizedDraws) {
      if (!numbers.includes(item.number)) break;
      item.currentOpen += 1;
    }
  });
  const hot = new Set(
    [...stats]
      .sort((a, b) => b.count - a.count || Number(a.number) - Number(b.number))
      .slice(0, 10)
      .map((item) => item.number),
  );
  const cold = new Set(
    [...stats]
      .sort((a, b) => a.count - b.count || Number(a.number) - Number(b.number))
      .filter((item) => !hot.has(item.number))
      .slice(0, 10)
      .map((item) => item.number),
  );
  return { sampleSize: sample.length, stats, hot, cold };
}

function numberCounts(numbers: string[]) {
  return numbers.reduce((counts, number) => {
    const normalized = normalizeNumber(number);
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
    return counts;
  }, new Map<string, number>());
}

function numberSum(numbers: string[]) {
  return numbers.reduce((sum, number) => sum + Number(number), 0);
}

function parseModels(draw: DrawSnapshot): Model[] {
  return draw.models || [];
}

function modelStats(draws: DrawSnapshot[]) {
  return MODEL_NAMES.map((model) => {
    const rows = draws.flatMap((draw) =>
      parseModels(draw)
        .filter((item) => item.name === model)
        .map((item) => ({ item, draw })),
    );
    const size = rows.filter(
      ({ item, draw }) => item.official.size === draw.size,
    ).length;
    const oddEven = rows.filter(
      ({ item, draw }) => item.official.oddEven === draw.oddEven,
    ).length;
    return {
      model,
      samples: rows.length,
      sizeRate: rows.length ? size / rows.length : null,
      oddEvenRate: rows.length ? oddEven / rows.length : null,
    };
  });
}

function wilsonLowerBound(rate: number, samples: number) {
  if (!samples) return -1;
  const z = 1.96;
  const denominator = 1 + (z * z) / samples;
  const centre = rate + (z * z) / (2 * samples);
  const margin = z * Math.sqrt((rate * (1 - rate)) / samples + (z * z) / (4 * samples * samples));
  return (centre - margin) / denominator;
}

const SINGLE_BET_COST = 25;
const BASIC_PAYOUTS: Record<string, Record<number, number>> = {
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

function settleSingleBet(key: string, item: Model, draw: DrawSnapshot) {
  let payout = 0;
  let matches = 0;
  let targetCount: number | null = null;
  if (key === "size") {
    matches = item.official.size && normalizeCategory(item.official.size) === normalizeCategory(draw.size) ? 1 : 0;
    payout = matches ? 150 : 0;
  } else if (key === "oddEven") {
    matches = item.official.oddEven && normalizeCategory(item.official.oddEven) === normalizeCategory(draw.oddEven) ? 1 : 0;
    payout = matches ? 150 : 0;
  } else if (key === "superNumber") {
    matches = normalizeNumber(item.official.superNumber) === normalizeNumber(draw.superNumber) ? 1 : 0;
    payout = matches ? 1200 : 0;
  } else {
    const predicted = item.official.basic[key] || [];
    const drawnNumbers = new Set(draw.numbers.map(normalizeNumber));
    matches = predicted.filter((number) => drawnNumbers.has(normalizeNumber(number))).length;
    targetCount = predicted.length;
    payout = BASIC_PAYOUTS[key]?.[matches] || 0;
  }
  return { payout, profit: payout - SINGLE_BET_COST, won: payout > 0, matches, targetCount };
}

function bestPlayStats(draws: DrawSnapshot[], latestModels: Model[]) {
  const minimumSamples = 4;
  const plays = [
    { key: "size", label: "猜大小" },
    { key: "oddEven", label: "猜單雙" },
    { key: "superNumber", label: "超級獎號" },
    ...Array.from({ length: 10 }, (_, i) => ({
      key: `${i + 1}星`,
      label: `${i + 1} 星`,
    })),
  ];
  return plays.map((play) => {
    const candidates = MODEL_NAMES.map((model) => {
      const rows = draws.flatMap((draw) =>
        parseModels(draw)
          .filter((item) => item.name === model)
          .map((item) => ({ item, draw })),
      );
      let wins = 0;
      let trials = 0;
      let profit = 0;
      let matches = 0;
      let targetCount = 0;
      rows.forEach(({ item, draw }) => {
        const result = settleSingleBet(play.key, item, draw);
        wins += result.won ? 1 : 0;
        profit += result.profit;
        matches += result.matches;
        targetCount += result.targetCount || 1;
        trials += 1;
      });
      const latest = latestModels.find((item) => item.name === model);
      const prediction =
        play.key === "size"
          ? latest?.official.size
          : play.key === "oddEven"
            ? latest?.official.oddEven
            : play.key === "superNumber"
              ? latest?.official.superNumber
              : latest?.official.basic[play.key]?.join("、");
      const rate = trials ? wins / trials : null;
      return {
        model,
        samples: trials,
        wins,
        matches,
        targetCount,
        profit,
        averageMatches: trials ? matches / trials : null,
        averageTargetCount: trials ? targetCount / trials : null,
        averageProfit: trials ? profit / trials : null,
        rate,
        confidence: rate == null || trials < minimumSamples ? -1 : wilsonLowerBound(rate, trials),
        prediction: prediction || "—",
      };
    }).sort((a, b) => b.confidence - a.confidence || (b.rate ?? -1) - (a.rate ?? -1));
    return { ...play, best: candidates[0], metricLabel: "中獎率" };
  });
}

function Rate({ value, label = "勝率" }: { value: number | null; label?: string }) {
  return (
    <span className="tabular-nums font-semibold" aria-label={value == null ? `${label}未知` : `${label} ${(value * 100).toFixed(1)}%`}>
      {value == null ? "—" : `${(value * 100).toFixed(1)}%`}
    </span>
  );
}

function BacktestEvidence({
  wins,
  samples,
  matches,
  targetCount,
  profit,
}: {
  wins: number;
  samples: number;
  matches: number;
  targetCount: number;
  profit: number;
}) {
  return (
    <span className="block text-[10px] font-normal leading-4 text-muted-foreground">
      {samples ? `${wins}/${samples} 達標 · 平均命中 ${matches ? (matches / samples).toFixed(1) : "0"}${targetCount > 1 ? `/${(targetCount / samples).toFixed(0)}` : ""}` : "尚無有效樣本"}
      <span className="ml-1">· {formatNetProfit(profit)}</span>
    </span>
  );
}

function formatNetProfit(value: number | null) {
  if (value == null) return "—";
  return `${value > 0 ? "+" : ""}${Math.round(value).toLocaleString("zh-TW")} 元`;
}

function PredictionValue({ value }: { value: string }) {
  const parts = value.split("、").filter(Boolean);
  const isNumbers = parts.length > 0 && parts.every((part) => /^\d{1,2}$/.test(part));
  if (!isNumbers) {
    return <span className="break-words text-sm font-semibold text-cyan-300 sm:text-base">{value}</span>;
  }
  return (
    <div className="flex min-w-0 flex-wrap gap-1" role="list" aria-label={`預測號碼 ${parts.join("、")}`}>
      {parts.map((part) => (
        <span key={part} role="listitem" aria-label={`預測號碼 ${part}`} className="flex h-7 min-w-7 items-center justify-center rounded-full border border-cyan-300/70 bg-cyan-400/15 px-1.5 text-xs font-bold tabular-nums text-cyan-200">
          {part}
        </span>
      ))}
    </div>
  );
}

const HISTORY_PLAYS = [
  { key: "size", label: "猜大小" },
  { key: "oddEven", label: "猜單雙" },
  { key: "superNumber", label: "超級獎號" },
  ...Array.from({ length: 10 }, (_, index) => ({ key: `${index + 1}星`, label: `${index + 1} 星` })),
];

function predictionForPlay(model: Model, key: string) {
  if (key === "size") return model.official.size || "—";
  if (key === "oddEven") return model.official.oddEven || "—";
  if (key === "superNumber") return model.official.superNumber || "—";
  return model.official.basic[key]?.join("、") || "—";
}

function HistoricalModelDetails({ model, draw }: { model: Model; draw: DrawSnapshot }) {
  return (
    <details className="mt-3 rounded-2xl border border-border bg-background/70 p-3">
      <summary className="cursor-pointer list-none text-sm font-semibold text-cyan-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-200">
        <span className="flex items-center justify-between gap-2">
          <span>{model.name}</span>
          <span className="text-xs font-normal text-muted-foreground">查看結算</span>
        </span>
      </summary>
      <div className="mt-3 space-y-2">
        {HISTORY_PLAYS.map((play) => {
          const result = settleSingleBet(play.key, model, draw);
          return (
            <div key={play.key} className="rounded-xl border border-border bg-card/70 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-amber-100">{play.label}</div>
                  <div className="mt-1 text-xs text-slate-300">當期預測</div>
                  <div className="mt-1 min-w-0"><PredictionValue value={predictionForPlay(model, play.key)} /></div>
                </div>
                <div className="shrink-0 text-right text-xs leading-6">
                  <div className={result.won ? "font-semibold text-emerald-300" : "font-semibold text-rose-300"}>
                    {result.won ? "中獎" : "未中獎"}
                  </div>
                  <div className="text-muted-foreground">
                    {result.targetCount ? `命中 ${result.matches}/${result.targetCount}` : `結果 ${result.matches ? "相符" : "不符"}`}
                  </div>
                  <div className="text-slate-300">派彩 {result.payout.toLocaleString("zh-TW")} 元</div>
                  <div className={result.profit >= 0 ? "font-semibold text-emerald-300" : "font-semibold text-rose-300"}>
                    淨 {formatNetProfit(result.profit)}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}
const TARGET_LABELS: Record<string, string> = {
  size: "猜大小",
  oddEven: "猜單雙",
  superNumber: "超級獎號",
};
function targetLabel(target: string) {
  return TARGET_LABELS[target] || target.replace("星", " 星");
}

function modelPlainLanguage(name: string) {
  if (name === "梅花易數") return "用預測當下的年支、農曆月日與時辰取上下卦、動爻；期號與玩法只是所問事項。";
  if (name === "六爻八卦") return "用數位蓍草執行分二、掛一、揲四、歸奇三變，逐爻得到六、七、八、九；期號與玩法只是所問事項。";
  if (name === "河圖洛書") return "用九宮數字定位，再觀察號碼和九宮位置的關係。";
  if (name === "數字卦（楚簡研究版）") return "採用文獻記載的數字集合，將期號轉成六個可重算數字特徵。";
  if (name === "奇門遁甲（九宮研究版）") return "取九宮、九星、八門三個結構做簡化特徵，不冒充完整奇門排盤。";
  if (name === "多模型聚合") return "依各模型歷史回測表現加權整合，產生共識候選，不把共識當成保證。";
  return "取太乙行九宮的結構做九宮循環索引，不冒充完整太乙排盤。";
}
function ScoreBar({
  value,
  tone = "bg-cyan-300",
}: {
  value: number | null | undefined;
  tone?: string;
}) {
  const percent = value == null ? 0 : Math.max(0, Math.min(100, value * 100));
  return (
    <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-700">
      <div
        className={`h-full rounded-full ${tone}`}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

export function BingoResearchView() {
  const [draws, setDraws] = useState<DrawSnapshot[]>([]);
  const sorted = useMemo(
    () =>
      [...draws].sort(
        (a, b) =>
          Number(b.period) - Number(a.period) || b.fetchedAt - a.fetchedAt,
      ),
    [draws],
  );
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [historyDays, setHistoryDays] = useState(30);
  const [backup, setBackup] = useState<DrawSnapshot["backup"]>();
  const [now, setNow] = useState(() => new Date());
  const [page, setPage] = useState<Page>("overview");
  const latest = sorted[0];
  const latestModels = useMemo(
    () => (latest ? parseModels(latest) : []),
    [latest],
  );
  const stats = useMemo(() => modelStats(sorted), [sorted]);
  const bestPlays = useMemo(
    () => bestPlayStats(sorted, latestModels),
    [sorted, latestModels],
  );
  const recentStats = useMemo(() => recentNumberStats(sorted), [sorted]);
  const sourceHealth = latest?.sourceHealth || [];

  const sync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    setError("");
    try {
      const snapshot = await fetchLatest(1);
      const records = snapshot.history?.length ? snapshot.history : [snapshot];
      setDraws(records);
      setHistoryDays(snapshot.historyDays ?? 30);
      setBackup(snapshot.backup);
      setLastSync(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "讀取失敗");
    } finally {
      setSyncing(false);
    }
  }, [syncing]);

  useEffect(() => {
    void sync();
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const nextDraw = getNextDraw(now);
  const taipeiTime = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(now);

  const pageButton = (key: Page, label: string) => (
    <Button
      size="sm"
      variant={page === key ? "default" : "ghost"}
      aria-current={page === key ? "page" : undefined}
      aria-label={`${label}${page === key ? "，目前頁面" : "，切換頁面"}`}
      onClick={() => setPage(key)}
    >
      {label}
    </Button>
  );
  const mobilePageButton = (key: Page, label: string) => (
    <Button
      className="h-12 flex-1 flex-col gap-0.5 px-1 text-xs"
      size="sm"
      variant={page === key ? "default" : "ghost"}
      aria-current={page === key ? "page" : undefined}
      aria-label={`${label}${page === key ? "，目前頁面" : "，切換頁面"}`}
      onClick={() => setPage(key)}
    >
      <span>{label}</span>
      <span className="text-xs opacity-80">
        {page === key ? "目前" : "查看"}
      </span>
    </Button>
  );
  return (
    <div className="relative flex h-full min-h-0 min-w-0 max-w-full flex-col overflow-x-hidden bg-background font-sans text-foreground antialiased">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-24 -top-24 h-64 w-64 rounded-full bg-cyan-500/10 blur-3xl motion-safe:animate-pulse" />
        <div className="absolute -bottom-32 -right-20 h-72 w-72 rounded-full bg-orange-500/10 blur-3xl" />
      </div>
      <PluginTopbar
        title="賓果玄學研究台"
        rightButtons={[
          {
            icon: syncing ? "loader-2" : "refresh",
            onClick: syncing ? undefined : () => void sync(),
            title: syncing ? "同步中" : "重新讀取",
          },
        ]}
      />
      <div className="relative z-10 flex min-h-0 min-w-0 flex-1 overflow-x-hidden" aria-busy={syncing}>
        <CustomScrollbar orientation="vertical">
          <div className="mx-auto min-w-0 max-w-5xl space-y-4 overflow-x-hidden p-3 pb-24 sm:space-y-5 sm:p-5 sm:pb-6">
            <header className="overflow-hidden rounded-3xl border border-border bg-card p-4 shadow-xl shadow-black/20 sm:p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-cyan-300/30 bg-cyan-300/10 px-2.5 py-1 text-xs font-medium text-cyan-100">
                    <span aria-hidden="true" className="h-2 w-2 rounded-full bg-cyan-300 motion-safe:animate-pulse" />
                    即時研究看板 · 僅供研究
                  </div>
                  <div className="text-sm font-medium text-muted-foreground">距離下期開獎</div>
                  <div className="mt-1 tabular-nums text-3xl font-bold tracking-tight text-cyan-100 sm:text-4xl" aria-label={`距離下期開獎 ${formatCountdown(nextDraw.getTime() - now.getTime())}`}>
                    {formatCountdown(nextDraw.getTime() - now.getTime())}
                  </div>
                </div>
                <div className="rounded-2xl border border-border bg-background/70 px-3 py-2 text-right">
                  <div className="text-xs text-muted-foreground">台北時間</div>
                  <time className="text-sm font-medium text-foreground" dateTime={now.toISOString()}>{taipeiTime}</time>
                  <div className="mt-1 text-[10px] text-cyan-200">{latest ? "資料已更新" : "等待資料"}</div>
                </div>
              </div>
              <p className="mt-4 max-w-2xl text-sm leading-6 text-muted-foreground">官方結果、研究預測、計算方法與歷史回測分層呈現；所有結果僅供研究，不代表中獎保證。</p>
              <nav aria-label="研究台頁面" className="mt-5 hidden flex-wrap gap-2 border-t border-slate-700/80 pt-4 sm:flex">
                {pageButton("overview", "首頁")}
                {pageButton("process", "計算過程")}
                {pageButton("history", "歷史紀錄")}
              </nav>
            </header>
            {error && (
              <div role="alert" className="rounded-lg border border-red-300/70 bg-red-950/60 p-3 text-sm leading-6 text-red-100">
                {error}
              </div>
            )}
            <div className="sr-only" aria-live="polite">
              {syncing ? "正在同步官方開獎資料" : lastSync ? "資料同步完成" : ""}
            </div>
            {page === "overview" && (
              <>
                <section aria-labelledby="latest-draw-heading" className="rounded-3xl border border-orange-300/30 bg-card p-4 shadow-lg shadow-orange-950/20 backdrop-blur transition-colors duration-300 sm:p-5">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-orange-200/80">01 · 官方結果</p>
                      <h2 id="latest-draw-heading" className="mt-1 text-lg font-bold text-orange-100">最新開獎號碼</h2>
                    </div>
                    <span className="shrink-0 text-lg font-semibold tabular-nums text-orange-100" aria-label={latest ? `第 ${latest.period} 期` : "等待同步"}>
                      {latest ? `第 ${latest.period} 期` : "等待同步"}
                    </span>
                  </div>
                  {latest ? (
                    <>
                      <div className="mt-2 flex flex-wrap gap-1.5" aria-label={`第 ${latest.period} 期大小、單雙、超級獎號結果`}>
                        <span className="rounded-full border border-orange-300/40 bg-orange-300/10 px-2.5 py-0.5 text-[11px] font-semibold text-orange-100">
                          大小：{latest.size || "—"}
                        </span>
                        <span className="rounded-full border border-cyan-300/40 bg-cyan-300/10 px-2.5 py-0.5 text-[11px] font-semibold text-cyan-100">
                          單雙：{latest.oddEven || "—"}
                        </span>
                        <span className="rounded-full border border-red-300/40 bg-red-400/10 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-red-100">
                          超級獎號：{latest.superNumber || "—"}
                        </span>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground" aria-label="號碼球顏色說明">
                        <span className="font-medium text-muted-foreground">球色：</span>
                        <span className="inline-flex items-center gap-1"><i aria-hidden="true" className="h-2 w-2 rounded-full bg-orange-400" />一般</span>
                        <span className="inline-flex items-center gap-1"><i aria-hidden="true" className="h-2 w-2 rounded-full bg-pink-500" />熱號</span>
                        <span className="inline-flex items-center gap-1"><i aria-hidden="true" className="h-2 w-2 rounded-full bg-blue-500" />冷號</span>
                        <span className="inline-flex items-center gap-1"><i aria-hidden="true" className="h-2 w-2 rounded-full bg-red-500" />超級</span>
                        <span className="inline-flex items-center gap-1"><i aria-hidden="true" className="flex h-3 min-w-3 items-center justify-center rounded-full bg-slate-800 px-0.5 text-[8px] text-white">2</i>連開</span>
                      </div>
                      <div className="mt-3 grid grid-cols-5 justify-items-center gap-x-1 gap-y-4 rounded-2xl border border-orange-200/10 bg-slate-950/40 px-2.5 py-4 sm:grid-cols-10 sm:gap-x-2 sm:gap-y-5 sm:px-3" role="list" aria-label={`第 ${latest.period} 期的 20 個開獎號碼，附近 30 期冷熱與連開資訊`}>
                        {latest.numbers.map((number, index) => {
                          const normalized = normalizeNumber(number);
                          const isSuperNumber = normalizeNumber(latest.superNumber) === normalized;
                          const isHot = recentStats.hot.has(normalized);
                          const isCold = recentStats.cold.has(normalized);
                          const numberStat = recentStats.stats[Number(normalized) - 1];
                          return (
                          <div
                            key={`${number}-${index}`}
                            role="listitem"
                            aria-label={`開獎號碼 ${number}${isSuperNumber ? "，超級獎號" : isHot ? "，熱門號碼" : isCold ? "，冷門號碼" : ""}，近 ${recentStats.sampleSize} 期出現 ${numberStat?.count || 0} 次，連續開出 ${numberStat?.currentOpen || 0} 期`}
                            className="flex min-w-0 flex-col items-center gap-1"
                          >
                            <span className={`relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full border text-sm font-bold tabular-nums text-white transition-transform duration-300 hover:-translate-y-0.5 sm:h-12 sm:w-12 sm:text-base ${isSuperNumber ? "border-red-100 bg-gradient-to-br from-red-400 via-red-600 to-red-800 shadow-[0_2px_10px_rgba(239,68,68,0.55)]" : isHot ? "border-pink-100 bg-gradient-to-br from-pink-300 via-pink-600 to-fuchsia-800 shadow-[0_2px_12px_rgba(236,72,153,0.62)]" : isCold ? "border-sky-100 bg-gradient-to-br from-sky-300 via-blue-600 to-indigo-800 shadow-[0_2px_12px_rgba(59,130,246,0.55)]" : "border-orange-100 bg-gradient-to-br from-orange-300 via-amber-400 to-orange-600 shadow-[0_2px_8px_rgba(249,115,22,0.42)]"}`}>
                              {normalized}
                              {(numberStat?.currentOpen || 0) > 1 && (
                                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-white/80 bg-slate-900/90 px-1 text-[9px] font-bold leading-none text-white shadow-[0_1px_5px_rgba(15,23,42,0.65)]">
                                  {numberStat?.currentOpen}
                                </span>
                              )}
                            </span>
                          </div>
                          );
                        })}
                      </div>
                    </>
                  ) : (
                    <p className="mt-2 text-sm text-slate-400">
                      等待首次同步。
                    </p>
                  )}
                </section>
                <section aria-labelledby="prediction-heading" className="min-w-0 max-w-full rounded-3xl border border-amber-300/30 bg-card p-4 shadow-lg shadow-amber-950/20 backdrop-blur sm:p-5">
                  <div className="flex items-end justify-between gap-2">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-200/80">02 · 研究預測</p>
                      <h2 id="prediction-heading" className="mt-1 text-lg font-bold text-amber-100">本期預測與中獎率</h2>
                    </div>
                    <span className="shrink-0 rounded-full border border-slate-600 bg-slate-950/50 px-2.5 py-1 text-xs text-slate-300">歷史回測</span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">先看歷史回測證據，再看本期預測；樣本不足時顯示「—」，不把未知當成 0%。</p>
                  <div className="mt-4 min-w-0 max-w-full divide-y divide-slate-800 overflow-hidden rounded-2xl border border-slate-700/80 bg-slate-950/50">
                    <div className="grid grid-cols-[4.5rem_5rem_minmax(0,1fr)] gap-2 border-b border-slate-700 px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground sm:grid-cols-[6rem_5rem_minmax(0,1fr)]">
                      <span>玩法</span>
                      <span>歷史回測</span>
                      <span className="text-right">預測號碼</span>
                    </div>
                    {bestPlays.map((play) => (
                      <div
                        key={play.key}
                        className="grid min-w-0 max-w-full grid-cols-[4.5rem_5rem_minmax(0,1fr)] items-center gap-2 px-2.5 py-2.5 sm:grid-cols-[6rem_5rem_minmax(0,1fr)]"
                      >
                        <span className="shrink-0 whitespace-nowrap text-xs text-slate-300 sm:text-sm">
                          {play.label}
                        </span>
                        <span className="text-xs font-semibold tabular-nums text-amber-200 sm:text-sm">
                          <Rate value={play.best.rate} label={play.metricLabel} />
                          <BacktestEvidence wins={play.best.wins} samples={play.best.samples} matches={play.best.matches} targetCount={play.best.targetCount} profit={play.best.profit} />
                        </span>
                        <div className="min-w-0 max-w-full">
                          <PredictionValue value={play.best.prediction} />
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              </>
            )}
            {page === "process" && (
              <section aria-labelledby="process-heading" className="min-w-0 rounded-3xl border border-amber-300/30 bg-card p-4 shadow-xl shadow-amber-950/20 backdrop-blur sm:p-5">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-200/80">03 · 透明方法</p>
                <h2 id="process-heading" className="mt-1 text-xl font-bold tracking-tight text-amber-100">計算過程與模型透明度</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  四個步驟把資料轉成研究結果：讀取、計算、回測、輸出。每個模型都保留規則、輸入與證據，方便重新檢查。
                </p>
                <div className="mt-5 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                  {[
                    ["01", "讀資料", "歷史期數"],
                    ["02", "算特徵", "規則與頻率"],
                    ["03", "做回測", "逐玩法比較"],
                    ["04", "出結果", "預測與勝率"],
                  ].map(([number, title, detail]) => (
                    <div key={number} className="rounded-2xl border border-border bg-background/70 p-3 transition-transform duration-300 hover:-translate-y-0.5">
                      <div className="text-xs font-semibold tabular-nums text-amber-200">STEP {number}</div>
                      <div className="mt-1 font-semibold text-foreground">{title}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">{detail}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-4 rounded-2xl border border-cyan-300/25 bg-cyan-300/10 p-4 text-sm leading-6 text-slate-200">
                  <strong className="text-cyan-100">怎麼讀研究證據？</strong>
                  <p className="mt-1">權重是模型採用歷史訊號的比例；回測率是過往預測與實際結果的命中比例。兩者都不是下一期的機率或保證。</p>
                </div>
                <div className="mt-3 space-y-3">
                  {latestModels.map((model) => (
                    <article key={model.name} className="min-w-0 rounded-2xl border border-border bg-background/70 p-4 shadow-lg shadow-black/10 transition-transform duration-300 hover:-translate-y-0.5">
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <div className="truncate font-semibold text-foreground">{model.name}</div>
                        <span className="shrink-0 rounded-full bg-amber-300/15 px-2 py-1 text-xs tabular-nums text-amber-100">樣本 {model.calculation?.historySamples ?? 0} 期</span>
                      </div>
                      <div className="mt-1 text-xs text-amber-100">{model.status || "狀態未提供"}</div>
                      <p className="mt-2 text-sm leading-6 text-slate-300">{modelPlainLanguage(model.name)}</p>
                      <div className="mt-3 rounded-xl border border-border bg-card p-3 text-xs leading-6 text-muted-foreground">
                        <div className="mb-1 font-semibold text-cyan-200">計算輸入</div>
                        <span className="text-foreground">起卦依據：</span>每個玩法／星級均以預測當下時間獨立起卦；目標期號與玩法只標記問題，不直接硬編碼成卦象。
                        <div className="mt-2 space-y-1">
                          {Object.entries(model.calculation?.targetCastings || {}).map(([target, formula]) => (
                            <div key={target} className="break-words"><span className="text-amber-200">{targetLabel(target)}：</span>{formula}{model.calculation?.targetCastingValues?.[target] ? `｜結果：${model.calculation.targetCastingValues[target]}` : ""}</div>
                          ))}
                        </div>
                      </div>
                      <div className="mt-3">
                        <div className="mb-2 text-xs font-medium text-amber-200">各玩法／星級的歷史權重</div>
                        <div className="grid min-w-0 gap-x-3 gap-y-2 sm:grid-cols-2">
                          {Object.entries(model.calculation?.empiricalWeights || {}).map(([target, weight]) => (
                            <div key={target} className="grid min-w-0 grid-cols-[4.5rem_minmax(0,1fr)_2.5rem] items-center gap-2 text-xs">
                              <span className="truncate text-slate-300">{targetLabel(target)}</span>
                              <ScoreBar value={weight} tone="bg-amber-300" />
                              <span className="text-right tabular-nums text-amber-200">{(weight * 100).toFixed(0)}%</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="mt-3">
                        <div className="mb-2 text-xs font-medium text-cyan-200">各玩法／星級的歷史回測率</div>
                        <div className="grid min-w-0 gap-x-3 gap-y-2 sm:grid-cols-2">
                          {Object.entries(model.calculation?.evolution || {}).map(([target, profile]) => (
                            <div key={target} className="grid min-w-0 grid-cols-[4.5rem_minmax(0,1fr)_2.8rem] items-center gap-2 text-xs">
                              <span className="truncate text-slate-300">{targetLabel(target)}</span>
                              <ScoreBar value={profile.score} />
                              <span className="text-right tabular-nums text-cyan-200">{profile.score == null ? "—" : `${(profile.score * 100).toFixed(1)}%`}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="mt-3 border-t border-slate-800 pt-2 text-xs leading-5 text-slate-300">
                        本模型候選：{model.research.numberPicks.join("、")} · 區間：{model.research.zones.join("、")} · 總和：{model.research.sumBand}
                      </div>
                      {model.research.targetResearch && (
                        <div className="mt-3 border-t border-border pt-3">
                          <div className="mb-2 text-xs font-semibold text-amber-200">各玩法／星級專屬輸出</div>
                          <div className="grid gap-2 sm:grid-cols-2">
                            {Object.entries(model.research.targetResearch).map(([target, result]) => {
                              const prediction = target === "size"
                                ? model.official.size
                                : target === "oddEven"
                                  ? model.official.oddEven
                                  : target === "superNumber"
                                    ? model.official.superNumber
                                    : result.numberPicks.join("、");
                              return (
                                <div key={target} className="rounded-lg border border-border bg-card/70 px-2.5 py-2 text-[11px]">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="font-semibold text-foreground">{targetLabel(target)}</span>
                                    <span className="font-bold tabular-nums text-cyan-200">{prediction || "—"}</span>
                                  </div>
                                  <div className="mt-1 text-muted-foreground">{result.sumBand} · {result.oddEvenCount} · {result.highLowCount}</div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      {model.sources && model.sources.length > 0 && (
                        <div className="mt-2 border-t border-slate-800 pt-2 text-xs leading-6 text-slate-300">
                          <span className="text-slate-200">參考來源：</span>
                          {model.sources.map((source) => (
                            <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="mt-1 block min-h-6 break-words text-cyan-200 underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200">
                              {source.name}
                            </a>
                          ))}
                        </div>
                      )}
                    </article>
                  ))}
                </div>
                <div className="mt-3 rounded-xl border border-amber-300/30 bg-amber-300/10 p-3 text-xs leading-5 text-amber-100">
                  勝率計算：命中期數 ÷ 有效預測期數 × 100%。樣本不足或舊資料沒有保存細節時，畫面會顯示「—」，不把未知資料當成 0%。
                </div>
              </section>
            )}
            {page === "history" && (
              <section aria-labelledby="history-heading" className="rounded-3xl border border-cyan-300/30 bg-card p-4 shadow-xl shadow-cyan-950/20 backdrop-blur sm:p-5">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-200/80">04 · 歷史紀錄</p>
                <h2 id="history-heading" className="mt-1 text-xl font-bold tracking-tight text-cyan-100">歷史開獎與研究紀錄</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  每一期先看官方結果，再展開模型查看預測、派彩與單注淨盈虧；數字只代表歷史紀錄，不代表未來結果。
                </p>
                <div className="relative mt-5 space-y-3 before:absolute before:bottom-3 before:left-3 before:top-3 before:w-px before:bg-cyan-300/25">
                  {sorted.slice(0, 50).map((draw) => (
                    <article
                      key={draw.period}
                      className="relative ml-7 rounded-2xl border border-border bg-background/70 p-3 transition-colors duration-300 hover:border-cyan-300/50 sm:p-4"
                    >
                      <span aria-hidden="true" className="absolute -left-[1.65rem] top-5 h-3 w-3 rounded-full border-2 border-slate-950 bg-cyan-300 shadow-[0_0_0_4px_rgba(103,232,249,0.15)]" />
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <h3 className="text-base font-bold text-white">第 {draw.period} 期</h3>
                        <span className="rounded-full border border-border bg-card px-2 py-1 text-[10px] font-semibold text-muted-foreground">已結算</span>
                      </div>
                        <div className="mt-1 text-xs leading-6 text-slate-300">
                          開獎時間 {draw.drawAt || "未知"} · 資料來源{" "}
                          {draw.sourceLabel || "未知"}
                        </div>
                      <div className="mt-3 rounded-xl border border-slate-800 bg-slate-900/80 p-3 text-sm leading-6 text-slate-200">
                        <div className="mb-3 flex flex-wrap gap-1.5" aria-label={`第 ${draw.period} 期總和、大小、單雙結果`}>
                          <span className="rounded-full border border-violet-300/30 bg-violet-300/10 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-violet-100">
                            總和：{numberSum(draw.numbers)}
                          </span>
                          <span className="rounded-full border border-orange-300/30 bg-orange-300/10 px-2 py-0.5 text-[11px] font-semibold text-orange-100">
                            大小：{draw.size || "—"}
                          </span>
                          <span className="rounded-full border border-cyan-300/30 bg-cyan-300/10 px-2 py-0.5 text-[11px] font-semibold text-cyan-100">
                            單雙：{draw.oddEven || "—"}
                          </span>
                        </div>
                        <div className="grid grid-cols-5 gap-x-1.5 gap-y-3 sm:grid-cols-10" role="list" aria-label={`第 ${draw.period} 期的開獎號碼`}>
                          {draw.numbers.map((number, index) => {
                            const normalized = normalizeNumber(number);
                            const isSuperNumber = normalizeNumber(draw.superNumber) === normalized;
                            const repeatCount = numberCounts(draw.numbers).get(normalized) || 1;
                            const isRepeated = repeatCount > 1;
                            const isHot = recentStats.hot.has(normalized);
                            const isCold = recentStats.cold.has(normalized);
                            return (
                              <div key={`${draw.period}-${number}-${index}`} role="listitem" aria-label={`開獎號碼 ${number}${isSuperNumber ? "，超級獎號" : ""}`} className="flex min-w-0 flex-col items-center gap-1">
                                <span className={`relative flex aspect-square w-full max-w-9 items-center justify-center rounded-full border text-xs font-bold tabular-nums text-white ${isSuperNumber ? "border-red-100 bg-gradient-to-br from-red-400 via-red-600 to-red-800 shadow-[0_2px_10px_rgba(239,68,68,0.55)]" : isHot ? "border-pink-100 bg-gradient-to-br from-pink-300 via-pink-600 to-fuchsia-800 shadow-[0_2px_12px_rgba(236,72,153,0.62)]" : isCold ? "border-sky-100 bg-gradient-to-br from-sky-300 via-blue-600 to-indigo-800 shadow-[0_2px_12px_rgba(59,130,246,0.55)]" : "border-orange-100 bg-gradient-to-br from-orange-300 via-amber-400 to-orange-600 shadow-[0_2px_8px_rgba(249,115,22,0.42)]"}`}>
                                  {normalized}
                                  {isRepeated && !isSuperNumber && (
                                    <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-white/80 bg-pink-600 px-1 text-[9px] font-bold leading-none text-white shadow-[0_1px_5px_rgba(236,72,153,0.65)]">
                                      {repeatCount}
                                    </span>
                                  )}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                        <div className="mt-3 border-t border-border pt-2 text-[11px] text-muted-foreground">模型紀錄：
                        {parseModels(draw)
                          .map((model) => model.name)
                          .join("、") || "—"}
                        </div>
                      </div>
                      {parseModels(draw).map((model) => (
                        <HistoricalModelDetails key={model.name} model={model} draw={draw} />
                      ))}
                    </article>
                  ))}
                  {sorted.length === 0 && (
                    <p className="rounded-2xl border border-dashed border-slate-700 p-5 text-center text-sm text-slate-300">尚無歷史紀錄。</p>
                  )}
                </div>
              </section>
            )}
            {false && (
              <div className="text-xs leading-6 text-slate-300">
                資料來源：
                {sourceHealth
                  .filter((source) => source.ok)
                  .map((source) => source.name)
                  .join("、")}{" "}
                ·{" "}
                {backup?.enabled
                  ? "研究資料已同步"
                  : "研究資料尚未同步"}
              </div>
            )}
            {page !== "overview" && latest && (
              <div className="text-xs leading-6 text-slate-300" role="status">
                研究資料已同步；畫面內容僅呈現開獎資料、研究方法與統計結果。
              </div>
            )}
          </div>
        </CustomScrollbar>
      </div>
      <nav aria-label="手機頁面導覽" className="fixed inset-x-0 bottom-0 z-20 flex gap-1 border-t border-cyan-300/30 bg-slate-950/95 p-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] shadow-2xl shadow-black/40 backdrop-blur sm:hidden">
        {mobilePageButton("overview", "總覽")}
        {mobilePageButton("process", "過程")}
        {mobilePageButton("history", "歷史")}
      </nav>
    </div>
  );
}
