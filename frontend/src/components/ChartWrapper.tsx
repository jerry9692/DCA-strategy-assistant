import React, { Suspense, lazy } from "react";

const LazyChart = lazy(() => import("../Chart"));

export function ChartWrapper({ option, height }: { option: object; height: number }) {
  return (
    <Suspense fallback={<div className="chart-placeholder" style={{ height }}>正在加载图表</div>}>
      <LazyChart option={option} height={height} />
    </Suspense>
  );
}
