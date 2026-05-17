import React, { Component, type ErrorInfo, type ReactNode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactECharts from "echarts-for-react";
import { Activity, BarChart3, RefreshCcw, SlidersHorizontal } from "lucide-react";
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
type TodaySignal = {
  symbol: string;
  name: string;
  decision?: Decision;
  marketState?: MarketState | null;
  dataSource?: string;
  cacheStatus?: string;
  error?: string;
};
type UiError = { message: string; code?: string; retryable: boolean };
type PresetMode = "conservative" | "balanced" | "aggressive" | "custom";
type ViewMode = "signals" | "backtest";

const api = "";
const SETTINGS_KEY = "dca-assistant-settings-v2";
const today = new Date();
const fiveYearsAgo = new Date(today);
fiveYearsAgo.setFullYear(today.getFullYear() - 5);

const PARAMETER_PRESETS: Record<Exclude<PresetMode, "custom">, { label: string; minMultiplier: number; maxMultiplier: number }> = {
  conservative: { label: "保守", minMultiplier: 0.6, maxMultiplier: 1.5 },
  balanced: { label: "均衡", minMultiplier: 0.2, maxMultiplier: 2.5 },
  aggressive: { label: "激进", minMultiplier: 0.1, maxMultiplier: 4 }
};

const CRISIS_SCENARIOS = [
  {
    id: "covid_2020",
    name: "2020 熔断冲击",
    startDate: "2020-02-18",
    endDate: "2020-05-29",
    summary: "检验策略在急跌和快速反弹中的加码节奏。"
  },
  {
    id: "rate_hike_2022",
    name: "2022 加息杀估值",
    startDate: "2022-01-03",
    endDate: "2022-12-30",
    summary: "检验策略在长时间下跌和震荡中的资金消耗。"
  },
  {
    id: "ai_rebound_2023",
    name: "2023 科技股修复",
    startDate: "2023-01-03",
    endDate: "2023-08-31",
    summary: "观察策略在持续修复行情中是否过早降档。"
  }
];

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
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

function metric(value: number | null | undefined, suffix = "") {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
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
  const [viewMode, setViewMode] = useState<ViewMode>((savedSettings?.viewMode as ViewMode) ?? "signals");
  const [symbol, setSymbol] = useState(String(savedSettings?.symbol ?? "QQQ"));
  const [strategyType, setStrategyType] = useState(String(savedSettings?.strategyType ?? "composite_score"));
  const [baseAmount, setBaseAmount] = useState(Number(savedSettings?.baseAmount ?? 100));
  const [frequency, setFrequency] = useState<"weekly" | "monthly">((savedSettings?.frequency as "weekly" | "monthly") ?? "weekly");
  const [minMultiplier, setMinMultiplier] = useState(Number(savedSettings?.minMultiplier ?? 0.2));
  const [maxMultiplier, setMaxMultiplier] = useState(Number(savedSettings?.maxMultiplier ?? 2.5));
  const [startDate, setStartDate] = useState(String(savedSettings?.startDate ?? isoDate(fiveYearsAgo)));
  const [endDate, setEndDate] = useState(String(savedSettings?.endDate ?? isoDate(today)));
  const [params, setParams] = useState<Record<string, number | string | boolean>>({});
  const [result, setResult] = useState<Backtest | null>(null);
  const [todaySignals, setTodaySignals] = useState<TodaySignal[]>([]);
  const [quickDecision, setQuickDecision] = useState<Decision | null>(null);
  const [quickData, setQuickData] = useState<{ dataSource: string; cacheStatus: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [signalsLoading, setSignalsLoading] = useState(false);
  const [recommendationLoading, setRecommendationLoading] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [showAllReasons, setShowAllReasons] = useState(false);
  const [presetMode, setPresetMode] = useState<PresetMode>((savedSettings?.presetMode as PresetMode) ?? "balanced");
  const [activeScenarioId, setActiveScenarioId] = useState<string | null>(String(savedSettings?.activeScenarioId ?? "") || null);
  const [comparisonStrategyTypes, setComparisonStrategyTypes] = useState<string[]>(
    Array.isArray(savedSettings?.comparisonStrategyTypes) ? savedSettings.comparisonStrategyTypes : ["drawdown_boost", "ma_deviation"]
  );

  const selectedStrategy = useMemo(() => strategies.find((item) => item.type === strategyType), [strategies, strategyType]);
  const config = useMemo(
    () => ({
      strategyType,
      baseAmount,
      frequency,
      minMultiplier,
      maxMultiplier,
      params
    }),
    [strategyType, baseAmount, frequency, minMultiplier, maxMultiplier, params]
  );

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
    if (!selectedStrategy || Object.keys(params).length === 0) return;
    window.localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        viewMode,
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
        comparisonStrategyTypes
      })
    );
  }, [activeScenarioId, baseAmount, comparisonStrategyTypes, endDate, frequency, maxMultiplier, minMultiplier, params, presetMode, selectedStrategy, startDate, strategyType, symbol, viewMode]);

  useEffect(() => {
    if (!selectedStrategy || viewMode !== "backtest") return;
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
          comparisonStrategyTypes
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
  }, [symbol, startDate, endDate, config, selectedStrategy, refreshNonce, comparisonStrategyTypes, viewMode]);

  useEffect(() => {
    if (!selectedStrategy || viewMode !== "signals") return;
    const handle = window.setTimeout(() => {
      setSignalsLoading(true);
      setError(null);
      fetch(`${api}/api/signals/today`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          asOf: endDate,
          config
        })
      })
        .then(readJson<{ signals: TodaySignal[] }>)
        .then((data) => setTodaySignals(data.signals))
        .catch((err) => setError(toUiError(err)))
        .finally(() => setSignalsLoading(false));
    }, 350);
    return () => window.clearTimeout(handle);
  }, [config, endDate, refreshNonce, selectedStrategy, viewMode]);

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
    const scenario = CRISIS_SCENARIOS.find((item) => item.id === scenarioId);
    if (!scenario) return;
    setActiveScenarioId(scenario.id);
    setStartDate(scenario.startDate);
    setEndDate(scenario.endDate);
    setViewMode("backtest");
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
          name: "本策略回撤",
          type: "line",
          showSymbol: false,
          data: result?.contributions.map((event) => event.drawdownPct) ?? [],
          areaStyle: { color: "rgba(124, 58, 237, 0.08)" },
          lineStyle: { color: "#7c3aed", width: 2 }
        },
        {
          name: "固定DCA回撤",
          type: "line",
          showSymbol: false,
          data: result?.fixedContributions.map((event) => event.drawdownPct) ?? [],
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
          name: selectedStrategy?.name ?? "本策略",
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
    [result, selectedStrategy]
  );

  const comparisonRows = useMemo(
    () => [
      ...(result
        ? [
            {
              strategyType: result.strategyType,
              name: selectedStrategy?.name ?? "本策略",
              metrics: result.metrics
            }
          ]
        : []),
      ...(result?.strategyComparisons.map((item) => ({ strategyType: item.strategyType, name: item.name, metrics: item.metrics })) ?? [])
    ],
    [result, selectedStrategy]
  );

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">DCA Strategy Assistant v0.2</p>
          <h1>{viewMode === "signals" ? "今日信号面板" : "定投策略工作台"}</h1>
        </div>
        <div className="topbar-actions">
          <div className="view-tabs">
            <button type="button" className={viewMode === "signals" ? "active" : ""} onClick={() => setViewMode("signals")}>
              今日信号
            </button>
            <button type="button" className={viewMode === "backtest" ? "active" : ""} onClick={() => setViewMode("backtest")}>
              回测工作台
            </button>
          </div>
          <button className={loading || signalsLoading ? "icon-button spinning" : "icon-button"} onClick={() => setRefreshNonce((value) => value + 1)} title="刷新" disabled={loading || signalsLoading}>
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
        {viewMode === "backtest" && (
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
        )}
        <label>
          基础金额
          <input type="number" min={1} step={10} value={baseAmount} onChange={(event) => { setBaseAmount(Number(event.target.value)); markCustom(); }} />
        </label>
        {viewMode === "backtest" && (
          <>
            <label>
              频率
              <select value={frequency} onChange={(event) => setFrequency(event.target.value as "weekly" | "monthly")}>
                <option value="weekly">每周</option>
                <option value="monthly">每月</option>
              </select>
            </label>
            <label>
              开始
              <input type="date" value={startDate} onChange={(event) => { setStartDate(event.target.value); setActiveScenarioId(null); }} />
            </label>
          </>
        )}
        <label>
          {viewMode === "signals" ? "信号日期" : "结束"}
          <input type="date" value={endDate} onChange={(event) => { setEndDate(event.target.value); setActiveScenarioId(null); }} />
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

      {viewMode === "signals" && (
        <section className="today-dashboard">
          <div className="section-title">
            <Activity size={17} />
            今日信号
          </div>
          <div className="signal-grid">
            {todaySignals.map((item) => (
              <article key={item.symbol} className="signal-card">
                <div className="signal-head">
                  <div>
                    <strong>{item.symbol}</strong>
                    <span>{item.name}</span>
                  </div>
                  <b className={item.marketState ? `state-dot ${item.marketState.tone}` : "state-dot neutral"}>{item.marketState?.label ?? "等待数据"}</b>
                </div>
                {item.error ? (
                  <p className="signal-error">{item.error}</p>
                ) : (
                  <>
                    <div className="signal-amount">
                      <span>建议投入</span>
                      <strong>${metric(item.decision?.recommendedAmount)}</strong>
                    </div>
                    <div className="signal-meta">
                      <span>倍率 {metric(item.decision?.multiplier, "x")}</span>
                      <span>评分 {metric(item.decision?.score)}</span>
                      <span>价格 ${metric(item.decision?.price)}</span>
                    </div>
                    <p>{item.marketState?.summary}</p>
                    <div className="reason-row compact">
                      {item.decision?.reasons.slice(0, 3).map((reason) => (
                        <span key={reason}>{reason}</span>
                      ))}
                    </div>
                  </>
                )}
              </article>
            ))}
            {signalsLoading && (
              <article className="signal-card loading-card">
                <RefreshCcw size={18} />
                <span>正在刷新今日信号</span>
              </article>
            )}
          </div>
        </section>
      )}

      {viewMode === "backtest" && (
        <section className="crisis-strip">
          <div>
            <strong>历史危机回放</strong>
            <span>{CRISIS_SCENARIOS.find((item) => item.id === activeScenarioId)?.summary ?? "选择一个场景，快速切换到对应行情区间验证策略表现。"}</span>
          </div>
          <div className="scenario-buttons">
            {CRISIS_SCENARIOS.map((scenario) => (
              <button type="button" key={scenario.id} className={activeScenarioId === scenario.id ? "active" : ""} onClick={() => applyScenario(scenario.id)}>
                {scenario.name}
              </button>
            ))}
          </div>
        </section>
      )}

      {viewMode === "backtest" && <section className="workspace">
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
                const checked = comparisonStrategyTypes.includes(strategy.type);
                const disabled = !checked && comparisonStrategyTypes.length >= 3;
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
            <Metric label="组合最大回撤" value={metric(result?.metrics.maxDrawdownPct, "%")} />
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
              组合回撤对比
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
          {(loading || recommendationLoading) && <p className="muted">正在刷新策略结果...</p>}
          <p className="muted">数据：{dataSource} · {cacheStatus}</p>
        </aside>
      </section>}
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
