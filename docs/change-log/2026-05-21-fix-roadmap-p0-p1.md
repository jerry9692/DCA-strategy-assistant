```markdown
# 变更说明 — 2026-05-21 落地 Roadmap P0 + P1

承接 `roadmap-2026-q3.md` 的工程基础底线（P0：A1-A6）和架构债（P1：B1-B4），
本次提交把所有条目落地到位，并修复了一轮内部代码审查里发现的真 bug。

文档分两部分：第一部分是 P0/P1 整体落地清单（A1-A6 + B1-B3 已先行落地的部分），
第二部分是审查里指出的 B2 cache bug + B4 类型同步未接通 + CI ESLint 非阻塞这三个问题的修复。

---

## 第一部分 — P0/P1 已落地清单

| 项 | 状态 | 落点 |
|---|---|---|
| A1 ruff format/lint | ✅ | `pyproject.toml` 配置 line-length 120 + E/F/W/I/UP/B/SIM/RUF |
| A2 pyright | ✅ | `pyproject.toml` 加 pyright section，`typeCheckingMode = "off"` 起步，注释说明先不堵 CI |
| A3 ESLint + Prettier + Vitest | ✅ | `eslint.config.js` + `.prettierrc` + `frontend/src/utils.test.ts`（13 用例） |
| A4 GitHub Actions CI | ✅ | `.github/workflows/ci.yml` 双 job：backend lint+format+test，frontend tsc+lint+vitest |
| A5 Dockerfile + docker-compose | ✅ | 多阶段构建，uvicorn 同时服务 API 和前端静态文件 |
| A6 LICENSE / .gitattributes / CONTRIBUTING / .gitignore | ✅ | 全部到位，运行日志加进 .gitignore |
| B1 拆 `frontend/src/main.tsx` | ✅ | 1438 行 → 11 行，`App.tsx`/`hooks/`/`components/`/`utils.ts`/`types.ts`/`api.ts` 分层 |
| B2 优化器 prepare_market 缓存 | ⚠️→✅ | 初版用 `id(prices)` 做 key 有 bug，本次改为语义键并接通请求边界（详见第二部分） || B3 策略注册表 | ✅ | `strategies.py` 用 `@register_strategy(name)` 装饰器替代 if/elif 链 |
| B4 OpenAPI 类型同步 | ⚠️→✅ | 初版只生成了 `api.generated.ts` 但前端未引用，本次让 `types.ts` 真正消费它（详见第二部分） |

---

## 第二部分 — 审查发现的三个问题修复

### 1. B2 — `prepare_market` cache key 用 `id(prices)` 导致脏读

**现象**：`backend/app/strategies.py` 第 99-104 行原本用：```pythoncache_key = (id(prices), settings)
```

CPython 的 `id()` 是对象内存地址，对象被 GC 释放后地址会被复用。本地跑 pytest 时 `test_rsi_sentiment_invests_more_when_oversold_than_overheated` 因此偶发失败： `fixture_prices(list(range(100, 170)))` 算完 RSI 后 DataFrame 释放；下一个 `fixture_prices(list(range(170, 100, -1)))` 拿到同一内存地址；`id()` 命中前一次 缓存，两个完全相反方向的价格序列拿到同一份指标。

**生产影响**：`/api/backtests/run` 每次都会用 `get_price_history` 现造一个临时 DataFrame，函数返回后立刻释放。两次连续请求同标的不同时间窗，第二次 `id()` 就可能复用第一次的地址，用户体感是"换了时间窗，建议没变"。`main.py` 也没 在请求边界 `clear_prepare_cache()`，污染只能等内存抖动自然消除。

**修复**：

1. 缓存键改成语义键：
   
   ```python
   PreparedCacheKey = tuple[tuple[int, ...], pd.Timestamp, pd.Timestamp, float, float, IndicatorSettings]
   
   def _semantic_cache_key(prices, settings):
      return (
          prices.shape,
          prices.index[0],
          prices.index[-1],
          float(prices.iloc[0]["close"]),
          float(prices.iloc[-1]["close"]),
          settings,
      )
   ```
   
   组件全是 O(1) lookup，开销可忽略；语义稳定，对象生命周期再换也不会撞。

2. `main.py` 在 `backtest()` 和 `recommendation()` 入口都调用 `clear_prepare_cache()`， 把缓存生命周期收敛到单次请求，不再依赖 GC 节奏。`optimize_parameters` 之前 就已经在入口清缓存，保留。

**新增 2 条回归用例**：

- `test_prepare_market_cache_does_not_collide_when_python_recycles_object_ids`： 显式 `del` 前一个 DataFrame，构造一个会导致 SMA/drawdown 显著不同的反向序列， 断言不同价格 → 不同指标。`id()` 复用陷阱直接命中。
- `test_prepare_market_cache_returns_same_object_on_hit`：同一 prices+config 二次调用必须返回 `is` 同一对象，确保缓存还在工作（修复不能把缓存改坏）。

### 2. B4 — OpenAPI 类型同步只做了一半

**现象**：

openapi.json 已能从 `export_openapi.py` 导出， 

package.json 已加 `"generate:api"` 脚本， 

api.generated.ts（626 行）也确实生成出来了。但：

- `api.generated.ts` 在前端**没有任何文件引用**（grep 0 处命中）
- types.ts 仍是手写的 151 行，跟后端 Pydantic 模型完全独立维护
- CI 没跑 schema 漂移检查

也就是 B4 处于"刀备好了但没用"的状态，roadmap 想消除的"前后端类型双改"痛点没消除。 此外 `/api/backtests/run` 和 `/api/recommendations/run` 用的是 `dict` 返回类型， 所以 OpenAPI schema 也没暴露 `BacktestResult`、`StrategyDecision` 等关键类型。

**修复**：

1. **后端给所有端点加 `response_model`**：
   
   - `/api/strategies` → `StrategyDefinitionsResponse`（新建）
   - `/api/recommendations/run` → `RecommendationResponse`（新建）
   - `/api/backtests/run` → `BacktestResult`（已有，签名从 `dict` 改成 `BacktestResult`）

2. **`ContributionEvent` 加 `accountDrawdownPct: float | None = None`**， 让 `_chart_contributions` 用 `model_copy(update=...)` 直接构造 model 列表， 不再返回散装 dict。`_chart_prices` 同样改返回 `list[PricePoint]`。

3. **types.ts 完全重写**：
   
   - 所有 API 类型从 `api.generated.ts` re-export，不再手写
   - 几个字段做了精确 narrowing（`Contribution.reasons` 必填、 `accountDrawdownPct` 必填、`Backtest.contributions` 等必填）， 把 Pydantic `default_factory=list` 在 OpenAPI 里变成的 optional 收紧到 UI 实际形态
   - 只保留 `UiError`、`PresetMode`、`Frequency`、`MarketCode`、`PressureScenario` 等纯 UI 类型

4. **CI 加 schema/类型漂移检测**（详见第 3 项）。

**副作用调整**：

- ParamControl.tsx：`min`/`max` 从 schema 拿到的是 `number | null | undefined`，传给 HTML `<input>` 需要 `?? undefined` 兜底
- `frontend/src/utils.ts::accountDrawdown`：入参类型从 `Contribution` 放宽 到结构子集 `{ drawdownPct: number; accountDrawdownPct?: number | null }`， 这样测试可以传 partial mock 而不需要伪造 `shares`、`totalShares` 等
- `frontend/src/utils.ts::describeConfig`、`useBacktest.ts::applyOptimizedConfig`： 接受 narrowed 类型 + 原始 schema 类型的 union，让 optimizer 直接传过来的 schema 类型也能流过去
- `frontend/src/utils.ts::defaultsFor`：在边界做 `as ParamValue` 类型断言

### 3. CI ESLint 非阻塞 + 加 schema 漂移检查

**现象**：

ci.yml 里 ESLint 步骤是 `npx eslint src || true`（注释写"non-blocking until B1 hooks cleanup"）。 B1 已经做完，不该继续放过 hooks 警告。同时 CI 没有任何检测能在 后端 schema 改动而前端类型未跟进时报警。

**修复**：

- ESLint 步骤去掉 `|| true`，恢复阻塞
- backend job 加一步"OpenAPI 是否最新"：跑完测试后重新执行 `python export_openapi.py`，再 `git diff --exit-code openapi.json`， schema 漂移就 fail
- frontend job 加一步"生成的 API 类型是否最新"：跑完 lint/test 后 重新执行 `npm run generate:api`，再 `git diff --exit-code src/api.generated.ts`， 类型漂移就 fail
- frontend job 加 `needs: backend`，后端通过后才跑

副带：

package.json 加 `"type": "module"`，消除 ESLint 本地跑时 `MODULE_TYPELESS_PACKAGE_JSON` 警告噪声。

---

## 验证

```text
pytest backend/tests -q                  47 passed
ruff check backend/                       All checks passed
ruff format --check backend/              clean
cd frontend && npx tsc --noEmit          0 errors
cd frontend && npx eslint src             exit 0
cd frontend && npx vitest run             13 passed
backend → openapi.json → frontend → api.generated.ts   diff clean
```

## 文件清单

修改：

- strategies.py — 缓存键改语义键，注释更新
- main.py — 三个端点加 `response_model`，请求入口 `clear_prepare_cache()`，`_chart_contributions`/`_chart_prices` 返回 model 列表
- models.py — 新增 `RecommendationResponse`/`StrategyDefinitionsResponse`，`ContributionEvent` 加 `accountDrawdownPct`
- openapi.json — 重新导出
- types.ts — 完全重写，从 `api.generated.ts` re-export
- api.generated.ts — 重新生成（覆盖更多 schema）
- utils.ts — `accountDrawdown` 入参放宽，`describeConfig`/`exportBacktestCsv` 兼容 schema 类型
- ParamControl.tsx — `min`/`max` null 兜底
- useBacktest.ts — `applyOptimizedConfig` 接受宽 schema 类型
- useChartOptions.ts — `strategyComparisons` 可空兜底
- App.tsx — `OptimizationPanel` prop 接受宽 schema 类型
- utils.test.ts — `accountDrawdown` 测试改用 partial mock
- package.json — 加 `"type": "module"`
- test_strategies.py — 新增 2 条 prepare_market 缓存回归用例
- ci.yml — ESLint 改成阻塞，加两步漂移检查，前端依赖后端

## 与 roadmap 的关系

`roadmap-2026-q3.md` 的 P0（A1-A6）+ P1（B1-B4）至此全部落地到位。 之前的 P0/P1（2026-05-18 修复批次）覆盖了功能层 bug；本次覆盖工程基础和架构债。

下一阶段建议从 P2 开始：

- C1 支持更多标的（用户面价值最高）
- C2 暴露费率/滑点参数（开发量最低）
- D1 滚动窗口表现（差异化 + 低成本）

B2 缓存改成 ProcessPoolExecutor 方案、B1 把 OptimizationPanel 拆出去等 "完成度可继续提升"的项目，等用户反馈或下次添新页面时再做即可。



---

## 附录 — 合并前的前端图表回归修复

P1 主体内容合到分支后，本地手感测试发现两个 P1 范围之外但同样应该一起修的
图表回归，所以一并落地：

### 7. ECharts 不删多余 series（"鬼线"问题）

**现象**：在策略对决勾选两个对比策略 → chart 显示 4 条线 → 取消勾选 → chart
还是 4 条线，对比策略的线没消失。

**诊断**：

- 前端 `comparisonStrategyTypes` state 已经是 `[]`
- Network 里看请求 body `comparisonStrategyTypes: []`
- 后端 response `strategyComparisons: []`
- 但 chart 依然渲染 4 条线

`echarts-for-react` 默认 `notMerge=false`，新 option 会跟旧 option 做深 merge。
当 series 数量减少时，旧 series 不会被新 option 自动移除——多余的 2 条 series
就以最后一次接收到的数据快照留在 chart 里。

**修复**：`frontend/src/Chart.tsx` 给 `EChartsReactCore` 加 `notMerge` prop，
每次更新都用新 option 完整替换 chart 状态。这是对所有 5 张图（priceOption、
contributionOption、drawdownOption、signalOption、showdownOption）都生效的
单点修复。

### 8. backtest 请求竞速保护

**现象**：连续快速勾选/取消对比策略时，旧请求可能在新请求之后回来，把已经
更新过的 result state 反向覆盖。修第 7 项时顺手发现的潜在 bug，但不是这次
"鬼线"的根因。

**修复**：`useBacktest.ts` 的 backtest effect 加 `let cancelled = false`
闭包标志，cleanup 时设 `true`；fetch promise resolve 时检查 flag，已 cancel
就丢弃响应。

### 9. Y 轴 6 位数标签被裁切

**现象**："策略对决"等图的 Y 轴标签 `150,000` 显示成 `50,000`，开头那个 "1"
被裁掉，导致用户误以为不同策略 5 倍差距（实际是 ~10% 差距）。

**修复**：`useChartOptions.ts` 把 5 张图的 `grid.left` 从 46 调到 64，留出
6 位数标签的空间。

---

## 与 roadmap 的关系（更新版）

`roadmap-2026-q3.md` 的 P0（A1-A6）+ P1（B1-B4）至此全部落地。第 7-9 项
属于 P2 范围之外的"已合到 main 之前发现的小回归"，跟 P1 工作流自然衔接，
所以并入这份 change-log，方便日后回溯。
