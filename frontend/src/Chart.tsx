import EChartsReactCore from "echarts-for-react/lib/core";
import { BarChart, LineChart, ScatterChart } from "echarts/charts";
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  type DataZoomComponentOption,
  type GridComponentOption,
  type LegendComponentOption,
  type TooltipComponentOption,
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import type { BarSeriesOption, LineSeriesOption, ScatterSeriesOption } from "echarts/charts";

echarts.use([BarChart, LineChart, ScatterChart, GridComponent, LegendComponent, TooltipComponent, DataZoomComponent, CanvasRenderer]);

type ChartOption = echarts.ComposeOption<
  | BarSeriesOption
  | LineSeriesOption
  | ScatterSeriesOption
  | GridComponentOption
  | LegendComponentOption
  | TooltipComponentOption
  | DataZoomComponentOption
>;

export default function Chart({ option, height }: { option: ChartOption | object; height: number }) {
  return (
    <EChartsReactCore
      echarts={echarts}
      option={option}
      notMerge
      style={{ height, width: "100%" }}
    />
  );
}
