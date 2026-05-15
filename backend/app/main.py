from datetime import date, timedelta

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import pandas as pd

from app.backtester import DcaBacktester
from app.data import PriceDataError, get_price_history, validate_symbol
from app.models import (
    Asset,
    BacktestMetrics,
    BacktestRequest,
    BacktestResult,
    PricePoint,
    RecommendationRequest,
    SUPPORTED_ASSETS,
    StrategyConfig,
)
from app.strategies import evaluate_prepared_strategy, evaluate_strategy, prepare_market
from app.strategy_definitions import COMMON_PARAMETERS, STRATEGIES


app = FastAPI(title="DCA Strategy Assistant", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _raise_api_error(exc: Exception) -> None:
    if isinstance(exc, PriceDataError):
        raise HTTPException(
            status_code=400,
            detail={"message": exc.message, "code": exc.code, "retryable": exc.retryable},
        ) from exc
    raise HTTPException(status_code=400, detail={"message": str(exc), "code": "request_failed", "retryable": False}) from exc


@app.get("/api/assets", response_model=list[Asset])
def assets() -> list[Asset]:
    return [Asset(symbol=symbol, name=name) for symbol, name in SUPPORTED_ASSETS.items()]


@app.get("/api/strategies")
def strategies() -> dict:
    return {"commonParameters": COMMON_PARAMETERS, "strategies": STRATEGIES}


@app.post("/api/recommendations/run")
def recommendation(request: RecommendationRequest):
    try:
        symbol = validate_symbol(request.symbol)
        end = request.asOf or date.today()
        start = end - timedelta(days=365 * 10)
        prices, data_source, cache_status = get_price_history(symbol, start, end)
        decision = evaluate_strategy(request.config.strategyType, request.config, prices)
        return {"symbol": symbol, "decision": decision, "dataSource": data_source, "cacheStatus": cache_status}
    except Exception as exc:
        _raise_api_error(exc)


def _fixed_config(config: StrategyConfig) -> StrategyConfig:
    return StrategyConfig(
        strategyType="fixed_dca",
        baseAmount=config.baseAmount,
        frequency=config.frequency,
        minMultiplier=1,
        maxMultiplier=1,
        params={},
    )


def _chart_prices(prices, start: date, max_points: int = 360) -> list[dict]:
    visible = prices.loc[prices.index >= pd.Timestamp(start)]
    if len(visible) > max_points:
        step = max(1, len(visible) // max_points)
        visible = visible.iloc[::step]
    return [
        {"date": idx.date().isoformat(), "close": round(float(row["close"]), 4)}
        for idx, row in visible.iterrows()
    ]


def _chart_contributions(events) -> list[dict]:
    return [
        {
            "date": event.date,
            "price": event.price,
            "amount": event.amount,
            "portfolioValue": event.portfolioValue,
            "multiplier": event.multiplier,
            "score": event.score,
        }
        for event in events
    ]


@app.post("/api/backtests/run")
def backtest(request: BacktestRequest) -> dict:
    try:
        symbol = validate_symbol(request.symbol)
        end = request.endDate or date.today()
        start = request.startDate or (end - timedelta(days=365 * 5))
        warmup = start - timedelta(days=365 * 3)
        prices, data_source, cache_status = get_price_history(symbol, warmup, end)

        backtester = DcaBacktester(prices)
        prepared = prepare_market(prices, request.config)
        events, metrics = backtester.run(
            request.config.strategyType,
            request.config,
            start,
            end,
            fee_rate=float(request.config.params.get("feeRate", 0)),
            slippage_rate=float(request.config.params.get("slippageRate", 0)),
            prepared=prepared,
        )
        fixed_events, fixed_metrics = backtester.run("fixed_dca", _fixed_config(request.config), start, end)
        versus = None
        if fixed_metrics.endingValue > 0:
            versus = round((metrics.endingValue / fixed_metrics.endingValue - 1) * 100, 2)
        metrics = BacktestMetrics(**{**metrics.model_dump(), "versusFixedPct": versus})
        recommendation = evaluate_prepared_strategy(request.config.strategyType, request.config, prepared)
        return {
            "symbol": symbol,
            "strategyType": request.config.strategyType,
            "recommendation": recommendation.model_dump(),
            "metrics": metrics.model_dump(),
            "fixedMetrics": fixed_metrics.model_dump(),
            "contributions": _chart_contributions(events),
            "fixedContributions": _chart_contributions(fixed_events),
            "priceSeries": _chart_prices(prices, start),
            "dataSource": data_source,
            "cacheStatus": cache_status,
        }
    except Exception as exc:
        _raise_api_error(exc)
