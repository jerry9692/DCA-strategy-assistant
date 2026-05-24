# DCA Strategy Assistant v0.3

A local web application for dynamic Dollar-Cost Averaging (DCA) investment research. Instead of investing the same amount every period, it uses 7 market-driven strategies to adjust your contribution based on current conditions — buy more when the market dips, less when it's overheated.

Currently supports built-in US ETFs and a first batch of core China ETFs. US assets include broad-market, dividend/value, international, bond, commodity, and advanced/high-volatility ETFs; China assets currently include SSE 50, CSI 300, CSI 500, ChiNext, and STAR 50 ETF proxies. The UI separates assets by market before showing the filtered symbol list.

> **Disclaimer**: This tool is for research and decision support only. It does not auto-trade, does not connect to brokerage APIs, and does not constitute investment advice.

## Strategies

| Strategy | Logic |
|----------|-------|
| Fixed DCA | Always invest the base amount (benchmark) |
| Drawdown Boost | Scale up when price drops from 252-day high |
| MA Deviation | Adjust based on deviation from 200-day SMA |
| Historical Percentile | Weight by where price ranks in a 756-day window |
| RSI Sentiment | Buy more when RSI signals oversold (<30), less when overbought (>70) |
| Grid Weighted | Divide the rolling price range into buckets, assign a multiplier to each |
| Composite Score | Weighted average of all 5 signals above |

Each strategy returns a recommended amount, multiplier, score, raw signal values, and human-readable reasons.

Default dynamic bounds are intentionally mild: **0.8x minimum** and **1.2x maximum**. The tool is designed as disciplined DCA with small adjustments, not market-timing.

## v0.3 Highlights

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

## v0.2 Highlights

- Compare dynamic DCA against both fixed DCA and a lump-sum investment baseline.
- Read the current market state from 50/200-day moving averages.
- Evaluate strategies with Sharpe and Sortino ratios in addition to return and drawdown.
- Run a strategy showdown by comparing up to 3 extra strategies on the same asset and date range.
- Apply conservative, balanced, or aggressive parameter presets saved in localStorage.
- Replay preset crisis scenarios such as the 2020 selloff and 2022 rate-hike drawdown.
- Switch between light and dark themes, and export date-aligned wide CSV backtest records.
- Generate robust parameter suggestions by validating candidate settings across multiple market regimes.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python 3.10+, FastAPI, pandas, numpy, yfinance, SQLModel (SQLite) |
| Frontend | React 18, TypeScript, Vite, Apache ECharts (source WIP) |
| Testing | pytest |

## Getting Started

### Prerequisites
- Python 3.10+
- Node.js 18+

### One-click dev startup on Windows

Double-click `start-dev.bat`, or run:

```powershell
.\start-dev.ps1
```

It opens two PowerShell windows, one for the FastAPI backend and one for the Vite frontend:

- Backend: `http://127.0.0.1:8000`
- Frontend: `http://127.0.0.1:5173`

If dependencies are missing, run this once:

```powershell
.\start-dev.ps1 -Install
```

### Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

The API will be available at `http://127.0.0.1:8000`. On first request, historical price data is automatically fetched from Yahoo Finance and cached to `backend/data/dca_assistant.sqlite`.

### Tests

```bash
PYTHONPATH=backend pytest backend/tests -q
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/assets` | List supported assets |
| GET | `/api/strategies` | Strategy definitions with default parameters |
| POST | `/api/recommendations/run` | Get a single investment recommendation for a given date |
| POST | `/api/optimizations/run` | Search robust parameters for the current strategy across multiple scenarios |
| POST | `/api/backtests/run` | Run a full historical backtest with metrics and chart data |

## Backtest Output

Each backtest returns:

- **Metrics**: total invested, ending portfolio value, total return %, annualized return %, max drawdown, Sharpe/Sortino ratios, number of buys, and comparisons against fixed-DCA and lump-sum baselines
- **Contribution events**: date, price, amount, shares purchased, portfolio value, multiplier per buy, holding drawdown, and account drawdown for chart comparison
- **Baselines**: fixed-DCA and lump-sum metrics and chart series
- **Strategy comparisons**: optional peer strategy results for showdown charts and tables
- **Market state**: 50/200-day moving-average trend label and summary
- **Rolling performance**: 1-year or 3-year money-weighted annualized return series for the strategy, fixed DCA, and lump-sum baseline
- **Price series**: daily close prices for charting
- **Recommendation**: the strategy's current signal

## Optimization Output

Parameter optimization returns a robust suggestion, not a future guarantee. It evaluates the current strategy's candidate parameters across the selected date range plus preset stress scenarios, then ranks candidates by a stability-aware score that balances annualized return, Sharpe ratio, drawdown, and fixed-DCA underperformance. The default search keeps DCA discipline by only considering 0.6-0.8x minimum multipliers and 1.2-1.5x maximum multipliers.

The response includes the baseline config, recommended config, Top 5 candidates, scenario-by-scenario metrics, searched count, and skipped count.

## Project Structure

```
DCA-strategy-assistant/
├── backend/
│   ├── app/
│   │   ├── main.py                  # FastAPI entry point
│   │   ├── models.py                # Pydantic data models
│   │   ├── strategies.py            # Strategy evaluation engine
│   │   ├── strategy_definitions.py  # Strategy metadata & defaults
│   │   ├── indicators.py            # Technical indicators (SMA, RSI, drawdown, etc.)
│   │   ├── backtester.py            # DCA backtesting engine
│   │   └── data.py                  # yfinance data fetching + SQLite caching
│   ├── tests/
│   │   └── test_strategies.py       # strategy and backtest tests
│   ├── data/                        # SQLite cache & yfinance data
│   └── requirements.txt
├── frontend/                        # React UI (source in progress)
│   ├── tsconfig.json
│   └── vite.config.ts
└── docs/
    ├── user-guide.md                # User manual (Chinese)
    ├── task-list.md                 # Feature backlog
    └── change-log/                  # Dated implementation notes
```

## Assumptions & Limitations

- v0.3: Built-in ETF universe only. US ETFs use USD display; China ETFs use CNY display and Yahoo Finance provider symbols (`.SS` / `.SZ`) behind the scenes.
- The grid strategy is "grid-weighted DCA" — it only adjusts buy amounts, no sell signals.
- Backtesting uses a simple IRR bisection method for annualized return.
- Price data is fetched from Yahoo Finance with `auto_adjust=True`, so historical close prices already reflect dividend and split adjustments. Backtest returns and drawdowns therefore implicitly assume cash dividends are reinvested on the ex-date at that day's close. There is no separate "hold dividends as cash" mode yet.
- Fee and slippage rates are exposed in the right-side parameter panel and applied during backtests.
- Parameter optimization is historical multi-scenario validation only. It does not predict which parameters will be best in future markets.

## License

MIT
