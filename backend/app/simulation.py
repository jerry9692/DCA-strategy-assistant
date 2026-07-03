"""D3 Monte Carlo simulation.

Generates future price paths via Geometric Brownian Motion fitted on
historical daily log returns, then runs the current strategy + fixed
DCA + lump sum on each path to produce a distribution of final values
and a "beat probability".

Scope notes:
- Plain GBM, no regime-switching / jump-diffusion. The model is
  deliberately simple — the value is in showing a *distribution*,
  not in modeling tail risk precisely. The disclaimer makes the
  limitation explicit to the user.
- Synchronous: 1000 paths × 60 months target < 8s on a single
  worker. For larger runs the frontend warns about latency.
- The `prepare_market` cache is cleared at the start of each path
  so 1000 paths don't accumulate 1000 cached indicator frames
  (each ~3700 rows × several columns) and balloon memory.
"""

from __future__ import annotations

import secrets
from datetime import date

import numpy as np
import pandas as pd

from app.backtester import _trade_day_schedule
from app.data import PriceDataError
from app.models import (
    FittedParams,
    MonteCarloBand,
    MonteCarloChartData,
    MonteCarloRequest,
    MonteCarloResponse,
    MonteCarloSamplePath,
    ScenarioStats,
    StrategyConfig,
)
from app.strategies import _settings, clear_prepare_cache, get_strategy, prepare_market

# Appended to every response so the user can't mistake the simulated
# distribution for a forecast.
DISCLAIMER = (
    "基于历史波动率的概率分布,不是预测。"
    "真实市场存在肥尾、波动率聚集和 regime 切换,"
    "实际结果可能显著偏离此分布。"
    "过去的表现不代表未来回报。"
)

TRADING_DAYS_PER_MONTH = 21
TRADING_DAYS_PER_YEAR = 252
MIN_HISTORY_DAYS = 252  # 1 year minimum to fit mu/sigma meaningfully


def fit_log_returns(prices: pd.DataFrame) -> FittedParams:
    """Fit daily log-return mean and std from the close column.

    Raises PriceDataError(code="insufficient_data") if fewer than
    MIN_HISTORY_DAYS valid closes are available — a sub-1-year sample
    gives meaningless volatility.
    """
    closes = prices["close"].dropna()
    if len(closes) < MIN_HISTORY_DAYS:
        raise PriceDataError(
            "历史价格不足 1 年,无法稳定拟合波动率,请扩大回测区间后再试。",
            code="insufficient_data",
            retryable=False,
        )
    log_returns = np.log(closes / closes.shift(1)).dropna()
    mu_daily = float(log_returns.mean())
    sigma_daily = float(log_returns.std(ddof=1))
    return FittedParams(
        muDaily=mu_daily,
        sigmaDaily=sigma_daily,
        muAnnualized=mu_daily * TRADING_DAYS_PER_YEAR,
        sigmaAnnualized=sigma_daily * np.sqrt(TRADING_DAYS_PER_YEAR),
        sampleSize=len(log_returns),
        startPrice=float(closes.iloc[-1]),
    )


def generate_paths(
    s0: float,
    mu_daily: float,
    sigma_daily: float,
    horizon_months: int,
    num_paths: int,
    seed: int,
) -> np.ndarray:
    """Generate (num_paths, steps+1) GBM price paths.

    Column 0 is s0 (the starting price); columns 1..steps are the
    simulated future daily closes. `steps = horizon_months * 21`.

    mu_daily and sigma_daily are the sample mean and std of HISTORICAL
    daily log returns. Under GBM, daily log returns are i.i.d.
    N(mu_daily, sigma_daily²) — the -0.5σ² drift correction is already
    baked into mu_daily because it is computed from log returns (not
    arithmetic returns). So each simulated daily log return is simply
    mu_daily + sigma_daily * Z, with no additional dt scaling.
    """
    steps = horizon_months * TRADING_DAYS_PER_MONTH
    rng = np.random.default_rng(seed)
    z = rng.standard_normal((num_paths, steps))
    log_returns = mu_daily + sigma_daily * z
    log_prices = np.cumsum(log_returns, axis=1)
    future_prices = s0 * np.exp(log_prices)
    return np.column_stack([np.full(num_paths, s0), future_prices])


def _build_synthetic_prices(historical: pd.DataFrame, future_path: np.ndarray) -> pd.DataFrame:
    """Append a single simulated future path to the historical closes.

    future_path[0] equals the last historical close (s0), so it is
    dropped to avoid a duplicate row. The future segment is indexed by
    business days (Mon-Fri) starting the day after the last historical
    bar; real exchange holidays are not modeled, but
    `_trade_day_schedule` snaps each scheduled buy to the next
    available index in the concatenated frame, so the strategy still
    executes on valid rows.
    """
    last_date = historical.index[-1]
    future_dates = pd.bdate_range(
        start=last_date + pd.Timedelta(days=1),
        periods=len(future_path) - 1,
    )
    future_df = pd.DataFrame({"close": future_path[1:]}, index=future_dates)
    return pd.concat([historical[["close"]], future_df])


def _make_synthetic_builder(
    historical: pd.DataFrame, future_dates: pd.DatetimeIndex
) -> tuple[pd.DataFrame, int]:
    """Pre-build a reusable synthetic-price frame template.

    Returns (template_df, future_start_pos). The caller fills the
    future segment in-place via `template_df.iloc[future_start_pos:, 0] = path`,
    avoiding a per-path pd.concat (which was the #1 hotspot at
    ~36ms/path — concat rebuilds the internal BlockManager even when
    only close values change).

    The historical segment is shared (read-only during simulation) so
    in-place mutation of the future slice is safe as long as each path
    overwrites the entire future segment before reading.
    """
    future_len = len(future_dates)
    hist_close = historical["close"].to_numpy(dtype=float)
    full_close = np.concatenate([hist_close, np.zeros(future_len)])
    full_index = historical.index.append(future_dates)
    template = pd.DataFrame({"close": full_close}, index=full_index)
    return template, len(hist_close)


def _monthly_values(events: list, sim_start: date, horizon_months: int) -> np.ndarray:
    """Reduce a per-path event list to a (horizon_months+1,) array of
    portfolio values, one per month offset from sim_start.

    Each event is bucketed into "month offset from sim_start" (calendar
    month difference). Within a bucket the last event wins (events are
    already in chronological order from the backtester). Gaps are
    forward-filled so the chart line stays continuous when a month has
    no scheduled buy (rare, but possible at the edges).
    """
    result = np.zeros(horizon_months + 1)
    if not events:
        return result
    sim_start_ts = pd.Timestamp(sim_start)
    for event in events:
        event_ts = pd.Timestamp(event.date)
        months_diff = (event_ts.year - sim_start_ts.year) * 12 + (
            event_ts.month - sim_start_ts.month
        )
        if 0 <= months_diff <= horizon_months:
            result[months_diff] = event.portfolioValue
    # Forward-fill zeros (months with no event).
    last = 0.0
    for i in range(len(result)):
        if result[i] == 0.0:
            result[i] = last
        else:
            last = result[i]
    return result


def _scenario_stats(values: np.ndarray) -> ScenarioStats:
    if len(values) == 0:
        return ScenarioStats(p5=0, p25=0, p50=0, p75=0, p95=0, mean=0, std=0)
    return ScenarioStats(
        p5=round(float(np.percentile(values, 5)), 2),
        p25=round(float(np.percentile(values, 25)), 2),
        p50=round(float(np.percentile(values, 50)), 2),
        p75=round(float(np.percentile(values, 75)), 2),
        p95=round(float(np.percentile(values, 95)), 2),
        mean=round(float(values.mean()), 2),
        std=round(float(values.std(ddof=1)), 2) if len(values) > 1 else 0.0,
    )


def _monthly_percentile_curve(matrix: np.ndarray, pct: float) -> list[float]:
    """Per-month percentile across paths. Returns a list aligned with
    the months axis (length = horizon_months + 1).
    """
    if matrix.size == 0:
        return []
    return [round(float(np.percentile(matrix[:, m], pct)), 2) for m in range(matrix.shape[1])]


# ─── Fast-path scenario runners ──────────────────────────────────────────────
#
# These bypass DcaBacktester.run / _run_fixed / run_lump_sum entirely.
# MC only needs (final_value, monthly_value_curve) per path — not
# ContributionEvent objects, not BacktestMetrics (Sharpe/Sortino/IRR
# via bisection), not _with_cashflow_adjusted_drawdowns. Skipping
# that post-processing cuts per-path cost by ~3x.
#
# The buy math is identical to the backtester:
#   shares += amount*(1-fee) / (price*(1+slippage))
#   final  = shares * close_at_last_trading_day_le_sim_end
# The mark-to-market step in the backtester appends a synthetic
# amount=0 event at prices.index[-1] (which == sim_end for the
# synthetic frame), so final_value = shares * prices["close"].iloc[-1]
# in all cases — whether or not the last trade day coincides with
# the last row.


def _bucket_monthly_values(
    dates: list[pd.Timestamp],
    values: np.ndarray,
    sim_start: date,
    horizon: int,
) -> np.ndarray:
    """Bucket (date, value) pairs by calendar month offset from
    sim_start, keeping the last value per month. Forward-fill gaps.

    Array-based equivalent of _monthly_values, avoiding ContributionEvent
    construction entirely.
    """
    result = np.zeros(horizon + 1)
    if len(dates) == 0:
        return result
    sim_start_ts = pd.Timestamp(sim_start)
    for d, v in zip(dates, values):
        months_diff = (d.year - sim_start_ts.year) * 12 + (d.month - sim_start_ts.month)
        if 0 <= months_diff <= horizon:
            result[months_diff] = v
    last = 0.0
    for i in range(len(result)):
        if result[i] == 0.0:
            result[i] = last
        else:
            last = result[i]
    return result


def _fast_fixed_dca(
    prices: pd.DataFrame,
    trade_days: pd.DatetimeIndex,
    base_amount: float,
    fee_rate: float,
    slippage_rate: float,
    sim_start: date,
    horizon: int,
) -> tuple[float, np.ndarray]:
    """Vectorized fixed DCA: buy base_amount on each scheduled trade
    day. Returns (final_value, monthly_values).
    """
    if len(trade_days) == 0:
        return 0.0, np.zeros(horizon + 1)
    closes = prices.loc[trade_days, "close"].astype(float).values
    exec_prices = closes * (1 + slippage_rate)
    bought = (base_amount * (1 - fee_rate)) / exec_prices
    cum_shares = np.cumsum(bought)
    portfolio_values = cum_shares * closes
    last_close = float(prices["close"].iloc[-1])
    final_value = float(cum_shares[-1] * last_close)
    all_dates = list(trade_days) + [prices.index[-1]]
    all_values = np.append(portfolio_values, final_value)
    monthly = _bucket_monthly_values(all_dates, all_values, sim_start, horizon)
    return final_value, monthly


def _fast_lump_sum(
    prices: pd.DataFrame,
    trade_days: pd.DatetimeIndex,
    total_amount: float,
    fee_rate: float,
    slippage_rate: float,
    sim_start: date,
    horizon: int,
) -> tuple[float, np.ndarray]:
    """Vectorized lump sum: invest total_amount on the first trade day.
    """
    if len(trade_days) == 0 or total_amount <= 0:
        return 0.0, np.zeros(horizon + 1)
    closes = prices.loc[trade_days, "close"].astype(float).values
    first_price = closes[0]
    exec_price = first_price * (1 + slippage_rate)
    shares = (total_amount * (1 - fee_rate)) / exec_price
    portfolio_values = shares * closes
    last_close = float(prices["close"].iloc[-1])
    final_value = float(shares * last_close)
    all_dates = list(trade_days) + [prices.index[-1]]
    all_values = np.append(portfolio_values, final_value)
    monthly = _bucket_monthly_values(all_dates, all_values, sim_start, horizon)
    return final_value, monthly


def _fast_strategy_run(
    prices: pd.DataFrame,
    prepared: pd.DataFrame,
    strategy_type: str,
    config: StrategyConfig,
    trade_days: pd.DatetimeIndex,
    fee_rate: float,
    slippage_rate: float,
    sim_start: date,
    horizon: int,
) -> tuple[float, np.ndarray]:
    """Run the strategy buy loop without _metrics / drawdowns /
    _raw_signals / StrategyDecision construction.

    Vectorized over trade_days: extract all needed indicator columns
    once as numpy arrays, compute per-strategy score/amount in bulk,
    then run the buy accumulation as a single Python loop over the
    (small) trade-day count. This avoids the per-row pandas .loc
    lookup + Series construction overhead of the backtester path,
    which dominates at 1000 paths.
    """
    from app.strategies import _param

    n = len(trade_days)
    if n == 0:
        return 0.0, np.zeros(horizon + 1)

    # Bulk-extract indicator columns at the trade-day positions.
    # get_indexer is O(n) once; subsequent array indexing is O(1).
    positions = prepared.index.get_indexer(trade_days)
    close = prepared["close"].to_numpy(dtype=float)[positions]
    # NaN → sentinel; replaced after signal computation.
    nan_mask = np.isnan(close)
    close = np.where(nan_mask, 0.0, close)

    def _col(name: str) -> np.ndarray:
        if name not in prepared.columns:
            return np.full(n, np.nan)
        return prepared[name].to_numpy(dtype=float)[positions]

    drawdown_pct = _col("drawdown_pct")
    sma_deviation_pct = _col("sma_deviation_pct")
    percentile = _col("percentile")
    rsi = _col("rsi")
    rolling_low = _col("rolling_low")
    grid_high = _col("grid_high")

    # Compute score per trade-day, vectorized per strategy.
    # Each branch mirrors the registered evaluator's math exactly.
    min_mult = config.minMultiplier
    max_mult = config.maxMultiplier
    base = config.baseAmount

    def _amounts_from_score(score: np.ndarray) -> np.ndarray:
        bounded = np.clip(score, 0.0, 1.0)
        mult = min_mult + bounded * (max_mult - min_mult)
        return np.round(base * mult, 2)

    if strategy_type == "fixed_dca":
        amounts = np.full(n, round(base, 2))
    elif strategy_type == "drawdown_boost":
        max_dd = float(_param(config, "maxDrawdownPct", 30))
        depth = np.maximum(0.0, -drawdown_pct / 100)
        score = np.clip(depth / max(max_dd / 100, 1e-4), 0, 1)
        score = np.where(np.isnan(drawdown_pct), 0.5, score)
        warmup = np.isnan(drawdown_pct)
        amounts = _amounts_from_score(np.where(warmup, 0.5, score))
        amounts = np.where(warmup, round(base, 2), amounts)
    elif strategy_type == "ma_deviation":
        threshold = float(_param(config, "deviationPct", 15))
        score = np.clip(0.5 - sma_deviation_pct / max(2 * threshold, 1e-4), 0, 1)
        warmup = np.isnan(sma_deviation_pct)
        amounts = _amounts_from_score(np.where(warmup, 0.5, score))
        amounts = np.where(warmup, round(base, 2), amounts)
    elif strategy_type == "historical_percentile":
        score = np.clip(1 - percentile / 100, 0, 1)
        warmup = np.isnan(percentile)
        amounts = _amounts_from_score(np.where(warmup, 0.5, score))
        amounts = np.where(warmup, round(base, 2), amounts)
    elif strategy_type == "rsi_sentiment":
        oversold = float(_param(config, "oversold", 30))
        overbought = float(_param(config, "overbought", 70))
        score = np.clip((overbought - rsi) / max(1, overbought - oversold), 0, 1)
        warmup = np.isnan(rsi)
        amounts = _amounts_from_score(np.where(warmup, 0.5, score))
        amounts = np.where(warmup, round(base, 2), amounts)
    elif strategy_type == "grid_weighted":
        smooth = bool(_param(config, "smooth", True))
        low = rolling_low
        high = grid_high
        valid = ~(np.isnan(low) | np.isnan(high))
        pos = np.where(valid & (high > low), np.clip((close - low) / (high - low), 0, 1), 0.5)
        score = 1 - pos
        if smooth:
            score = np.clip(score * 0.85 + 0.5 * 0.15, 0, 1)
        warmup = ~valid
        amounts = _amounts_from_score(np.where(warmup, 0.5, score))
        amounts = np.where(warmup, round(base, 2), amounts)
    elif strategy_type == "composite_score":
        # Vectorized composite: same weight-blend math as the evaluator.
        max_dd = float(_param(config, "maxDrawdownPct", 30))
        threshold = float(_param(config, "deviationPct", 15))
        oversold = float(_param(config, "oversold", 30))
        overbought = float(_param(config, "overbought", 70))

        w_dd = float(_param(config, "drawdownWeight", 1))
        w_ma = float(_param(config, "maWeight", 1))
        w_pct = float(_param(config, "percentileWeight", 1))
        w_rsi = float(_param(config, "rsiWeight", 1))
        w_grid = float(_param(config, "gridWeight", 1))

        s_dd = np.clip(np.maximum(0.0, -drawdown_pct / 100) / max(max_dd / 100, 1e-4), 0, 1)
        s_ma = np.clip(0.5 - sma_deviation_pct / max(2 * threshold, 1e-4), 0, 1)
        s_pct = np.clip(1 - percentile / 100, 0, 1)
        s_rsi = np.clip((overbought - rsi) / max(1, overbought - oversold), 0, 1)

        low = rolling_low
        high = grid_high
        grid_valid = ~(np.isnan(low) | np.isnan(high))
        grid_pos = np.where(grid_valid & (high > low), np.clip((close - low) / (high - low), 0, 1), 0.5)
        s_grid = 1 - grid_pos

        # Warmup masks per signal.
        warm_dd = np.isnan(drawdown_pct)
        warm_ma = np.isnan(sma_deviation_pct)
        warm_pct = np.isnan(percentile)
        warm_rsi = np.isnan(rsi)
        warm_grid = ~grid_valid

        # Weighted average, skipping warmup signals (weight treated as 0).
        active_dd = (w_dd > 0) & ~warm_dd
        active_ma = (w_ma > 0) & ~warm_ma
        active_pct = (w_pct > 0) & ~warm_pct
        active_rsi = (w_rsi > 0) & ~warm_rsi
        active_grid = (w_grid > 0) & ~warm_grid

        total_w = (
            np.where(active_dd, w_dd, 0.0)
            + np.where(active_ma, w_ma, 0.0)
            + np.where(active_pct, w_pct, 0.0)
            + np.where(active_rsi, w_rsi, 0.0)
            + np.where(active_grid, w_grid, 0.0)
        )
        weighted = (
            np.where(active_dd, s_dd * w_dd, 0.0)
            + np.where(active_ma, s_ma * w_ma, 0.0)
            + np.where(active_pct, s_pct * w_pct, 0.0)
            + np.where(active_rsi, s_rsi * w_rsi, 0.0)
            + np.where(active_grid, s_grid * w_grid, 0.0)
        )
        score = np.where(total_w > 0, weighted / np.where(total_w > 0, total_w, 1.0), 0.5)
        amounts = _amounts_from_score(score)
    else:
        # Fallback: per-row evaluator call (slower but correct for any
        # future strategy that doesn't have a vectorized path yet).
        evaluator = get_strategy(strategy_type)
        amounts = np.zeros(n)
        for j in range(n):
            row = prepared.iloc[positions[j]]
            score, amt, _, _, warmup = evaluator(row, config)
            amounts[j] = config.baseAmount if warmup else amt

    # Buy accumulation loop (Python, but only n iterations where n is
    # the trade-day count — typically 60 for monthly × 5y).
    exec_prices = close * (1 + slippage_rate)
    net_amounts = amounts * (1 - fee_rate)
    # Avoid div-by-zero; rows with exec_price<=0 buy 0 shares.
    safe_exec = np.where(exec_prices > 0, exec_prices, 1.0)
    bought = np.where(exec_prices > 0, net_amounts / safe_exec, 0.0)
    cum_shares = np.cumsum(bought)
    values = cum_shares * close

    last_close = float(prices["close"].iloc[-1])
    final_value = float(cum_shares[-1] * last_close) if n > 0 else 0.0
    all_dates = list(trade_days) + [prices.index[-1]]
    all_values = np.append(values, final_value)
    monthly = _bucket_monthly_values(all_dates, all_values, sim_start, horizon)
    return final_value, monthly


def run_montecarlo(
    request: MonteCarloRequest,
    prices: pd.DataFrame,
    currency: str,
) -> MonteCarloResponse:
    """Run the full Monte Carlo simulation and return the distribution.

    `prices` is the historical price frame (same one used by the
    backtest endpoint). `currency` is currently unused but kept in the
    signature for symmetry with other endpoints and future LLM tie-in.
    """
    fitted = fit_log_returns(prices)
    seed = request.seed if request.seed is not None else secrets.randbelow(2**32)
    paths = generate_paths(
        fitted.startPrice,
        fitted.muDaily,
        fitted.sigmaDaily,
        request.horizonMonths,
        request.numPaths,
        seed,
    )

    historical = prices.sort_index()

    # Truncate history to the minimum lookback the indicators need
    # BEFORE building the synthetic template. The backtest endpoint
    # passes ~8 years of prices (5y range + 3y warmup), but MC only
    # needs enough to let rolling windows (SMA200, percentile-756,
    # etc.) produce non-NaN values at sim_start. Going longer just
    # multiplies the rolling-compute cost per path.
    config = request.config
    indicator_settings = _settings(config)
    min_warmup = (
        max(
            indicator_settings.high_window,
            indicator_settings.ma_window,
            indicator_settings.percentile_window,
            indicator_settings.grid_window,
        )
        + 50
    )
    if len(historical) > min_warmup:
        historical = historical.tail(min_warmup)

    sim_start = historical.index[-1].date()
    future_dates = pd.bdate_range(
        start=historical.index[-1] + pd.Timedelta(days=1),
        periods=request.horizonMonths * TRADING_DAYS_PER_MONTH,
    )
    sim_end = future_dates[-1].date()

    # Pre-build a reusable synthetic-price frame template so the per-path
    # loop only mutates the future close slice in-place instead of
    # rebuilding a DataFrame via pd.concat each iteration.
    synthetic_template, future_start_pos = _make_synthetic_builder(historical, future_dates)

    fee_rate = float(config.params.get("feeRate", 0))
    slippage_rate = float(config.params.get("slippageRate", 0))

    # All paths share the same index (historical tail + same future
    # bdate_range), so the trade-day schedule is identical across
    # paths. Compute it once outside the loop — _trade_day_schedule
    # does a per-scheduled-day searchsorted over the full price index,
    # which is ~11ms per call and would dominate at 1000 paths.
    trade_days = _trade_day_schedule(synthetic_template, sim_start, sim_end, config.frequency)
    lump_total = round(config.baseAmount * len(trade_days), 2)

    strategy_finals = np.zeros(request.numPaths)
    fixed_finals = np.zeros(request.numPaths)
    lump_finals = np.zeros(request.numPaths)
    horizon = request.horizonMonths
    strategy_monthly = np.zeros((request.numPaths, horizon + 1))
    fixed_monthly = np.zeros((request.numPaths, horizon + 1))
    lump_monthly = np.zeros((request.numPaths, horizon + 1))

    # In-place mutation target: copy the template once so we don't
    # corrupt the original. Each path overwrites the future slice
    # before any read, so reuse across paths is safe.
    synthetic_prices = synthetic_template.copy()

    for i in range(request.numPaths):
        # Clear the prepare_market cache from the previous path so we
        # don't accumulate one cached indicator frame per path (each
        # ~3700 rows × several columns → ~150MB at 1000 paths).
        clear_prepare_cache()
        # Overwrite only the future segment; historical closes are
        # identical across paths. This avoids pd.concat (~36ms/path).
        synthetic_prices.iloc[future_start_pos:, 0] = paths[i][1:]

        # Strategy: needs indicators (prepare_market) + per-trade-day
        # evaluator calls. Uses _fast_strategy_run to skip _metrics,
        # _with_cashflow_adjusted_drawdowns, _raw_signals, and
        # StrategyDecision construction — MC only needs the value curve.
        prepared = prepare_market(synthetic_prices, config)
        strategy_finals[i], strategy_monthly[i] = _fast_strategy_run(
            synthetic_prices, prepared, config.strategyType, config,
            trade_days, fee_rate, slippage_rate, sim_start, horizon,
        )

        # Fixed DCA: vectorized, no indicators needed.
        fixed_finals[i], fixed_monthly[i] = _fast_fixed_dca(
            synthetic_prices, trade_days, config.baseAmount,
            fee_rate, slippage_rate, sim_start, horizon,
        )

        # Lump sum invests the same total as fixed DCA would have over
        # the horizon, on day one. This keeps the comparison about
        # timing, not about total budget.
        lump_finals[i], lump_monthly[i] = _fast_lump_sum(
            synthetic_prices, trade_days, lump_total,
            fee_rate, slippage_rate, sim_start, horizon,
        )

    # Final cleanup so the cache doesn't leak simulated frames into
    # the next request.
    clear_prepare_cache()

    beat_probability = float(np.mean(strategy_finals > fixed_finals))

    months = list(range(horizon + 1))

    # Pick 6 representative paths by their final-value rank to overlay
    # as thin sample lines on the chart. Using ranks (p5/p20/p40/p60/
    # p80/p95) ensures we show a spread from worst to best outcome
    # without cherry-picking extreme paths.
    SAMPLE_RANKS = (5, 20, 40, 60, 80, 95)
    ranked_indices = np.argsort(strategy_finals)
    sample_paths: list[MonteCarloSamplePath] = []
    for rank in SAMPLE_RANKS:
        idx = ranked_indices[round(rank / 100 * (request.numPaths - 1))]
        sample_paths.append(MonteCarloSamplePath(
            rank=rank,
            strategyValues=[float(v) for v in strategy_monthly[idx]],
        ))

    chart = MonteCarloChartData(
        months=months,
        strategyMedian=_monthly_percentile_curve(strategy_monthly, 50),
        strategyBand5_95=MonteCarloBand(
            lower=_monthly_percentile_curve(strategy_monthly, 5),
            upper=_monthly_percentile_curve(strategy_monthly, 95),
        ),
        strategyBand25_75=MonteCarloBand(
            lower=_monthly_percentile_curve(strategy_monthly, 25),
            upper=_monthly_percentile_curve(strategy_monthly, 75),
        ),
        fixedDcaMedian=_monthly_percentile_curve(fixed_monthly, 50),
        lumpSumMedian=_monthly_percentile_curve(lump_monthly, 50),
        samplePaths=sample_paths,
    )

    return MonteCarloResponse(
        symbol=request.symbol,
        horizonMonths=request.horizonMonths,
        numPaths=request.numPaths,
        seed=seed,
        fittedParams=fitted,
        strategy=_scenario_stats(strategy_finals),
        fixedDca=_scenario_stats(fixed_finals),
        lumpSum=_scenario_stats(lump_finals),
        beatFixedDcaProbability=round(beat_probability, 4),
        chart=chart,
        disclaimer=DISCLAIMER,
    )
