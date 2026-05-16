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
type UiError = { message: string; code?: string; retryable: boolean };

const api = "";
const today = new Date();
const fiveYearsAgo = new Date(today);
fiveYearsAgo.setFullYear(today.getFullYear() - 5);

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

function metric(value: number | null | undefined, suffix = "") {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
}

function drawdownSeries(events: Contribution[]) {
  let peak = 0;
  return events.map((event) => {
    peak = Math.max(peak, event.portfolioValue);
    return peak > 0 ? Number(((event.portfolioValue / peak - 1) * 100).toFixed(2)) : 0;
  });
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
  const [assets, setAssets] = useState<Asset[]>([]);
  const [strategies, setStrategies] = useState<StrategyDef[]>([]);
  const [symbol, setSymbol] = useState("QQQ");
  const [strategyType, setStrategyType] = useState("composite_score");
  const [baseAmount, setBaseAmount] = useState(100);
  const [frequency, setFrequency] = useState<"weekly" | "monthly">("weekly");
  const [minMultiplier, setMinMultiplier] = useState(0.2);
  const [maxMultiplier, setMaxMultiplier] = useState(2.5);
  const [startDate, setStartDate] = useState(isoDate(fiveYearsAgo));
  const [endDate, setEndDate] = useState(isoDate(today));
  const [params, setParams] = useState<Record<string, number | string | boolean>>({});
  const [result, setResult] = useState<Backtest | null>(null);
  const [quickDecision, setQuickDecision] = useState<Decision | null>(null);
  const [quickData, setQuickData] = useState<{ dataSource: string; cacheStatus: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [recommendationLoading, setRecommendationLoading] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [showAllReasons, setShowAllReasons] = useState(false);
  const [comparisonStrategyTypes, setComparisonStrategyTypes] = useState<string[]>(["drawdown_boost", "ma_deviation"]);

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
        const composite = strategyData.strategies.find((item: StrategyDef) => item.type === "composite_score");
        setParams(defaultsFor(composite));
      })
      .catch((err) => setError(toUiError(err)));
  }, []);

  useEffect(() => {
    setParams(defaultsFor(selectedStrategy));
    setComparisonStrategyTypes((current) => current.filter((item) => item !== strategyType));
  }, [strategyType]);

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
  }, [symbol, startDate, endDate, config, selectedStrategy, refreshNonce, comparisonStrategyTypes]);

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
      yAxis: { type: "value", axisLabel: { color: "#64748b", formatter: "{value}%" } },
      series: [
        {
          name: "本策略回撤",
          type: "line",
          showSymbol: false,
          data: drawdownSeries(result?.contributions ?? []),
          areaStyle: { color: "rgba(124, 58, 237, 0.08)" },
          lineStyle: { color: "#7c3aed", width: 2 }
        },
        {
          name: "固定DCA回撤",
          type: "line",
          showSymbol: false,
          data: drawdownSeries(result?.fixedContributions ?? []),
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
          <h1>定投策略工作台</h1>
        </div>
        <button className={loading ? "icon-button spinning" : "icon-button"} onClick={() => setRefreshNonce((value) => value + 1)} title="刷新回测" disabled={loading}>
          <RefreshCcw size={18} />
        </button>
      </header>

      <section className="control-strip">
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
          <input type="number" min={1} step={10} value={baseAmount} onChange={(event) => setBaseAmount(Number(event.target.value))} />
        </label>
        <label>
          频率
          <select value={frequency} onChange={(event) => setFrequency(event.target.value as "weekly" | "monthly")}>
            <option value="weekly">每周</option>
            <option value="monthly">每月</option>
          </select>
        </label>
        <label>
          开始
          <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
        </label>
        <label>
          结束
          <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
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
          <RangeControl label="最低倍率" value={minMultiplier} min={0} max={1} step={0.05} onChange={setMinMultiplier} />
          <RangeControl label="最高倍率" value={maxMultiplier} min={1} max={5} step={0.1} onChange={setMaxMultiplier} />
          {selectedStrategy?.parameters.map((param) => (
            <ParamControl
              key={param.key}
              param={param}
              value={params[param.key] ?? param.default}
              onChange={(value) => setParams((current) => ({ ...current, [param.key]: value }))}
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
