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
      if (!response.ok) throw new Error(`資料服務 HTTP ${response.status}`);
      return (await response.json()) as DrawSnapshot;
    } catch (error) {
      lastError =
        error instanceof Error && /abort|signal/i.test(error.message)
          ? new Error("資料服務逾時，請稍後重試")
          : error;
      if (attempt < 2)
        await new Promise((resolve) =>
          window.setTimeout(resolve, 800 * (attempt + 1)),
        );
    } finally {
      window.clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("資料服務連線失敗");
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

function bestPlayStats(draws: DrawSnapshot[], latestModels: Model[]) {
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
      const hits = rows.filter(({ item, draw }) => {
        if (play.key === "size") return item.official.size === draw.size;
        if (play.key === "oddEven")
          return item.official.oddEven === draw.oddEven;
        if (play.key === "superNumber")
          return item.official.superNumber === draw.superNumber;
        const predicted = item.official.basic[play.key] || [];
        const actual = new Set(draw.numbers);
        return (
          predicted.length > 0 &&
          predicted.every((number) => actual.has(number))
        );
      }).length;
      const latest = latestModels.find((item) => item.name === model);
      const prediction =
        play.key === "size"
          ? latest?.official.size
          : play.key === "oddEven"
            ? latest?.official.oddEven
            : play.key === "superNumber"
              ? latest?.official.superNumber
              : latest?.official.basic[play.key]?.join("、");
      return {
        model,
        samples: rows.length,
        hits,
        rate: rows.length ? hits / rows.length : null,
        prediction: prediction || "—",
      };
    }).sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
    return { ...play, best: candidates[0] };
  });
}

function Rate({ value }: { value: number | null }) {
  return (
    <span className="tabular-nums font-semibold" aria-label={value == null ? "勝率未知" : `勝率 ${(value * 100).toFixed(1)}%`}>
      {value == null ? "—" : `${(value * 100).toFixed(1)}%`}
    </span>
  );
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
    <div className="h-full min-w-0 max-w-full flex flex-col min-h-0 overflow-x-hidden bg-slate-950 text-slate-100">
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
      <div className="flex-1 min-h-0 min-w-0 overflow-x-hidden" aria-busy={syncing}>
        <CustomScrollbar orientation="vertical">
          <div className="mx-auto min-w-0 max-w-4xl space-y-3 overflow-x-hidden p-3 pb-20 sm:p-4 sm:pb-4">
            <div className="rounded-2xl border border-cyan-400/30 bg-slate-900 p-3 shadow-lg shadow-cyan-950/30 sm:p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs text-slate-300">距離下期開獎</div>
                  <div className="tabular-nums text-2xl font-semibold text-cyan-200 sm:text-3xl" aria-label={`距離下期開獎 ${formatCountdown(nextDraw.getTime() - now.getTime())}`}>
                    {formatCountdown(nextDraw.getTime() - now.getTime())}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-slate-300">台北時間</div>
                  <time className="text-sm text-slate-100" dateTime={now.toISOString()}>{taipeiTime}</time>
                </div>
              </div>
              <div className="mt-3 hidden flex-wrap gap-1 border-t border-slate-700 pt-2 sm:flex">
                {pageButton("overview", "首頁")}
                {pageButton("process", "計算過程")}
                {pageButton("history", "歷史紀錄")}
              </div>
            </div>
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
                <section aria-labelledby="latest-draw-heading" className="rounded-2xl border border-orange-400/30 bg-slate-900 p-3 shadow-lg shadow-orange-950/20 sm:p-4">
                  <div className="flex items-center justify-between gap-2">
                    <h2 id="latest-draw-heading" className="font-semibold text-orange-200">
                      最新開獎號碼
                    </h2>
                    <span className="shrink-0 text-lg font-semibold tabular-nums text-orange-100" aria-label={latest ? `第 ${latest.period} 期` : "等待同步"}>
                      {latest ? `第 ${latest.period} 期` : "等待同步"}
                    </span>
                  </div>
                  {latest ? (
                    <>
                      <div className="mt-3 grid grid-cols-10 gap-1.5" role="list" aria-label={`第 ${latest.period} 期的 20 個開獎號碼`}>
                        {latest.numbers.map((number, index) => (
                          <span
                            key={`${number}-${index}`}
                            role="listitem"
                            aria-label={`開獎號碼 ${number}`}
                            className="flex aspect-square min-h-6 min-w-6 items-center justify-center rounded-full border border-orange-100 bg-gradient-to-br from-orange-300 via-orange-500 to-orange-700 text-xs font-bold tabular-nums text-white shadow-[0_2px_6px_rgba(249,115,22,0.35)] sm:text-sm"
                          >
                            {number}
                          </span>
                        ))}
                      </div>
                      <div className="mt-3 flex items-center justify-between rounded-xl border border-red-400/40 bg-red-950/20 px-3 py-2">
                        <span className="text-xs font-medium text-red-200 sm:text-sm">
                          超級獎號
                        </span>
                        <span className="flex h-10 w-10 items-center justify-center rounded-full border border-red-100 bg-gradient-to-br from-red-400 via-red-600 to-red-800 text-sm font-bold tabular-nums text-white shadow-[0_2px_8px_rgba(239,68,68,0.4)]" aria-label={`超級獎號 ${latest.superNumber || "未知"}`}>
                          {latest.superNumber || "—"}
                        </span>
                      </div>
                    </>
                  ) : (
                    <p className="mt-2 text-sm text-slate-400">
                      等待首次同步。
                    </p>
                  )}
                </section>
                <section aria-labelledby="prediction-heading" className="min-w-0 max-w-full rounded-2xl border border-amber-300/40 bg-slate-900 p-3 shadow-lg shadow-amber-950/20 sm:p-4">
                  <div className="flex items-end justify-between gap-2">
                    <h2 id="prediction-heading" className="font-semibold text-amber-200">
                      本期預測玩法、勝率與號碼
                    </h2>
                    <span className="shrink-0 text-xs text-slate-300">
                      歷史統計
                    </span>
                  </div>
                  <div className="mt-2 min-w-0 max-w-full divide-y divide-slate-800 overflow-hidden rounded-xl border border-slate-700 bg-slate-950/50">
                    <div className="grid grid-cols-[4.5rem_3.5rem_minmax(0,1fr)] gap-2 border-b border-slate-700 px-2.5 py-2 text-xs text-slate-300 sm:grid-cols-[6rem_4rem_minmax(0,1fr)]">
                      <span>玩法</span>
                      <span>勝率</span>
                      <span className="text-right">預測號碼</span>
                    </div>
                    {bestPlays.map((play) => (
                      <div
                        key={play.key}
                        className="grid min-w-0 max-w-full grid-cols-[4.5rem_3.5rem_minmax(0,1fr)] items-center gap-2 px-2.5 py-2 sm:grid-cols-[6rem_4rem_minmax(0,1fr)]"
                      >
                        <span className="shrink-0 whitespace-nowrap text-xs text-slate-300 sm:text-sm">
                          {play.label}
                        </span>
                        <span className="text-xs font-semibold tabular-nums text-amber-200 sm:text-sm">
                          <Rate value={play.best.rate} />
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
              <section aria-labelledby="process-heading" className="min-w-0 rounded-2xl border border-amber-300/50 bg-slate-900 p-3 shadow-lg shadow-amber-950/20 sm:p-4">
                <h2 id="process-heading" className="font-semibold text-amber-200">計算過程與模型透明度</h2>
                <p className="mt-1 text-xs leading-5 text-slate-400">
                  白話說：先讀取歷史資料，再計算特徵，接著用過去開獎做回測，最後才產生預測。這是統計研究，不是保證中獎。
                </p>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                  {[
                    ["01", "讀資料", "歷史期數"],
                    ["02", "算特徵", "規則與頻率"],
                    ["03", "做回測", "逐玩法比較"],
                    ["04", "出結果", "預測與勝率"],
                  ].map(([number, title, detail]) => (
                    <div key={number} className="rounded-xl border border-slate-700 bg-slate-800 p-2.5">
                      <div className="text-lg font-bold tabular-nums text-amber-300">{number}</div>
                      <div className="font-medium text-white">{title}</div>
                      <div className="mt-0.5 text-xs text-slate-300">{detail}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 rounded-xl border-l-4 border-cyan-300 bg-slate-800 p-3 text-xs leading-5 text-slate-300">
                  <b className="text-cyan-200">怎麼看這些數字？</b>
                  <p className="mt-1">權重越高，代表該玩法越重視歷史出現頻率；越低，代表越重視模型本身的規則。回測率是把較早期資料當成「當時已知資料」來預測，再和真正開獎結果比對。</p>
                </div>
                <div className="mt-3 space-y-3">
                  {latestModels.map((model) => (
                    <div key={model.name} className="min-w-0 rounded-xl border border-amber-300/30 bg-slate-950/60 p-3">
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <div className="truncate font-semibold text-white">{model.name}</div>
                        <span className="shrink-0 rounded-full bg-amber-300/15 px-2 py-1 text-xs text-amber-100">{model.calculation?.historySamples ?? 0} 期樣本</span>
                      </div>
                      <div className="mt-1 text-xs text-amber-100">{model.status || "版本狀態未保存"}</div>
                      <p className="mt-1 text-xs leading-5 text-slate-400">{modelPlainLanguage(model.name)}</p>
                      <div className="mt-2 rounded-lg border border-slate-700 bg-slate-900 p-2 text-xs leading-6 text-slate-200">
                        <span className="text-cyan-200">起卦依據：</span>每個玩法／星級均以預測當下時間獨立起卦；目標期號與玩法只標記問題，不直接硬編碼成卦象。
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
                      {model.sources && model.sources.length > 0 && (
                        <div className="mt-2 border-t border-slate-800 pt-2 text-xs leading-6 text-slate-300">
                          <span className="text-slate-400">來源：</span>
                          {model.sources.map((source) => (
                            <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="mt-1 block min-h-6 break-words text-cyan-200 underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200">
                              {source.name}
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <div className="mt-3 rounded-xl border border-amber-300/30 bg-amber-300/10 p-3 text-xs leading-5 text-amber-100">
                  勝率計算：命中期數 ÷ 有效預測期數 × 100%。樣本不足或舊資料沒有保存細節時，畫面會顯示「—」，不把未知資料當成 0%。
                </div>
              </section>
            )}
            {page === "history" && (
              <section aria-labelledby="history-heading" className="rounded-2xl border border-cyan-400/30 bg-slate-900 p-3 shadow-lg shadow-cyan-950/20 sm:p-4">
                <h2 id="history-heading" className="font-semibold text-cyan-200">歷史開獎與預測</h2>
                <p className="mt-1 text-xs text-slate-400">
                  資料由 Zeabur PostgreSQL 提供，前端僅讀取，不在 Vault
                  建立、修改或刪除紀錄。
                </p>
                <div className="mt-3 space-y-2">
                  {sorted.slice(0, 50).map((draw) => (
                    <div
                      key={draw.period}
                      className="rounded-xl border border-slate-700 p-3"
                    >
                      <div className="text-sm">
                        <b className="text-white">第 {draw.period} 期</b>
                        <div className="mt-1 text-xs leading-6 text-slate-300">
                          開獎 {draw.drawAt || "時間未知"} · 來源{" "}
                          {draw.sourceLabel || "未知"}
                        </div>
                      </div>
                      <div className="mt-2 break-words text-xs leading-5 text-slate-300">
                        號碼：{draw.numbers.join("、")} · 大小／單雙：
                        {draw.size || "—"}／{draw.oddEven || "—"} · 預測模型：
                        {parseModels(draw)
                          .map((model) => model.name)
                          .join("、") || "—"}
                      </div>
                    </div>
                  ))}
                  {sorted.length === 0 && (
                    <p className="text-sm text-slate-400">尚無歷史紀錄。</p>
                  )}
                </div>
              </section>
            )}
            {page !== "overview" && sourceHealth.length > 0 && (
              <div className="text-xs leading-6 text-slate-300">
                資料來源：
                {sourceHealth
                  .filter((source) => source.ok)
                  .map((source) => source.name)
                  .join("、")}{" "}
                ·{" "}
                {backup?.enabled
                  ? `算法／權重已備份至 ${backup.repo || "GitHub"}`
                  : "算法／權重 GitHub 備份尚未啟用"}
              </div>
            )}
          </div>
        </CustomScrollbar>
      </div>
      <div className="fixed inset-x-0 bottom-0 z-20 flex gap-1 border-t border-cyan-400/30 bg-slate-950/95 p-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] shadow-lg backdrop-blur sm:hidden">
        {mobilePageButton("overview", "總覽")}
        {mobilePageButton("process", "過程")}
        {mobilePageButton("history", "歷史")}
      </div>
    </div>
  );
}
