# D5 压力测试 (What-if) — 设计稿

> 状态:草案
> 日期:2026-07-06
> 关联路线图:[roadmap-2026-q3.md](./roadmap-2026-q3.md) §D5、[task-list.md](./task-list.md) #25

---

## 1. 目标与边界

### 解决什么问题
回测回答"过去发生了什么",蒙特卡洛回答"未来可能怎样",**压力测试回答"如果暴跌明天发生,我的策略会怎么决策、我能承受多大浮亏"**。

三者闭环后,用户在暴跌前就做好了心理准备,减少恐慌操作。

### 不解决什么
- **不预测暴跌是否会发生**。用户自己设假设场景,系统只负责推演。
- **不做概率分布**。这是确定性单路径推演,不是 MC。MC 回答分布,压力测试回答"最坏情况下我会怎样"。
- **不接 LLM 解读**。第一版不接,和 D3 蒙特卡洛保持一致。

### 用户故事
> 我跑完一次 QQQ + composite_score 的 5 年回测,看到年化 12%、最大回撤 18%。
> 但我不知道:如果下个月再跌 20%,我的策略会建议投多少?我会浮亏多少?
> 压力测试面板就是回答这两个问题。

---

## 2. 场景模型

### 路径形状 (shape)
用户选择未来价格路径的形状。三种预设:

| shape | 含义 | 数学 |
|-------|------|------|
| `one_time` | 一次性跌/涨后横盘 | 第 1 个交易日即到目标价,之后保持不变 |
| `gradual` | 线性渐变 | 从 S_0 线性插值到目标价,每日等比例变动 |
| `v_shape` | V 型反转 | 中点跌/涨到目标价,末点回到 S_0 |

### 参数
| 参数 | 范围 | 默认 | 说明 |
|------|------|------|------|
| `totalChangePct` | -60 ~ +60 | -20 | 总变动百分比,负=跌,正=涨 |
| `horizonMonths` | 1 / 3 / 6 / 12 | 3 | 推演时长 |
| `shape` | one_time / gradual / v_shape | v_shape | 路径形状 |

### 路径生成
- `S_0` = 回测区间最后一天的收盘价
- 总步数 = `horizonMonths × 21`(每月约 21 个交易日)
- `one_time`: `S_t = S_0 × (1 + change)` 对所有 t ≥ 1
- `gradual`: `S_t = S_0 × (1 + change × t / steps)`
- `v_shape`: `S_t = S_0 × (1 + change × (1 - |2t/steps - 1|))`,中点达极值,末点回 S_0

---

## 3. 数据流

```
用户在前端选好场景参数 + 点"推演"
        │
        ▼
POST /api/stress-tests/run
        │
        ▼
后端:
  1. validate_symbol + get_price_history(同回测,含 3 年 warmup)
  2. 按 shape + change + horizon 生成单条未来价格路径
  3. 拼接历史 + 未来 → 合成价格序列
  4. DcaBacktester.run() 跑策略(用完整合成序列,指标会覆盖未来段)
  5. 同样跑 fixed_dca 和 lump_sum
  6. 过滤出未来段的 contribution events
  7. 从未来段 events 算 maxFloatingLoss
  8. 返回结构化结果
        │
        ▼
前端:
  - 未来买入明细表(日期、价格、金额、倍率、评分)
  - 最大浮亏卡片
  - 组合价值曲线图(历史段实线 + 未来段高亮)
  - 策略 vs 固定 DCA vs 一次性对比
  - 兜底 disclaimer
```

**复用既有基础设施**:`DcaBacktester.run()` / `_run_fixed` / `run_lump_sum` 全部复用,`prepare_market` 用合成序列算指标。单路径无需清缓存(MC 才需要)。

---

## 4. API 形状

### 请求
```python
class StressTestRequest(BaseModel):
    symbol: str = "QQQ"
    startDate: date | None = None
    endDate: date | None = None
    config: StrategyConfig = Field(default_factory=StrategyConfig)
    shape: str = "v_shape"           # one_time | gradual | v_shape
    totalChangePct: float = -20.0    # -60 ~ +60
    horizonMonths: int = 3           # 1 / 3 / 6 / 12
```

### 响应
```python
class StressTestResponse(BaseModel):
    symbol: str
    shape: str
    totalChangePct: float
    horizonMonths: int
    startPrice: float                 # S_0
    endPrice: float                   # 末点价格
    minPrice: float                   # 路径最低价
    # 未来段的买入明细(策略 / 固定 DCA / 一次性各一组)
    strategyContributions: list[ContributionEvent]
    fixedDcaContributions: list[ContributionEvent]
    lumpSumContributions: list[ContributionEvent]
    # 未来段指标
    strategyMetrics: StressTestMetrics
    fixedDcaMetrics: StressTestMetrics
    lumpSumMetrics: StressTestMetrics
    # 未来段价格序列(给前端画图)
    futurePriceSeries: list[PricePoint]
    disclaimer: str

class StressTestMetrics(BaseModel):
    totalInvested: float
    endingValue: float
    returnPct: float
    maxFloatingLossPct: float    # 最差浮亏(组合价值 - 已投入) / 已投入
    buyCount: int
```

### 端点
`POST /api/stress-tests/run` — 在 `main.py` 注册。

### 错误处理
- `totalChangePct` 超出 [-60, 60]:返回 `invalid_change_pct`
- `horizonMonths` 不在白名单 [1, 3, 6, 12]:返回 `invalid_horizon`
- `shape` 不在白名单:返回 `invalid_shape`
- 历史数据不足(< 252 天):复用 `PriceDataError(code="insufficient_data")`

---

## 5. UI 放置

### 位置
回测结果区下方,与"未来推演(蒙特卡洛)"同级,作为**新卡片**"压力测试 (What-if)"。

### 卡片布局
```
┌─ 压力测试 (What-if) ───────────────────────────────────────────┐
│  假设未来 N 个月价格变动,推演策略的买入决策和最大浮亏            │
│                                                                  │
│  场景形状 [V 型反转 ▾]  总变动 [───●──] -20%  时长 [3 月 ▾]     │
│  [开始推演]                                                      │
│  ────────────────────────────────────────────────────────────   │
│                                                                  │
│  ┌─ 关键数字 ───────────────────────────────────────────────┐  │
│  │  最大浮亏          策略期末值     固定 DCA 期末值          │  │
│  │  -8.3%             $2,840         $2,710                  │  │
│  │  (红色突出)        策略多投 4.8%                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ 组合价值曲线 ───────────────────────────────────────────┐  │
│  │  历史段(实线) │ 未来段(高亮色)                          │  │
│  │  策略 / 固定 DCA / 一次性 三条线                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ 未来买入明细 ───────────────────────────────────────────┐  │
│  │  日期       价格     策略金额  倍率   评分   固定 DCA     │  │
│  │  2026-07-13 $345.20  $118.50   1.19   0.72   $100         │  │
│  │  ...                                                     │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ⚠ 假设场景推演,不是预测。真实市场的暴跌形状、持续时间和反弹   │
│    节奏会显著偏离此模型。                                       │
└──────────────────────────────────────────────────────────────────┘
```

### 交互细节
- **场景形状下拉**:V 型反转(默认) / 一次性暴跌 / 线性渐跌
- **总变动滑块**:-60% ~ +60%,步长 5%,默认 -20%。负值标红,正值标绿
- **时长下拉**:1 / 3 / 6 / 12 月。默认 3 月
- **开始推演按钮**:点击后 disabled + "推演中…",结果区骨架屏
- **关键数字卡**:
  - 最大浮亏(红色 `--danger` 突出,大字)
  - 策略期末值 + 相对固定 DCA 差值
  - hover 浮亏 → "未来段组合价值最低点距已投入的缺口"
- **组合价值曲线**:历史段灰色实线,未来段彩色高亮,三条线对比
- **未来买入明细表**:只显示未来段的买入事件
- **底部 disclaimer**:永远可见

---

## 6. 文案策略

### 标题
- 卡片标题:**压力测试 (What-if)**
- 副标题:**假设未来 {N} 个月价格{涨/跌}{X}%,推演策略的买入决策和最大浮亏**

### 关键数字标签
- "最大浮亏" — 不写"最大亏损",因为未实现
- "策略期末值" — 不写"预计收益"
- "策略多投/少投 X%" — 相对固定 DCA

### 兜底 disclaimer
> ⚠ 假设场景推演,不是预测。真实市场的暴跌形状、持续时间和反弹节奏会显著偏离此模型。过去的表现不代表未来回报。

### 禁用词
- "预测""预计""将会""一定""必然"
- "稳定收益""保本""安全"

---

## 7. 测试计划

### 后端单测 (`tests/test_stress_test.py`)
1. `test_generate_path_one_time_drop` — 一次性跌 20%,所有未来点 = S_0×0.8
2. `test_generate_path_gradual_decline` — 线性跌,末点 = S_0×0.8
3. `test_generate_path_v_shape_midpoint_extreme` — V 型中点最低,末点回 S_0
4. `test_generate_path_positive_change_is_jump` — +20% 生成上涨路径
5. `test_stress_test_returns_future_contributions` — 返回的 events 都在未来段
6. `test_stress_test_max_floating_loss_is_negative` — 跌幅场景浮亏 < 0
7. `test_stress_test_rejects_invalid_shape` — 非法 shape 报错
8. `test_stress_test_rejects_invalid_change_pct` — 超出 ±60 报错
9. `test_stress_test_rejects_invalid_horizon` — 非白名单月数报错
10. `test_stress_test_strategy_buys_more_on_drawdown` — 跌幅加码策略在跌时倍率 > 1

### Lint
- `ruff check` + `ruff format --check` 全过
- `tsc --noEmit` + `eslint` 全过

---

## 8. 实现步骤

1. **后端 models.py**:加 `StressTestRequest` / `StressTestResponse` / `StressTestMetrics`
2. **后端 app/stress_test.py**:
   - `generate_stress_path(s0, shape, total_change_pct, horizon_months)` → `np.ndarray`
   - `run_stress_test(request, prices, currency)` → `StressTestResponse`
   - 内部:拼接合成价格 → `DcaBacktester.run()` → 过滤未来 events → 算 maxFloatingLoss
3. **后端 main.py**:加 `POST /api/stress-tests/run` 端点
4. **后端 tests/test_stress_test.py**:10 个测试用例
5. **前端 types.ts**:从 `api.generated.ts` re-export 压力测试类型
6. **前端 api.ts**:加 `runStressTest(req)` 函数
7. **前端 components/StressTestPanel.tsx**:场景控件 + 关键数字 + 曲线 + 明细表
8. **前端 App.tsx**:在蒙特卡洛面板下方挂载 `<StressTestPanel>`
9. **前端 styles.css**:加 `.stress-test-panel` 样式
10. **导出 OpenAPI**:`python backend/export_openapi.py` → 前端 `openapi-typescript`
11. **验证**:pytest + ruff + tsc + eslint + vitest

---

## 9. 不做范围

- ❌ **不做多路径/概率分布**(那是 D3 蒙特卡洛的事)
- ❌ **不接 LLM 解读**
- ❌ **不做自定义路径形状**(只预设 3 种)
- ❌ **不做导出 CSV**(单路径推演,导出意义不大)
- ❌ **不对对比策略跑压力测试**(只对当前主策略 + 固定 DCA + 一次性)
