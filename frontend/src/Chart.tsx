import EChartsReactCore from "echarts-for-react/lib/core";
import { BarChart, LineChart, ScatterChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
  type GridComponentOption,
  type LegendComponentOption,
  type TooltipComponentOption,
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import type { BarSeriesOption, LineSeriesOption, ScatterSeriesOption } from "echarts/charts";

echarts.use([BarChart, LineChart, ScatterChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

type ChartOption = echarts.ComposeOption<
  | BarSeriesOption
  | LineSeriesOption
  | ScatterSeriesOption
  | GridComponentOption
  | LegendComponentOption
  | TooltipComponentOption
>;

export default function Chart({ option, height }: { option: ChartOption | object; height: number }) {
  // notMerge=true so reducing series count (e.g. unchecking a strategy
  // comparison) actually removes the old series. With the default merge
  // behavior ECharts keeps stale series around, leaving ghost lines on
  // the chart after the underlying data already dropped them.
  return <EChartsReactCore echarts={echarts} option={option} notMerge style={{ height }} />;
}
