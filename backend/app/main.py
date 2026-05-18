from datetime import date, timedelta
from functools import lru_cache

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
    MarketState,
    PricePoint,
    OptimizationJobCreateResponse,
    OptimizationJobStatus,
    OptimizationRequest,
    OptimizationResult,
    RecommendationRequest,
    SUPPORTED_ASSETS,
    StrategyConfig,
    StrategyComparison,
)
from app.optimization_jobs import cancel_optimization_job, create_optimization_job, get_optimization_job
from app.optimizer import optimize_parameters
from app.strategies import evaluate_prepared_strategy, evaluate_strategy, prepare_market
from app.strategy_definitions import COMMON_PARAMETERS, STRATEGIES


app = FastAPI(title="DCA Strategy Assistant", version="0.3.0")

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


@app.post("/api/optimizations/run", response_model=OptimizationResult)
def optimization(request: OptimizationRequest) -> OptimizationResult:
    try:
        return optimize_parameters(request)
    except Exception as exc:
        _raise_api_error(exc)


@app.post("/api/optimizations/jobs", response_model=OptimizationJobCreateResponse)
def create_optimization(request: OptimizationRequest) -> OptimizationJobCreateResponse:
    try:
        return OptimizationJobCreateResponse(jobId=create_optimization_job(request))
    except Exception as exc:
        _raise_api_error(exc)


@app.get("/api/optimizations/jobs/{job_id}", response_model=OptimizationJobStatus)
def optimization_status(job_id: str) -> OptimizationJobStatus:
    status = get_optimization_job(job_id)
    if status is None:
        raise HTTPException(status_code=404, detail={"message": "调优任务不存在。", "code": "job_not_found", "retryable": False})
    return status


@app.delete("/api/optimizations/jobs/{job_id}", response_model=OptimizationJobStatus)
def cancel_optimization(job_id: str) -> OptimizationJobStatus:
    status = cancel_optimization_job(job_id)
    if status is None:
        raise HTTPException(status_code=404, detail={"message": "调优任务不存在。", "code": "job_not_found", "retryable": False})
    return status


def _fixed_config(config: StrategyConfig) -> StrategyConfig:
    return StrategyConfig(
        strategyType="fixed_dca",
        baseAmount=config.baseAmount,
        frequency=config.frequency,
        # min strictly less than max is enforced by StrategyConfig; we still
        # want a "no dynamic adjustment" baseline, so keep them effectively
        # equal with a negligible delta. The fixed_dca strategy ignores
        # these multipliers anyway.
        minMultiplier=1,
        maxMultiplier=1.0001,
        params={},
    )


@lru_cache(maxsize=128)
def _cached_fixed_backtest(
    symbol: str,
    start: date,
    end: date,
    base_amount: float,
    frequency: str,
    risk_free_rate: float,
) -> tuple[tuple, BacktestMetrics]:
    prices, _, _ = get_price_history(symbol, start, end)
    events, metrics = DcaBacktester(prices).run(
        "fixed_dca",
        StrategyConfig(
            strategyType="fixed_dca",
            baseAmount=base_amount,
            frequency=frequency,
            minMultiplier=1,
            maxMultiplier=1.0001,
            params={},
        ),
        start,
        end,
        risk_free_rate=risk_free_rate,
    )
    return tuple(events), metrics


def _chart_prices(prices, start: date, max_points: int = 360) -> list[dict]:
    visible = prices.loc[prices.index >= pd.Timestamp(start)]
    if len(visible) > max_points:
        step = max(1, len(visible) // max_points)
        visible = visible.iloc[::step]
    return [
        {"date": idx.date().isoformat(), "close": round(float(row["close"]), 4)}
        for idx, row in visible.iterrows()
    ]


def _account_drawdowns(events, scheduled_budget: float | None = None) -> list[float]:
    if not events:
        return []

    curve = 1.0
    peak = 1.0
    drawdowns = [0.0]
    for index, (previous, current) in enumerate(zip(events, events[1:]), start=1):
        if scheduled_budget is None:
            previous_cash = 0.0
        else:
            previous_planned_budget = scheduled_budget * index
            previous_cash = max(0.0, previous_planned_budget - previous.totalInvested)
        previous_account_value = previous.portfolioValue + previous_cash
        if previous_account_value <= 0:
            period_return = 0.0
        else:
            current_buy_value = current.shares * current.price
            value_before_new_budget = current.portfolioValue - current_buy_value + previous_cash
            period_return = value_before_new_budget / previous_account_value - 1
        curve *= 1 + period_return
        peak = max(peak, curve)
        drawdowns.append((curve / peak - 1) * 100 if peak > 0 else 0.0)
    return [round(item, 2) for item in drawdowns]


def _chart_contributions(events, scheduled_budget: float | None = None) -> list[dict]:
    account_drawdowns = _account_drawdowns(events, scheduled_budget)
    return [
        {
            "date": event.date,
            "price": event.price,
            "amount": event.amount,
            "portfolioValue": event.portfolioValue,
            "multiplier": event.multiplier,
            "score": event.score,
            "drawdownPct": event.drawdownPct,
            "accountDrawdownPct": account_drawdown,
        }
        for event, account_drawdown in zip(events, account_drawdowns)
    ]


def _with_comparison_metrics(
    metrics: BacktestMetrics,
    fixed_metrics: BacktestMetrics,
    lump_sum_metrics: BacktestMetrics,
) -> BacktestMetrics:
    fixed_vs = None
    lump_vs = None
    if fixed_metrics.endingValue > 0:
        fixed_vs = round((metrics.endingValue / fixed_metrics.endingValue - 1) * 100, 2)
    if lump_sum_metrics.endingValue > 0:
        lump_vs = round((metrics.endingValue / lump_sum_metrics.endingValue - 1) * 100, 2)
    return BacktestMetrics(**{**metrics.model_dump(), "versusFixedPct": fixed_vs, "versusLumpSumPct": lump_vs})


def _strategy_name(strategy_type: str) -> str:
    for strategy in STRATEGIES:
        if strategy.type == strategy_type:
            return strategy.name
    return strategy_type


def _strategy_config(base_config: StrategyConfig, strategy_type: str) -> StrategyConfig:
    if strategy_type == base_config.strategyType:
        return base_config
    return StrategyConfig(
        strategyType=strategy_type,
        baseAmount=base_config.baseAmount,
        frequency=base_config.frequency,
        minMultiplier=base_config.minMultiplier,
        maxMultiplier=base_config.maxMultiplier,
        params=dict(base_config.params),
    )


def _market_state(prices: pd.DataFrame, end: date) -> MarketState:
    visible = prices.loc[prices.index <= pd.Timestamp(end)].copy()
    if visible.empty:
        return MarketState(label="数据不足", tone="neutral", summary="没有足够价格数据判断市场状态。")
    close = visible["close"]
    latest_idx = close.dropna().index[-1]
    latest_price = float(close.loc[latest_idx])
    sma50 = close.rolling(50, min_periods=20).mean().loc[latest_idx]
    sma200 = close.rolling(200, min_periods=60).mean().loc[latest_idx]
    if pd.isna(sma50) or pd.isna(sma200):
        return MarketState(
            label="数据预热中",
            tone="neutral",
            summary="均线样本不足，暂按中性市场处理。",
            price=round(latest_price, 4),
        )

    distance = (latest_price / float(sma200) - 1) * 100 if float(sma200) > 0 else None
    if latest_price >= float(sma50) >= float(sma200):
        label = "上升趋势"
        tone = "up"
        summary = "价格位于 50 日和 200 日均线上方，市场背景偏强。"
    elif latest_price <= float(sma50) <= float(sma200):
        label = "下降趋势"
        tone = "down"
        summary = "价格位于 50 日和 200 日均线下方，市场背景偏弱。"
    else:
        label = "震荡区间"
        tone = "neutral"
        summary = "短中期均线信号不一致，市场背景偏震荡。"
    return MarketState(
        label=label,
        tone=tone,
        summary=summary,
        price=round(latest_price, 4),
        sma50=round(float(sma50), 4),
        sma200=round(float(sma200), 4),
        distanceToSma200Pct=round(distance, 2) if distance is not None else None,
    )


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
        fee_rate = float(request.config.params.get("feeRate", 0))
        slippage_rate = float(request.config.params.get("slippageRate", 0))
        risk_free_rate = request.riskFreeRate
        events, metrics = backtester.run(
            request.config.strategyType,
            request.config,
            start,
            end,
            fee_rate=fee_rate,
            slippage_rate=slippage_rate,
            prepared=prepared,
            risk_free_rate=risk_free_rate,
        )
        if fee_rate == 0 and slippage_rate == 0:
            fixed_events_tuple, fixed_metrics = _cached_fixed_backtest(
                symbol,
                start,
                end,
                request.config.baseAmount,
                request.config.frequency,
                risk_free_rate,
            )
            fixed_events = list(fixed_events_tuple)
        else:
            fixed_events, fixed_metrics = backtester.run(
                "fixed_dca",
                _fixed_config(request.config),
                start,
                end,
                fee_rate=fee_rate,
                slippage_rate=slippage_rate,
                risk_free_rate=risk_free_rate,
            )
        lump_sum_events, lump_sum_metrics = backtester.run_lump_sum(
            fixed_metrics.totalInvested,
            start,
            end,
            request.config.frequency,
            fee_rate=fee_rate,
            slippage_rate=slippage_rate,
            risk_free_rate=risk_free_rate,
        )
        metrics = _with_comparison_metrics(metrics, fixed_metrics, lump_sum_metrics)
        recommendation = evaluate_prepared_strategy(request.config.strategyType, request.config, prepared)
        comparisons: list[StrategyComparison] = []
        seen = {request.config.strategyType}
        for strategy_type in request.comparisonStrategyTypes:
            if strategy_type in seen or strategy_type not in {item.type for item in STRATEGIES}:
                continue
            seen.add(strategy_type)
            comparison_config = _strategy_config(request.config, strategy_type)
            comparison_prepared = prepare_market(prices, comparison_config)
            comparison_events, comparison_metrics = backtester.run(
                strategy_type,
                comparison_config,
                start,
                end,
                fee_rate=float(comparison_config.params.get("feeRate", 0)),
                slippage_rate=float(comparison_config.params.get("slippageRate", 0)),
                prepared=comparison_prepared,
                risk_free_rate=risk_free_rate,
            )
            comparisons.append(
                StrategyComparison(
                    strategyType=strategy_type,
                    name=_strategy_name(strategy_type),
                    metrics=_with_comparison_metrics(comparison_metrics, fixed_metrics, lump_sum_metrics),
                    contributions=comparison_events,
                )
            )
        return {
            "symbol": symbol,
            "strategyType": request.config.strategyType,
            "recommendation": recommendation.model_dump(),
            "metrics": metrics.model_dump(),
            "fixedMetrics": fixed_metrics.model_dump(),
            "lumpSumMetrics": lump_sum_metrics.model_dump(),
            "marketState": _market_state(prices, end).model_dump(),
            "contributions": _chart_contributions(events, request.config.baseAmount),
            "fixedContributions": _chart_contributions(fixed_events, request.config.baseAmount),
            "lumpSumContributions": _chart_contributions(lump_sum_events),
            "strategyComparisons": [
                {
                    "strategyType": item.strategyType,
                    "name": item.name,
                    "metrics": item.metrics.model_dump(),
                    "contributions": _chart_contributions(item.contributions, request.config.baseAmount),
                }
                for item in comparisons
            ],
            "priceSeries": _chart_prices(prices, start),
            "dataSource": data_source,
            "cacheStatus": cache_status,
        }
    except Exception as exc:
        _raise_api_error(exc)
