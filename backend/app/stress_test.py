"""D5 Stress Test (What-if) simulation.

Generates a single deterministic future price path based on a
user-chosen shape (one-time / gradual / v-shape) and total % change,
appends it to the historical price series, then runs the current
strategy + fixed DCA + lump sum on the combined series to show the
future-segment buy plan and max floating loss.

Scope notes:
- Single deterministic path, not a distribution (that's D3 Monte Carlo).
- Reuses DcaBacktester.run / _run_fixed / run_lump_sum so the buy math
  and indicator calculation are identical to a real backtest.
- The strategy sees the full historical+future price series, so
  indicators (SMA, RSI, drawdown) react to the simulated crash as if
  it were real market data.
"""

from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd

from app.backtester import DcaBacktester
from app.data import PriceDataError
from app.models import (
    ContributionEvent,
    PricePoint,
    StrategyConfig,
    StressTestMetrics,
    StressTestRequest,
    StressTestResponse,
)
from app.strategies import clear_prepare_cache, prepare_market

TRADING_DAYS_PER_MONTH = 21
MIN_HISTORY_DAYS = 252  # 1 year minimum for indicators to be meaningful

DISCLAIMER = "假设场景推演,不是预测。真实市场的暴跌形状、持续时间和反弹节奏会显著偏离此模型。过去的表现不代表未来回报。"


def generate_stress_path(
    s0: float,
    shape: str,
    total_change_pct: float,
    horizon_months: int,
) -> np.ndarray:
    """Generate a single deterministic future price path.

    Returns an array of length ``horizon_months * 21 + 1`` where
    element 0 is ``s0`` (the starting price) and elements 1..N are
    the simulated future daily closes.

    Shapes:
    - ``one_time``: price stays at s0 for the first ~1/4 of the horizon
      then jumps to ``s0 * (1 + change)`` and stays flat. Models
      "sudden shock after a brief calm" — strategies accumulate at
      least one buy at s0 before the shock so floating losses show up.
    - ``gradual``: linear interpolation from s0 to
      ``s0 * (1 + change)`` over the full horizon. Models "slow bleed".
    - ``v_shape``: price reaches ``s0 * (1 + change)`` at the midpoint
      and returns to s0 at the end. Models "crash + recovery".
    """
    steps = horizon_months * TRADING_DAYS_PER_MONTH
    change = total_change_pct / 100.0
    t = np.arange(steps + 1, dtype=float)

    if shape == "one_time":
        # Price stays at s0 for the first ~1/4 of the horizon, then
        # instantaneously jumps to the target and stays flat. The delay
        # gives every strategy (including monthly fixed DCA) at least
        # one buy at s0 BEFORE the shock, so the chart shows real
        # floating losses (crash) or gains (spike) instead of the
        # degenerate "all buys at the post-jump price" flat line where
        # maxFloatingLoss is always 0 %.
        target = s0 * (1 + change)
        jump_idx = max(1, steps // 4)
        path = np.empty(steps + 1, dtype=float)
        path[: jump_idx + 1] = s0
        path[jump_idx + 1 :] = target
    elif shape == "gradual":
        # Linear from s0 to s0*(1+change).
        path = s0 * (1 + change * t / steps)
    elif shape == "v_shape":
        # Triangular: peak/trough at midpoint, back to s0 at end.
        # factor goes 0 -> 1 -> 0. Use piecewise linear so that an
        # integer index always hits factor=1 (the exact extreme),
        # which matters when steps is odd (e.g. steps=21 for 1 month).
        mid = steps // 2
        up = np.linspace(0.0, 1.0, mid + 1)
        down = np.linspace(1.0, 0.0, steps - mid + 1)[1:]
        factor = np.concatenate([up, down])
        path = s0 * (1 + change * factor)
    else:  # pragma: no cover — validated by StressTestRequest
        raise ValueError(f"Unknown shape: {shape!r}")

    # Guard against non-positive prices (a -60% drop is fine, -100%+ is not).
    path = np.maximum(path, 0.01)
    return path


def _build_synthetic_prices(historical: pd.DataFrame, future_path: np.ndarray) -> pd.DataFrame:
    """Append a single stress-test path to the historical closes.

    future_path[0] equals the last historical close (s0), so it is
    dropped to avoid a duplicate row. The future segment is indexed by
    business days (Mon-Fri) starting the day after the last historical
    bar; real exchange holidays are not modeled, but
    `_trade_day_schedule` snaps each scheduled buy to the next
    available index in the concatenated frame.
    """
    last_date = historical.index[-1]
    future_dates = pd.bdate_range(
        start=last_date + pd.Timedelta(days=1),
        periods=len(future_path) - 1,
    )
    future_df = pd.DataFrame({"close": future_path[1:]}, index=future_dates)
    return pd.concat([historical[["close"]], future_df])


def _future_metrics(
    events: list[ContributionEvent],
    future_prices: pd.DataFrame,
) -> StressTestMetrics:
    """Compute stress-test metrics.

    ``maxFloatingLossPct`` is the worst (most negative) value of
    ``(portfolioValue - totalInvested) / totalInvested`` evaluated at
    every future price point — not just at buy events. This captures
    the deepest underwater point between buys, when the price drops
    after a buy but before the next one.

    ``future_prices`` is the future-segment price frame (dates >=
    sim_start), used to mark the cumulative position to market at
    every daily close.
    """
    if not events:
        return StressTestMetrics(
            totalInvested=0,
            endingValue=0,
            returnPct=0,
            maxFloatingLossPct=0,
            buyCount=0,
        )

    # The last event carries the mark-to-market snapshot; its
    # portfolioValue reflects the price at the end of the horizon.
    last = events[-1]
    total_invested = last.totalInvested
    ending_value = last.portfolioValue

    return_pct = ((ending_value - total_invested) / total_invested * 100) if total_invested > 0 else 0.0

    # Walk the future price series, marking the cumulative position to
    # market at each close. Buys take effect on their trade date, so
    # the cumulative shares/invested step up as we cross each buy.
    buy_events = sorted((ev for ev in events if ev.amount > 0), key=lambda e: e.date)
    worst = 0.0
    if buy_events:
        buy_idx = 0
        cumulative_shares = 0.0
        cumulative_invested = 0.0
        for ts, price in future_prices["close"].items():
            while buy_idx < len(buy_events) and pd.Timestamp(buy_events[buy_idx].date) <= ts:
                cumulative_shares = buy_events[buy_idx].totalShares
                cumulative_invested = buy_events[buy_idx].totalInvested
                buy_idx += 1
            if cumulative_invested > 0:
                portfolio_value = cumulative_shares * float(price)
                ratio = (portfolio_value - cumulative_invested) / cumulative_invested * 100
                if ratio < worst:
                    worst = ratio

    # Count real buys (amount > 0), excluding the MTM snapshot.
    buy_count = sum(1 for ev in events if ev.amount > 0)

    # Normalize -0.0 to +0.0 both before and after rounding so that
    # near-zero floating artifacts don't render as "-0.0%".
    max_loss = round(worst + 0.0, 2)
    if max_loss == 0:
        max_loss = 0.0

    return StressTestMetrics(
        totalInvested=round(total_invested, 2),
        endingValue=round(ending_value, 2),
        returnPct=round(return_pct + 0.0, 2),
        maxFloatingLossPct=max_loss,
        buyCount=buy_count,
    )


def _filter_future_events(events: list[ContributionEvent], sim_start: date) -> list[ContributionEvent]:
    """Keep only events that fall on or after sim_start."""
    return [ev for ev in events if pd.Timestamp(ev.date).date() >= sim_start]


def _fixed_config(config: StrategyConfig) -> StrategyConfig:
    """Build a fixed-DCA config mirroring the main backtest endpoint."""
    return StrategyConfig(
        strategyType="fixed_dca",
        baseAmount=config.baseAmount,
        frequency=config.frequency,
        minMultiplier=1,
        maxMultiplier=1.0001,
        params={},
    )


def run_stress_test(
    request: StressTestRequest,
    prices: pd.DataFrame,
    currency: str,
) -> StressTestResponse:
    """Run a single-path stress test and return the future buy plan.

    ``prices`` is the historical price frame (same one used by the
    backtest endpoint, including the 3-year warmup).
    """
    historical = prices.sort_index()
    if len(historical) < MIN_HISTORY_DAYS:
        raise PriceDataError(
            "历史价格不足 1 年,无法生成有意义的压力测试,请扩大回测区间后再试。",
            code="insufficient_data",
            retryable=False,
        )

    s0 = round(float(historical["close"].iloc[-1]), 4)
    future_path = generate_stress_path(
        s0,
        request.shape,
        request.totalChangePct,
        request.horizonMonths,
    )

    synthetic = _build_synthetic_prices(historical, future_path)

    sim_start = synthetic.index[len(historical)].date()  # first future date
    sim_end = synthetic.index[-1].date()

    config = request.config
    fee_rate = float(config.params.get("feeRate", 0))
    slippage_rate = float(config.params.get("slippageRate", 0))
    risk_free_rate = 0.04  # stress test doesn't compute Sharpe/Sortino

    # Bound the prepare_market cache to this request. A single stress
    # test needs at most 2 prepared frames (strategy + fixed), so
    # there's no memory pressure — but clearing keeps behavior
    # consistent with the backtest endpoint.
    clear_prepare_cache()

    backtester = DcaBacktester(synthetic)
    prepared = prepare_market(synthetic, config)

    # Strategy: run on the future segment only, but indicators use the
    # full synthetic series (historical + future) so SMA/RSI/drawdown
    # react to the simulated crash.
    strategy_events, _ = backtester.run(
        config.strategyType,
        config,
        sim_start,
        sim_end,
        fee_rate=fee_rate,
        slippage_rate=slippage_rate,
        prepared=prepared,
        risk_free_rate=risk_free_rate,
    )

    # Fixed DCA: same future segment.
    fixed_config = _fixed_config(config)
    fixed_events, _ = backtester.run(
        "fixed_dca",
        fixed_config,
        sim_start,
        sim_end,
        fee_rate=fee_rate,
        slippage_rate=slippage_rate,
        risk_free_rate=risk_free_rate,
    )

    # The backtester may include events before sim_start if the
    # schedule snaps backwards — filter to future-segment only.
    strategy_future = _filter_future_events(strategy_events, sim_start)
    fixed_future = _filter_future_events(fixed_events, sim_start)

    # Lump sum: invest the same total as fixed DCA actually deployed
    # in the future segment, on the first future trade day. Deriving
    # the budget from the filtered fixed events (rather than
    # baseAmount * buy_count) matches the backtest endpoint pattern
    # and guards against any pre-start events the schedule might emit.
    fixed_total_invested = fixed_future[-1].totalInvested if fixed_future else 0.0
    lump_events, _ = backtester.run_lump_sum(
        fixed_total_invested,
        sim_start,
        sim_end,
        config.frequency,
        fee_rate=fee_rate,
        slippage_rate=slippage_rate,
        risk_free_rate=risk_free_rate,
    )

    lump_future = _filter_future_events(lump_events, sim_start)

    # Future-segment price frame for mark-to-market in _future_metrics.
    # Use pd.Timestamp to avoid the Pandas4Warning about slicing with
    # a bare datetime.date.
    future_prices = synthetic.loc[pd.Timestamp(sim_start) :]

    # Build the future price series for the chart. Include s0 as the
    # first point (anchored at the last historical date) so the chart
    # shows the full path from the current price through the scenario.
    last_hist_ts = historical.index[-1]
    future_dates = pd.bdate_range(
        start=last_hist_ts + pd.Timedelta(days=1),
        periods=len(future_path) - 1,
    )
    all_dates = pd.DatetimeIndex([last_hist_ts, *future_dates])
    future_price_series = [
        PricePoint(date=d.date().isoformat(), close=round(float(p), 4)) for d, p in zip(all_dates, future_path)
    ]

    return StressTestResponse(
        symbol=request.symbol,
        shape=request.shape,
        totalChangePct=request.totalChangePct,
        horizonMonths=request.horizonMonths,
        startPrice=s0,
        endPrice=round(float(future_path[-1]), 4),
        minPrice=round(float(np.min(future_path)), 4),
        strategyContributions=strategy_future,
        fixedDcaContributions=fixed_future,
        lumpSumContributions=lump_future,
        strategyMetrics=_future_metrics(strategy_future, future_prices),
        fixedDcaMetrics=_future_metrics(fixed_future, future_prices),
        lumpSumMetrics=_future_metrics(lump_future, future_prices),
        futurePriceSeries=future_price_series,
        disclaimer=DISCLAIMER,
    )
