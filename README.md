# DCA Strategy Assistant v0.2

A local web application for dynamic Dollar-Cost Averaging (DCA) investment research. Instead of investing the same amount every period, it uses 7 market-driven strategies to adjust your contribution based on current conditions — buy more when the market dips, less when it's overheated.

Currently supports **QQQ, VOO, SPY** (US-listed ETFs, USD denominated, daily data).

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

## v0.2 Highlights

- Compare dynamic DCA against both fixed DCA and a lump-sum investment baseline.
- Read the current market state from 50/200-day moving averages.
- Evaluate strategies with Sharpe and Sortino ratios in addition to return and drawdown.
- Run a strategy showdown by comparing up to 3 extra strategies on the same asset and date range.
- Apply conservative, balanced, or aggressive parameter presets saved in localStorage.
- Replay preset crisis scenarios such as the 2020 selloff and 2022 rate-hike drawdown.
- Switch between light and dark themes, and export backtest contribution records to CSV.
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
    ├── v0.1-plan.md                 # Implementation plan (Chinese)
    ├── user-guide.md                # User manual (Chinese)
    └── task-list.md                 # Feature backlog
```

## Assumptions & Limitations

- v0.2: USD only, daily data, QQQ/VOO/SPY only.
- The grid strategy is "grid-weighted DCA" — it only adjusts buy amounts, no sell signals.
- Backtesting uses a simple IRR bisection method for annualized return; no dividend reinvestment yet.
- Fee and slippage rates are supported in the engine but not yet exposed in strategy parameters.
- Parameter optimization is historical multi-scenario validation only. It does not predict which parameters will be best in future markets.

## License

MIT
