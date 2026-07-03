# D3 蒙特卡洛模拟 — 设计稿

> 状态:草案,待用户确认后开工
> 日期:2026-07-03
> 关联路线图:[roadmap-2026-q3.md](./roadmap-2026-q3.md) §D3

---

## 1. 目标与边界

### 解决什么问题
回测回答"过去发生了什么",LLM 解读回答"过去为什么这样",**蒙特卡洛回答"未来可能怎样"**。
三者闭环后,工具从"研究工具"升级为"决策助手"。

### 不解决什么
- **不预测未来**。GBM 假设收益率独立同分布,真实市场有肥尾、波动率聚集、regime 切换,任何"未来路径"都是概率分布的一个样本,不是预报。
- **不做 regime-switching / jump-diffusion** 等高阶模型。第一版用最朴素 GBM,把工程量压在"分布展示"而非"模型复杂度",避免过拟合嫌疑。后续可作为 D3.1 升级。

### 用户故事
> 我跑完一次 QQQ + composite_score 的 10 年回测,看到年化 12%、最大回撤 18%。
> 但我不知道:如果未来 5 年波动率和过去类似,这个策略的终值大概在什么区间?
> 它有多大把握跑赢"每周固定投 100 美元"?
> 蒙特卡洛面板就是回答这两个问题。

---

## 2. 数学模型

### 收益率拟合
从历史价格序列(用户回测使用的同一份 `prices`)取日对数收益率:

```
log_returns = ln(close_t / close_{t-1})
mu_daily  = mean(log_returns)
sigma_daily = std(log_returns, ddof=1)
```

转换年化用于展示:
```
mu_annualized    = 252 * mu_daily
sigma_annualized = sqrt(252) * sigma_daily
```

### 路径生成(GBM)
对未来 `H` 个月(默认 60),每个交易日:
```
S_{t+1} = S_t * exp((mu - 0.5 * sigma²) * dt + sigma * sqrt(dt) * Z)
Z ~ N(0, 1)
dt = 1 / 252
```
- 起点价格 `S_0` = 回测区间最后一天的收盘价
- 总步数 = `H * 21`(每月约 21 个交易日)
- 生成 `N` 条路径(默认 1000),用 `numpy.random.default_rng(seed)` 保证可复现

### 策略执行
对每条生成的价格路径:
1. 拼接:历史 `prices` + 模拟未来段(只保留 `close` 列,日期用 `pd.bdate_range` 顺延)
2. 复用 `prepare_market(...)` + `evaluate_prepared_strategy(...)` 跑当前策略
3. 记录该路径的:策略终值、固定 DCA 终值、一次性买入终值

### 分布统计
跨 N 条路径算:
- 5 / 25 / 50 / 75 / 95 分位数(策略、固定 DCA、一次性各一组)
- **策略战胜固定 DCA 的概率** = `mean(strategy_final > fixed_dca_final)`
- 中位数路径(用于主图叠加)
- 5-95 / 25-75 分位带(用于主图填充)

---

## 3. 数据流

```
用户在前端调好策略参数 + 点"推演未来"
        │
        ▼
POST /api/simulations/montecarlo
        │
        ▼
后端:
  1. validate_symbol + get_price_history(同回测)
  2. 拟合 mu / sigma
  3. 生成 N 条未来价格路径(numpy)
  4. 对每条路径:拼接历史+未来 → prepare_market → evaluate_prepared_strategy
  5. 收集终值,算分位数 + 战胜概率
  6. 返回结构化结果
        │
        ▼
前端:
  - ECharts 画分位带图(主图)
  - 关键数字卡片(中位数、5-95区间、战胜概率)
  - 兜底文案(不预测声明)
```

**复用既有缓存**:`prepare_market` 的语义缓存键 `(shape, index[0], index[-1], close[0], close[-1], settings)` 对每条模拟路径都不同,所以不能跨路径共享。但单次 MC 请求内 N 条路径串行跑,无需清缓存(每条键都不同,不会脏读)。

---

## 4. API 形状

### 请求
```python
class MonteCarloRequest(BaseModel):
    symbol: str
    startDate: date
    endDate: date
    config: StrategyConfig
    horizonMonths: int = 60        # 12-120
    numPaths: int = 1000           # 100 / 500 / 1000 / 2000
    seed: int | None = None        # 可复现,默认随机
```

### 响应
```python
class MonteCarloResponse(BaseModel):
    symbol: str
    horizonMonths: int
    numPaths: int
    seed: int                       # 返回实际用的种子,便于复现
    fittedParams: FittedParams      # mu/sigma 年化,供前端展示
    strategy: ScenarioStats
    fixedDca: ScenarioStats
    lumpSum: ScenarioStats
    beatFixedDcaProbability: float  # 0-1
    chart: ChartData                # 直接给前端画图用的数据
    disclaimer: str

class FittedParams(BaseModel):
    muDaily: float
    sigmaDaily: float
    muAnnualized: float
    sigmaAnnualized: float
    sampleSize: int                 # 用了多少个交易日拟合

class ScenarioStats(BaseModel):
    p5: float
    p25: float
    p50: float
    p75: float
    p95: float
    mean: float
    std: float

class ChartData(BaseModel):
    months: list[int]               # [0, 1, 2, ..., H]
    strategyMedian: list[float]     # 每月的中位数组合价值
    strategyBand5_95: list[tuple[float, float]]   # (lower, upper)
    strategyBand25_75: list[tuple[float, float]]
    fixedDcaMedian: list[float]
    lumpSumMedian: list[float]
```

### 端点
`POST /api/simulations/montecarlo` — 在 `main.py` 注册。

### 错误处理
- 数据不足(< 1 年历史):返回 `insufficient_data` 错误
- horizon 超出 120 月:返回 `invalid_horizon`
- numPaths 不在白名单 [100, 500, 1000, 2000]:返回 `invalid_num_paths`

### 不接 LLM
**第一版不接 LLM 解读**。原因:
- MC 输出已经是结构化概率分布,不需要自然语言再加工
- 避免和刚做完的 E2 问答功能耦合
- 如果用户想问"为什么战胜概率是 62%",可以直接在现有 LLM 问答面板问,上下文里会带 MC 结果(后续可作为 D3.2 增强)

---

## 5. UI 放置

### 位置
回测结果区下方,作为**新卡片**"未来推演 (蒙特卡洛模拟)"。
不挤进现有"指标卡片"行,避免干扰回测结果的清晰度。

### 卡片布局(遵循用户偏好:紧凑、聚合、高对比度)

```
┌─ 未来推演 ──────────────────────────────────────────────────────┐
│  基于过去 10 年波动率,模拟未来 60 个月的可能路径分布              │
│                                                                  │
│  推演时长 [────●────] 60 月    路径数 [1000 ▾]   [开始推演]      │
│  ────────────────────────────────────────────────────────────   │
│                                                                  │
│  ┌─ 分位带图(主图, ECharts)──────────────────┐  ┌─ 关键数字 ─┐ │
│  │                                            │  │ 策略中位数  │ │
│  │      ╭───────╮  ← 95 分位                  │  │ $ 18,420   │ │
│  │     ╱ ── ── ╲     (浅色填充 5-95)          │  │ 5-95 区间  │ │
│  │    │ ────── │    ← 中位数(粗线)           │  │ $9.2k-32k  │ │
│  │     ╲ ── ── ╱     (中色填充 25-75)          │  │ ────────   │ │
│  │      ╰───────╯  ← 5 分位                   │  │ 战胜固定   │ │
│  │   ─ ─ ─ ─ ─ ─     ← 固定DCA中位数(虚线)   │  │ 定投概率   │ │
│  │                                            │  │   62 %     │ │
│  │  0      20      40      60  月             │  │ (大字突出) │ │
│  └────────────────────────────────────────────┘  └────────────┘ │
│                                                                  │
│  ⚠ 基于历史波动率的概率分布,不是预测。真实市场存在肥尾、波动率  │
│    聚集和 regime 切换,实际结果可能显著偏离此分布。              │
└──────────────────────────────────────────────────────────────────┘
```

### 交互细节
- **推演时长滑块**:12-120 月,步长 6,默认 60。滑块旁实时显示"X 月 = X 年"
- **路径数下拉**:100 / 500 / 1000 / 2000。1000 默认。>1000 时滑块旁加提示"计算较慢"
- **开始推演按钮**:点击后按钮 disabled + 显示"推演中…(约 5 秒)",主图区域显示骨架屏
- **主图 hover**:tooltip 显示该月的 5/25/50/75/95 分位数值
- **关键数字卡**:
  - 策略中位数终值(大字)
  - 5-95 区间(小字)
  - 战胜固定 DCA 概率(超大字,金色 `--accent` 突出)
  - hover 战胜概率 → tooltip 解释"在 1000 条模拟路径中,有 620 条策略终值高于固定定投"
- **底部 disclaimer**:永远可见(不折叠),用 `--text-secondary` 灰色小字

### 与既有设计语言对齐
- 卡片:`background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 8px`
- 标题:`var(--text-primary)` 粗体,与"AI 解读"卡片同级
- 主图配色:
  - 策略中位数:`var(--accent)`(金色粗线)
  - 5-95 带:`rgba(var(--accent-rgb), 0.08)`
  - 25-75 带:`rgba(var(--accent-rgb), 0.18)`
  - 固定 DCA 中位数:`var(--text-secondary)` 虚线
  - 一次性买入中位数:`var(--link)` 虚线
- 暗色模式:全用 CSS 变量,自动适配

---

## 6. 文案策略(避免误导)

### 标题
- 卡片标题:**未来推演**
- 副标题:**基于过去 X 年的波动率,模拟未来 Y 个月的路径分布**

### 关键数字标签
- "策略中位数终值"(不写"预计终值")
- "5-95 分位区间"(不写"波动范围")
- "策略战胜固定定投的概率"(不写"胜率")

### 鼠标 hover 文案
- 战胜概率:"在 {N} 条模拟路径中,有 {win} 条策略终值高于固定定投"
- 分位带:"此月份有 90% 的模拟路径终值落在 ${low} - ${high} 之间"

### 兜底 disclaimer(底部常驻)
> ⚠ 基于历史波动率的概率分布,不是预测。真实市场存在肥尾、波动率聚集和 regime 切换,实际结果可能显著偏离此分布。过去的表现不代表未来回报。

### 禁用词
- "预测""预计""将会""一定""必然"
- "胜率"(用"概率"替代,避免赌徒语义)
- "稳定收益""保本"

---

## 7. 风险与限制

### 模型风险
| 风险 | 缓解 |
|------|------|
| GBM 假设 i.i.d. 收益率,忽略肥尾 | 文案明确"真实市场存在肥尾" |
| 历史波动率不代表未来 | 文案明确"基于历史波动率" |
| 1000 条路径在极端分位仍有统计噪声 | p5/p95 用 `numpy.percentile` 插值,平滑展示 |
| 模拟路径起点用最后收盘价,若回测末尾是异常高点会高估 | 不做特殊处理,但展示 `S_0` 让用户判断 |

### 工程风险
| 风险 | 缓解 |
|------|------|
| 1000 路径 × 60 月 × 策略评估 = 较慢 | 单次请求内串行跑,前端骨架屏 + 5 秒预估;不异步任务化(避免复杂度) |
| `prepare_market` 缓存被 N 条路径污染 | MC 端点结束后调 `clear_prepare_cache()` |
| 内存峰值:1000 × 1260 × DataFrame | 每条路径评估完只保留终值,中间 DataFrame 立即释放 |

### 性能预算
- 1000 路径 × 60 月:目标 < 8 秒(单线程)
- 2000 路径 × 120 月:目标 < 25 秒,前端提示"计算较慢"
- 若超时,返回 `mc_timeout` 错误,建议减少路径数或缩短时长

---

## 8. 测试计划

### 后端单测(`tests/test_simulation.py`)
1. `test_fit_log_returns_returns_correct_mu_sigma` — 已知序列的 mu/sigma
2. `test_generate_paths_respects_seed` — 同种子生成相同路径
3. `test_generate_paths_start_price_matches` — 起点价格 = 历史最后收盘
4. `test_montecarlo_returns_percentiles` — 返回 5/25/50/75/95 分位
5. `test_montecarlo_beat_probability_in_range` — 概率在 [0, 1]
6. `test_montecarlo_rejects_short_history` — < 1 年历史报错
7. `test_montecarlo_rejects_invalid_horizon` — > 120 月报错
8. `test_montecarlo_rejects_invalid_num_paths` — 非白名单值报错
9. `test_montecarlo_strategy_runs_on_simulated_prices` — 策略在模拟路径上能正常评估
10. `test_chart_data_months_length_matches_horizon` — chart.months 长度 = H+1

### 前端
- 不写组件单测(项目前端测试以 utils 为主,组件靠手动验证 + E2E)
- 手动验证:亮/暗模式切换、滑块联动、hover tooltip、disclaimer 常驻

### Lint
- `ruff check app tests` 全过
- `tsc --noEmit` + `eslint` 全过

---

## 9. 实现步骤

1. **后端 models.py**:加 `MonteCarloRequest` / `MonteCarloResponse` / `FittedParams` / `ScenarioStats` / `ChartData`
2. **后端 app/simulation.py**:
   - `fit_log_returns(prices)` → `FittedParams`
   - `generate_paths(s0, mu, sigma, horizon_months, num_paths, seed)` → `np.ndarray (N, H*21)`
   - `run_montecarlo(request, prices, currency)` → `MonteCarloResponse`
   - 内部循环:对每条路径拼 DataFrame + `prepare_market` + `evaluate_prepared_strategy`,收集终值
3. **后端 main.py**:加 `POST /api/simulations/montecarlo` 端点,接入 `clear_prepare_cache`
4. **后端 tests/test_simulation.py**:10 个测试用例
5. **前端 types.ts**:从生成后的 `api.generated.ts` re-export MC 类型
6. **前端 api.ts**:加 `runMonteCarlo(req)` 函数
7. **前端 components/MonteCarloPanel.tsx**:
   - state:`result` / `loading` / `error` / `params(horizon, numPaths)`
   - 滑块 + 下拉 + 按钮
   - ECharts 分位带图配置(参考 `useChartOptions.ts` 既有风格)
   - 关键数字卡
   - disclaimer
8. **前端 App.tsx**:在回测结果区下方挂载 `<MonteCarloPanel>`
9. **前端 styles.css**:加 `.monte-carlo-panel` 相关样式,全用 CSS 变量
10. **导出 OpenAPI**:`python backend/app/export_openapi.py` → 前端 `openapi-typescript`
11. **验证**:pytest + ruff + tsc + eslint

---

## 10. 不做范围(明确排除)

- ❌ **不接 LLM 解读 MC 结果**(D3.2 增强)
- ❌ **不做 regime-switching / jump-diffusion 模型**(D3.1 增强)
- ❌ **不做异步任务化**(同步即可,1000 路径 < 8 秒)
- ❌ **不做路径数自定义输入**(只允许白名单 4 档)
- ❌ **不做对比策略的 MC**(只对当前主策略 + 固定 DCA + 一次性,对比策略不跑)
- ❌ **不做导出 CSV**(MC 是概率分布,导出意义不大)

---

## 11. 待确认决策点

请用户在开工前确认以下几点:

1. **卡片位置**:回测结果区下方 vs 优化面板下方 vs 独立 Tab?
   - 推荐:回测结果区下方(与"AI 解读"同级,形成"过去→未来"叙事)
2. **默认参数**:60 月 + 1000 路径,是否合适?
3. **是否需要 LLM 解读 MC**:第一版不接,后续 D3.2 再加,可以吗?
4. **路径数上限**:2000 是否够?要不要加 5000 档(会更慢)?
5. **一次性买入对比**:是否保留?(若用户预算=定投总投入,一次性买入对比有意义;若用户没有这笔钱,对比可能误导)
