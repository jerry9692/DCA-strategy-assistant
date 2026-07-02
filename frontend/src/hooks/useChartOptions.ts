import { useMemo } from "react";
import type { Backtest, StrategyDef } from "../types";
import { accountDrawdown, pairSeries } from "../utils";

export function useChartOptions(
  result: Backtest | null,
  selectedStrategy: StrategyDef | undefined,
  strategyNameByType: Map<string, string>,
  darkMode: boolean,
) {
  const chartTheme = useMemo(() => {
    const text = darkMode ? "#8b95a5" : "#6b7689";
    const legend = darkMode ? "#e8eaed" : "#1a1f2e";
    const gridLine = darkMode ? "#1c2530" : "#e8ecf0";
    const axisLine = darkMode ? "#243044" : "#d1d9e6";
    return {
      tooltip: {
        trigger: "axis",
        backgroundColor: darkMode ? "#11161e" : "#ffffff",
        borderColor: darkMode ? "#243044" : "#e8ecf0",
        textStyle: { color: darkMode ? "#e8eaed" : "#1a1f2e", fontFamily: "JetBrains Mono, monospace" },
      },
      legend: { top: 0, textStyle: { color: legend, fontSize: 11 } },
      xAxis: {
        type: "time",
        axisLabel: { color: text, fontSize: 11 },
        axisLine: { lineStyle: { color: axisLine } },
        axisTick: { lineStyle: { color: axisLine } },
        splitLine: { lineStyle: { color: gridLine } },
      },
      valueAxis: {
        type: "value",
        axisLabel: { color: text, fontSize: 11 },
        axisLine: { lineStyle: { color: axisLine } },
        axisTick: { lineStyle: { color: axisLine } },
        splitLine: { lineStyle: { color: gridLine } },
      },
    };
  }, [darkMode]);

  // Series color palette — amber gold accent, soft blue for strategy,
  // muted gray for fixed baseline, red for lump sum.
  const C = {
    accent: "#f0b232",      // amber gold — buy points, multiplier, main strategy in showdown
    strategy: "#6ea8fe",    // soft blue — strategy value, score, drawdown
    fixed: "#8b95a5",       // muted gray — fixed DCA baseline
    lumpSum: "#ef5350",     // red — lump sum
    comparison: ["#26d07c", "#6ea8fe", "#f0b232"], // green, blue, gold
  };

  const priceOption = useMemo(
    () => ({
      tooltip: chartTheme.tooltip,
      grid: { left: 64, right: 18, top: 24, bottom: 34 },
      xAxis: chartTheme.xAxis,
      yAxis: { ...chartTheme.valueAxis, scale: true },
      series: [
        {
          name: "价格",
          type: "line",
          showSymbol: false,
          data: result?.priceSeries.map((point) => [point.date, point.close]) ?? [],
          lineStyle: { color: C.strategy, width: 2 },
        },
        {
          name: "买入点",
          type: "scatter",
          data: result?.contributions.filter((event) => event.amount > 0).map((event) => [event.date, event.price]) ?? [],
          symbolSize: 6,
          itemStyle: { color: C.accent },
        },
      ],
    }),
    [chartTheme, result],
  );

  const contributionOption = useMemo(
    () => ({
      tooltip: chartTheme.tooltip,
      legend: chartTheme.legend,
      grid: { left: 64, right: 20, top: 36, bottom: 34 },
      xAxis: chartTheme.xAxis,
      yAxis: [
        { ...chartTheme.valueAxis, name: "组合价值", nameTextStyle: { color: chartTheme.valueAxis.axisLabel.color } },
        { ...chartTheme.valueAxis, name: "投入金额", nameTextStyle: { color: chartTheme.valueAxis.axisLabel.color } },
      ],
      series: [
        { name: "本策略投入", type: "bar", yAxisIndex: 1, data: pairSeries(result?.contributions, (e) => e.amount), itemStyle: { color: C.accent } },
        { name: "固定投入", type: "bar", yAxisIndex: 1, data: pairSeries(result?.fixedContributions, (e) => e.amount), itemStyle: { color: C.fixed, opacity: 0.5 } },
        { name: "本策略价值", type: "line", yAxisIndex: 0, data: pairSeries(result?.contributions, (e) => e.portfolioValue), showSymbol: false, lineStyle: { color: C.strategy, width: 2 } },
        { name: "固定DCA价值", type: "line", yAxisIndex: 0, data: pairSeries(result?.fixedContributions, (e) => e.portfolioValue), showSymbol: false, lineStyle: { color: C.fixed, width: 2, type: "dashed" } },
        { name: "一次性买入", type: "line", yAxisIndex: 0, data: pairSeries(result?.lumpSumContributions, (e) => e.portfolioValue), showSymbol: false, lineStyle: { color: C.lumpSum, width: 2, type: "dotted" } },
      ],
    }),
    [chartTheme, result],
  );

  const drawdownOption = useMemo(
    () => ({
      tooltip: chartTheme.tooltip,
      legend: chartTheme.legend,
      grid: { left: 64, right: 20, top: 36, bottom: 34 },
      xAxis: chartTheme.xAxis,
      yAxis: { ...chartTheme.valueAxis, max: 0 },
      series: [
        {
          name: "本策略账户回撤",
          type: "line",
          showSymbol: false,
          data: pairSeries(result?.contributions, accountDrawdown),
          areaStyle: { color: "rgba(110, 168, 254, 0.08)" },
          lineStyle: { color: C.strategy, width: 2 },
        },
        ...(result?.strategyComparisons?.map((item, index) => ({
          name: `${item.name}账户回撤`,
          type: "line",
          showSymbol: false,
          data: pairSeries(item.contributions, accountDrawdown),
          lineStyle: { color: C.comparison[index % 3], width: 2 },
        })) ?? []),
        {
          name: "固定DCA账户回撤",
          type: "line",
          showSymbol: false,
          data: pairSeries(result?.fixedContributions, accountDrawdown),
          lineStyle: { color: C.fixed, width: 2, type: "dashed" },
        },
      ],
    }),
    [chartTheme, result],
  );

  const signalOption = useMemo(
    () => ({
      tooltip: chartTheme.tooltip,
      legend: chartTheme.legend,
      grid: { left: 64, right: 20, top: 36, bottom: 34 },
      xAxis: chartTheme.xAxis,
      yAxis: [
        { ...chartTheme.valueAxis, min: 0, max: 1 },
        { ...chartTheme.valueAxis, axisLabel: { ...chartTheme.valueAxis.axisLabel, formatter: "{value}x" } },
      ],
      series: [
        {
          name: "策略评分",
          type: "line",
          showSymbol: false,
          data: pairSeries(result?.contributions, (e) => e.score),
          lineStyle: { color: C.strategy, width: 2 },
        },
        {
          name: "投入倍率",
          type: "line",
          yAxisIndex: 1,
          showSymbol: false,
          data: pairSeries(result?.contributions, (e) => e.multiplier),
          lineStyle: { color: C.accent, width: 2 },
        },
      ],
    }),
    [chartTheme, result],
  );

  const rollingWindowYears = result?.rollingPerformance?.[0]?.windowYears ?? null;
  const rollingOption = useMemo(
    () => ({
      tooltip: {
        ...chartTheme.tooltip,
        valueFormatter: (value: number | string | null) => (typeof value === "number" ? `${value.toFixed(2)}%` : "-"),
      },
      legend: chartTheme.legend,
      grid: { left: 64, right: 20, top: 42, bottom: 34 },
      xAxis: chartTheme.xAxis,
      yAxis: { ...chartTheme.valueAxis, axisLabel: { ...chartTheme.valueAxis.axisLabel, formatter: "{value}%" } },
      series: [
        {
          name: "本策略",
          type: "line",
          showSymbol: false,
          data: pairSeries(result?.rollingPerformance, (e) => e.strategyAnnualizedReturnPct),
          lineStyle: { color: C.strategy, width: 2 },
        },
        {
          name: "固定DCA",
          type: "line",
          showSymbol: false,
          data: pairSeries(result?.rollingPerformance, (e) => e.fixedAnnualizedReturnPct),
          lineStyle: { color: C.fixed, width: 2, type: "dashed" },
        },
        {
          name: "一次性买入",
          type: "line",
          showSymbol: false,
          data: pairSeries(result?.rollingPerformance, (e) => e.lumpSumAnnualizedReturnPct),
          lineStyle: { color: C.lumpSum, width: 2, type: "dotted" },
        },
      ],
    }),
    [chartTheme, result],
  );

  const showdownOption = useMemo(
    () => ({
      tooltip: chartTheme.tooltip,
      legend: chartTheme.legend,
      grid: { left: 64, right: 20, top: 42, bottom: 34 },
      xAxis: chartTheme.xAxis,
      yAxis: { ...chartTheme.valueAxis, name: "组合价值", nameTextStyle: { color: chartTheme.valueAxis.axisLabel.color } },
      series: [
        {
          name: result ? strategyNameByType.get(result.strategyType) ?? "本策略" : selectedStrategy?.name ?? "本策略",
          type: "line",
          showSymbol: false,
          data: pairSeries(result?.contributions, (e) => e.portfolioValue),
          lineStyle: { color: C.accent, width: 2 },
        },
        ...(result?.strategyComparisons?.map((item, index) => ({
          name: item.name,
          type: "line",
          showSymbol: false,
          data: pairSeries(item.contributions, (e) => e.portfolioValue),
          lineStyle: { color: C.comparison[index % 3], width: 2 },
        })) ?? []),
        {
          name: "固定DCA",
          type: "line",
          showSymbol: false,
          data: pairSeries(result?.fixedContributions, (e) => e.portfolioValue),
          lineStyle: { color: C.fixed, width: 2, type: "dashed" },
        },
      ],
    }),
    [chartTheme, result, selectedStrategy, strategyNameByType],
  );

  const comparisonRows = useMemo(
    () => [
      ...(result
        ? [{ strategyType: result.strategyType, name: strategyNameByType.get(result.strategyType) ?? "本策略", metrics: result.metrics }]
        : []),
      ...(result?.strategyComparisons?.map((item) => ({ strategyType: item.strategyType, name: item.name, metrics: item.metrics })) ?? []),
    ],
    [result, strategyNameByType],
  );

  return {
    priceOption,
    contributionOption,
    drawdownOption,
    signalOption,
    rollingOption,
    rollingWindowYears,
    showdownOption,
    comparisonRows,
  };
}
