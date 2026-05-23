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
    const text = darkMode ? "#cbd5e1" : "#64748b";
    const legend = darkMode ? "#dbeafe" : "#475569";
    const gridLine = darkMode ? "#243244" : "#e2e8f0";
    const axisLine = darkMode ? "#334155" : "#cbd5e1";
    return {
      tooltip: {
        trigger: "axis",
        backgroundColor: darkMode ? "#0f172a" : "#ffffff",
        borderColor: darkMode ? "#334155" : "#e2e8f0",
        textStyle: { color: darkMode ? "#e5e7eb" : "#334155" },
      },
      legend: { top: 0, textStyle: { color: legend } },
      xAxis: {
        type: "time",
        axisLabel: { color: text },
        axisLine: { lineStyle: { color: axisLine } },
        axisTick: { lineStyle: { color: axisLine } },
        splitLine: { lineStyle: { color: gridLine } },
      },
      valueAxis: {
        type: "value",
        axisLabel: { color: text },
        axisLine: { lineStyle: { color: axisLine } },
        axisTick: { lineStyle: { color: axisLine } },
        splitLine: { lineStyle: { color: gridLine } },
      },
    };
  }, [darkMode]);

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
          lineStyle: { color: "#2563eb", width: 2 },
        },
        {
          name: "买入点",
          type: "scatter",
          data: result?.contributions.filter((event) => event.amount > 0).map((event) => [event.date, event.price]) ?? [],
          symbolSize: 6,
          itemStyle: { color: "#059669" },
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
        { name: "本策略投入", type: "bar", yAxisIndex: 1, data: pairSeries(result?.contributions, (e) => e.amount), itemStyle: { color: "#0f766e" } },
        { name: "固定投入", type: "bar", yAxisIndex: 1, data: pairSeries(result?.fixedContributions, (e) => e.amount), itemStyle: { color: "#94a3b8", opacity: 0.5 } },
        { name: "本策略价值", type: "line", yAxisIndex: 0, data: pairSeries(result?.contributions, (e) => e.portfolioValue), showSymbol: false, lineStyle: { color: "#7c3aed", width: 2 } },
        { name: "固定DCA价值", type: "line", yAxisIndex: 0, data: pairSeries(result?.fixedContributions, (e) => e.portfolioValue), showSymbol: false, lineStyle: { color: "#64748b", width: 2, type: "dashed" } },
        { name: "一次性买入", type: "line", yAxisIndex: 0, data: pairSeries(result?.lumpSumContributions, (e) => e.portfolioValue), showSymbol: false, lineStyle: { color: "#dc2626", width: 2, type: "dotted" } },
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
          areaStyle: { color: "rgba(124, 58, 237, 0.08)" },
          lineStyle: { color: "#7c3aed", width: 2 },
        },
        ...(result?.strategyComparisons?.map((item, index) => ({
          name: `${item.name}账户回撤`,
          type: "line",
          showSymbol: false,
          data: pairSeries(item.contributions, accountDrawdown),
          lineStyle: { color: ["#0f766e", "#2563eb", "#d97706"][index % 3], width: 2 },
        })) ?? []),
        {
          name: "固定DCA账户回撤",
          type: "line",
          showSymbol: false,
          data: pairSeries(result?.fixedContributions, accountDrawdown),
          lineStyle: { color: "#64748b", width: 2, type: "dashed" },
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
          lineStyle: { color: "#2563eb", width: 2 },
        },
        {
          name: "投入倍率",
          type: "line",
          yAxisIndex: 1,
          showSymbol: false,
          data: pairSeries(result?.contributions, (e) => e.multiplier),
          lineStyle: { color: "#0f766e", width: 2 },
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
          lineStyle: { color: "#7c3aed", width: 2 },
        },
        ...(result?.strategyComparisons?.map((item, index) => ({
          name: item.name,
          type: "line",
          showSymbol: false,
          data: pairSeries(item.contributions, (e) => e.portfolioValue),
          lineStyle: { color: ["#0f766e", "#2563eb", "#d97706"][index % 3], width: 2 },
        })) ?? []),
        {
          name: "固定DCA",
          type: "line",
          showSymbol: false,
          data: pairSeries(result?.fixedContributions, (e) => e.portfolioValue),
          lineStyle: { color: "#64748b", width: 2, type: "dashed" },
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

  return { priceOption, contributionOption, drawdownOption, signalOption, showdownOption, comparisonRows };
}
