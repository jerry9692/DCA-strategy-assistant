# DCA Strategy Assistant v0.5

[![CN](https://img.shields.io/badge/lang-%E4%B8%AD%E6%96%87-red)](README.md)

A local web application for dynamic Dollar-Cost Averaging (DCA) investment research. Instead of investing the same amount every period, it uses 7 market-driven strategies to adjust your contribution based on current conditions — buy more when the market dips, less when it's overheated.

Currently supports built-in US ETFs and a first batch of core China ETFs. US assets include broad-market, dividend/value, international, bond, commodity, and advanced/high-volatility ETFs; China assets currently include SSE 50, CSI 300, CSI 500, ChiNext, and STAR 50 ETF proxies. The UI separates assets by market before showing the filtered symbol list. Market data uses East Money as the primary data source, Yahoo Finance as fallback, with local SQLite caching.

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

## v0.5 Highlights

- **Data source switched to East Money primary, Yahoo Finance fallback**: A-share / US ETFs prefer East Money's `push2his.eastmoney.com` endpoint, automatically falling back to yfinance on failure. When both sources fail, the local SQLite cache is used (cache is returned if its tail is within 7 days of the request end, avoiding empty data on holidays).
- **East Money IPv6 connectivity fix**: The IPv6 endpoint of `push2his.eastmoney.com` suffered `RemoteDisconnected` on some domestic networks. `eastmoney.py` now forces IPv4, supports both HTTP/HTTPS, retries 3 times with exponential backoff (1.5s / 3s / 4.5s), and fixes the `_TIMEOOUT` typo.
- **Unified forward-adjusted price baseline**: Removed the special `510050: 0` entry in `_EM_FQT`. All symbols now use `fqt=1` (forward-adjusted), consistent with yfinance's `auto_adjust=True`, resolving 5-15% historical price drift and chart jumps.
- **Dirty data sanitization**: Added `_sanitize_prices` to drop ticks with `close <= 0` or single-day change > 80% (e.g. the 4 dirty QQQ cache rows that caused the 2024 chart plunge).
- **Dynamic cache source labels**: Added `_cached_source_label` that inspects `PriceBar.source` to produce "East Money cache" / "Yahoo Finance cache" / "Mixed cache (East Money + Yahoo)", replacing the previously hardcoded "Yahoo Finance cache".
- **Reasoning model compatibility**: Reasoning models like `mimo-v2.5` consume `reasoning_tokens` for internal chain-of-thought before emitting the final answer, so `max_tokens=400` produced empty `content`. Removed the `reasoning_content` fallback, raised explanation `max_tokens` from 400 to 1500 and chat `max_tokens` from 600 to 2000, and added an empty-content warning log.
- **Metric card horizontal scroll fix**: Added `min-width: 0` to `.metrics-row` so the flex container can shrink and trigger overflow, changed `.metric-cell` to `flex: 1 1 138px; min-width: 138px`, removed `overflow: hidden` and `text-overflow: ellipsis`. Full amounts now display via pure horizontal scrolling.

## v0.3 Highlights

- Fixed a bug where backtests would duplicate purchases of the same trading day when starting on weekends or month-start non-trading days.
- Signal warm-up now explicitly warns users instead of silently falling back to base amount; yellow banner shown above the recommendation card.
- Optimizer correctly handles `versusFixedPct=None` scenarios when averaging across regimes, preventing fragile candidates from ranking first.
- Four main charts unified to timeline + `[date, value]` tuples, with multiple series aligned by date instead of by index.
- End-of-period mark-to-market event added so endingValue / max drawdown / IRR reflect the true terminal price.
- Risk-free rate changed from hardcoded 4% to a configurable slider (0–10%), affecting Sharpe and Sortino ratios.
- `StrategyConfig` validates `minMultiplier < maxMultiplier` to prevent degenerate "always below base" configurations.
- Graceful degradation when yfinance returns only Adj Close (no more KeyError).
- `ContributionEvent` frozen to prevent lru_cache pollution from downstream mutation.
- Documentation aligned with actual behavior: historical backtests **implicitly include dividend reinvestment** (auto_adjust).
- C1 expanded asset universe: 26 US ETFs + 5 China A-share index ETFs, with `Market` + `Asset` dual dropdowns to avoid mixing.
- D1 rolling performance chart: shows 3-year or 1-year money-weighted annualized returns from each rolling window start, revealing whether a strategy only performed well in a few specific years.
- E2 LLM explanation (first half): connects to OpenAI-compatible APIs (OpenAI / DeepSeek / Moonshot / Zhipu, etc.) to explain "why this period's suggested amount" in plain language. API key stored in browser localStorage only, forwarded through local backend — never persisted or logged. Interactive Q&A portion coming in a future iteration.

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
| Backend | Python 3.10+, FastAPI, pandas, numpy, East Money API (primary data source), yfinance (fallback), SQLModel (SQLite) |
| Frontend | React 18, TypeScript, Vite, Apache ECharts |
| Testing | pytest, Vitest |

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

The API will be available at `http://127.0.0.1:8000`. On first request, historical price data is automatically fetched from East Money (falling back to Yahoo Finance on failure) and cached to `backend/data/dca_assistant.sqlite`.

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
| POST | `/api/explanations/run` | Generate plain-language explanation of a recommendation via user-supplied LLM |
| POST | `/api/optimizations/run` | Search robust parameters for the current strategy across multiple scenarios |
| POST | `/api/optimizations/jobs` | Create an async optimization job (returns immediately) |
| GET | `/api/optimizations/jobs/{job_id}` | Query async optimization job status |
| DELETE | `/api/optimizations/jobs/{job_id}` | Cancel an async optimization job |
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
- **LLM Explanation** (optional): plain-language Chinese explanation of "why this amount", generated by the user's own OpenAI-compatible API key. Key stored in browser localStorage only, forwarded through local backend — never persisted or logged

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
│   │   ├── optimizer.py             # Parameter optimization engine
│   │   ├── optimization_jobs.py     # Async optimization job management
│   │   ├── explanations.py          # LLM-powered recommendation explanation (reasoning-model compatible)
│   │   ├── eastmoney.py             # East Money data source (force IPv4 + retries)
│   │   └── data.py                  # Dual-source data fetching (East Money + yfinance) + SQLite caching + sanitization
│   ├── tests/
│   │   ├── test_strategies.py       # Strategy and backtest tests
│   │   ├── test_data.py             # Data fetching tests
│   │   └── test_explanations.py     # LLM explanation tests
│   ├── data/                        # SQLite cache (with source column labeling data origin)
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── App.tsx                  # Main application component
│   │   ├── main.tsx                 # React entry point
│   │   ├── api.ts                   # API client utilities
│   │   ├── api.generated.ts         # OpenAPI-generated TypeScript types
│   │   ├── types.ts                 # Frontend type definitions
│   │   ├── constants.ts             # Constants and presets
│   │   ├── utils.ts                 # Utility functions
│   │   ├── Chart.tsx                # Chart component wrapper
│   │   ├── styles.css               # Application styles
│   │   ├── components/              # UI components (ChartWrapper, Metric, etc.)
│   │   └── hooks/                   # React hooks (useBacktest, useChartOptions, useLlmExplanation)
│   ├── tsconfig.json
│   └── vite.config.ts
├── docs/
│   ├── user-guide.md                # User manual (Chinese)
│   ├── roadmap-2026-q3.md           # Development roadmap
│   ├── task-list.md                 # Feature backlog
│   └── change-log/                  # Dated implementation notes
├── start-dev.ps1                    # One-click dev startup (PowerShell)
├── pyproject.toml                   # Python project config (Ruff, Pyright, pytest)
└── Dockerfile                       # Multi-stage Docker build
```

## Assumptions & Limitations

- v0.5: Built-in ETF universe only. US ETFs use USD display; China ETFs use CNY display. Market data uses East Money as the primary source (A-shares via codes like `510050`, US ETFs via `QQQ.US`), with Yahoo Finance as fallback (A-shares via `.SS` / `.SZ` codes).
- The grid strategy is "grid-weighted DCA" — it only adjusts buy amounts, no sell signals.
- Backtesting uses a simple IRR bisection method for annualized return.
- All symbols use unified forward-adjusted prices: East Money `fqt=1`, yfinance `auto_adjust=True`, both consistent. Backtest returns and drawdowns therefore implicitly assume cash dividends are reinvested on the ex-date at that day's close. There is no separate "hold dividends as cash" mode yet.
- When both data sources fail, the local SQLite cache provides fault tolerance: cache is returned if its tail is within 7 days of the request end, avoiding empty backtest data on holidays or transient network outages.
- Fee and slippage rates are exposed in the right-side parameter panel and applied during backtests.
- Parameter optimization is historical multi-scenario validation only. It does not predict which parameters will be best in future markets.
- AI explanation supports both regular chat models and reasoning models (e.g. `mimo-v2.5`) under the OpenAI-compatible protocol. Reasoning models consume tokens for internal chain-of-thought before emitting the final answer, so `max_tokens` has been raised to 1500/2000 to avoid empty content.

## License

MIT
