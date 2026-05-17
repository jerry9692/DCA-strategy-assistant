import React, { Component, type ErrorInfo, type ReactNode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactECharts from "echarts-for-react";
import { Activity, BarChart3, Download, Moon, RefreshCcw, SlidersHorizontal, Sparkles, Sun } from "lucide-react";
import "./styles.css";

type Asset = { symbol: string; name: string; currency: string };
type Param = {
  key: string;
  label: string;
  type: "number" | "range" | "select" | "toggle";
  default: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: string | number | boolean }[];
  help?: string;
};
type StrategyDef = { type: string; name: string; description: string; parameters: Param[] };
type Decision = {
  date: string;
  price: number;
  recommendedAmount: number;
  multiplier: number;
  score: number;
  rawSignals: Record<string, number | string | null>;
  reasons: string[];
};
type Contribution = {
  date: string;
  price: number;
  amount: number;
  portfolioValue: number;
  multiplier: number;
  score: number;
  drawdownPct: number;
  accountDrawdownPct?: number;
};
type Metrics = {
  totalInvested: number;
  endingValue: number;
  returnPct: number;
  annualizedReturnPct: number;
  maxDrawdownPct: number;
  buyCount: number;
  avgContribution: number;
  versusFixedPct?: number | null;
  versusLumpSumPct?: number | null;
  sharpeRatio?: number | null;
  sortinoRatio?: number | null;
};
type MarketState = {
  label: string;
  tone: "up" | "down" | "neutral";
  summary: string;
  price?: number | null;
  sma50?: number | null;
  sma200?: number | null;
  distanceToSma200Pct?: number | null;
};
type StrategyComparison = {
  strategyType: string;
  name: string;
  metrics: Metrics;
  contributions: Contribution[];
};
type StrategyConfigPayload = {
  strategyType: string;
  baseAmount: number;
  frequency: "weekly" | "biweekly" | "monthly";
  minMultiplier: number;
  maxMultiplier: number;
  params: Record<string, number | string | boolean>;
};
type Backtest = {
  symbol: string;
  strategyType: string;
  recommendation: Decision;
  metrics: Metrics;
  fixedMetrics?: Metrics;
  lumpSumMetrics?: Metrics;
  marketState?: MarketState | null;
  contributions: Contribution[];
  fixedContributions: Contribution[];
  lumpSumContributions: Contribution[];
  strategyComparisons: StrategyComparison[];
  priceSeries: { date: string; close: number }[];
  dataSource: string;
  cacheStatus: string;
};
type RecommendationResponse = {
  symbol: string;
  decision: Decision;
  dataSource: string;
  cacheStatus: string;
};
type OptimizationScenarioMetric = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  metrics: Metrics;
  fixedMetrics: Metrics;
  score: number;
};
type OptimizationCandidate = {
  rank: number;
  score: number;
  config: StrategyConfigPayload;
  scenarios: OptimizationScenarioMetric[];
  summary: Metrics;
};
type OptimizationScenarioResult = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  baselineMetrics: Metrics;
  recommendedMetrics: Metrics;
  fixedMetrics: Metrics;
};
type OptimizationResult = {
  symbol: string;
  objective: "robust_return" | "max_return" | "min_drawdown";
  baselineConfig: StrategyConfigPayload;
  recommendedConfig: StrategyConfigPayload;
  baselineSummary: Metrics;
  recommendedSummary: Metrics;
  candidates: OptimizationCandidate[];
  scenarios: OptimizationScenarioResult[];
  searchedCount: number;
  skippedCount: number;
};
type OptimizationJobStatus = {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress: number;
  evaluatedCount: number;
  totalCount: number;
  currentScenario?: string | null;
  bestSoFar?: OptimizationCandidate | null;
  result?: OptimizationResult | null;
  error?: string | null;
};
type UiError = { message: string; code?: string; retryable: boolean };
type PresetMode = "conservative" | "balanced" | "aggressive" | "custom";
type Frequency = "weekly" | "biweekly" | "monthly";
type MarketCode = "us" | "cn";
type PressureScenario = {
  id: string;
  market: MarketCode;
  name: string;
  startDate: string;
  endDate: string;
  summary: string;
};

const api = "";
const SETTINGS_KEY = "dca-assistant-settings-v3";
const today = new Date();
const todayIso = isoDate(today);
const fiveYearsAgo = new Date(today);
fiveYearsAgo.setFullYear(today.getFullYear() - 5);

const PARAMETER_PRESETS: Record<Exclude<PresetMode, "custom">, { label: string; minMultiplier: number; maxMultiplier: number }> = {
  conservative: { label: "保守", minMultiplier: 0.8, maxMultiplier: 1.2 },
  balanced: { label: "均衡", minMultiplier: 0.8, maxMultiplier: 1.2 },
  aggressive: { label: "激进", minMultiplier: 0.8, maxMultiplier: 1.2 }
};

const ASSET_MARKETS: Record<string, MarketCode> = {
  QQQ: "us",
  SPY: "us",
  VOO: "us"
};

const PRESSURE_SCENARIOS: PressureScenario[] = [
  {
    id: "brexit_2016",
    market: "us",
    name: "2016 Brexit 冲击",
    startDate: "2016-06-23",
    endDate: "2016-07-15",
    summary: "短期外部事件冲击，检验快速下跌后的恢复节奏。"
  },
  {
    id: "q4_selloff_2018",
    market: "us",
    name: "2018 Q4 紧缩杀跌",
    startDate: "2018-10-03",
    endDate: "2018-12-24",
    summary: "高波动下跌窗口，检验加码纪律和资金消耗。"
  },
  {
    id: "covid_2020",
    market: "us",
    name: "2020 熔断冲击",
    startDate: "2020-02-18",
    endDate: "2020-05-29",
    summary: "检验策略在急跌和快速反弹中的加码节奏。"
  },
  {
    id: "liquidity_rally_2021",
    market: "us",
    name: "2021 流动性牛市",
    startDate: "2021-01-04",
    endDate: "2021-12-31",
    summary: "持续上涨环境，观察策略是否过早降档。"
  },
  {
    id: "rate_hike_2022",
    market: "us",
    name: "2022 加息杀估值",
    startDate: "2022-01-03",
    endDate: "2022-12-30",
    summary: "检验策略在长时间下跌和震荡中的资金消耗。"
  },
  {
    id: "ai_rebound_2023",
    market: "us",
    name: "2023 科技股修复",
    startDate: "2023-01-03",
    endDate: "2023-08-31",
    summary: "观察策略在持续修复行情中是否过早降档。"
  },
  {
    id: "ai_momentum_2024",
    market: "us",
    name: "2024 AI 集中行情",
    startDate: "2023-10-27",
    endDate: "2024-07-10",
    summary: "强趋势上涨窗口，检验策略在高位环境下的投入控制。"
  }
];

const QUICK_BACKTEST_PERIODS = [
  { id: "1y", label: "1年", years: 1 },
  { id: "3y", label: "3年", years: 3 },
  { id: "5y", label: "5年", years: 5 },
  { id: "10y", label: "10年", years: 10 }
];

function isoDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateInput(value: string) {
  const parsed = new Date(`${value}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function yearsBefore(dateText: string, years: number) {
  const date = parseDateInput(dateText);
  date.setFullYear(date.getFullYear() - years);
  return isoDate(date);
}

function clampEndDate(value: string) {
  return value > todayIso ? todayIso : value;
}

function defaultsFor(strategy?: StrategyDef) {
  const params: Record<string, number | string | boolean> = {};
  strategy?.parameters.forEach((param) => {
    params[param.key] = param.default;
  });
  return params;
}

function presetFor(strategy: StrategyDef | undefined, mode: PresetMode) {
  const base = defaultsFor(strategy);
  if (mode === "custom") {
    return {
      minMultiplier: PARAMETER_PRESETS.balanced.minMultiplier,
      maxMultiplier: PARAMETER_PRESETS.balanced.maxMultiplier,
      params: base
    };
  }

  const preset = PARAMETER_PRESETS[mode];
  const params = { ...base };
  if (mode === "conservative") {
    if ("maxDrawdownPct" in params) params.maxDrawdownPct = 40;
    if ("deviationPct" in params) params.deviationPct = 25;
    if ("oversold" in params) params.oversold = 25;
    if ("overbought" in params) params.overbought = 75;
    if ("smooth" in params) params.smooth = true;
  }
  if (mode === "aggressive") {
    if ("maxDrawdownPct" in params) params.maxDrawdownPct = 20;
    if ("deviationPct" in params) params.deviationPct = 10;
    if ("oversold" in params) params.oversold = 35;
    if ("overbought" in params) params.overbought = 65;
    if ("smooth" in params) params.smooth = false;
    if ("drawdownWeight" in params) params.drawdownWeight = 1.5;
    if ("maWeight" in params) params.maWeight = 1.2;
    if ("rsiWeight" in params) params.rsiWeight = 1.2;
  }
  return { minMultiplier: preset.minMultiplier, maxMultiplier: preset.maxMultiplier, params };
}

function readSavedSettings() {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function csvEscape(value: number | string | null | undefined) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadText(filename: string, content: string, type = "text/csv;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportBacktestCsv(result: Backtest | null) {
  if (!result) return;
  const rows = [["series", "date", "price", "amount", "portfolioValue", "multiplier", "score", "holdingDrawdownPct", "accountDrawdownPct"]];
  const append = (series: string, events: Contribution[]) => {
    events.forEach((event) => {
      rows.push([
        series,
        event.date,
        String(event.price),
        String(event.amount),
        String(event.portfolioValue),
        String(event.multiplier),
        String(event.score),
        String(event.drawdownPct),
        String(accountDrawdown(event))
      ]);
    });
  };
  append("strategy", result.contributions);
  append("fixed_dca", result.fixedContributions);
  append("lump_sum", result.lumpSumContributions);
  result.strategyComparisons.forEach((item) => append(item.strategyType, item.contributions));
  const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\n");
  downloadText(`dca-backtest-${result.symbol}-${result.strategyType}-${result.recommendation.date}.csv`, csv);
}

function describeConfig(config: StrategyConfigPayload) {
  const items = [
    `最低 ${config.minMultiplier}x`,
    `最高 ${config.maxMultiplier}x`,
    ...Object.entries(config.params).map(([key, value]) => `${key}: ${String(value)}`)
  ];
  return items.join(" · ");
}

function metric(value: number | null | undefined, suffix = "") {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
}

function accountDrawdown(event: Contribution) {
  return event.accountDrawdownPct ?? event.drawdownPct;
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const detail = payload?.detail;
    if (typeof detail === "object" && detail?.message) {
      throw { message: detail.message, code: detail.code, retryable: Boolean(detail.retryable) };
    }
    throw { message: typeof detail === "string" ? detail : "请求失败", retryable: true };
  }
  if (!payload) {
    throw { message: "后端返回了空响应，请重试。", retryable: true };
  }
  return payload as T;
}

function toUiError(err: unknown): UiError {
  if (typeof err === "object" && err !== null && "message" in err) {
    const shaped = err as { message?: unknown; code?: unknown; retryable?: unknown };
    return {
      message: String(shaped.message || "请求失败"),
      code: typeof shaped.code === "string" ? shaped.code : undefined,
      retryable: shaped.retryable !== false
    };
  }
  return { message: "请求失败", retryable: true };
}

function ErrorFallback({ onReset }: { onReset: () => void }) {
  return (
    <main className="app-shell">
      <section className="fatal-error">
        <p className="eyebrow">DCA Strategy Assistant v0.2</p>
        <h1>界面渲染遇到问题</h1>
        <p className="muted">当前数据没有丢失，可以先恢复界面再重试。</p>
        <button type="button" onClick={onReset}>
          恢复界面
        </button>
      </section>
    </main>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("UI render failed", error, info);
  }

  reset = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return <ErrorFallback onReset={this.reset} />;
    }
    return this.props.children;
  }
}

function App() {
  const savedSettings = useMemo(() => readSavedSettings(), []);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [strategies, setStrategies] = useState<StrategyDef[]>([]);
  const [darkMode, setDarkMode] = useState(Boolean(savedSettings?.darkMode));
  const [symbol, setSymbol] = useState(String(savedSettings?.symbol ?? "QQQ"));
  const [strategyType, setStrategyType] = useState(String(savedSettings?.strategyType ?? "composite_score"));
  const [baseAmount, setBaseAmount] = useState(Number(savedSettings?.baseAmount ?? 100));
  const [frequency, setFrequency] = useState<Frequency>((savedSettings?.frequency as Frequency) ?? "weekly");
  const [minMultiplier, setMinMultiplier] = useState(Number(savedSettings?.minMultiplier ?? 0.8));
  const [maxMultiplier, setMaxMultiplier] = useState(Number(savedSettings?.maxMultiplier ?? 1.2));
  const [startDate, setStartDate] = useState(String(savedSettings?.startDate ?? isoDate(fiveYearsAgo)));
  const [endDate, setEndDate] = useState(clampEndDate(String(savedSettings?.endDate ?? todayIso)));
  const [params, setParams] = useState<Record<string, number | string | boolean>>({});
  const [result, setResult] = useState<Backtest | null>(null);
  const [quickDecision, setQuickDecision] = useState<Decision | null>(null);
  const [quickData, setQuickData] = useState<{ dataSource: string; cacheStatus: string } | null>(null);
  const [optimization, setOptimization] = useState<OptimizationResult | null>(null);
  const [optimizationJob, setOptimizationJob] = useState<OptimizationJobStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [recommendationLoading, setRecommendationLoading] = useState(false);
  const [optimizationLoading, setOptimizationLoading] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [showAllReasons, setShowAllReasons] = useState(false);
  const [presetMode, setPresetMode] = useState<PresetMode>((savedSettings?.presetMode as PresetMode) ?? "balanced");
  const [activeScenarioId, setActiveScenarioId] = useState<string | null>(String(savedSettings?.activeScenarioId ?? "") || null);
  const [comparisonStrategyTypes, setComparisonStrategyTypes] = useState<string[]>(
    Array.isArray(savedSettings?.comparisonStrategyTypes) ? savedSettings.comparisonStrategyTypes : ["drawdown_boost", "ma_deviation"]
  );

  const selectedStrategy = useMemo(() => strategies.find((item) => item.type === strategyType), [strategies, strategyType]);
  const strategyNameByType = useMemo(
    () => new Map(strategies.map((strategy) => [strategy.type, strategy.name])),
    [strategies]
  );
  const comparisonTypes = useMemo(
    () => comparisonStrategyTypes.filter((item, index, source) => item !== strategyType && source.indexOf(item) === index),
    [comparisonStrategyTypes, strategyType]
  );
  const activeMarket = ASSET_MARKETS[symbol] ?? "us";
  const pressureScenarios = useMemo(
    () => PRESSURE_SCENARIOS.filter((scenario) => scenario.market === activeMarket),
    [activeMarket]
  );
  const activeScenario = useMemo(
    () => pressureScenarios.find((scenario) => scenario.id === activeScenarioId) ?? null,
    [activeScenarioId, pressureScenarios]
  );
  const activePeriodId = useMemo(
    () => QUICK_BACKTEST_PERIODS.find((period) => yearsBefore(endDate, period.years) === startDate)?.id ?? null,
    [endDate, startDate]
  );
  const config = useMemo(
    (): StrategyConfigPayload => ({
      strategyType,
      baseAmount,
      frequency,
      minMultiplier,
      maxMultiplier,
      params
    }),
    [strategyType, baseAmount, frequency, minMultiplier, maxMultiplier, params]
  );
  const optimizationActive = optimizationJob?.status === "queued" || optimizationJob?.status === "running";

  useEffect(() => {
    setOptimization(null);
    if (optimizationActive && optimizationJob) {
      fetch(`${api}/api/optimizations/jobs/${optimizationJob.jobId}`, { method: "DELETE" }).catch(() => undefined);
      setOptimizationLoading(false);
    }
    setOptimizationJob(null);
  }, [symbol, strategyType, startDate, endDate, config]);

  useEffect(() => {
    Promise.all([fetch(`${api}/api/assets`).then(readJson<Asset[]>), fetch(`${api}/api/strategies`).then(readJson<{ strategies: StrategyDef[] }>)])
      .then(([assetData, strategyData]) => {
        setAssets(assetData);
        setStrategies(strategyData.strategies);
        const active = strategyData.strategies.find((item: StrategyDef) => item.type === strategyType) ?? strategyData.strategies.find((item: StrategyDef) => item.type === "composite_score");
        if (savedSettings?.params && savedSettings?.strategyType === strategyType) {
          setParams(savedSettings.params);
        } else {
          const preset = presetFor(active, presetMode);
          setMinMultiplier(preset.minMultiplier);
          setMaxMultiplier(preset.maxMultiplier);
          setParams(preset.params);
        }
      })
      .catch((err) => setError(toUiError(err)));
  }, []);

  useEffect(() => {
    const preset = presetFor(selectedStrategy, presetMode === "custom" ? "balanced" : presetMode);
    setMinMultiplier(preset.minMultiplier);
    setMaxMultiplier(preset.maxMultiplier);
    setParams(preset.params);
    setComparisonStrategyTypes((current) => current.filter((item) => item !== strategyType));
  }, [strategyType]);

  useEffect(() => {
    if (activeScenarioId && !activeScenario) setActiveScenarioId(null);
  }, [activeScenario, activeScenarioId]);

  useEffect(() => {
    if (endDate > todayIso) {
      setEndDate(todayIso);
      setActiveScenarioId(null);
    }
  }, [endDate]);

  useEffect(() => {
    if (!selectedStrategy || Object.keys(params).length === 0) return;
    window.localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        darkMode,
        symbol,
        strategyType,
        baseAmount,
        frequency,
        minMultiplier,
        maxMultiplier,
        startDate,
        endDate,
        params,
        presetMode,
        activeScenarioId,
        comparisonStrategyTypes: comparisonTypes
      })
    );
  }, [activeScenarioId, baseAmount, comparisonTypes, darkMode, endDate, frequency, maxMultiplier, minMultiplier, params, presetMode, selectedStrategy, startDate, strategyType, symbol]);

  useEffect(() => {
    if (!selectedStrategy) return;
    const handle = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      fetch(`${api}/api/backtests/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          startDate,
          endDate,
          config,
          comparisonStrategyTypes: comparisonTypes
        })
      })
        .then(async (res) => {
          return readJson<Backtest>(res);
        })
        .then((data) => {
          setResult(data);
          setQuickDecision(null);
          setQuickData(null);
        })
        .catch((err) => setError(toUiError(err)))
        .finally(() => setLoading(false));
    }, 450);
    return () => window.clearTimeout(handle);
  }, [symbol, startDate, endDate, config, selectedStrategy, refreshNonce, comparisonTypes]);

  useEffect(() => {
    if (!optimizationJob || !optimizationActive) return;
    let stopped = false;
    const poll = () => {
      fetch(`${api}/api/optimizations/jobs/${optimizationJob.jobId}`)
        .then(readJson<OptimizationJobStatus>)
        .then((job) => {
          if (stopped) return;
          setOptimizationJob(job);
          if (job.status === "completed") {
            if (job.result) setOptimization(job.result);
            setOptimizationLoading(false);
          }
          if (job.status === "failed") {
            setError({ message: job.error || "参数调优失败，请重试。", retryable: true });
            setOptimizationLoading(false);
          }
          if (job.status === "cancelled") {
            setOptimizationLoading(false);
          }
        })
        .catch((err) => {
          if (stopped) return;
          setError(toUiError(err));
          setOptimizationLoading(false);
        });
    };
    poll();
    const handle = window.setInterval(poll, 1000);
    return () => {
      stopped = true;
      window.clearInterval(handle);
    };
  }, [optimizationJob?.jobId, optimizationActive]);

  const applyPreset = (mode: PresetMode) => {
    setPresetMode(mode);
    if (mode === "custom") return;
    const preset = presetFor(selectedStrategy, mode);
    setMinMultiplier(preset.minMultiplier);
    setMaxMultiplier(preset.maxMultiplier);
    setParams(preset.params);
  };

  const markCustom = () => {
    setPresetMode("custom");
    setActiveScenarioId(null);
  };

  const applyScenario = (scenarioId: string) => {
    if (!scenarioId) {
      setActiveScenarioId(null);
      return;
    }
    const scenario = pressureScenarios.find((item) => item.id === scenarioId);
    if (!scenario) return;
    setActiveScenarioId(scenario.id);
    setStartDate(scenario.startDate);
    setEndDate(scenario.endDate);
  };

  const applyBacktestPeriod = (years: number) => {
    setStartDate(yearsBefore(endDate, years));
    setActiveScenarioId(null);
  };

  const runRecommendationOnly = () => {
    if (!selectedStrategy) return;
    setRecommendationLoading(true);
    setError(null);
    fetch(`${api}/api/recommendations/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol,
        asOf: endDate,
        config
      })
    })
      .then(readJson<RecommendationResponse>)
      .then((data) => {
        setQuickDecision(data.decision);
        setQuickData({ dataSource: data.dataSource, cacheStatus: data.cacheStatus });
        setResult((current) =>
          current
            ? {
                ...current,
                recommendation: data.decision,
                dataSource: data.dataSource,
                cacheStatus: data.cacheStatus
              }
            : current
        );
      })
      .catch((err) => setError(toUiError(err)))
      .finally(() => setRecommendationLoading(false));
  };

  const runOptimization = () => {
    if (!selectedStrategy) return;
    setOptimizationLoading(true);
    setError(null);
    setOptimization(null);
    setOptimizationJob(null);
    fetch(`${api}/api/optimizations/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol,
        startDate,
        endDate,
        config,
        objective: "robust_return"
      })
    })
      .then(readJson<{ jobId: string }>)
      .then((data) =>
        setOptimizationJob({
          jobId: data.jobId,
          status: "queued",
          progress: 0,
          evaluatedCount: 0,
          totalCount: 0
        })
      )
      .catch((err) => {
        setError(toUiError(err));
        setOptimizationLoading(false);
      });
  };

  const cancelOptimization = () => {
    if (!optimizationJob || !optimizationActive) return;
    fetch(`${api}/api/optimizations/jobs/${optimizationJob.jobId}`, { method: "DELETE" })
      .then(readJson<OptimizationJobStatus>)
      .then((job) => {
        setOptimizationJob(job);
        setOptimizationLoading(false);
      })
      .catch((err) => setError(toUiError(err)));
  };

  const applyOptimizedConfig = (optimizedConfig: StrategyConfigPayload) => {
    setPresetMode("custom");
    setMinMultiplier(optimizedConfig.minMultiplier);
    setMaxMultiplier(optimizedConfig.maxMultiplier);
    setParams(optimizedConfig.params);
  };

  const priceOption = useMemo(() => {
    const dates = result?.priceSeries.map((p) => p.date) ?? [];
    return {
      tooltip: { trigger: "axis" },
      grid: { left: 42, right: 18, top: 24, bottom: 34 },
      xAxis: { type: "category", data: dates, axisLabel: { color: "#64748b" } },
      yAxis: { type: "value", scale: true, axisLabel: { color: "#64748b" } },
      series: [
        {
          name: "价格",
          type: "line",
          showSymbol: false,
          data: result?.priceSeries.map((p) => p.close) ?? [],
          lineStyle: { color: "#2563eb", width: 2 }
        },
        {
          name: "买入点",
          type: "scatter",
          data: result?.contributions.map((event) => [event.date, event.price]) ?? [],
          symbolSize: 6,
          itemStyle: { color: "#059669" }
        }
      ]
    };
  }, [result]);

  const contributionOption = useMemo(
    () => ({
      tooltip: { trigger: "axis" },
      legend: { top: 0, textStyle: { color: "#475569" } },
      grid: { left: 46, right: 20, top: 36, bottom: 34 },
      xAxis: { type: "category", data: result?.contributions.map((event) => event.date) ?? [], axisLabel: { color: "#64748b" } },
      yAxis: [
        { type: "value", name: "组合价值", axisLabel: { color: "#64748b" } },
        { type: "value", name: "投入金额", axisLabel: { color: "#64748b" } }
      ],
      series: [
        { name: "本策略投入", type: "bar", yAxisIndex: 1, data: result?.contributions.map((event) => event.amount) ?? [], itemStyle: { color: "#0f766e" } },
        { name: "固定投入", type: "bar", yAxisIndex: 1, data: result?.fixedContributions.map((event) => event.amount) ?? [], itemStyle: { color: "#94a3b8", opacity: 0.5 } },
        { name: "本策略价值", type: "line", yAxisIndex: 0, data: result?.contributions.map((event) => event.portfolioValue) ?? [], showSymbol: false, lineStyle: { color: "#7c3aed", width: 2 } },
        { name: "固定DCA价值", type: "line", yAxisIndex: 0, data: result?.fixedContributions.map((event) => event.portfolioValue) ?? [], showSymbol: false, lineStyle: { color: "#64748b", width: 2, type: "dashed" } },
        { name: "一次性买入", type: "line", yAxisIndex: 0, data: result?.lumpSumContributions.map((event) => event.portfolioValue) ?? [], showSymbol: false, lineStyle: { color: "#dc2626", width: 2, type: "dotted" } }
      ]
    }),
    [result]
  );

  const toggleComparison = (type: string) => {
    setComparisonStrategyTypes((current) => {
      if (current.includes(type)) return current.filter((item) => item !== type);
      if (current.length >= 3) return current;
      return [...current, type];
    });
  };

  const activeAsset = assets.find((item) => item.symbol === symbol);
  const decision = quickDecision ?? result?.recommendation;
  const reasons = decision?.reasons ?? [];
  const visibleReasons = showAllReasons ? reasons : reasons.slice(0, 5);
  const dataSource = quickData?.dataSource ?? result?.dataSource ?? "-";
  const cacheStatus = quickData?.cacheStatus ?? result?.cacheStatus ?? "-";

  const drawdownOption = useMemo(
    () => ({
      tooltip: { trigger: "axis" },
      legend: { top: 0, textStyle: { color: "#475569" } },
      grid: { left: 46, right: 20, top: 36, bottom: 34 },
      xAxis: { type: "category", data: result?.contributions.map((event) => event.date) ?? [], axisLabel: { color: "#64748b" } },
      yAxis: { type: "value", max: 0, axisLabel: { color: "#64748b", formatter: "{value}%" } },
      series: [
        {
          name: "本策略账户回撤",
          type: "line",
          showSymbol: false,
          data: result?.contributions.map(accountDrawdown) ?? [],
          areaStyle: { color: "rgba(124, 58, 237, 0.08)" },
          lineStyle: { color: "#7c3aed", width: 2 }
        },
        ...(result?.strategyComparisons.map((item, index) => ({
          name: `${item.name}账户回撤`,
          type: "line",
          showSymbol: false,
          data: item.contributions.map(accountDrawdown),
          lineStyle: { color: ["#0f766e", "#2563eb", "#d97706"][index % 3], width: 2 }
        })) ?? []),
        {
          name: "固定DCA账户回撤",
          type: "line",
          showSymbol: false,
          data: result?.fixedContributions.map(accountDrawdown) ?? [],
          lineStyle: { color: "#64748b", width: 2, type: "dashed" }
        }
      ]
    }),
    [result]
  );

  const signalOption = useMemo(
    () => ({
      tooltip: { trigger: "axis" },
      legend: { top: 0, textStyle: { color: "#475569" } },
      grid: { left: 46, right: 20, top: 36, bottom: 34 },
      xAxis: { type: "category", data: result?.contributions.map((event) => event.date) ?? [], axisLabel: { color: "#64748b" } },
      yAxis: [
        { type: "value", min: 0, max: 1, axisLabel: { color: "#64748b" } },
        { type: "value", axisLabel: { color: "#64748b", formatter: "{value}x" } }
      ],
      series: [
        {
          name: "策略评分",
          type: "line",
          showSymbol: false,
          data: result?.contributions.map((event) => event.score) ?? [],
          lineStyle: { color: "#2563eb", width: 2 }
        },
        {
          name: "投入倍率",
          type: "line",
          yAxisIndex: 1,
          showSymbol: false,
          data: result?.contributions.map((event) => event.multiplier) ?? [],
          lineStyle: { color: "#0f766e", width: 2 }
        }
      ]
    }),
    [result]
  );

  const showdownOption = useMemo(
    () => ({
      tooltip: { trigger: "axis" },
      legend: { top: 0, textStyle: { color: "#475569" } },
      grid: { left: 46, right: 20, top: 42, bottom: 34 },
      xAxis: { type: "category", data: result?.contributions.map((event) => event.date) ?? [], axisLabel: { color: "#64748b" } },
      yAxis: { type: "value", name: "组合价值", axisLabel: { color: "#64748b" } },
      series: [
        {
          name: result ? strategyNameByType.get(result.strategyType) ?? "本策略" : selectedStrategy?.name ?? "本策略",
          type: "line",
          showSymbol: false,
          data: result?.contributions.map((event) => event.portfolioValue) ?? [],
          lineStyle: { color: "#7c3aed", width: 2 }
        },
        ...(result?.strategyComparisons.map((item, index) => ({
          name: item.name,
          type: "line",
          showSymbol: false,
          data: item.contributions.map((event) => event.portfolioValue),
          lineStyle: { color: ["#0f766e", "#2563eb", "#d97706"][index % 3], width: 2 }
        })) ?? []),
        {
          name: "固定DCA",
          type: "line",
          showSymbol: false,
          data: result?.fixedContributions.map((event) => event.portfolioValue) ?? [],
          lineStyle: { color: "#64748b", width: 2, type: "dashed" }
        }
      ]
    }),
    [result, selectedStrategy, strategyNameByType]
  );

  const comparisonRows = useMemo(
    () => [
      ...(result
        ? [
            {
              strategyType: result.strategyType,
              name: strategyNameByType.get(result.strategyType) ?? "本策略",
              metrics: result.metrics
            }
          ]
        : []),
      ...(result?.strategyComparisons.map((item) => ({ strategyType: item.strategyType, name: item.name, metrics: item.metrics })) ?? [])
    ],
    [result, strategyNameByType]
  );

  return (
    <main className="app-shell" data-theme={darkMode ? "dark" : "light"}>
      <header className="topbar">
        <div>
          <p className="eyebrow">DCA Strategy Assistant v0.2</p>
          <h1>定投策略工作台</h1>
        </div>
        <div className="topbar-actions">
          <button className="icon-button" onClick={() => setDarkMode((value) => !value)} title={darkMode ? "切换浅色模式" : "切换暗色模式"}>
            {darkMode ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button className={loading ? "icon-button spinning" : "icon-button"} onClick={() => setRefreshNonce((value) => value + 1)} title="刷新" disabled={loading}>
            <RefreshCcw size={18} />
          </button>
        </div>
      </header>

      <section className="control-strip">
        <label>
          策略
          <select value={strategyType} onChange={(event) => setStrategyType(event.target.value)}>
            {strategies.map((strategy) => (
              <option key={strategy.type} value={strategy.type}>
                {strategy.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          参数预设
          <select value={presetMode} onChange={(event) => applyPreset(event.target.value as PresetMode)}>
            <option value="conservative">保守</option>
            <option value="balanced">均衡</option>
            <option value="aggressive">激进</option>
            <option value="custom">自定义</option>
          </select>
        </label>
        <label>
          标的
          <select value={symbol} onChange={(event) => setSymbol(event.target.value)}>
            {assets.map((asset) => (
              <option key={asset.symbol} value={asset.symbol}>
                {asset.symbol} · {asset.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          基础金额
          <input type="number" min={1} step={10} value={baseAmount} onChange={(event) => { setBaseAmount(Number(event.target.value)); markCustom(); }} />
        </label>
        <label>
          频率
          <select value={frequency} onChange={(event) => setFrequency(event.target.value as Frequency)}>
            <option value="weekly">每周</option>
            <option value="biweekly">双周</option>
            <option value="monthly">每月</option>
          </select>
        </label>
        <label>
          开始
          <input type="date" value={startDate} onChange={(event) => { setStartDate(event.target.value); setActiveScenarioId(null); }} />
        </label>
        <label>
          结束
          <div className="date-with-action">
            <input type="date" max={todayIso} value={endDate} onChange={(event) => { setEndDate(clampEndDate(event.target.value)); setActiveScenarioId(null); }} />
            <button type="button" onClick={() => { setEndDate(todayIso); setActiveScenarioId(null); }}>
              今天
            </button>
          </div>
        </label>
        <div className="period-control">
          <span>快捷周期</span>
          <div className="period-buttons">
            {QUICK_BACKTEST_PERIODS.map((period) => (
              <button
                type="button"
                key={period.id}
                className={activePeriodId === period.id ? "active" : ""}
                onClick={() => applyBacktestPeriod(period.years)}
              >
                {period.label}
              </button>
            ))}
          </div>
        </div>
        <label className="pressure-control">
          压力测试
          <select value={activeScenario?.id ?? ""} onChange={(event) => applyScenario(event.target.value)}>
            <option value="">普通区间</option>
            {pressureScenarios.map((scenario) => (
              <option key={scenario.id} value={scenario.id}>
                {scenario.name}
              </option>
            ))}
          </select>
        </label>
      </section>

      {error && (
        <div className="error">
          <span>{error.message}</span>
          {error.retryable && (
            <button type="button" onClick={() => setRefreshNonce((value) => value + 1)}>
              重试
            </button>
          )}
        </div>
      )}

      {activeScenario && (
        <section className="pressure-strip">
          <div>
            <strong>{activeScenario.name}</strong>
            <span>{activeScenario.startDate} 至 {activeScenario.endDate} · {activeScenario.summary}</span>
          </div>
          <button type="button" className="reason-toggle" onClick={() => setActiveScenarioId(null)}>
            清除场景
          </button>
        </section>
      )}

      <section className="workspace">
        <aside className="strategy-list">
          <div className="section-title">
            <Activity size={17} />
            策略
          </div>
          {strategies.map((strategy) => (
            <button
              key={strategy.type}
              className={strategy.type === strategyType ? "strategy active" : "strategy"}
              onClick={() => setStrategyType(strategy.type)}
            >
              <strong>{strategy.name}</strong>
              <span>{strategy.description}</span>
            </button>
          ))}
          <div className="showdown-picker">
            <strong>策略对决</strong>
            <span>最多选择 3 个策略加入同场对比。</span>
            {strategies
              .filter((strategy) => strategy.type !== strategyType)
              .map((strategy) => {
                const checked = comparisonTypes.includes(strategy.type);
                const disabled = !checked && comparisonTypes.length >= 3;
                return (
                  <label key={strategy.type} className={disabled ? "compare-choice disabled" : "compare-choice"}>
                    <input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggleComparison(strategy.type)} />
                    <span>{strategy.name}</span>
                  </label>
                );
              })}
          </div>
        </aside>

        <section className={loading ? "center-panel is-loading" : "center-panel"}>
          {loading && (
            <div className="loading-overlay">
              <RefreshCcw size={18} />
              <span>正在刷新回测</span>
            </div>
          )}
          <div className="recommendation">
            <div>
              <p className="muted">{activeAsset?.symbol} · {decision?.date ?? "等待数据"}</p>
              <h2>${metric(decision?.recommendedAmount)}</h2>
              <p className="muted">基础 ${baseAmount} · 倍率 {metric(decision?.multiplier, "x")} · 当前价 ${metric(decision?.price)}</p>
            </div>
            <div className="recommendation-actions">
              <button type="button" className="secondary-action" onClick={() => exportBacktestCsv(result)} disabled={!result}>
                <Download size={16} />
                导出 CSV
              </button>
              <button type="button" className="secondary-action" onClick={runRecommendationOnly} disabled={recommendationLoading || loading}>
                {recommendationLoading ? "刷新中" : "仅刷新建议"}
              </button>
              <div className="score-pill">评分 {metric(decision?.score)}</div>
            </div>
          </div>

          {result?.marketState && (
            <div className={`market-state ${result.marketState.tone}`}>
              <strong>{result.marketState.label}</strong>
              <span>{result.marketState.summary}</span>
              <b>
                SMA50 ${metric(result.marketState.sma50)} · SMA200 ${metric(result.marketState.sma200)} · 距 SMA200 {metric(result.marketState.distanceToSma200Pct, "%")}
              </b>
            </div>
          )}

          <div className="reason-row">
            {visibleReasons.map((reason) => (
              <span key={reason}>{reason}</span>
            ))}
            {reasons.length > 5 && (
              <button type="button" className="reason-toggle" onClick={() => setShowAllReasons((value) => !value)}>
                {showAllReasons ? "收起" : `展开全部 ${reasons.length} 条`}
              </button>
            )}
          </div>

          <div className="metrics-grid">
            <Metric label="总投入" value={`$${metric(result?.metrics.totalInvested)}`} />
            <Metric label="期末价值" value={`$${metric(result?.metrics.endingValue)}`} />
            <Metric label="收益率" value={metric(result?.metrics.returnPct, "%")} />
            <Metric label="资金年化" value={metric(result?.metrics.annualizedReturnPct, "%")} />
            <Metric label="持仓最大回撤" value={metric(result?.metrics.maxDrawdownPct, "%")} />
            <Metric label="相对固定" value={metric(result?.metrics.versusFixedPct, "%")} />
            <Metric label="相对一次性" value={metric(result?.metrics.versusLumpSumPct, "%")} />
            <Metric label="夏普比率" value={metric(result?.metrics.sharpeRatio)} />
            <Metric label="索提诺比率" value={metric(result?.metrics.sortinoRatio)} />
          </div>

          <div className="fixed-metrics">
            <span>固定 DCA 基准</span>
            <b>总投入 ${metric(result?.fixedMetrics?.totalInvested)}</b>
            <b>期末 ${metric(result?.fixedMetrics?.endingValue)}</b>
            <b>收益 {metric(result?.fixedMetrics?.returnPct, "%")}</b>
            <b>回撤 {metric(result?.fixedMetrics?.maxDrawdownPct, "%")}</b>
          </div>
          <div className="fixed-metrics">
            <span>一次性买入基准</span>
            <b>总投入 ${metric(result?.lumpSumMetrics?.totalInvested)}</b>
            <b>期末 ${metric(result?.lumpSumMetrics?.endingValue)}</b>
            <b>收益 {metric(result?.lumpSumMetrics?.returnPct, "%")}</b>
            <b>回撤 {metric(result?.lumpSumMetrics?.maxDrawdownPct, "%")}</b>
          </div>

          {optimizationActive && optimizationJob && (
            <div className="optimization-progress">
              <div className="optimization-progress-head">
                <div>
                  <div className="section-title">
                    <Sparkles size={17} />
                    稳健参数建议计算中
                  </div>
                  <p className="muted">
                    已验证 {optimizationJob.evaluatedCount} / {optimizationJob.totalCount || "-"} 组参数
                    {optimizationJob.currentScenario ? ` · ${optimizationJob.currentScenario}` : ""}
                  </p>
                </div>
                <button type="button" className="secondary-action" onClick={cancelOptimization}>
                  取消
                </button>
              </div>
              <div className="progress-track" aria-label="自动调优进度">
                <span style={{ width: `${Math.max(3, optimizationJob.progress)}%` }} />
              </div>
              <div className="progress-meta">
                <b>{metric(optimizationJob.progress, "%")}</b>
                {optimizationJob.bestSoFar && <span>当前最佳：{describeConfig(optimizationJob.bestSoFar.config)}</span>}
              </div>
            </div>
          )}

          {optimization && (
            <div className="optimization-panel">
              <div className="optimization-head">
                <div>
                  <div className="section-title">
                    <Sparkles size={17} />
                    稳健参数建议
                  </div>
                  <p className="muted">这是基于历史多场景验证的稳健建议，不代表未来保证最优。默认只搜索最低 0.6-0.8x、最高 1.2-1.5x，保持定投纪律。</p>
                </div>
                <button type="button" className="secondary-action" onClick={() => applyOptimizedConfig(optimization.recommendedConfig)}>
                  应用推荐参数
                </button>
              </div>
              <div className="optimization-summary">
                <Metric label="推荐稳健分" value={metric(optimization.candidates[0]?.score)} />
                <Metric label="平均年化提升" value={metric(optimization.recommendedSummary.annualizedReturnPct - optimization.baselineSummary.annualizedReturnPct, "%")} />
                <Metric label="平均回撤变化" value={metric(optimization.recommendedSummary.maxDrawdownPct - optimization.baselineSummary.maxDrawdownPct, "%")} />
                <Metric label="搜索组合" value={`${optimization.searchedCount}`} />
              </div>
              <div className="config-preview">
                <span>推荐参数</span>
                <b>{describeConfig(optimization.recommendedConfig)}</b>
              </div>
              <div className="scenario-table">
                <div className="scenario-head">
                  <span>验证场景</span>
                  <span>推荐年化</span>
                  <span>当前年化</span>
                  <span>推荐回撤</span>
                  <span>相对固定</span>
                </div>
                {optimization.scenarios.map((scenario) => (
                  <div className="scenario-row" key={scenario.id}>
                    <span>{scenario.name}</span>
                    <b>{metric(scenario.recommendedMetrics.annualizedReturnPct, "%")}</b>
                    <b>{metric(scenario.baselineMetrics.annualizedReturnPct, "%")}</b>
                    <b>{metric(scenario.recommendedMetrics.maxDrawdownPct, "%")}</b>
                    <b>{metric(scenario.recommendedMetrics.versusFixedPct, "%")}</b>
                  </div>
                ))}
              </div>
              <div className="candidate-table">
                <div className="candidate-head">
                  <span>排名</span>
                  <span>稳健分</span>
                  <span>平均年化</span>
                  <span>平均回撤</span>
                  <span>参数</span>
                  <span>操作</span>
                </div>
                {optimization.candidates.map((candidate) => (
                  <div className="candidate-row" key={`${candidate.rank}-${candidate.score}`}>
                    <span>#{candidate.rank}</span>
                    <b>{metric(candidate.score)}</b>
                    <b>{metric(candidate.summary.annualizedReturnPct, "%")}</b>
                    <b>{metric(candidate.summary.maxDrawdownPct, "%")}</b>
                    <small>{describeConfig(candidate.config)}</small>
                    <button type="button" className="reason-toggle" onClick={() => applyOptimizedConfig(candidate.config)}>
                      应用
                    </button>
                  </div>
                ))}
              </div>
              {optimization.skippedCount > 0 && <p className="muted">已跳过 {optimization.skippedCount} 个超出上限或数据不足的场景/候选。</p>}
            </div>
          )}

          <div className="chart-block">
            <div className="section-title">
              <BarChart3 size={17} />
              价格与买入点
            </div>
            <ReactECharts option={priceOption} style={{ height: 300 }} />
          </div>
          <div className="chart-block">
            <div className="section-title">
              <BarChart3 size={17} />
              投入金额与组合价值
            </div>
            <ReactECharts option={contributionOption} style={{ height: 300 }} />
          </div>
          <div className="chart-block">
            <div className="section-title">
              <BarChart3 size={17} />
              账户回撤对比
            </div>
            <ReactECharts option={drawdownOption} style={{ height: 260 }} />
          </div>
          <div className="chart-block">
            <div className="section-title">
              <BarChart3 size={17} />
              评分与投入倍率
            </div>
            <ReactECharts option={signalOption} style={{ height: 260 }} />
          </div>
          <div className="chart-block">
            <div className="section-title">
              <BarChart3 size={17} />
              策略对决
            </div>
            <ReactECharts option={showdownOption} style={{ height: 300 }} />
            <div className="comparison-table">
              <div className="comparison-head">
                <span>策略</span>
                <span>总投入</span>
                <span>期末价值</span>
                <span>收益率</span>
                <span>最大回撤</span>
                <span>夏普</span>
                <span>索提诺</span>
              </div>
              {comparisonRows.map((item) => (
                <div key={item.strategyType} className="comparison-row">
                  <span>{item.name}</span>
                  <b>${metric(item.metrics.totalInvested)}</b>
                  <b>${metric(item.metrics.endingValue)}</b>
                  <b>{metric(item.metrics.returnPct, "%")}</b>
                  <b>{metric(item.metrics.maxDrawdownPct, "%")}</b>
                  <b>{metric(item.metrics.sharpeRatio)}</b>
                  <b>{metric(item.metrics.sortinoRatio)}</b>
                </div>
              ))}
            </div>
          </div>
        </section>

        <aside className="param-panel">
          <div className="section-title">
            <SlidersHorizontal size={17} />
            参数
          </div>
          {selectedStrategy && <p className="strategy-note">{selectedStrategy.description}</p>}
          <RangeControl label="最低倍率" value={minMultiplier} min={0} max={1} step={0.05} onChange={(value) => { setMinMultiplier(value); markCustom(); }} />
          <RangeControl label="最高倍率" value={maxMultiplier} min={1} max={5} step={0.1} onChange={(value) => { setMaxMultiplier(value); markCustom(); }} />
          {selectedStrategy?.parameters.map((param) => (
            <ParamControl
              key={param.key}
              param={param}
              value={params[param.key] ?? param.default}
              onChange={(value) => { setParams((current) => ({ ...current, [param.key]: value })); markCustom(); }}
            />
          ))}
          <div className="optimizer-card">
            <strong>稳健参数建议</strong>
            <span>跨多个市场阶段搜索更稳定的参数。默认限制为最低 0.6-0.8x、最高 1.2-1.5x，不把功能变成择时交易。</span>
            <button type="button" className="secondary-action" onClick={runOptimization} disabled={optimizationLoading || loading || !selectedStrategy || strategyType === "fixed_dca"}>
              <Sparkles size={15} />
              {strategyType === "fixed_dca" ? "固定定投无需调优" : optimizationActive ? "正在后台计算" : "自动调优"}
            </button>
          </div>
          <div className="signals">
            <strong>当前信号</strong>
            {decision &&
              Object.entries(decision.rawSignals)
                .filter(([key]) => key !== "strategyType")
                .map(([key, value]) => (
                  <div key={key}>
                    <span>{key}</span>
                    <b>{value ?? "-"}</b>
                  </div>
                ))}
          </div>
          {(loading || recommendationLoading || optimizationLoading) && <p className="muted">{optimizationActive ? "调优任务在后台运行，可以继续查看页面。" : "正在刷新策略结果..."}</p>}
          <p className="muted">数据：{dataSource} · {cacheStatus}</p>
        </aside>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function RangeControl({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return (
    <label className="range-control">
      <span>
        {label}
        <b>{value}</b>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function ParamControl({ param, value, onChange }: { param: Param; value: number | string | boolean; onChange: (value: number | string | boolean) => void }) {
  if (param.type === "toggle") {
    return (
      <label className="toggle">
        <span>{param.label}</span>
        <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />
      </label>
    );
  }
  if (param.type === "select") {
    return (
      <label>
        {param.label}
        <select value={String(value)} onChange={(event) => onChange(event.target.value)}>
          {param.options?.map((option) => (
            <option key={String(option.value)} value={String(option.value)}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (param.type === "range") {
    return <RangeControl label={param.label} value={Number(value)} min={param.min ?? 0} max={param.max ?? 100} step={param.step ?? 1} onChange={onChange as (value: number) => void} />;
  }
  return (
    <label>
      {param.label}
      <input type="number" min={param.min} max={param.max} step={param.step ?? 1} value={Number(value)} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
