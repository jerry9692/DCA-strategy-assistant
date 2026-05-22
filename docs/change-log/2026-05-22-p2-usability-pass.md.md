# 变更说明 — 2026-05-22 P2 可用性打磨第一轮

承接 `roadmap-2026-q3.md` 的 P2 计划，本次完成了 4 个用户面价值高、成本低的条目（C2 / C4 / C5 / C6），并在做 C4 时顺手发现并修复了一个 priceSeries 子采样 bug。

## 概览

| #   | 类别   | 标题                      | 影响范围                                                                                                                                                                           |
| --- | ---- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C2  | feat | 暴露费率和滑点参数               | `frontend/src/hooks/useBacktest.ts`、`frontend/src/App.tsx`                                                                                                                     |
| C5  | feat | 日期范围快捷验证                | `backend/app/data.py`、`backend/app/main.py`、`backend/app/models.py`、`frontend/src/hooks/useBacktest.ts`、`frontend/src/App.tsx`、`frontend/src/utils.ts`、`frontend/src/types.ts` |
| C6  | feat | 错误重试体验改进                | `frontend/src/components/ErrorBanner.tsx`（新文件）、`frontend/src/App.tsx`                                                                                                          |
| C4  | feat | 指标 hover 解释             | `frontend/src/components/Metric.tsx`、`frontend/src/App.tsx`、`frontend/src/styles.css`                                                                                          |
| -   | bug  | priceSeries 子采样导致绿点偏离蓝线 | `backend/app/main.py`、`backend/tests/test_strategies.py`                                                                                                                       |

测试：`pytest backend/tests` 50 passed（+3 新增），`vitest` 13 passed，`tsc/eslint/ruff` 全绿。

---

## C2 — 暴露费率和滑点参数

### 背景

后端 `DcaBacktester.run` 早就支持 `fee_rate` / `slippage_rate`，但前端从来没写过这两个 key，是事实上的 dead input。专业用户问"如果有 0.1% 滑点结果会怎样"完全没法回答。

### 修复

参数面板"无风险利率"下方加 2 个 `RangeControl`：交易费率 + 滑点率，0-0.5%、步进 0.01%。下面一行说明文字。

实现细节：fee/slippage 是用户偏好（跨策略持久），不是某个策略的参数。如果直接 `setParams(prev => ({...prev, feeRate}))` 写进 `params`，下次 preset 切换或换策略走 `setParams(preset.params)` 整个对象覆盖时会被擦掉。所以做成顶层 state（跟 `riskFreeRate` 一样），在 `config` 的 `useMemo` 里 spread 进 `params` 提交给后端：

```ts
const config = useMemo(
  (): StrategyConfigPayload => ({
    strategyType, baseAmount, frequency, minMultiplier, maxMultiplier,
    params: { ...params, feeRate, slippageRate },
  }),
  [strategyType, baseAmount, frequency, minMultiplier, maxMultiplier, params, feeRate, slippageRate],
);
```

`localStorage` 持久化。

后端 `_cached_fixed_backtest`（lru_cache）已经做对了的事：`if fee_rate == 0 and slippage_rate == 0` 才走缓存，否则跑独立 backtest。所以费率/滑点变化必然触发新的固定 DCA 基准，不会拿到错误的零成本数字。

### 验证

手工：调到 0.10% 看"期末价值"略微下降、"总投入"不变（用户实际付的金额）、"相对固定"几乎不变（两边都受同样费率影响）。切策略再切回，滑块值保留。刷新页面，值恢复。

---

## C5 — 日期范围快捷验证

### 背景

之前界面允许用户选 1990-01-01 当开始日期回测 QQQ，触发后端"yfinance 无数据"错误才报错。错误消息里其实写了"本地缓存范围为 X 至 Y"，但用户得自己解读，体验粗糙。

更糟的是快捷周期按钮：`applyBacktestPeriod(years)` 直接 `setStartDate(yearsBefore(endDate, years))`，没有任何边界检查。把结束日期设到 2000、点 10年，开始就掉到 1990——QQQ 1999 才上市。

### 修复

#### 后端

新增 `GET /api/assets/{symbol}/range` 返回每个标的的真实可用日期范围：

```python
_YFINANCE_EARLIEST_AVAILABLE = {
    "QQQ": date(1999, 3, 10),
    "SPY": date(1993, 1, 29),
    "VOO": date(2010, 9, 9),
}

def get_available_range(symbol: str) -> tuple[date, date]:
    floor = _YFINANCE_EARLIEST_AVAILABLE.get(normalized, date(1990, 1, 1))
    ceiling = date.today()
    return floor, ceiling
```

**关键设计决策**：floor 用 hardcoded 而不是 SQLite 缓存的 `min(bar_date)`。缓存只反映"用户曾经查过的范围"，不是数据真实可用范围。早期实现用了缓存值，导致 "QQQ 数据可用范围 2013-05-20 至..."，让用户以为 2008 数据没法回测——其实 yfinance 上明明有，只是没人请求过没存进缓存。改成 hardcoded 后，选 2008 会触发一次性 yfinance backfill，用户感知的是"第一次稍慢一点"而不是"不可用"。

#### 前端

- `useBacktest.ts` 加 `assetRange` state，symbol 变化时 fetch 一次
- 顶部加 hint 行 "QQQ 数据可用范围 1999-03-10 至 2026-05-22"
- 日期 `<input>` 加 `min`/`max`，浏览器原生 picker 不让选越界
- 新增 `clampToRange(value, range)` utility 在程序化设置日期时收紧
- 新增 cross-field guard useEffect：`endDate < startDate` 时把 end 推到 start
- `applyBacktestPeriod`（快捷周期按钮）调用 `clampToRange`，不会再让 10年快捷穿透 floor

### 验证

新增 2 条 backend 测试：`get_available_range` 用 hardcoded floor 而不是 cache、symbol 不在 hardcoded map 时回退到 1990。

手工：

- 切 QQQ → hint 显示 1999-03-10；切 SPY → 1993-01-29；切 VOO → 2010-09-09
- 结束设 2000-01-01 + 点 10年快捷 → 开始 clamp 到 1999-03-10（不是 1990）
- 开始 2020 + 手敲结束 2015 → 结束自动跳回 2020
- 选 2008 触发 yfinance backfill 并成功回测

---

## C6 — 错误重试体验改进

### 背景

yfinance 限流时报错条只有一行红字 + "重试" 按钮。用户不知道还要等多久，频繁点击只会再次触发限流，体验很差。

### 修复

错误条抽到独立组件 `<ErrorBanner>`：

- 普通可重试错误：保留单按钮 "重试"
- `error.code === "rate_limited"`：显示 60 秒倒计时，归零后自动重试一次。按钮文案 "60s 后自动重试 · 立即重试"，用户可以手动按按钮立刻试

实现细节：`onRetry` 闭包用 `useRef` 包一层，避免每次父组件 re-render 时 callback 引用变化导致倒计时重置。

```tsx
const retryRef = useRef(onRetry);
useEffect(() => { retryRef.current = onRetry; }, [onRetry]);

useEffect(() => {
  if (!isRateLimited) { setSecondsLeft(0); return; }
  setSecondsLeft(60);
  const handle = window.setInterval(() => {
    setSecondsLeft((prev) => {
      if (prev <= 1) { retryRef.current(); return 60; }
      return prev - 1;
    });
  }, 1000);
  return () => window.clearInterval(handle);
}, [isRateLimited, error.message]);
```

`error.message` 进依赖数组让"新错误"能重置倒计时，但相同消息（identical re-throw）不会让倒计时回到 60 秒。

---

## C4 — 指标 hover 解释

### 背景

指标卡只有标签 + 数字。"持仓最大回撤"、"夏普比率"、"索提诺比率"、"相对一次性" 对非专业用户都是黑话。

### 修复

`Metric` 组件加可选 `hint` prop：

```tsx
<Metric
  label="夏普比率"
  value={metric(state.result?.metrics.sharpeRatio)}
  hint="(收益 − 无风险利率) ÷ 总波动。> 1 不错，> 2 优秀。"
/>
```

`hint` 存在时 label 后跟一个 lucide `Info` icon，icon 用原生 `title` 属性。优点：

- 零依赖（不引入 tooltip 库）
- 桌面 hover、移动 long-press 都自然显示
- 屏幕阅读器自动读 `aria-label`
- `cursor: help` 让交互可发现

主指标 9 个 + 优化结果 4 个全部加上 hint，文案直接用 roadmap 里写好的解释。

---

## Bonus 修复 — priceSeries 子采样导致绿点偏离蓝线

### 现象

做 C4 手工验证时，注意到 5 年回测的"价格与买入点"图上有买入点（绿色 scatter）明显偏离蓝色价格线。具体复现：QQQ 5y 区间内 2025-04-21 那个买入点位于 $431（一个清算日低点），但蓝线在那个日期附近渲染的 Y 值大约 $447，差了 $16。

### 根因

`backend/app/main.py::_chart_prices`：

```python
def _chart_prices(prices, start, max_points=360):
    visible = prices.loc[prices.index >= pd.Timestamp(start)]
    if len(visible) > max_points:
        step = max(1, len(visible) // max_points)
        visible = visible.iloc[::step]   # ← 子采样
    return [...]
```

5 年回测有 ~1260 个交易日，`step = 1260 // 360 = 3`，每 3 天才取 1 个点送给前端。这会**跳过真实的买入日**——比如 4/14（被采）→ 4/17（被采）→ 4/20（采到但是周末没数据）→ 4/23（被采）。4/21 这个真实交易日在 `priceSeries` 里完全消失。

但 `contributions` 不抽样（每个买入事件都在）。绿点画在 `(4/21, $431)`，蓝线从 `(4/17, $442)` 直线插值到 `(4/23, $452)`，那段 4/21 处大约 $447。视觉上绿点就"掉到线下面"。

### 修复

去掉 `max_points` 参数，priceSeries 返回区间内**每一个交易日**：

```python
def _chart_prices(prices, start: date) -> list[PricePoint]:
    visible = prices.loc[prices.index >= pd.Timestamp(start)]
    return [PricePoint(...) for idx, row in visible.iterrows()]
```

10 年回测约 2520 个点 → JSON 约 80 KB，ECharts 几毫秒就渲染完，子采样的"性能优化"是过度优化。绿点现在永远贴着蓝线。

### 回归测试

新增 `test_chart_prices_returns_every_trading_day_in_window`：构造 600 个交易日的 fixture（超过原 360 上限），断言 `len(chart) == 600` 且首尾日期完整保留。

---

## 与 roadmap 的关系

`roadmap-2026-q3.md` 的 P2 范围：

- ✅ C2 暴露费率和滑点参数
- ✅ C4 指标 hover 解释
- ✅ C5 日期范围快捷验证
- ✅ C6 错误重试体验改进
- ⏳ C1 支持更多标的（下一档主线候选）
- ⏳ C3 URL state 同步（下一档主线候选）
- 🟡 C7-C10（暗色细节、CSV 体验等纯打磨，按节奏选做）

下一步建议：**C3 URL state 同步**，是 P2 里第一个有"增长机制"价值的条目，做完后用户分享配置 = 免费传播；同时为 D1（滚动窗口）/D2（多标的）的 state 扩展铺路。
