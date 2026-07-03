import { useMemo, useState } from "react";
import { AlertTriangle, Play, RefreshCcw } from "lucide-react";
import type { MonteCarloResponse, UiError } from "../types";
import { ChartWrapper } from "./ChartWrapper";

const PATH_OPTIONS = [100, 500, 1000, 2000] as const;
type PathCount = (typeof PATH_OPTIONS)[number];

const HORIZON_MIN = 12;
const HORIZON_MAX = 120;
const HORIZON_STEP = 6;
const HORIZON_DEFAULT = 60;
const PATHS_DEFAULT: PathCount = 1000;

interface MonteCarloPanelProps {
  result: MonteCarloResponse | null;
  loading: boolean;
  error: UiError | null;
  onRun: (horizonMonths: number, numPaths: number) => void;
  moneySymbol: string;
  darkMode: boolean;
  yearsLabel: string;
}

function compactCurrency(value: number | null | undefined, symbol: string): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${symbol}${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${symbol}${(value / 1_000).toFixed(1)}k`;
  return `${symbol}${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function fullCurrency(value: number | null | undefined, symbol: string): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${symbol}${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function MonteCarloPanel({
  result,
  loading,
  error,
  onRun,
  moneySymbol,
  darkMode,
  yearsLabel,
}: MonteCarloPanelProps) {
  const [horizon, setHorizon] = useState(HORIZON_DEFAULT);
  const [numPaths, setNumPaths] = useState<PathCount>(PATHS_DEFAULT);

  const horizonYears = (horizon / 12).toFixed(1);
  const slowHint = numPaths >= 2000;

  const handleRun = () => {
    if (loading) return;
    onRun(horizon, numPaths);
  };

  const chartOption = useMemo(() => buildChartOption(result, darkMode), [result, darkMode]);

  return (
    <div className="monte-carlo-panel">
      <div className="monte-carlo-head">
        <div>
          <div className="section-title">
            <RefreshCcw size={17} />
            未来推演（蒙特卡洛模拟）
          </div>
          <p className="muted">
            基于过去 {yearsLabel} 的波动率，模拟未来 {horizon} 个月（约 {horizonYears} 年）的可能路径分布。
          </p>
        </div>
      </div>

      <div className="monte-carlo-controls">
        <label className="monte-carlo-slider">
          <span className="monte-carlo-slider__label">
            推演时长
            <b>{horizon} 月</b>
            <span className="monte-carlo-slider__hint">≈ {horizonYears} 年</span>
          </span>
          <input
            type="range"
            min={HORIZON_MIN}
            max={HORIZON_MAX}
            step={HORIZON_STEP}
            value={horizon}
            disabled={loading}
            onChange={(event) => setHorizon(Number(event.target.value))}
          />
        </label>

        <label className="monte-carlo-select">
          <span>路径数</span>
          <select value={numPaths} disabled={loading} onChange={(event) => setNumPaths(Number(event.target.value) as PathCount)}>
            {PATH_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt} 条
              </option>
            ))}
          </select>
          {slowHint && <span className="monte-carlo-slow-hint">计算较慢</span>}
        </label>

        <button
          type="button"
          className="secondary-action"
          onClick={handleRun}
          disabled={loading}
        >
          <Play size={15} />
          {loading ? "推演中…" : "开始推演"}
        </button>
      </div>

      {loading && !result && (
        <div className="chart-placeholder monte-carlo-skeleton" style={{ height: 380 }}>
          <RefreshCcw size={18} />
          <span>正在生成 {numPaths} 条路径，约 {numPaths >= 2000 ? "25" : "8"} 秒…</span>
        </div>
      )}

      {!loading && !result && !error && (
        <div className="chart-placeholder" style={{ height: 220 }}>
          尚未推演。设置时长与路径数后点击「开始推演」。
        </div>
      )}

      {error && !result && (
        <div className="error-banner">
          <span>{error.message}</span>
          <button type="button" className="secondary-action" onClick={handleRun}>重试</button>
        </div>
      )}

      {result && (
        <div className="monte-carlo-body">
          <div className="monte-carlo-chart">
            <ChartWrapper option={chartOption} height={380} />
          </div>

          <aside className="monte-carlo-stats">
            <div className="monte-carlo-stat">
              <span className="monte-carlo-stat__label">策略中位数终值</span>
              <span className="monte-carlo-stat__value">{fullCurrency(result.strategy.p50, moneySymbol)}</span>
              <span className="monte-carlo-stat__sub">
                5-95 分位区间 {compactCurrency(result.strategy.p5, moneySymbol)} – {compactCurrency(result.strategy.p95, moneySymbol)}
              </span>
            </div>

            <div className="monte-carlo-stat">
              <span className="monte-carlo-stat__label">固定定投中位数</span>
              <span className="monte-carlo-stat__value muted-value">{fullCurrency(result.fixedDca.p50, moneySymbol)}</span>
              <span className="monte-carlo-stat__sub">
                5-95 分位区间 {compactCurrency(result.fixedDca.p5, moneySymbol)} – {compactCurrency(result.fixedDca.p95, moneySymbol)}
              </span>
            </div>

            <div
              className="monte-carlo-stat monte-carlo-stat--highlight"
              title={`在 ${result.numPaths} 条模拟路径中，约 ${Math.round(result.beatFixedDcaProbability * result.numPaths)} 条策略终值高于固定定投。`}
            >
              <span className="monte-carlo-stat__label">策略战胜固定定投的概率</span>
              <span className="monte-carlo-stat__big">{Math.round(result.beatFixedDcaProbability * 100)}%</span>
              <span className="monte-carlo-stat__sub">
                基于 {result.numPaths} 条路径
              </span>
            </div>

            <div className="monte-carlo-stat monte-carlo-stat--fit">
              <span className="monte-carlo-stat__label">拟合参数</span>
              <span className="monte-carlo-stat__sub">
                年化 μ {(result.fittedParams.muAnnualized * 100).toFixed(1)}% / σ {(result.fittedParams.sigmaAnnualized * 100).toFixed(1)}%
              </span>
              <span className="monte-carlo-stat__sub">
                起点 {moneySymbol}{result.fittedParams.startPrice.toFixed(2)} · 样本 {result.fittedParams.sampleSize} 日
              </span>
            </div>
          </aside>
        </div>
      )}

      <p className="monte-carlo-disclaimer">
        <AlertTriangle size={13} />
        <span>
          基于历史波动率的概率分布，不是预测。真实市场存在肥尾、波动率聚集和 regime 切换，实际结果可能显著偏离此分布。过去的波动率不代表未来。
        </span>
      </p>
    </div>
  );
}

function buildChartOption(result: MonteCarloResponse | null, darkMode: boolean) {
  if (!result) return {};
  const { chart } = result;
  const months = chart.months;
  const xLabels = months.map((m) => `${m}月`);

  const textColor = darkMode ? "#8b95a5" : "#6b7689";
  const legendColor = darkMode ? "#e8eaed" : "#1a1f2e";
  const gridLine = darkMode ? "#1c2530" : "#e8ecf0";
  const axisLine = darkMode ? "#243044" : "#d1d9e6";
  const tooltipBg = darkMode ? "#11161e" : "#ffffff";
  const tooltipBorder = darkMode ? "#243044" : "#e8ecf0";
  const tooltipText = darkMode ? "#e8eaed" : "#1a1f2e";

  const accent = "#f0b232";
  const accentBand5_95 = darkMode ? "rgba(240, 178, 50, 0.10)" : "rgba(200, 135, 10, 0.10)";
  const accentBand25_75 = darkMode ? "rgba(240, 178, 50, 0.22)" : "rgba(200, 135, 10, 0.22)";
  const fixedColor = "#8b95a5";
  const lumpSumColor = "#ef5350";

  // ECharts stack trick: stack lower band first, then a transparent
  // band of width (upper - lower) so the visible lower fill spans the
  // 5-95 range and the upper fill draws the 25-75 range on top.
  const band5_95Lower = chart.strategyBand5_95.lower;
  const band5_95Gap = chart.strategyBand5_95.upper.map((u, i) => u - band5_95Lower[i]);
  const band25_75Lower = chart.strategyBand25_75.lower;
  const band25_75Gap = chart.strategyBand25_75.upper.map((u, i) => u - band25_75Lower[i]);

  return {
    tooltip: {
      trigger: "axis",
      backgroundColor: tooltipBg,
      borderColor: tooltipBorder,
      textStyle: { color: tooltipText, fontFamily: "JetBrains Mono, monospace" },
      axisPointer: { type: "cross", label: { backgroundColor: tooltipBorder, color: tooltipText } },
      formatter: (params: Array<{ axisValue: string; seriesName: string; value: number | number[]; dataIndex: number }>) => {
        if (!params.length) return "";
        const idx = params[0].dataIndex;
        const lines = [`${params[0].axisValue}`];
        const p5 = chart.strategyBand5_95.lower[idx];
        const p95 = chart.strategyBand5_95.upper[idx];
        const p25 = chart.strategyBand25_75.lower[idx];
        const p75 = chart.strategyBand25_75.upper[idx];
        const p50 = chart.strategyMedian[idx];
        const fd = chart.fixedDcaMedian[idx];
        const ls = chart.lumpSumMedian[idx];
        lines.push(`策略中位 ${formatMoney(p50)}`);
        lines.push(`25-75 区间 ${formatMoney(p25)} – ${formatMoney(p75)}`);
        lines.push(`5-95 区间 ${formatMoney(p5)} – ${formatMoney(p95)}`);
        lines.push(`固定定投 ${formatMoney(fd)}`);
        lines.push(`一次性 ${formatMoney(ls)}`);
        return lines.join("<br/>");
      },
    },
    legend: {
      top: 0,
      textStyle: { color: legendColor, fontSize: 11 },
      data: ["策略中位数", "5-95 分位", "25-75 分位", "固定定投中位数", "一次性买入"],
    },
    grid: { left: 64, right: 18, top: 36, bottom: 32 },
    xAxis: {
      type: "category",
      data: xLabels,
      axisLabel: { color: textColor, fontSize: 11 },
      axisLine: { lineStyle: { color: axisLine } },
      axisTick: { lineStyle: { color: axisLine } },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      axisLabel: {
        color: textColor,
        fontSize: 11,
        formatter: (value: number) => formatMoney(value),
      },
      axisLine: { lineStyle: { color: axisLine } },
      axisTick: { lineStyle: { color: axisLine } },
      splitLine: { lineStyle: { color: gridLine } },
    },
    series: [
      // 5-95 band: stack a hidden lower baseline + the gap as visible fill.
      // Both share the same name so the legend toggles them together; the
      // baseline is excluded from legend.data so only one entry shows.
      {
        name: "5-95 分位",
        type: "line",
        stack: "band-5-95",
        symbol: "none",
        data: band5_95Lower,
        lineStyle: { width: 0, opacity: 0 },
        areaStyle: { color: "transparent" },
        tooltip: { show: false },
        silent: true,
        z: 1,
      },
      {
        name: "5-95 分位",
        type: "line",
        stack: "band-5-95",
        symbol: "none",
        data: band5_95Gap,
        areaStyle: { color: accentBand5_95 },
        lineStyle: { width: 0, opacity: 0 },
        z: 2,
      },
      // 25-75 band: same stack trick on a separate stack
      {
        name: "25-75 分位",
        type: "line",
        stack: "band-25-75",
        symbol: "none",
        data: band25_75Lower,
        lineStyle: { width: 0, opacity: 0 },
        areaStyle: { color: "transparent" },
        tooltip: { show: false },
        silent: true,
        z: 3,
      },
      {
        name: "25-75 分位",
        type: "line",
        stack: "band-25-75",
        symbol: "none",
        data: band25_75Gap,
        areaStyle: { color: accentBand25_75 },
        lineStyle: { width: 0, opacity: 0 },
        z: 4,
      },
      // Strategy median (thick accent line)
      {
        name: "策略中位数",
        type: "line",
        symbol: "none",
        data: chart.strategyMedian,
        lineStyle: { color: accent, width: 2.5 },
        z: 6,
      },
      // Fixed DCA median (dashed gray)
      {
        name: "固定定投中位数",
        type: "line",
        symbol: "none",
        data: chart.fixedDcaMedian,
        lineStyle: { color: fixedColor, width: 1.5, type: "dashed" },
        z: 5,
      },
      // Lump sum median (dotted red)
      {
        name: "一次性买入",
        type: "line",
        symbol: "none",
        data: chart.lumpSumMedian,
        lineStyle: { color: lumpSumColor, width: 1.5, type: "dotted" },
        z: 5,
      },
    ],
  };
}

function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
