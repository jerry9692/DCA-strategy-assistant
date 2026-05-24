# DCA Strategy Assistant — 下阶段路线图（2026 Q3+）

---# DCA Strategy Assistant — 下阶段路线图（2026 Q3+）

代码审查（2026-05-18 P0/P1/P2 三轮）已经把 #1-#10 + 架构 F 的全部 bug 和健壮性条目清零。从这里开始的工作分成两条线：

- **稳态线**：把项目从"能跑的研究工具"升级为"可被同事/朋友/外部用户使用的产品"。重点是工程质量、可部署、可观测。
- **价值线**：把 DCA 助手从"7 个策略 + 回测工作台"升级到"投资决策伴侣"。重点是新功能、新 insight、新差异化。

下面按 P0 → P1 → P2 → P3 → 实验排，每一项都给出**价值 / 成本 / 触发条件**三个判断维度，方便取舍。

> **进度（2026-05-24 更新）**：P0（A1-A6）+ P1（B1-B4）+ P2（C1-C10）+ P3 D1 已合到 main。
> 
> - P2 已完成：C2 费率滑点、C4 指标 hover、C5 日期范围、C6 错误重试。
> - 顺手修复：长回测下 priceSeries 子采样导致买入点偏离价格线（详见
>   change-log）。
> 
> 详见 [`change-log/2026-05-22-p2-usability-pass.md`](./change-log/2026-05-22-p2-usability-pass.md)。
> 下一档主线建议是 D3（蒙特卡洛模拟）或 D2（多标的组合定投）。D1 已完成，
> 后续 D2/D3 等扩展功能可以继续沿用同一套 URL state 机制。

#### P0 — 工程基础底线（建议本周内做）

这一档不是产品功能，是没了它就会咬人的最小工程基础。当前项目缺这一块的程度让代码审查能找到的 bug 还会继续来。

> ✅ 全部完成（2026-05-21）。

### A1 ✅ 引入 ruff + black + 后端 pre-commit

`pyproject.toml` 已配置 ruff（行长 120，启用 E/F/W/I/UP/B/SIM/RUF）。CI 会跑 `ruff check` 和 `ruff format --check`。

### A2 ✅ 后端加 mypy 或 pyright

选用 pyright，`pyproject.toml` 已加 section。当前 `typeCheckingMode = "off"` 起步，避免 ~95 个 pandas 相关类型窄化告警一次性堵 CI；后续按模块逐步收紧到 "basic"。

### A3 ✅ 前端加 ESLint + Prettier + Vitest

`eslint.config.js` + `.prettierrc` + `frontend/src/utils.test.ts` 三件套到位。`pairSeries`、`accountDrawdown`、`metric`、`csvEscape` 已被覆盖（13 个用例）。CI 上 ESLint 已经是阻塞步骤。

### A4 ✅ GitHub Actions CI

`.github/workflows/ci.yml` 双 job：

- backend：ruff lint + format check + pytest + OpenAPI schema 漂移检查
- frontend：tsc --noEmit + eslint + vitest + 生成 API 类型漂移检查
- frontend `needs: backend`，前端在后端通过后才跑

### A5 ✅ Dockerfile + docker-compose

多阶段构建（Node 编译前端 → Python 起 uvicorn 同时服务 API 和静态文件）。`docker-compose.yml` 持久化 `backend/data` 卷。

### A6 ✅ 仓库基础健全

- `LICENSE`（MIT）已建
- `.gitattributes` 设 LF 统一，`.bat` / `.ps1` 保留 CRLF
- `CONTRIBUTING.md` 给了最小开发流程文档
- `.gitignore` 排除了 `backend/server.*.log`、`uvicorn.log`、`yfinance-cache/`

---

---

#### P1 — 必修的架构债（建议本月内做）

这一档的项目已经在多次代码审查里被点过名，再不做就会拖慢所有功能开发。

> ✅ B1-B4 全部完成（2026-05-21）。其中 B2 和 B4 经过一轮审查发现初版有遗留问题，
> 已修复，详见 [`change-log/2026-05-21-fix-roadmap-p0-p1.md`](./change-log/2026-05-21-fix-roadmap-p0-p1.md)。

### B1 ✅ 拆 `frontend/src/main.tsx`

1438 行单文件 → 11 行（只剩 ErrorBoundary + createRoot）。逻辑分层：

- `App.tsx`（376 行）— 顶层 layout + JSX
- `hooks/useBacktest.ts`（362 行）— 17 个 useState、5 个 useEffect 集中管理
- `hooks/useChartOptions.ts`（161 行）— 5 张图表配置
- `utils.ts`（141 行）— 数据处理 + CSV 导出
- `types.ts`（98 行）— 类型集中（B4 之后从 `api.generated.ts` re-export）
- `api.ts`（33 行）— `readJson` + `toUiError`
- `components/`（4 个组件）

未做完的小尾巴（属于 P2 范围，下次顺手做）：

- `OptimizationPanel` 还在 `App.tsx` 末尾（建议挪到 `panels/OptimizationPanel.tsx`）
- `useBacktest.ts::config` 仍触发激进 cancel（架构 G）
- 几处 `eslint-disable react-hooks/exhaustive-deps`，长期可用 useReducer 收成几个 reducer

### B2 ✅ 优化器并行化或缓存

实现的是 roadmap 方案 A（`prepare_market` 加缓存）。多进程方案没做，因为 DataFrame
跨进程序列化成本不低，先看缓存能省多少更稳妥。

**初版用 `id(prices)` 做 key 触发了脏读**——CPython 复用对象地址会让两个完全
不同的价格序列共享同一个缓存条目。本次修正：

- 缓存键改成 `(prices.shape, index[0], index[-1], close[0], close[-1], settings)` 语义键
- `main.py` 在 `backtest()` / `recommendation()` 入口调用 `clear_prepare_cache()`，
  把缓存生命周期收敛到单次请求，避免长期运行下 dict 无限增长

新增 2 条回归测试守住这条路径（详见 change-log）。

### B3 ✅ 策略注册表

`strategies.py` 用 `@register_strategy(name)` 装饰器注册 7 个策略，
`evaluate_prepared_strategy` 通过 `get_strategy(name)` 派发。
之前那段 7 段 if/elif 不再存在。

加第 8 个策略只需要写一个被装饰的函数，验证了"扩展点干净"目标。

### B4 ✅ OpenAPI 类型同步

后端 `export_openapi.py` 导出 schema → `openapi-typescript` 生成
`frontend/src/api.generated.ts`，前端 `types.ts` 完全从生成产物 re-export。

**初版只生成了文件但前端没人引用**，本次修正：

- `/api/strategies`、`/api/recommendations/run`、`/api/backtests/run` 全部加
  `response_model`，OpenAPI schema 真正暴露 `BacktestResult`、`StrategyDecision` 等
- `frontend/src/types.ts` 改成从 `api.generated.ts` re-export，几个字段做精确 narrowing
- CI 加 schema/类型漂移检查：后端 schema 改了但 `openapi.json` 没回写、或前端类型
  没重新生成，CI 直接 fail

下次后端模型变化会被 CI 强制要求同步 OpenAPI 和前端类型。

---

---

## P2 — 现有功能完善（建议下迭代做）

这一档是已有功能的体验细化和小幅扩展。

### C1 ✅ 支持更多标的（task-list #18）

- **现状**：`SUPPORTED_ASSETS` 写死 QQQ/VOO/SPY 三个。
- **价值**：高。任何用户上来都会问"能加我持有的 XX 吗"。
- **成本**：1-2 天。
- **改动**：
  - 后端 `SUPPORTED_ASSETS` 扩展到 ~20 个常见 ETF（VTI、IWM、VEA、VWO、SCHD、VYM、ARKK、SOXX、XLK、XLE、IBIT、GLD、TLT、IEF、AGG、BND、AVUV、VXUS）。
  - 前端 select 改成 grouped（美股大盘 / 行业 / 国际 / 债券 / 商品 / 加密）。
  - 验证：每个新标的至少跑一次完整 5 年回测，看缓存层和指标计算都正常。
- **注意**：QQQ/VOO/SPY 是高度相关的同类资产，扩展后会暴露各种被掩盖的边角问题（高波动 ETF 在 RSI/grid 策略下的表现、债券 ETF 的低回撤导致 drawdown_boost 几乎不触发）。
- **完成情况**：C1 第一版已完成。美股新增核心宽基、红利价值、国际股票、债券防守、商品替代和高级/高波动 ETF，共 26 个内置美股 ETF；A 股新增上证 50、沪深 300、中证 500、创业板、科创 50 五个基础指数 ETF。前端用标准 `市场` + `标的` 双下拉筛选，标的下拉仅显示当前市场内的分组资产；高波动/杠杆/比特币 ETF 显示风险提示；A 股通过 `providerSymbol` 映射到 Yahoo Finance 的 `.SS/.SZ` 数据源代码，金额展示切换为人民币符号。

### C2 ✅ 暴露费率和滑点参数

- **现状**：后端支持 `fee_rate` / `slippage_rate`，但前端 params 里没有对应控件，`config.params.get("feeRate", 0)` 永远拿到 0。
- **价值**：中-高。机构 / 专业用户会问"如果我每次买入有 0.1% 滑点会怎样"。零成本回测让人怀疑数据真实性。
- **成本**：1 小时。
- **改动**：参数面板加两个 RangeControl（费率 0-0.5%，滑点 0-0.5%），写进 `config.params` 即可，后端无需改。

### C3 ✅ URL state 同步

- **现状**：用户做完一次"QQQ + composite_score + 2018-2024"的完美回测，没法把链接发给朋友。刷新页面也丢失（虽然 localStorage 部分恢复）。
- **价值**：中-高。增长机制：用户分享配置 = 免费传播。
- **成本**：半天。
- **方案**：把 symbol / strategyType / startDate / endDate / preset / 主要 params 序列化到 URL search params。`useEffect` 双向同步。复杂参数（comparison strategies）可以省略或单独加。
- **完成情况**：已实现 URL 优先恢复 + 地址栏自动同步。同步字段包括 symbol、strategy、日期、金额、频率、倍率、preset、场景、对比策略、无风险利率、费率/滑点和策略参数（`p.xxx=value`）。

### C4 ✅ 指标 hover 解释

- **现状**：指标卡只有标签 + 数字。"持仓最大回撤"、"夏普比率"、"索提诺比率"、"相对一次性"对非专业用户都是黑话。
- **价值**：中。降低门槛，提高用户对工具的信任。
- **成本**：2 小时。
- **方案**：每个指标卡加 `<span title="...">i</span>` 或用 lucide `Info` icon + tooltip。文案：
  - 持仓最大回撤：从"已经买入的资产"高点到低点的最大百分比跌幅
  - 夏普比率：(收益 - 无风险利率) / 总波动。> 1 不错，> 2 优秀
  - 索提诺比率：只用下行波动算分母，对"上行波动"不惩罚。比夏普更适合定投者
  - 相对固定：如果你照本策略投，比每周固定金额多赚（或少赚）多少
  - 相对一次性：如果你期初一次性投入同样总预算，本策略多赚（或少赚）多少

### C5 ✅ 日期范围快捷验证

- **现状**：start > end 不会被前端拦下，等后端报错才提示。日期超过 yfinance 最早数据点（QQQ 1999-03、SPY 1993-01）时会拿到很短的回测但不警告。
- **价值**：低-中。健壮性。
- **成本**：1 小时。
- **方案**：前端加 `min`/`max` HTML 限制 + 提交前 startDate < endDate 校验，并显示 "数据从 XXX 起可用" 的灰色提示。

### C6 ✅ 错误重试体验改进

- **现状**：rate-limited 错误显示一行红字 + 重试按钮。用户不知道还要等多久才能重试，频繁点击只会再次触发。
- **价值**：中。yfinance 限流是 5 分钟级别，体验非常差。
- **成本**：2 小时。
- **方案**：
  - rate_limited 错误带一个 60 秒倒计时按钮（按钮上显示剩余秒数）。
  - 倒计时结束自动 retry 一次，再失败再倒计时。

### C7 ✅ 优化任务的 cancel 触发收窄（架构建议 G）

- **现状**：`useEffect` 依赖 `config`，只要任意 params 变就 cancel 任务。用户在 5 分钟优化跑到 80% 时随手拖了一下滑块就会全部白跑。
- **价值**：中。当前行为太激进。
- **成本**：1 小时。
- **方案**：把 cancel 的依赖收窄为 `[symbol, strategyType, startDate, endDate]`。其它参数变化只刷新 backtest，不取消优化。
- **完成情况**：已把调优重置范围收窄到标的、策略和日期区间。普通参数、倍率、费率/滑点变化不会取消后台调优；结果面板会标记“当前参数已不同于启动本次调优时的参数”，提示用户必要时重新调优。

### C8 ✅ 优化结果在前端不会被参数变更"隐藏"

- **现状**：现在 `setOptimization(null)` 在 useEffect 依赖 `config` 时就清空。用户应用了推荐参数后立刻丢失结果。
- **价值**：中。
- **成本**：30 分钟。
- **方案**：把"应用推荐参数"做成一个明确的"接受"按钮，状态切换为"已应用 + 显示原优化结果"，不要 silent 清空。
- **完成情况**：应用推荐参数或 Top 5 候选参数后，优化结果面板继续保留，并显示已应用状态。推荐参数按钮和已应用候选行会进入 disabled 状态，避免重复操作。

### C9 ✅ 暗色模式细节

- **现状**：暗色模式整体不错，但若干小问题：
  - lucide icons 默认还是黑色，在深色背景上对比度不足。
  - 优化进度条 `progress-track` 在暗色下是 `#1e293b`，有点看不清。
  - 图表的 `#64748b` 文字标签在暗色背景下偏暗。
  - 暗色下"快捷周期"按钮 active 状态绿色不够亮。
- **价值**：低。
- **成本**：1 小时。
- **方案**：用统一的图表主题配置处理暗色模式下的坐标轴、网格线、图例和 tooltip。
- **完成情况**：图表配置接入暗色主题，坐标轴、网格线、图例和 tooltip 会随主题切换；暗色下图标继承当前文本色，优化进度条、加载浮层、快捷周期 active 态和指标说明 icon 的对比度也已提升。

### C10 ✅ CSV 导出体验

- **现状**：导出是单一 CSV 把所有 series 混在一起靠 `series` 列区分。用户用 Excel 打开后还要 pivot 一次。
- **价值**：低-中。
- **成本**：1 小时。
- **方案**：要么按 series 分文件打 zip，要么改成宽表（每个 series 一组列）。
- **完成情况**：已改成按日期对齐的宽表 CSV。同一行包含本策略、固定 DCA、一次性买入和策略对决的投入金额、组合价值、倍率、评分、持仓回撤和账户回撤，Excel 打开后不需要再 pivot。导出内容生成函数已加单测。

---

## P3 — 新功能 / 产品差异化（按节奏选 1-2 个做）

这一档是真正影响产品定位的。建议每个迭代选 1 个，不要全做。

### D1 ✅ 滚动窗口表现（task-list #33）

- **价值**：高。直接回答"这策略在不同年份是否一致"——单一收益数字回答不了的问题。
- **成本**：1 天。
- **改动**：后端在 backtest 路径里多算一组 rolling-3y annualized return。前端加一张图。
- **差异化**：DCA 工具普遍只给汇总指标，给"时间剖面"立刻拉开差距。
- **注意**：3 年窗口在 5 年回测里只能取 2 个点，需要至少 5+ 年才有意义。前端要根据回测长度动态选 1y/3y。
- **完成情况**：已在回测结果中返回 `rollingPerformance`。长区间自动使用滚动 3 年年化，2-5 年区间使用滚动 1 年年化，短于约 2 年时不展示。口径采用现金流调整后的时间加权收益，前端同时展示本策略、固定 DCA 和一次性买入，用来观察表现是否集中在少数年份。

### D2 多标的组合定投（task-list #34）

- **价值**：高。从单标的工具变组合管理工具，定位级跃迁。
- **成本**：3-4 天（前端 + 后端都要大改）。
- **思路**：
  - 后端 `BacktestRequest` 改成 `assets: list[{symbol: str, weight: float}]`（单标的等价于 weight=1.0）。
  - 每个标的独立跑 backtest，最后汇总组合级别 metrics。
  - 组合评分策略可以"先按标的算 score 再加权"或"用组合整体的 drawdown/MA"两种语义，需要决策。
  - 前端加组合编辑器（饼图 + 权重滑块）、组合视图（堆叠柱、各标的贡献对比）。
- **风险**：UI 复杂度激增。建议先做"等权多标的"，权重编辑作为 follow-up。

### D3 蒙特卡洛模拟（新提出）⭐⭐ 强差异化

- **价值**：很高。回测看的是"过去发生了什么"，蒙特卡洛回答"未来可能发生什么"。
- **成本**：1-2 天。
- **方案**：
  - 用历史价格的对数收益率拟合 mu / sigma（或更高级的 GBM / regime-switching）。
  - 生成 1000 条未来 5 年价格路径。
  - 在每条路径上跑当前策略和固定 DCA。
  - 展示：终值的中位数 / 5/95 分位 / "策略战胜固定 DCA 的概率"。
- **差异化**：市面上没有 DCA 工具做这个。
- **风险**：用户可能误以为"模拟 = 预测"。需要明确文案"这是基于历史波动率的概率分布，不是预测"。

### D4 参数敏感度热力图（新提出）

- **价值**：中-高。"参数自动调优"找出最佳一组，但用户不知道为什么。热力图直观展示"哪个参数变化最影响结果"。
- **成本**：1 天。
- **方案**：固定其他参数，对单个参数做 grid search（10-20 个值），画一条线（X=参数值，Y=年化）。每个可调参数一张迷你图，整体一个 3x3 的小图墙。
- **差异化**：让"调参"从盲调变可视化。

### D5 压力测试（task-list #25）

- **价值**：中。心理价值高，但工程量适中。
- **成本**：1.5 天。
- **方案**：用户输入"未来 1/3/6 个月跌 X%"，系统在当前价格序列后面 append 模拟价格段，跑策略评价，展示推演的买入计划和最大浮亏。
- **风险**：模拟价格的形状（一次性跌、缓慢跌、V 型）会显著影响结果，需要 UI 让用户选择。

### D6 策略日记（task-list #26）

- **价值**：长期最高。解决 DCA 的真敌人——执行力。
- **成本**：3-5 天（含 SQLite 表设计、UI、月度复盘报告）。
- **触发条件**：当工具有了核心粘性（比如 D1 + 几个 D 系列）后再加。早期加会冷启动数据不够。

### D7 历史滚动 Sharpe / 滚动相关性（新提出）

- **价值**：中。专业用户喜欢的"指标的指标"。
- **成本**：半天。
- **方案**：rolling 12 月 Sharpe / rolling 12 月 portfolio vs 标的相关系数图。看"策略的表现稳不稳定"和"策略和买入并持有的差异是否在拉开"。

### D8 策略组合（meta-strategy）

- **价值**：中。"我同时跑跌幅加码和 RSI 情绪，每周各分配一半预算"。
- **成本**：1 天。
- **方案**：composite score 已经做"信号合成"，再加一个"金额分配合成"——把每周预算按权重分给多个策略各自决策。
- **差异化**：让用户自己组装策略组合。

### D9 实盘对账模式

- **价值**：中。用户输入实际买入记录（券商 CSV），系统对比"实际 vs 策略推荐"的差距。
- **成本**：2-3 天。
- **方案**：导入 CSV → 解析 → 在所有图表上叠加"实际买入"曲线 → 季度复盘报告。
- **差异化**：把工具从"事前推荐"扩展到"事后复盘"。

---

## 实验性 / 高风险高收益（不一定值得做，但值得想）

### E1 集成 macro 数据

- VIX / 联储利率 / 收益率曲线 / 失业率 → 做 macro-aware 策略。技术上拉 FRED API。
- 风险：数据源依赖、维护成本。
- 价值：差异化但用户群窄。

### E2 LLM 解读 + 智能问答

- "为什么本周建议投 120 美元而不是 100？"用 LLM 综合 marketState + signals + reasons 生成自然语言解读。
- 风险：成本（API call）、幻觉、对工具基调的破坏。
- 价值：降低非专业用户门槛。
- 建议：作为可选 sidebar，不强推。

### E3 加密资产支持

- BTC / ETH 的 yfinance 也覆盖。但波动率 + 流动性 + 假期模式（24/7 vs 5/2）和 ETF 完全不同。
- 风险：需要重新校准所有阈值（30% drawdown 在 BTC 是常态）。
- 价值：用户群完全不同。
- 建议：作为独立 mode（"crypto mode"）而不是混在 ETF 列表里。

### E4 "教学回放"

- 用户看 2020-03 那段：暂停、解释信号、让用户预测下一周策略会怎么决策、给出实际答案。
- 价值：教育，让用户理解"为什么策略这样选"。
- 成本：UI 复杂，但内容可以慢慢加。

### E5 公开排行榜

- 用户的策略+参数可以提交到公开榜单，按 5/10 年回测排行。
- 风险：数据隐私、刷榜、过拟合鼓励。
- 价值：社区效应。
- 建议：远期选项。

---

## 工程质量 / 运维（不论做不做新功能都要持续做）

### Q1 测试覆盖率

- 后端 45 个用例，但没有覆盖率统计。先 `pytest --cov=app --cov-report=term-missing` 看一遍。
- 估计 strategies.py 覆盖良好（80%+），data.py 不足（缺真实 yfinance 错误注入），main.py 仅入口被覆盖。
- 目标：90%+ on strategies.py / backtester.py / optimizer.py，70%+ on main.py / data.py。

### Q2 前端 E2E 测试

- 用 Playwright 写 3-5 个关键流程：切策略 + 调参 + 看回测结果、跑稳健调优、压力场景、CSV 导出。
- 即使每周跑一次也能在大改之后兜底。
- 成本：1 天搭起来，每个用例 30 分钟。

### Q3 结构化日志

- 当前后端日志四散在 `server.err.log` / `server.out.log` / `server.job.log` / `uvicorn.log`。看不出来谁在做什么。
- 改成 stdlib `logging` + JSON formatter。每个请求带 request_id。
- 成本：半天。

### Q4 健康检查 + 简单监控

- `GET /api/health` 返回 `{ status, dataCacheSize, uptimeSeconds }`。
- 优化任务的 dict 长期累积（`optimization_jobs._jobs`），加一个定时清理（保留最近 100 条）。
- 成本：1 小时。

### Q5 价格缓存清理策略

- 当前 SQLite 的 PriceBar 表无限制累积。10 个标的 × 10 年 ≈ 25k 行，没问题；但如果有人开了 50 个标的的话会涨。
- 加一个简单 TTL 或 LRU 清理脚本。
- 触发条件：标的数量超过 30 个时再做。

### Q6 部署文档

- 至少写一份 `docs/deployment.md`，覆盖：
  - 单机 Docker 部署
  - 反向代理（nginx 示例）
  - HTTPS / 域名
  - 数据卷持久化
  - 升级流程（数据库迁移当前没做，要么明确"不破坏 schema"，要么引入 alembic）

### Q7 安全扫描

- `pip-audit` / `npm audit` 跑一遍，看依赖有没有 CVE。CI 加上每周一次扫描。
- 当前 yfinance 依赖链（含 lxml、html5lib 等）有过历史 CVE，值得跟踪。

---

## 文档收尾

### M1 README 升级

- 当前 README 是 v0.2 时点的快照。本次 P0/P1/P2 修复后应当更新：
  - 明确"已包含分红再投资（auto_adjust）"
  - 添加"无风险利率可配置"功能说明
  - "Assumptions & Limitations" 段补充"warmup 期间会显示提示"
  - 加一个 GIF / 截图，展示工作台样子（README 现在纯文字）

### M2 整理 user-guide.md 和 task-list.md 的关系

- 当前 task-list.md 已经成了"代码审查 + 修复历史档案"，混合了 P0/P1/P2 已修和 P3 待办。
- 建议拆成：
  - `docs/CHANGELOG.md`（按时间线记录已修复条目，链到 change-log/*.md）
  - `docs/ROADMAP.md`（这份文档，按优先级记录待做条目）
  - `docs/user-guide.md` 保留并继续更新

### M3 写一份 ARCHITECTURE.md

- 一页纸说清楚：数据流（yfinance → SQLite cache → DcaBacktester → API → React），关键决策（为什么选 ECharts、为什么 Pydantic v2、为什么 SQLite 不 Postgres），扩展点（怎么加新策略、怎么加新指标、怎么加新图表）。
- 价值：未来接手者能在 30 分钟内进入状态。

---

###### 个人推荐的执行顺序

P0 + P1 + P2 第一档已合并（2026-05-22）。下一档建议从 P2 后半 + C1 挑：

1. **D3 蒙特卡洛模拟**（1-2 天）—— 强差异化，回答概率分布而不是只看历史。
2. **D2 多标的组合定投**（3-4 天）—— 产品定位升级，但 UI 和后端改动更大。
3. **D4 参数敏感度热力图**（1 天）—— 给自动调优补解释层，让用户知道参数为什么这样选。

**最值得多花时间想清楚的是 D2（多标的组合）和 D3（蒙特卡洛）**，
这两个能把工具从"研究工具"升级到"决策助手"，但工程量大、设计成本高。
建议先做 D3 或 D4 继续增强"决策解释力"，D2 则适合作为一次较完整的组合管理版本。

---

## 不建议做的事情

- **支持自定义策略 DSL / 用户写代码定义策略**：复杂度爆炸，当前用户群也不需要。
- **加更多 cosmetic 功能**（动画过渡、品牌化、3D 图表）：当前体验已经超过同类工具，进一步打磨边际收益低。
- **真实交易 API 接入**：不在产品定位内（disclaimer 明确说"不自动下单"），也是合规炸药。
- **完整用户系统（注册/登录）**：当前是本地工具定位，加用户系统就要做服务端、隐私、密码安全，工程量爆炸。如果有云端部署需求再考虑。

---

## 总结

这次代码审查的三轮工作（P0 5 项 + P1 3 项 + P2 6 项）已经把"代码层面的债务"清干净了。从这里开始，**工程基础（CI、测试、Docker）和架构债（拆 main.tsx、优化器并行）应该是下个月的主线**。功能层面，**滚动窗口 + 多标的 + 蒙特卡洛**是最能拉开差距的三个方向。

任何一项开工都建议先开 issue / 写设计稿，别上来就写代码。这份文档可以作为讨论的起点。
