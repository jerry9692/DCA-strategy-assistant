# DCA Strategy Assistant v0.4

[![EN](https://img.shields.io/badge/lang-English-blue)](README.en.md)

一个用于动态定投（DCA）策略研究的本地 Web 应用。不再每次都投相同金额，而是根据 7 种市场驱动的策略动态调整每期投入——市场跌得多就多买，涨得过热就少买。

当前内置美股 ETF 和第一批 A 股核心 ETF。美股覆盖宽基、红利/价值、国际、债券、商品及高波动品种；A 股目前包括上证 50、沪深 300、中证 500、创业板、科创 50 指数 ETF。前端按市场分离后再展示标的列表。

> **免责声明**：本工具仅用于研究和决策辅助，不自动下单，不连接券商 API，不构成投资建议。

## 策略一览

| 策略 | 逻辑 |
|------|------|
| 固定定投 (Fixed DCA) | 每期投入相同金额（基准参照） |
| 跌幅加码 (Drawdown Boost) | 价格相对 252 日高点跌幅越大，投得越多 |
| 均线偏离 (MA Deviation) | 低于 200 日均线多投，高于则少投 |
| 历史分位 (Historical Percentile) | 价格在 756 日窗口中所处分位越低，投得越多 |
| RSI 情绪 (RSI Sentiment) | RSI 超卖（<30）多投，超买（>70）少投 |
| 网格加权 (Grid Weighted) | 在滚动价格区间内分档，每档赋予不同倍率 |
| 组合评分 (Composite Score) | 上述五个信号加权合成 |

每种策略返回建议投入金额、倍率、评分、原始信号值和可读的理由说明。

默认动态范围刻意收窄：**最低 0.8 倍，最高 1.2 倍**。定位是纪律性定投 + 小幅调整，而非择时交易。

## v0.3 更新

- 修复了周末/月初非交易日开始时回测会重复买入同一个交易日的 bug。
- 信号预热不足时显式提示用户而不是悄悄按基础金额执行；前端在建议卡上方有黄色警示横幅。
- 优化器跨场景平均时正确处理 `versusFixedPct=None` 的场景，避免脆弱候选爬到榜首。
- 4 张主图表统一改为时间轴 + `[date, value]` 元组数据，多 series 按日期对齐而非按索引对齐。
- 区间末端补一笔 mark-to-market 事件，让 endingValue / 最大回撤 / IRR 反映末端真实价格。
- 无风险利率从硬编码 4% 变成可配置滑块（0-10%），影响夏普 / 索提诺。
- `StrategyConfig` 校验 `minMultiplier < maxMultiplier`，避免把工具退化成"始终低于基础金额"。
- yfinance 偶发只返回 Adj Close 时优雅降级，不再抛 KeyError。
- `ContributionEvent` frozen 化，防止 lru_cache 被下游意外修改污染。
- 文档对齐实际行为：明确历史回测**已经隐含分红再投资**（auto_adjust）。
- C1 扩展内置标的：26 个美股 ETF + 5 个 A 股基础指数 ETF，并用 `市场` + `标的` 双下拉避免长列表混杂。
- D1 新增滚动表现图：假设从每个滚动窗口起点开始执行对应方案，展示窗口内新增投入的 3 年 / 1 年资金年化，用来观察策略是否只在少数年份表现好。
- E2 LLM 智能解读（前半）：接入 OpenAI 兼容 API（支持 OpenAI / DeepSeek / Moonshot / 智谱等），用自然语言解释"为什么本期建议投这个金额"。API Key 仅存浏览器 localStorage，经本地后端转发，不落盘不记录。智能问答部分待后续迭代。

## v0.2 更新

- 与固定 DCA 和一次性投入（lump-sum）双基准对比。
- 从 50/200 日均线读取当前市场状态。
- 除收益率和回撤外，增加夏普比率和索提诺比率评估。
- 策略对决：同标的、同区间内最多对比 3 个额外策略。
- 保守 / 均衡 / 激进三档参数预设，保存到 localStorage。
- 可重放预设危机场景（2020 熔断、2022 加息等）。
- 明暗主题切换，支持按日期对齐的宽表 CSV 导出。
- 跨多市场阶段验证参数稳健性，生成调优建议。

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Python 3.10+, FastAPI, pandas, numpy, yfinance, SQLModel (SQLite) |
| 前端 | React 18, TypeScript, Vite, Apache ECharts |
| 测试 | pytest, Vitest |

## 快速开始

### 环境要求
- Python 3.10+
- Node.js 18+

### Windows 一键启动

双击 `start-dev.bat`，或在 PowerShell 中运行：

```powershell
.\start-dev.ps1
```

脚本会打开两个 PowerShell 窗口，分别启动后端和前端：

- 后端：`http://127.0.0.1:8000`
- 前端：`http://127.0.0.1:5173`

如果缺少依赖，先运行一次：

```powershell
.\start-dev.ps1 -Install
```

### 手动启动后端

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

API 运行在 `http://127.0.0.1:8000`。首次请求时自动从 Yahoo Finance 拉取历史价格并缓存到 `backend/data/dca_assistant.sqlite`。

### 运行测试

```bash
PYTHONPATH=backend pytest backend/tests -q
```

## API 端点

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/assets` | 列出支持的标的 |
| GET | `/api/strategies` | 策略定义及默认参数 |
| POST | `/api/recommendations/run` | 获取单次投资建议 |
| POST | `/api/explanations/run` | 通过用户提供的 LLM 生成建议的自然语言解读 |
| POST | `/api/optimizations/run` | 跨多场景搜索稳健参数 |
| POST | `/api/optimizations/jobs` | 创建异步调优任务（立即返回） |
| GET | `/api/optimizations/jobs/{job_id}` | 查询异步调优任务状态 |
| DELETE | `/api/optimizations/jobs/{job_id}` | 取消异步调优任务 |
| POST | `/api/backtests/run` | 运行完整历史回测，返回指标和图表数据 |

## 回测输出

每次回测返回：

- **指标**：总投入、期末组合价值、总收益率、年化收益率、最大回撤、夏普/索提诺比率、买入次数，以及与固定 DCA 和一次性投入的对比
- **买入明细**：日期、价格、金额、股数、组合价值、每期倍率、持仓回撤、账户回撤
- **基准**：固定 DCA 和一次性投入的指标与图表序列
- **策略对比**：可选的其他策略同场对比结果
- **市场状态**：50/200 日均线趋势判断
- **滚动表现**：1 年或 3 年资金加权年化收益率序列（本策略、固定 DCA、一次性投入）
- **价格序列**：每日收盘价
- **当前建议**：策略对当前日期的信号
- **LLM 解读**（可选）：用大白话解释"为什么本期建议投这个金额"，由用户自己的 OpenAI 兼容 API Key 驱动。Key 仅存浏览器 localStorage，经本地后端转发，不落盘不记录

## 优化输出

参数优化给出的是稳健建议，不是未来保证。它将当前策略的候选参数放到选定区间加预设压力场景中验证，然后按稳定性感知评分排序——综合年化收益、夏普比率、回撤和相对固定 DCA 的表现。默认仅搜索最低 0.6-0.8 倍、最高 1.2-1.5 倍的参数空间，保持定投纪律。

返回内容包括：基准配置、推荐配置、Top 5 候选、分场景指标、搜索和跳过数量。

## 项目结构

```
DCA-strategy-assistant/
├── backend/
│   ├── app/
│   │   ├── main.py                  # FastAPI 入口
│   │   ├── models.py                # Pydantic 数据模型
│   │   ├── strategies.py            # 策略评估引擎
│   │   ├── strategy_definitions.py  # 策略元数据与默认参数
│   │   ├── indicators.py            # 技术指标（SMA、RSI、回撤等）
│   │   ├── backtester.py            # DCA 回测引擎
│   │   ├── optimizer.py             # 参数优化引擎
│   │   ├── optimization_jobs.py     # 异步优化任务管理
│   │   ├── explanations.py          # LLM 解读模块
│   │   └── data.py                  # yfinance 数据获取 + SQLite 缓存
│   ├── tests/
│   │   ├── test_strategies.py       # 策略与回测测试
│   │   ├── test_data.py             # 数据获取测试
│   │   └── test_explanations.py     # LLM 解读测试
│   ├── data/                        # SQLite 缓存与 yfinance 数据
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── App.tsx                  # 主应用组件
│   │   ├── main.tsx                 # React 入口
│   │   ├── api.ts                   # API 客户端工具
│   │   ├── api.generated.ts         # OpenAPI 生成的 TypeScript 类型
│   │   ├── types.ts                 # 前端类型定义
│   │   ├── constants.ts             # 常量与预设
│   │   ├── utils.ts                 # 工具函数
│   │   ├── Chart.tsx                # 图表组件封装
│   │   ├── styles.css               # 应用样式
│   │   ├── components/              # UI 组件（ChartWrapper、Metric 等）
│   │   └── hooks/                   # React hooks（useBacktest、useChartOptions、useLlmExplanation）
│   ├── tsconfig.json
│   └── vite.config.ts
├── docs/
│   ├── user-guide.md                # 用户手册
│   ├── roadmap-2026-q3.md           # 开发路线图
│   ├── task-list.md                 # 功能待办
│   └── change-log/                  # 按日期的实现记录
├── start-dev.ps1                    # Windows 一键启动脚本
├── pyproject.toml                   # Python 项目配置（Ruff、Pyright、pytest）
└── Dockerfile                       # 多阶段 Docker 构建
```

## 假设与限制

- v0.4：仅限内置 ETF。美股 ETF 用美元展示；A 股 ETF 用人民币展示，底层通过 Yahoo Finance `.SS` / `.SZ` 代码获取数据。
- 网格策略是"网格加权 DCA"——仅调整买入金额，不含卖出信号。
- 回测使用简单的 IRR 二分法计算年化收益率。
- 价格数据以 `auto_adjust=True` 从 Yahoo Finance 获取，历史收盘价已反映分红和拆股调整。因此回测收益率和回撤已隐含分红再投资（在除权日以当日收盘价再投资）。暂不支持"分红留作现金"模式。
- 费率和滑点参数在右侧参数面板中可配置，回测时按比例扣减买入金额并抬高执行价。
- 参数优化仅为历史多场景验证，不预测未来最优参数。

## 许可证

MIT
