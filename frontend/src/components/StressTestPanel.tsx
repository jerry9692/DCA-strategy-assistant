import { useMemo, useState } from "react";
import { AlertTriangle, Play, TrendingDown } from "lucide-react";
import type { StressTestResponse, UiError } from "../types";
import { ChartWrapper } from "./ChartWrapper";

const SHAPES: { value: string; label: string }[] = [
  { value: "v_shape", label: "V 型反转" },
  { value: "one_time", label: "一次性跳变" },
  { value: "gradual", label: "线性渐变" },
];

const HORIZONS = [1, 3, 6, 12] as const;

const CHANGE_MIN = -60;
const CHANGE_MAX = 60;
const CHANGE_STEP = 5;
const CHANGE_DEFAULT = -20;
const HORIZON_DEFAULT = 3;

interface StressTestPanelProps {
  result: StressTestResponse | null;
  loading: boolean;
  error: UiError | null;
  onRun: (shape: string, totalChangePct: number, horizonMonths: number) => void;
  moneySymbol: string;
  darkMode: boolean;
}

function money(value: number | null | undefined, symbol: string): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${symbol}${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function pct(value: number | null | undefined, suffix = "%"): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${value.toFixed(1)}${suffix}`;
}

export function StressTestPanel({
  result,
  loading,
  error,
  onRun,
  moneySymbol,
  darkMode,
}: StressTestPanelProps) {
  const [shape, setShape] = useState(SHAPES[0].value);
  const [totalChangePct, setTotalChangePct] = useState(CHANGE_DEFAULT);
  const [horizonMonths, setHorizonMonths] = useState<number>(HORIZON_DEFAULT);

  const handleRun = () => {
    if (loading) return;
    onRun(shape, totalChangePct, horizonMonths);
  };

  const chartOption = useMemo(
    () => buildChartOption(result, darkMode, moneySymbol),
    [result, darkMode, moneySymbol],
  );

  // Join strategy + fixed DCA events by date for the detail table.
  const detailRows = useMemo(() => {
    if (!result) return [];
    const fixedByDate = new Map(result.fixedDcaContributions.map((e) => [e.date, e]));
    return result.strategyContributions
      .filter((e) => e.amount > 0)
      .map((e) => ({
        date: e.date,
        price: e.price,
        strategyAmount: e.amount,
        multiplier: e.multiplier,
        score: e.score,
        fixedAmount: fixedByDate.get(e.date)?.amount ?? null,
      }));
  }, [result]);

  const isDrop = totalChangePct < 0;
  const changeLabel = `${totalChangePct > 0 ? "+" : ""}${totalChangePct}%`;
  const shapeLabel = SHAPES.find((s) => s.value === shape)?.label ?? shape;
  const horizonLabel = `${horizonMonths} 月`;

  return (
    <div className="stress-test-panel">
      <div className="stress-test-head">
        <div className="section-title">
          <TrendingDown size={17} />
          压力测试（What-if）
        </div>
        <p className="muted">
          假设未来 {horizonLabel} 价格{isDrop ? "下跌" : "上涨"} {Math.abs(totalChangePct)}%（{shapeLabel}），推演策略的买入决策和最大浮亏。
        </p>
      </div>

      <div className="stress-test-controls">
        <label className="stress-test-field">
          <span>场景形状</span>
          <select value={shape} disabled={loading} onChange={(e) => setShape(e.target.value)}>
            {SHAPES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>

        <label className="stress-test-slider">
          <span className="stress-test-slider__label">
            总变动
            <b className={isDrop ? "stress-test-loss" : "stress-test-gain"}>{changeLabel}</b>
          </span>
          <input
            type="range"
            min={CHANGE_MIN}
            max={CHANGE_MAX}
            step={CHANGE_STEP}
            value={totalChangePct}
            disabled={loading}
            onChange={(e) => setTotalChangePct(Number(e.target.value))}
          />
        </label>

        <label className="stress-test-field">
          <span>时长</span>
          <select
            value={horizonMonths}
            disabled={loading}
            onChange={(e) => setHorizonMonths(Number(e.target.value))}
          >
            {HORIZONS.map((h) => (
              <option key={h} value={h}>{h} 月</option>
            ))}
          </select>
        </label>

        <button type="button" className="secondary-action" onClick={handleRun} disabled={loading}>
          <Play size={15} />
          {loading ? "推演中…" : "开始推演"}
        </button>
      </div>

      {loading && !result && (
        <div className="chart-placeholder stress-test-skeleton" style={{ height: 220 }}>
          <TrendingDown size={18} />
          <span>正在生成压力测试场景…</span>
        </div>
      )}

      {!loading && !result && !error && (
        <div className="chart-placeholder" style={{ height: 180 }}>
          尚未推演。设置场景形状、变动幅度和时长后点击「开始推演」。
        </div>
      )}

      {error && !result && (
        <div className="error-banner">
          <span>{error.message}</span>
          <button type="button" className="secondary-action" onClick={handleRun}>重试</button>
        </div>
      )}

      {result && (
        <div className="stress-test-body">
          <div className="stress-test-metrics">
            <div className="stress-test-metric stress-test-metric--loss" title="未来段组合价值最低点距已投入本金的缺口。">
              <span className="stress-test-metric__label">最大浮亏</span>
              <span className="stress-test-metric__value stress-test-loss">
                {pct(result.strategyMetrics.maxFloatingLossPct)}
              </span>
              <span className="stress-test-metric__sub">
                固定定投 {pct(result.fixedDcaMetrics.maxFloatingLossPct)}
              </span>
            </div>

            <div className="stress-test-metric">
              <span className="stress-test-metric__label">策略期末值</span>
              <span className={`stress-test-metric__value ${result.strategyMetrics.returnPct < 0 ? "stress-test-loss" : "stress-test-gain"}`}>
                {money(result.strategyMetrics.endingValue, moneySymbol)}
              </span>
              <span className="stress-test-metric__sub">
                收益 {pct(result.strategyMetrics.returnPct)} · {result.strategyMetrics.buyCount} 笔
              </span>
            </div>

            <div className="stress-test-metric">
              <span className="stress-test-metric__label">固定定投期末值</span>
              <span className={`stress-test-metric__value stress-test-metric__value--dim ${result.fixedDcaMetrics.returnPct < 0 ? "stress-test-loss" : "stress-test-gain"}`}>
                {money(result.fixedDcaMetrics.endingValue, moneySymbol)}
              </span>
              <span className="stress-test-metric__sub">
                收益 {pct(result.fixedDcaMetrics.returnPct)}
              </span>
            </div>

            <div className="stress-test-metric">
              <span className="stress-test-metric__label">一次性买入期末值</span>
              <span className={`stress-test-metric__value ${result.lumpSumMetrics.returnPct < 0 ? "stress-test-loss" : "stress-test-gain"}`}>
                {money(result.lumpSumMetrics.endingValue, moneySymbol)}
              </span>
              <span className="stress-test-metric__sub">
                收益 {pct(result.lumpSumMetrics.returnPct)}
              </span>
            </div>

            <div className="stress-test-metric">
              <span className="stress-test-metric__label">价格区间</span>
              <span className="stress-test-metric__value">
                {money(result.startPrice, moneySymbol)} → {money(result.endPrice, moneySymbol)}
              </span>
              <span className="stress-test-metric__sub">
                最低 {money(result.minPrice, moneySymbol)}
              </span>
            </div>
          </div>

          <div className="stress-test-chart">
            <ChartWrapper option={chartOption} height={320} />
          </div>

          {detailRows.length > 0 && (
            <div className="stress-test-detail">
              <div className="stress-test-detail__title">未来买入明细</div>
              <table className="stress-test-table">
                <thead>
                  <tr>
                    <th scope="col">日期</th>
                    <th scope="col">价格</th>
                    <th scope="col">策略金额</th>
                    <th scope="col">倍率</th>
                    <th scope="col">评分</th>
                    <th scope="col">固定定投</th>
                  </tr>
                </thead>
                <tbody>
                  {detailRows.map((row, idx) => (
                    <tr key={`${row.date}-${idx}`}>
                      <td>{row.date}</td>
                      <td>{money(row.price, moneySymbol)}</td>
                      <td>{money(row.strategyAmount, moneySymbol)}</td>
                      <td>{row.multiplier.toFixed(2)}x</td>
                      <td>{row.score.toFixed(2)}</td>
                      <td className="muted-value">{row.fixedAmount !== null ? money(row.fixedAmount, moneySymbol) : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <p className="stress-test-disclaimer">
        <AlertTriangle size={13} />
        <span>{result?.disclaimer ?? "假设场景推演，不是预测。真实市场的暴跌形状、持续时间和反弹节奏会显著偏离此模型。过去的表现不代表未来回报。"}</span>
      </p>
    </div>
  );
}

function buildChartOption(
  result: StressTestResponse | null,
  darkMode: boolean,
  moneySymbol: string,
) {
  if (!result) return {};

  const textColor = darkMode ? "#8b95a5" : "#6b7689";
  const legendColor = darkMode ? "#e8eaed" : "#1a1f2e";
  const gridLine = darkMode ? "#1c2530" : "#e8ecf0";
  const axisLine = darkMode ? "#243044" : "#d1d9e6";
  const tooltipBg = darkMode ? "#11161e" : "#ffffff";
  const tooltipBorder = darkMode ? "#243044" : "#e8ecf0";
  const tooltipText = darkMode ? "#e8eaed" : "#1a1f2e";

  const priceColor = darkMode ? "#5a6478" : "#b0b8c8";
  const strategyColor = "#f0b232";
  const fixedColor = "#8b95a5";
  const lumpColor = "#ef5350";

  const fmt = (v: number | null | undefined) => money(v, moneySymbol);

  // Build daily mark-to-market equity curves. For every future date
  // we walk forward through the buy events, accumulating shares and
  // invested amount, and multiply cumulative shares by that day's
  // close. This produces a smooth equity curve that reflects daily
  // price movement between buys (unlike a sparse event-step line
  // which is flat between buy points and hides the drawdown the
  // maxFloatingLossPct metric is computed from).
  const futureDates = result.futurePriceSeries.map((p) => p.date);
  const futurePrices = result.futurePriceSeries.map((p) => p.close);
  const buildEquityCurve = (events: { date: string; totalShares: number; amount: number; totalInvested: number }[]) => {
    const buyEvents = events
      .filter((e) => e.amount > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    let buyIdx = 0;
    let cumulativeShares = 0;
    return futureDates.map((d, i) => {
      while (buyIdx < buyEvents.length && buyEvents[buyIdx].date <= d) {
        cumulativeShares = buyEvents[buyIdx].totalShares;
        buyIdx += 1;
      }
      if (cumulativeShares <= 0) return null;
      return Number((cumulativeShares * futurePrices[i]).toFixed(2));
    });
  };

  const strategyValues = buildEquityCurve(result.strategyContributions);
  const fixedValues = buildEquityCurve(result.fixedDcaContributions);
  const lumpValues = buildEquityCurve(result.lumpSumContributions);

  return {
    tooltip: {
      trigger: "axis",
      backgroundColor: tooltipBg,
      borderColor: tooltipBorder,
      textStyle: { color: tooltipText, fontFamily: "JetBrains Mono, monospace" },
      axisPointer: { type: "cross", label: { backgroundColor: tooltipBorder, color: tooltipText } },
      formatter: (params: Array<{ axisValue: string; seriesName: string; value: number | null; dataIndex: number }>) => {
        if (!params.length) return "";
        const idx = params[0].dataIndex;
        const lines = [futureDates[idx]];
        const priceLine = futurePrices[idx];
        if (priceLine !== null && priceLine !== undefined) lines.push(`价格 ${fmt(priceLine)}`);
        const findVal = (name: string) => params.find((p) => p.seriesName === name)?.value;
        const sv = findVal("策略组合");
        if (sv !== null && sv !== undefined) lines.push(`策略 ${fmt(sv)}`);
        const fv = findVal("固定定投");
        if (fv !== null && fv !== undefined) lines.push(`固定定投 ${fmt(fv)}`);
        const lv = findVal("一次性买入");
        if (lv !== null && lv !== undefined) lines.push(`一次性 ${fmt(lv)}`);
        return lines.join("<br/>");
      },
    },
    legend: {
      top: 0,
      textStyle: { color: legendColor, fontSize: 11 },
      data: [
        { name: "价格", itemStyle: { color: priceColor } },
        { name: "策略组合", itemStyle: { color: strategyColor } },
        { name: "固定定投", itemStyle: { color: fixedColor } },
        { name: "一次性买入", itemStyle: { color: lumpColor } },
      ],
    },
    grid: { left: 72, right: 56, top: 36, bottom: 32 },
    xAxis: {
      type: "category",
      data: futureDates,
      axisLabel: { color: textColor, fontSize: 10, formatter: (v: string) => v.slice(5) },
      axisLine: { lineStyle: { color: axisLine } },
      axisTick: { lineStyle: { color: axisLine } },
      splitLine: { show: false },
      boundaryGap: false,
    },
    yAxis: [
      {
        type: "value",
        position: "left",
        axisLabel: {
          color: textColor,
          fontSize: 11,
          formatter: (value: number) => fmt(value),
        },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: gridLine } },
        scale: true,
      },
      {
        type: "value",
        position: "right",
        axisLabel: {
          color: priceColor,
          fontSize: 10,
          formatter: (value: number) => fmt(value),
        },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        scale: true,
      },
    ],
    series: [
      {
        name: "价格",
        type: "line",
        yAxisIndex: 1,
        symbol: "none",
        data: futurePrices,
        lineStyle: { color: priceColor, width: 1.5, type: "dashed" },
        itemStyle: { color: priceColor },
        z: 1,
      },
      {
        name: "一次性买入",
        type: "line",
        symbol: "none",
        data: lumpValues,
        lineStyle: { color: lumpColor, width: 1.5, type: "dotted" },
        itemStyle: { color: lumpColor },
        z: 2,
      },
      {
        name: "固定定投",
        type: "line",
        symbol: "none",
        data: fixedValues,
        lineStyle: { color: fixedColor, width: 1.5, type: "dashed" },
        itemStyle: { color: fixedColor },
        z: 3,
      },
      {
        name: "策略组合",
        type: "line",
        symbol: "none",
        data: strategyValues,
        lineStyle: { color: strategyColor, width: 2.5 },
        itemStyle: { color: strategyColor },
        z: 4,
      },
    ],
  };
}
