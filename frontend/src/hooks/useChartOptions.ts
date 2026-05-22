import { useMemo } from "react";
import type { Backtest, StrategyDef } from "../types";
import { accountDrawdown, pairSeries } from "../utils";

export function useChartOptions(
  result: Backtest | null,
  selectedStrategy: StrategyDef | undefined,
  strategyNameByType: Map<string, string>,
) {
  const priceOption = useMemo(
    () => ({
      tooltip: { trigger: "axis" },
      grid: { left: 64, right: 18, top: 24, bottom: 34 },
      xAxis: { type: "time", axisLabel: { color: "#64748b" } },
      yAxis: { type: "value", scale: true, axisLabel: { color: "#64748b" } },
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
    [result],
  );

  const contributionOption = useMemo(
    () => ({
      tooltip: { trigger: "axis" },
      legend: { top: 0, textStyle: { color: "#475569" } },
      grid: { left: 64, right: 20, top: 36, bottom: 34 },
      xAxis: { type: "time", axisLabel: { color: "#64748b" } },
      yAxis: [
        { type: "value", name: "组合价值", axisLabel: { color: "#64748b" } },
        { type: "value", name: "投入金额", axisLabel: { color: "#64748b" } },
      ],
      series: [
        { name: "本策略投入", type: "bar", yAxisIndex: 1, data: pairSeries(result?.contributions, (e) => e.amount), itemStyle: { color: "#0f766e" } },
        { name: "固定投入", type: "bar", yAxisIndex: 1, data: pairSeries(result?.fixedContributions, (e) => e.amount), itemStyle: { color: "#94a3b8", opacity: 0.5 } },
        { name: "本策略价值", type: "line", yAxisIndex: 0, data: pairSeries(result?.contributions, (e) => e.portfolioValue), showSymbol: false, lineStyle: { color: "#7c3aed", width: 2 } },
        { name: "固定DCA价值", type: "line", yAxisIndex: 0, data: pairSeries(result?.fixedContributions, (e) => e.portfolioValue), showSymbol: false, lineStyle: { color: "#64748b", width: 2, type: "dashed" } },
        { name: "一次性买入", type: "line", yAxisIndex: 0, data: pairSeries(result?.lumpSumContributions, (e) => e.portfolioValue), showSymbol: false, lineStyle: { color: "#dc2626", width: 2, type: "dotted" } },
      ],
    }),
    [result],
  );

  const drawdownOption = useMemo(
    () => ({
      tooltip: { trigger: "axis" },
      legend: { top: 0, textStyle: { color: "#475569" } },
      grid: { left: 64, right: 20, top: 36, bottom: 34 },
      xAxis: { type: "time", axisLabel: { color: "#64748b" } },
      yAxis: { type: "value", max: 0, axisLabel: { color: "#64748b" } },
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
    [result],
  );

  const signalOption = useMemo(
    () => ({
      tooltip: { trigger: "axis" },
      legend: { top: 0, textStyle: { color: "#475569" } },
      grid: { left: 64, right: 20, top: 36, bottom: 34 },
      xAxis: { type: "time", axisLabel: { color: "#64748b" } },
      yAxis: [
        { type: "value", min: 0, max: 1, axisLabel: { color: "#64748b" } },
        { type: "value", axisLabel: { color: "#64748b", formatter: "{value}x" } },
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
    [result],
  );

  const showdownOption = useMemo(
    () => ({
      tooltip: { trigger: "axis" },
      legend: { top: 0, textStyle: { color: "#475569" } },
      grid: { left: 64, right: 20, top: 42, bottom: 34 },
      xAxis: { type: "time", axisLabel: { color: "#64748b" } },
      yAxis: { type: "value", name: "组合价值", axisLabel: { color: "#64748b" } },
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
    [result, selectedStrategy, strategyNameByType],
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
