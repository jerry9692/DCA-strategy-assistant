from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.backtester import DcaBacktester, rolling_annualized_returns, rolling_lump_sum_annualized_returns
from app.data import PriceDataError, count_cached_bars, get_available_range, get_price_history, validate_symbol
from app.explanations import explain_decision, explain_selection
from app.models import (
    SUPPORTED_ASSETS,
    Asset,
    AssetRange,
    BacktestMetrics,
    BacktestRequest,
    BacktestResult,
    ContributionEvent,
    ExplanationRequest,
    ExplanationResponse,
    HealthResponse,
    MarketState,
    OptimizationJobCreateResponse,
    OptimizationJobStatus,
    OptimizationRequest,
    OptimizationResult,
    PricePoint,
    RecommendationRequest,
    RecommendationResponse,
    RollingPerformancePoint,
    SelectionExplanationRequest,
    SelectionExplanationResponse,
    StrategyComparison,
    StrategyConfig,
    StrategyDefinitionsResponse,
)
from app.optimization_jobs import (
    cancel_optimization_job,
    count_finished_jobs,
    create_optimization_job,
    get_optimization_job,
)
from app.optimizer import optimize_parameters
from app.strategies import clear_prepare_cache, evaluate_prepared_strategy, evaluate_strategy, prepare_market
from app.strategy_definitions import COMMON_PARAMETERS, STRATEGIES

app = FastAPI(title="DCA Strategy Assistant", version="0.4.0")

# Captured once at import time; /api/health reports elapsed seconds since.
# Module-level (not inside the handler) so a long-lived worker reports
# real uptime rather than "time since first request".
_STARTED_AT = datetime.now(timezone.utc)

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
    raise HTTPException(
        status_code=400, detail={"message": str(exc), "code": "request_failed", "retryable": False}
    ) from exc


@app.get("/api/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Liveness + cache-size probe for reverse proxies and operators.

    Deliberately touches only cheap, local signals (no yfinance, no
    backtest) so it stays fast even when the app is under load or
    offline. The route is registered before the catch-all SPA mount at
    the end of this module, so /api/health wins over static file
    serving regardless of mount order.
    """
    return HealthResponse(
        status="ok",
        version=app.version,
        dataCacheSize=count_cached_bars(),
        optimizationJobs=count_finished_jobs(),
        uptimeSeconds=round((datetime.now(timezone.utc) - _STARTED_AT).total_seconds(), 1),
    )


@app.get("/api/assets", response_model=list[Asset])
def assets() -> list[Asset]:
    result: list[Asset] = []
    for symbol, meta in SUPPORTED_ASSETS.items():
        # SUPPORTED_ASSETS is always {symbol: dict} at runtime; the str
        # branch is purely test compatibility for monkeypatched
        # {symbol: name} fixtures in tests/test_data.py. Don't drop it
        # without updating those tests.
        if isinstance(meta, str):
            result.append(Asset(symbol=symbol, name=meta))
        else:
            result.append(Asset(symbol=symbol, **meta))
    return result


@app.get("/api/assets/{symbol}/range", response_model=AssetRange)
def asset_range(symbol: str) -> AssetRange:
    """Return the date range the UI can use as min/max on date inputs.

    Sourced from the local SQLite cache when populated, falling back
    to a hardcoded earliest-available date per symbol when the cache
    is empty (fresh install). Avoids hitting yfinance just to discover
    the floor.
    """
    try:
        normalized = validate_symbol(symbol)
        floor, ceiling = get_available_range(normalized)
        return AssetRange(symbol=normalized, minDate=floor, maxDate=ceiling)
    except Exception as exc:
        _raise_api_error(exc)


@app.get("/api/strategies", response_model=StrategyDefinitionsResponse)
def strategies() -> StrategyDefinitionsResponse:
    return StrategyDefinitionsResponse(commonParameters=COMMON_PARAMETERS, strategies=STRATEGIES)


@app.post("/api/recommendations/run", response_model=RecommendationResponse)
def recommendation(request: RecommendationRequest) -> RecommendationResponse:
    try:
        # The prepare_market cache key is semantic (DataFrame shape +
        # endpoint timestamps + endpoint closes), so it stays correct
        # across requests. We still clear at the request boundary to keep
        # the dict from growing unboundedly under long-running uvicorn
        # workers — a single recommendation only needs one entry.
        clear_prepare_cache()
        symbol = validate_symbol(request.symbol)
        end = request.asOf or date.today()
        start = end - timedelta(days=365 * 10)
        prices, data_source, cache_status = get_price_history(symbol, start, end)
        decision = evaluate_strategy(request.config.strategyType, request.config, prices)
        return RecommendationResponse(
            symbol=symbol, decision=decision, dataSource=data_source, cacheStatus=cache_status
        )
    except Exception as exc:
        _raise_api_error(exc)


def _asset_currency(symbol: str) -> str:
    meta = SUPPORTED_ASSETS.get(symbol)
    if isinstance(meta, dict):
        currency = meta.get("currency", "USD")
        return "¥" if currency == "CNY" else "$"
    return "$"


@app.post("/api/explanations/run", response_model=ExplanationResponse)
def explanation(request: ExplanationRequest) -> ExplanationResponse:
    """Generate a plain-language explanation of the current
    recommendation via the user's OpenAI-compatible LLM.

    The API key in request.llm is forwarded to the provider for this
    single call only — never persisted, never logged. See
    explanations.py for the request construction.
    """
    try:
        clear_prepare_cache()
        symbol = validate_symbol(request.symbol)
        end = request.asOf or date.today()
        start = end - timedelta(days=365 * 10)
        prices, data_source, cache_status = get_price_history(symbol, start, end)
        decision = evaluate_strategy(request.config.strategyType, request.config, prices)
        market_state = _market_state(prices, end)
        currency = _asset_currency(symbol)
        text = explain_decision(request.model_copy(update={"symbol": symbol}), decision, market_state, currency)
        return ExplanationResponse(
            symbol=symbol,
            decision=decision,
            explanation=text,
            model=request.llm.model,
            dataSource=data_source,
            cacheStatus=cache_status,
        )
    except Exception as exc:
        _raise_api_error(exc)


@app.post("/api/explanations/selection", response_model=SelectionExplanationResponse)
def selection_explanation(request: SelectionExplanationRequest) -> SelectionExplanationResponse:
    """Explain user-selected page text with current strategy context.

    The selected text is treated as untrusted quoted content by the
    prompt; it is never executed as an instruction. The API key follows
    the same per-request forwarding rules as /api/explanations/run.
    """
    try:
        clear_prepare_cache()
        symbol = validate_symbol(request.symbol)
        end = request.asOf or date.today()
        start = end - timedelta(days=365 * 10)
        prices, data_source, cache_status = get_price_history(symbol, start, end)
        decision = evaluate_strategy(request.config.strategyType, request.config, prices)
        market_state = _market_state(prices, end)
        currency = _asset_currency(symbol)
        text = explain_selection(request.model_copy(update={"symbol": symbol}), decision, market_state, currency)
        return SelectionExplanationResponse(
            symbol=symbol,
            selectedText=request.selectedText,
            explanation=text,
            model=request.llm.model,
            dataSource=data_source,
            cacheStatus=cache_status,
        )
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
        raise HTTPException(
            status_code=404, detail={"message": "调优任务不存在。", "code": "job_not_found", "retryable": False}
        )
    return status


@app.delete("/api/optimizations/jobs/{job_id}", response_model=OptimizationJobStatus)
def cancel_optimization(job_id: str) -> OptimizationJobStatus:
    status = cancel_optimization_job(job_id)
    if status is None:
        raise HTTPException(
            status_code=404, detail={"message": "调优任务不存在。", "code": "job_not_found", "retryable": False}
        )
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


def _chart_prices(prices, start: date) -> list[PricePoint]:
    """Return every trading day in the visible window as a chart point.

    We used to subsample (`step = len // 360`) to keep payloads small,
    but that caused buy-point scatter dots to appear off the price
    line whenever a buy day landed on a sampled-out trading day:
    the line would interpolate around the gap, while the scatter
    point sat at the real close. ECharts has no trouble drawing a
    decade of daily closes (~2500 points), and the JSON payload is
    still well under 100 KB, so the simplification is worth it.
    """
    visible = prices.loc[prices.index >= pd.Timestamp(start)]
    return [
        PricePoint(date=idx.date().isoformat(), close=round(float(row["close"]), 4)) for idx, row in visible.iterrows()
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


def _chart_contributions(events, scheduled_budget: float | None = None) -> list[ContributionEvent]:
    account_drawdowns = _account_drawdowns(events, scheduled_budget)
    return [
        event.model_copy(update={"accountDrawdownPct": account_drawdown})
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


def _rolling_window_years(start: date, end: date) -> int | None:
    days = (end - start).days
    if days >= 365 * 5:
        return 3
    if days >= 365 * 2:
        return 1
    return None


def _rolling_performance(
    events: list[ContributionEvent],
    fixed_events: list[ContributionEvent],
    start: date,
    end: date,
) -> list[RollingPerformancePoint]:
    window_years = _rolling_window_years(start, end)
    if window_years is None:
        return []

    strategy = dict(rolling_annualized_returns(events, window_years))
    fixed = dict(rolling_annualized_returns(fixed_events, window_years))
    lump_sum = dict(rolling_lump_sum_annualized_returns(fixed_events, window_years))
    dates = sorted(set(strategy) | set(fixed) | set(lump_sum))
    return [
        RollingPerformancePoint(
            date=item,
            windowYears=window_years,
            strategyAnnualizedReturnPct=strategy.get(item),
            fixedAnnualizedReturnPct=fixed.get(item),
            lumpSumAnnualizedReturnPct=lump_sum.get(item),
        )
        for item in dates
    ]


@app.post("/api/backtests/run", response_model=BacktestResult)
def backtest(request: BacktestRequest) -> BacktestResult:
    try:
        # Bound the prepare_market cache lifetime to one request: a single
        # backtest run with comparison strategies needs at most a handful
        # of entries (one per distinct IndicatorSettings x distinct prices
        # frame), and clearing at the boundary keeps the dict from
        # accumulating across thousands of requests.
        clear_prepare_cache()
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
        return BacktestResult(
            symbol=symbol,
            strategyType=request.config.strategyType,
            recommendation=recommendation,
            metrics=metrics,
            fixedMetrics=fixed_metrics,
            lumpSumMetrics=lump_sum_metrics,
            marketState=_market_state(prices, end),
            contributions=_chart_contributions(events, request.config.baseAmount),
            fixedContributions=_chart_contributions(fixed_events, request.config.baseAmount),
            lumpSumContributions=_chart_contributions(lump_sum_events),
            strategyComparisons=[
                StrategyComparison(
                    strategyType=item.strategyType,
                    name=item.name,
                    metrics=item.metrics,
                    contributions=_chart_contributions(item.contributions, request.config.baseAmount),
                )
                for item in comparisons
            ],
            priceSeries=_chart_prices(prices, start),
            rollingPerformance=_rolling_performance(events, fixed_events, start, end),
            dataSource=data_source,
            cacheStatus=cache_status,
        )
    except Exception as exc:
        _raise_api_error(exc)


# --- Static file serving for Docker / production builds ---
# When the frontend is built (npm run build → frontend/dist/), mount it so
# the same uvicorn process can serve both the API and the SPA. In dev mode
# (Vite dev server on :5173) this path doesn't exist and is simply skipped.
_FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=str(_FRONTEND_DIST), html=True), name="spa")
