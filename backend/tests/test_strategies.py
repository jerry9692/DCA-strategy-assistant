import time

import pandas as pd
import pytest

from app.backtester import (
    DcaBacktester,
    _next_trading_day,
    _schedule,
    rolling_annualized_returns,
    rolling_lump_sum_annualized_returns,
)
from app.main import (
    _cached_fixed_backtest,
    _chart_contributions,
    _chart_prices,
    _market_state,
    _rolling_performance,
    _rolling_window_years,
    assets,
)
from app.models import BacktestMetrics, ContributionEvent, OptimizationRequest, OptimizationResult, StrategyConfig
from app.optimization_jobs import cancel_optimization_job, create_optimization_job, get_optimization_job
from app.optimizer import OptimizationCancelled, _robust_score, optimize_parameters
from app.strategies import (
    _prepare_cache,
    clear_prepare_cache,
    evaluate_prepared_strategy,
    evaluate_strategy,
    prepare_market,
)


def fixture_prices(values):
    index = pd.bdate_range("2020-01-01", periods=len(values))
    return pd.DataFrame({"close": values}, index=index)


def test_strategy_config_rejects_inverted_multiplier_bounds():
    """Regression test for code-review #8.

    Without this validation the API would accept minMultiplier >=
    maxMultiplier and silently lock buys at or below baseAmount, which
    completely breaks the dynamic-DCA narrative shown in the UI.
    """

    with pytest.raises(ValueError, match="minMultiplier"):
        StrategyConfig(
            strategyType="composite_score",
            baseAmount=100,
            minMultiplier=1.5,
            maxMultiplier=1.0,
        )

    with pytest.raises(ValueError, match="minMultiplier"):
        StrategyConfig(
            strategyType="composite_score",
            baseAmount=100,
            minMultiplier=1.0,
            maxMultiplier=1.0,
        )


def test_prepare_market_cache_does_not_collide_when_python_recycles_object_ids():
    """Regression test: an earlier implementation used `id(prices)` as
    part of the cache key, which silently returned stale indicators
    whenever CPython recycled an object address. The semantic key
    (shape + first/last index + first/last close + IndicatorSettings)
    should distinguish two different price series even when they happen
    to land at the same memory address.
    """

    clear_prepare_cache()
    # Use a series with real ups and downs so RSI actually moves out of
    # the fillna(50) neutral default.
    rising = fixture_prices([100 + (i * 1.0) - (0.3 if i % 5 == 0 else 0.0) for i in range(70)])
    rising_prepared = prepare_market(rising, StrategyConfig(strategyType="rsi_sentiment", baseAmount=100))
    rising_sma_tail = float(rising_prepared["sma"].iloc[-1])
    rising_dd_tail = float(rising_prepared["drawdown_pct"].iloc[-1])

    # Drop references so CPython is free to recycle the object id.
    del rising, rising_prepared

    falling = fixture_prices([200 - (i * 1.0) + (0.3 if i % 5 == 0 else 0.0) for i in range(70)])
    falling_prepared = prepare_market(falling, StrategyConfig(strategyType="rsi_sentiment", baseAmount=100))
    falling_sma_tail = float(falling_prepared["sma"].iloc[-1])
    falling_dd_tail = float(falling_prepared["drawdown_pct"].iloc[-1])

    # If the cache had keyed on id() and the address was recycled, both
    # series would yield identical indicators. With the semantic key
    # they must clearly differ: rising prices end above their SMA and
    # near their rolling high (drawdown ≈ 0), falling prices end below
    # their SMA and far from the rolling high.
    assert rising_sma_tail != falling_sma_tail
    assert rising_dd_tail != falling_dd_tail
    assert rising_dd_tail > -1.0  # rising series ends near rolling high
    assert falling_dd_tail < -30.0  # falling series ends well below high


def test_prepare_market_cache_returns_same_object_on_hit():
    """Cache hit must return the exact same DataFrame instance — not a
    re-computed copy — otherwise the cache provides no speedup.
    """

    clear_prepare_cache()
    prices = fixture_prices([100 + i for i in range(50)])
    config = StrategyConfig(strategyType="composite_score", baseAmount=100)
    first = prepare_market(prices, config)
    second = prepare_market(prices, config)
    assert first is second
    assert len(_prepare_cache) == 1


def test_fixed_dca_returns_base_amount():
    prices = fixture_prices([100, 101, 102, 103, 104])
    config = StrategyConfig(strategyType="fixed_dca", baseAmount=125, minMultiplier=0.2, maxMultiplier=2.5)
    decision = evaluate_strategy("fixed_dca", config, prices)
    assert decision.recommendedAmount == 125
    assert decision.multiplier == 1
    assert decision.reasons


def test_drawdown_boost_respects_multiplier_bounds():
    prices = fixture_prices([100] * 30 + [80])
    config = StrategyConfig(
        strategyType="drawdown_boost",
        baseAmount=100,
        minMultiplier=0.2,
        maxMultiplier=2.5,
        params={"lookbackDays": 30, "maxDrawdownPct": 20},
    )
    decision = evaluate_strategy("drawdown_boost", config, prices)
    assert 20 <= decision.recommendedAmount <= 250
    assert decision.multiplier == 2.5


def test_composite_weights_change_score():
    prices = fixture_prices(list(range(100, 180)) + list(range(180, 120, -1)))
    base = StrategyConfig(strategyType="composite_score", baseAmount=100)
    drawdown_heavy = StrategyConfig(
        strategyType="composite_score",
        baseAmount=100,
        params={"drawdownWeight": 3, "maWeight": 0, "percentileWeight": 0, "rsiWeight": 0, "gridWeight": 0},
    )
    assert (
        evaluate_strategy("composite_score", drawdown_heavy, prices).score
        != evaluate_strategy("composite_score", base, prices).score
    )


def test_backtester_runs_weekly_events():
    prices = fixture_prices([100 + i * 0.1 for i in range(120)])
    config = StrategyConfig(strategyType="fixed_dca", baseAmount=100, frequency="weekly")
    events, metrics = DcaBacktester(prices).run(
        "fixed_dca", config, pd.Timestamp("2020-01-01").date(), pd.Timestamp("2020-03-31").date()
    )
    assert events
    buys = [event for event in events if event.amount > 0]
    assert metrics.buyCount == len(buys)
    assert metrics.totalInvested == 100 * len(buys)


def test_ma_deviation_invests_more_below_average_than_above():
    above_prices = fixture_prices([100] * 80 + [120])
    below_prices = fixture_prices([100] * 80 + [80])
    config = StrategyConfig(
        strategyType="ma_deviation",
        baseAmount=100,
        minMultiplier=0.2,
        maxMultiplier=2.5,
        params={"maWindow": 60, "deviationPct": 20},
    )
    above = evaluate_strategy("ma_deviation", config, above_prices)
    below = evaluate_strategy("ma_deviation", config, below_prices)
    assert below.recommendedAmount > above.recommendedAmount


def test_rsi_sentiment_invests_more_when_oversold_than_overheated():
    overheated = fixture_prices(list(range(100, 170)))
    oversold = fixture_prices(list(range(170, 100, -1)))
    config = StrategyConfig(
        strategyType="rsi_sentiment",
        baseAmount=100,
        minMultiplier=0.2,
        maxMultiplier=2.5,
        params={"rsiWindow": 14, "oversold": 30, "overbought": 70},
    )
    hot = evaluate_strategy("rsi_sentiment", config, overheated)
    cold = evaluate_strategy("rsi_sentiment", config, oversold)
    assert cold.recommendedAmount > hot.recommendedAmount


def test_historical_percentile_invests_more_at_low_percentile():
    high_last = fixture_prices(list(range(100, 180)))
    low_last = fixture_prices(list(range(100, 180)) + [90])
    config = StrategyConfig(
        strategyType="historical_percentile",
        baseAmount=100,
        minMultiplier=0.2,
        maxMultiplier=2.5,
        params={"percentileWindow": 80},
    )
    high = evaluate_strategy("historical_percentile", config, high_last)
    low = evaluate_strategy("historical_percentile", config, low_last)
    assert low.recommendedAmount > high.recommendedAmount


def test_grid_weighted_invests_more_in_lower_bucket():
    high_bucket = fixture_prices(list(range(100, 180)))
    low_bucket = fixture_prices(list(range(100, 180)) + [105])
    config = StrategyConfig(
        strategyType="grid_weighted",
        baseAmount=100,
        minMultiplier=0.2,
        maxMultiplier=2.5,
        params={"gridWindow": 80, "gridCount": 8, "smooth": False},
    )
    high = evaluate_strategy("grid_weighted", config, high_bucket)
    low = evaluate_strategy("grid_weighted", config, low_bucket)
    assert low.recommendedAmount > high.recommendedAmount
    assert low.rawSignals["gridBucket"] < high.rawSignals["gridBucket"]


def test_composite_all_zero_weights_falls_back_to_neutral():
    prices = fixture_prices(list(range(100, 180)) + list(range(180, 120, -1)))
    config = StrategyConfig(
        strategyType="composite_score",
        baseAmount=100,
        minMultiplier=0.2,
        maxMultiplier=2.5,
        params={"drawdownWeight": 0, "maWeight": 0, "percentileWeight": 0, "rsiWeight": 0, "gridWeight": 0},
    )
    decision = evaluate_strategy("composite_score", config, prices)
    # No active signal means we fall back to a neutral, base-amount buy and
    # flag the decision as warmup so the UI can highlight it.
    assert decision.score == 0.5
    assert decision.warmup is True
    assert decision.multiplier == 1.0
    assert decision.recommendedAmount == 100


def test_empty_price_frame_raises_clear_error():
    config = StrategyConfig(strategyType="fixed_dca", baseAmount=100)
    with pytest.raises(ValueError, match="No price data"):
        evaluate_strategy("fixed_dca", config, pd.DataFrame(columns=["close"]))


def test_single_day_data_does_not_crash_for_fixed_dca():
    prices = fixture_prices([100])
    config = StrategyConfig(strategyType="fixed_dca", baseAmount=100)
    decision = evaluate_strategy("fixed_dca", config, prices)
    assert decision.recommendedAmount == 100


def test_next_trading_day_moves_weekend_to_next_available_day():
    prices = pd.DataFrame({"close": [100, 101]}, index=pd.to_datetime(["2020-01-06", "2020-01-07"]))
    assert _next_trading_day(prices, pd.Timestamp("2020-01-04")) == pd.Timestamp("2020-01-06")


def test_fee_and_slippage_reduce_purchased_shares():
    prices = fixture_prices([100, 101, 102, 103, 104])
    config = StrategyConfig(strategyType="fixed_dca", baseAmount=100, frequency="weekly")
    events, _ = DcaBacktester(prices).run(
        "fixed_dca",
        config,
        pd.Timestamp("2020-01-01").date(),
        pd.Timestamp("2020-01-10").date(),
        fee_rate=0.1,
        slippage_rate=0.1,
    )
    assert events[0].shares == round(90 / (100 * 1.1), 8)


def test_schedule_includes_start_date_as_first_buy_opportunity():
    schedule = _schedule(pd.Timestamp("2020-01-01").date(), pd.Timestamp("2020-01-15").date(), "weekly")
    assert schedule[0] == pd.Timestamp("2020-01-01")
    assert pd.Timestamp("2020-01-06") in schedule


def test_schedule_supports_biweekly_events():
    schedule = _schedule(pd.Timestamp("2020-01-01").date(), pd.Timestamp("2020-02-10").date(), "biweekly")
    assert schedule[0] == pd.Timestamp("2020-01-01")
    assert pd.Timestamp("2020-01-06") in schedule
    assert pd.Timestamp("2020-01-20") in schedule
    assert pd.Timestamp("2020-02-03") in schedule


def test_weekend_start_does_not_double_buy_on_next_monday():
    """Regression test for the duplicate-buy bug.

    When a backtest starts on a weekend, the calendar schedule contains both
    that weekend day and the following Monday (the W-MON anchor). Both map to
    the same trading day. The backtester must record only one buy for that
    Monday, otherwise totals, shares and metrics get inflated.
    """

    prices = pd.DataFrame(
        {"close": [100, 101, 102, 103, 104, 105, 106, 107, 108, 109]},
        index=pd.bdate_range("2021-05-24", periods=10),
    )
    config = StrategyConfig(strategyType="fixed_dca", baseAmount=100, frequency="weekly")
    events, metrics = DcaBacktester(prices).run(
        "fixed_dca",
        config,
        pd.Timestamp("2021-05-23").date(),  # Sunday
        pd.Timestamp("2021-06-11").date(),
    )
    buy_dates = [event.date for event in events if event.amount > 0]
    assert len(buy_dates) == len(set(buy_dates)), f"unexpected duplicate buys: {buy_dates}"
    assert metrics.buyCount == len(buy_dates)
    assert metrics.totalInvested == 100 * len(buy_dates)


def test_lump_sum_weekend_start_does_not_double_track_initial_buy():
    prices = pd.DataFrame(
        {"close": [100, 101, 102, 103, 104, 105, 106, 107, 108, 109]},
        index=pd.bdate_range("2021-05-24", periods=10),
    )
    events, metrics = DcaBacktester(prices).run_lump_sum(
        1000,
        pd.Timestamp("2021-05-23").date(),  # Sunday
        pd.Timestamp("2021-06-11").date(),
        "weekly",
    )
    dates = [event.date for event in events]
    assert len(dates) == len(set(dates)), f"unexpected duplicate events: {dates}"
    # First (and only) real buy still happens on the first usable trading day.
    assert events[0].amount == 1000
    assert all(event.amount == 0 for event in events[1:])
    assert metrics.buyCount == 1


def test_chart_prices_filters_with_timestamp_boundary():
    prices = pd.DataFrame(
        {"close": [100, 101, 102]},
        index=pd.to_datetime(["2021-09-30", "2021-10-01", "2021-10-04"]),
    )
    chart = _chart_prices(prices, pd.Timestamp("2021-10-01").date())
    assert [point.date for point in chart] == ["2021-10-01", "2021-10-04"]


def test_chart_prices_returns_every_trading_day_in_window():
    """Regression test: a previous version subsampled the price series
    to ~360 points, which caused buy-point scatter dots to drift off
    the price line whenever a buy day got sampled out. The chart must
    return every trading day in the visible window so the price line
    and buy points share the same X-axis grid.
    """

    # 600 trading days — more than the old 360-point cap, so the bug
    # would have triggered subsampling and dropped most of these.
    prices = pd.DataFrame(
        {"close": [100 + i * 0.1 for i in range(600)]},
        index=pd.bdate_range("2020-01-02", periods=600),
    )
    chart = _chart_prices(prices, pd.Timestamp("2020-01-02").date())
    assert len(chart) == 600
    # Every original date is preserved, no gaps from subsampling.
    chart_dates = [point.date for point in chart]
    assert chart_dates[0] == "2020-01-02"
    assert chart_dates[-1] == prices.index[-1].date().isoformat()


def test_chart_contributions_account_drawdown_reflects_cash_reserve():
    dynamic_events = [
        ContributionEvent(
            date="2020-01-01",
            price=100,
            amount=80,
            shares=0.8,
            totalShares=0.8,
            totalInvested=80,
            portfolioValue=80,
            multiplier=0.8,
            score=0.5,
            reasons=[],
        ),
        ContributionEvent(
            date="2020-01-08",
            price=90,
            amount=80,
            shares=0.88888889,
            totalShares=1.68888889,
            totalInvested=160,
            portfolioValue=152,
            multiplier=0.8,
            score=0.5,
            reasons=[],
        ),
    ]
    fixed_events = [
        ContributionEvent(
            date="2020-01-01",
            price=100,
            amount=100,
            shares=1,
            totalShares=1,
            totalInvested=100,
            portfolioValue=100,
            multiplier=1,
            score=0.5,
            reasons=[],
        ),
        ContributionEvent(
            date="2020-01-08",
            price=90,
            amount=100,
            shares=1.11111111,
            totalShares=2.11111111,
            totalInvested=200,
            portfolioValue=190,
            multiplier=1,
            score=0.5,
            reasons=[],
        ),
    ]

    dynamic = _chart_contributions(dynamic_events, scheduled_budget=100)
    fixed = _chart_contributions(fixed_events, scheduled_budget=100)

    assert dynamic[1].accountDrawdownPct == -8
    assert fixed[1].accountDrawdownPct == -10


def test_chart_contributions_account_drawdown_does_not_assume_borrowing():
    events = [
        ContributionEvent(
            date="2020-01-01",
            price=100,
            amount=150,
            shares=1.5,
            totalShares=1.5,
            totalInvested=150,
            portfolioValue=150,
            multiplier=1.5,
            score=1,
            reasons=[],
        ),
        ContributionEvent(
            date="2020-01-08",
            price=90,
            amount=150,
            shares=1.66666667,
            totalShares=3.16666667,
            totalInvested=300,
            portfolioValue=285,
            multiplier=1.5,
            score=1,
            reasons=[],
        ),
    ]

    chart = _chart_contributions(events, scheduled_budget=100)

    assert chart[1].accountDrawdownPct == -10


def test_signal_reasons_do_not_render_nan_for_short_windows():
    prepared = pd.DataFrame(
        {
            "close": [100],
            "drawdown_pct": [float("nan")],
            "sma_deviation_pct": [float("nan")],
            "percentile": [float("nan")],
            "rsi": [float("nan")],
            "rolling_low": [float("nan")],
            "grid_high": [float("nan")],
        },
        index=pd.to_datetime(["2020-01-01"]),
    )
    config = StrategyConfig(strategyType="composite_score", baseAmount=100)
    decision = evaluate_prepared_strategy("composite_score", config, prepared)
    assert "nan" not in " ".join(decision.reasons).lower()
    # When the indicators have not warmed up yet, expose the warmup flag
    # rather than silently swapping in default values.
    assert decision.warmup is True
    assert decision.rawSignals["percentile"] is None
    assert decision.rawSignals["rsi"] is None


def test_drawdown_boost_warmup_falls_back_to_base_amount_with_clear_reason():
    """Regression test for the silent-warmup issue from the code review.

    Before the fix, drawdown_boost without enough lookback returned score=0,
    pinned the multiplier to minMultiplier, and emitted '近窗口回撤 0.0%'
    as if the market were genuinely overheated. Users had no way to tell
    that the strategy was actually starved of data.
    """

    prepared = pd.DataFrame(
        {
            "close": [100],
            "drawdown_pct": [float("nan")],
            "sma_deviation_pct": [float("nan")],
            "percentile": [float("nan")],
            "rsi": [float("nan")],
            "rolling_low": [float("nan")],
            "grid_high": [float("nan")],
        },
        index=pd.to_datetime(["2020-01-01"]),
    )
    config = StrategyConfig(
        strategyType="drawdown_boost",
        baseAmount=100,
        minMultiplier=0.8,
        maxMultiplier=1.2,
    )
    decision = evaluate_prepared_strategy("drawdown_boost", config, prepared)
    assert decision.warmup is True
    assert decision.multiplier == 1.0
    assert decision.recommendedAmount == 100
    assert decision.score == 0.5
    assert "0.0%" not in " ".join(decision.reasons)
    assert any("预热" in reason for reason in decision.reasons)


def test_composite_partial_warmup_uses_only_active_signals():
    """If some sub-signals are still warming up but at least one is ready,
    the composite strategy should use only the ready ones and stay informative
    rather than dragging the score back to neutral."""

    prepared = pd.DataFrame(
        {
            "close": [100],
            # drawdown is the only fully-warmed signal in this fixture.
            "drawdown_pct": [-20.0],
            "sma_deviation_pct": [float("nan")],
            "percentile": [float("nan")],
            "rsi": [float("nan")],
            "rolling_low": [float("nan")],
            "grid_high": [float("nan")],
        },
        index=pd.to_datetime(["2020-01-01"]),
    )
    config = StrategyConfig(
        strategyType="composite_score",
        baseAmount=100,
        minMultiplier=0.8,
        maxMultiplier=1.2,
        params={"maxDrawdownPct": 30},
    )
    decision = evaluate_prepared_strategy("composite_score", config, prepared)
    # One signal active, four warming up: not flagged as warmup, but the
    # caller sees an explicit note about how many were skipped.
    assert decision.warmup is False
    assert any("子信号预热不足" in reason for reason in decision.reasons)
    # 20% drawdown vs a 30% trigger gives score ~0.67, well above neutral.
    assert decision.score > 0.5


def test_annualized_return_uses_money_weighted_dca_result():
    prices = fixture_prices([100 + i for i in range(520)])
    config = StrategyConfig(strategyType="fixed_dca", baseAmount=100, frequency="weekly")
    _, metrics = DcaBacktester(prices).run(
        "fixed_dca",
        config,
        pd.Timestamp("2020-01-01").date(),
        pd.Timestamp("2021-12-31").date(),
    )
    assert metrics.annualizedReturnPct > metrics.returnPct / 2


def test_rolling_annualized_returns_are_money_weighted():
    dates = pd.date_range("2020-01-01", "2021-01-01", freq="MS")
    prices = [100, 95, 90, 85, 80, 80, 80, 90, 100, 110, 115, 120, 120]

    def events(amounts: list[float]) -> list[ContributionEvent]:
        shares = 0.0
        invested = 0.0
        result = []
        for item_date, price, amount in zip(dates, prices, amounts):
            bought = amount / price if price > 0 else 0
            shares += bought
            invested += amount
            result.append(
                ContributionEvent(
                    date=item_date.date().isoformat(),
                    price=price,
                    amount=amount,
                    shares=round(bought, 8),
                    totalShares=round(shares, 8),
                    totalInvested=round(invested, 2),
                    portfolioValue=round(shares * price, 2),
                    multiplier=1,
                    score=0.5,
                    reasons=[],
                )
            )
        return result

    early_buyer = events([150, 150, 150, 150, 150, 150, 50, 50, 50, 50, 50, 50, 50])
    dip_buyer = events([50, 50, 50, 50, 50, 50, 150, 150, 150, 150, 150, 150, 150])

    early_points = rolling_annualized_returns(early_buyer, window_years=1)
    dip_points = rolling_annualized_returns(dip_buyer, window_years=1)

    assert early_points[-1][0] == "2021-01-01"
    assert dip_points[-1][1] > early_points[-1][1]


def test_rolling_lump_sum_uses_window_budget_at_window_start():
    prices = fixture_prices([100 + i * 0.2 for i in range(900)])
    config = StrategyConfig(strategyType="fixed_dca", baseAmount=100, frequency="weekly")
    fixed_events, _ = DcaBacktester(prices).run(
        "fixed_dca",
        config,
        pd.Timestamp("2020-01-01").date(),
        pd.Timestamp("2023-05-31").date(),
    )

    fixed_points = dict(rolling_annualized_returns(fixed_events, window_years=1))
    lump_points = dict(rolling_lump_sum_annualized_returns(fixed_events, window_years=1))
    common_dates = sorted(set(fixed_points) & set(lump_points))

    assert common_dates
    assert any(fixed_points[item] != lump_points[item] for item in common_dates)


def test_rolling_performance_selects_window_by_backtest_length():
    assert _rolling_window_years(pd.Timestamp("2020-01-01").date(), pd.Timestamp("2026-01-01").date()) == 3
    assert _rolling_window_years(pd.Timestamp("2022-01-01").date(), pd.Timestamp("2024-06-01").date()) == 1
    assert _rolling_window_years(pd.Timestamp("2024-01-01").date(), pd.Timestamp("2024-12-31").date()) is None


def test_rolling_performance_aligns_strategy_fixed_and_lump_sum():
    prices = fixture_prices([100 + i * 0.05 + (20 if 180 <= i <= 360 else 0) for i in range(900)])
    fixed_config = StrategyConfig(strategyType="fixed_dca", baseAmount=100, frequency="weekly")
    dynamic_config = StrategyConfig(
        strategyType="ma_deviation",
        baseAmount=100,
        frequency="weekly",
        minMultiplier=0.8,
        maxMultiplier=1.2,
        params={"maWindow": 80, "deviationPct": 10},
    )
    backtester = DcaBacktester(prices)
    dynamic_events, _ = backtester.run(
        "ma_deviation",
        dynamic_config,
        pd.Timestamp("2020-01-01").date(),
        pd.Timestamp("2023-05-31").date(),
    )
    fixed_events, _ = backtester.run(
        "fixed_dca",
        fixed_config,
        pd.Timestamp("2020-01-01").date(),
        pd.Timestamp("2023-05-31").date(),
    )

    points = _rolling_performance(
        dynamic_events,
        fixed_events,
        pd.Timestamp("2020-01-01").date(),
        pd.Timestamp("2023-05-31").date(),
    )

    assert points
    assert points[0].windowYears == 1
    assert points[-1].strategyAnnualizedReturnPct is not None
    assert points[-1].fixedAnnualizedReturnPct is not None
    assert points[-1].lumpSumAnnualizedReturnPct is not None
    assert any(
        point.strategyAnnualizedReturnPct != point.fixedAnnualizedReturnPct
        for point in points
        if point.strategyAnnualizedReturnPct is not None and point.fixedAnnualizedReturnPct is not None
    )


def test_lump_sum_invests_total_budget_once_and_tracks_value():
    prices = fixture_prices([100 + i for i in range(80)])
    events, metrics = DcaBacktester(prices).run_lump_sum(
        1000,
        pd.Timestamp("2020-01-01").date(),
        pd.Timestamp("2020-03-31").date(),
        "weekly",
    )
    assert events[0].amount == 1000
    assert all(event.amount == 0 for event in events[1:])
    assert metrics.totalInvested == 1000
    assert metrics.buyCount == 1
    assert metrics.endingValue > 1000


def test_metrics_use_period_end_close_for_ending_value():
    """Regression test for code-review #6.

    A backtest whose endDate is a few weeks after the last scheduled buy
    used to leave endingValue stuck at the last buy-day close. After the
    fix, endingValue tracks the close on the last trading day on or
    before endDate.
    """

    # Prices climb steadily; last weekly buy is around day 60. Include
    # weekday-only data through 2020-04-15 so endDate=2020-04-15 sits
    # well after the last weekly schedule point of late March.
    prices = pd.DataFrame(
        {"close": [100 + i * 0.5 for i in range(75)]},
        index=pd.bdate_range("2020-01-06", periods=75),
    )
    config = StrategyConfig(strategyType="fixed_dca", baseAmount=100, frequency="weekly")
    events, metrics = DcaBacktester(prices).run(
        "fixed_dca",
        config,
        pd.Timestamp("2020-01-06").date(),
        pd.Timestamp("2020-04-15").date(),
    )
    last_event = events[-1]
    last_buy = next(event for event in reversed(events) if event.amount > 0)
    # The mark-to-market event has amount=0 and sits strictly after the
    # last real buy.
    assert last_event.amount == 0
    assert last_event.date > last_buy.date
    # endingValue follows the mark-to-market close, not the last buy.
    assert metrics.endingValue == round(last_event.totalShares * last_event.price, 2)
    assert metrics.endingValue != round(last_buy.totalShares * last_buy.price, 2)
    # Buy count and total invested still reflect actual buys only.
    assert metrics.buyCount == sum(1 for event in events if event.amount > 0)
    assert metrics.totalInvested == max(event.totalInvested for event in events)


def test_cashflow_adjusted_drawdown_detects_price_drop_between_buys():
    prices = fixture_prices([100, 100, 100, 90, 90, 90, 90, 95])
    config = StrategyConfig(strategyType="fixed_dca", baseAmount=100, frequency="weekly")
    events, metrics = DcaBacktester(prices).run(
        "fixed_dca",
        config,
        pd.Timestamp("2020-01-01").date(),
        pd.Timestamp("2020-01-10").date(),
    )
    assert events[1].portfolioValue > events[0].portfolioValue
    assert events[1].drawdownPct == -10
    assert metrics.maxDrawdownPct == -10


def test_metrics_include_risk_adjusted_ratios_when_series_is_long_enough():
    prices = fixture_prices([100 + i * 0.5 for i in range(180)])
    config = StrategyConfig(strategyType="fixed_dca", baseAmount=100, frequency="weekly")
    _, metrics = DcaBacktester(prices).run(
        "fixed_dca",
        config,
        pd.Timestamp("2020-01-01").date(),
        pd.Timestamp("2020-06-30").date(),
    )
    assert metrics.sharpeRatio is not None
    assert metrics.sortinoRatio is None or isinstance(metrics.sortinoRatio, float)


def test_market_state_detects_uptrend():
    prices = fixture_prices([100 + i for i in range(260)])
    state = _market_state(prices, pd.Timestamp("2020-12-31").date())
    assert state.tone == "up"
    assert state.sma50 is not None
    assert state.sma200 is not None


def test_assets_endpoint_returns_grouped_us_etf_metadata():
    items = assets()
    by_symbol = {item.symbol: item for item in items}

    assert len(items) == 31
    assert by_symbol["VTI"].categoryLabel == "核心宽基"
    assert by_symbol["TQQQ"].riskLevel == "advanced"
    assert by_symbol["TQQQ"].riskNote is not None
    assert by_symbol["IBIT"].categoryLabel == "高级/高波动"
    assert by_symbol["510050"].market == "cn"
    assert by_symbol["510050"].currency == "CNY"
    assert by_symbol["510050"].providerSymbol == "510050.SS"
    assert by_symbol["159915"].providerSymbol == "159915.SZ"


def test_cached_fixed_backtest_reuses_same_parameter_result(monkeypatch):
    calls = 0
    prices = fixture_prices([100 + i for i in range(30)])

    def fake_price_history(symbol, start, end):
        nonlocal calls
        calls += 1
        return prices, "fixture", "cache-hit"

    monkeypatch.setattr("app.main.get_price_history", fake_price_history)
    _cached_fixed_backtest.cache_clear()
    start = pd.Timestamp("2020-01-01").date()
    end = pd.Timestamp("2020-01-31").date()

    _cached_fixed_backtest("QQQ", start, end, 100, "weekly", 0.04)
    _cached_fixed_backtest("QQQ", start, end, 100, "weekly", 0.04)

    assert calls == 1
    _cached_fixed_backtest.cache_clear()


def long_fixture_prices(start="2019-01-01", end="2024-12-31"):
    index = pd.bdate_range(start, end)
    values = [100 + i * 0.04 + (i % 90) * 0.03 for i in range(len(index))]
    return pd.DataFrame({"close": values}, index=index)


def test_optimizer_returns_candidates_for_each_tunable_strategy(monkeypatch):
    prices = long_fixture_prices()

    def fake_price_history(symbol, start, end):
        return prices, "fixture", "cache-hit"

    monkeypatch.setattr("app.optimizer.get_price_history", fake_price_history)
    monkeypatch.setattr("app.optimizer.MAX_CANDIDATES", 16)

    for strategy_type in [
        "drawdown_boost",
        "ma_deviation",
        "historical_percentile",
        "rsi_sentiment",
        "grid_weighted",
        "composite_score",
    ]:
        result = optimize_parameters(
            OptimizationRequest(
                symbol="QQQ",
                startDate=pd.Timestamp("2022-01-03").date(),
                endDate=pd.Timestamp("2024-12-31").date(),
                config=StrategyConfig(strategyType=strategy_type, baseAmount=100, frequency="weekly"),
            )
        )
        assert result.recommendedConfig.strategyType == strategy_type
        assert result.candidates
        assert result.scenarios
        assert result.searchedCount <= 16


def test_optimizer_rejects_fixed_dca():
    with pytest.raises(ValueError, match="固定定投没有可调参数"):
        optimize_parameters(OptimizationRequest(config=StrategyConfig(strategyType="fixed_dca")))


def test_optimizer_keeps_current_config_as_baseline(monkeypatch):
    prices = long_fixture_prices()

    def fake_price_history(symbol, start, end):
        return prices, "fixture", "cache-hit"

    config = StrategyConfig(
        strategyType="ma_deviation",
        baseAmount=100,
        frequency="weekly",
        minMultiplier=0.7,
        maxMultiplier=1.4,
        params={"maWindow": 150, "deviationPct": 12},
    )
    monkeypatch.setattr("app.optimizer.get_price_history", fake_price_history)
    monkeypatch.setattr("app.optimizer.MAX_CANDIDATES", 8)

    result = optimize_parameters(
        OptimizationRequest(
            symbol="QQQ",
            startDate=pd.Timestamp("2022-01-03").date(),
            endDate=pd.Timestamp("2024-12-31").date(),
            config=config,
        )
    )

    assert result.baselineConfig == config
    assert result.baselineSummary.buyCount > 0


def test_optimizer_default_search_space_stays_dca_like(monkeypatch):
    prices = long_fixture_prices()

    def fake_price_history(symbol, start, end):
        return prices, "fixture", "cache-hit"

    monkeypatch.setattr("app.optimizer.get_price_history", fake_price_history)

    result = optimize_parameters(
        OptimizationRequest(
            symbol="QQQ",
            startDate=pd.Timestamp("2022-01-03").date(),
            endDate=pd.Timestamp("2024-12-31").date(),
            config=StrategyConfig(strategyType="historical_percentile", baseAmount=100, frequency="weekly"),
        )
    )

    assert result.recommendedConfig.minMultiplier >= 0.6
    assert result.recommendedConfig.maxMultiplier <= 1.5
    assert all(candidate.config.minMultiplier >= 0.6 for candidate in result.candidates)
    assert all(candidate.config.maxMultiplier <= 1.5 for candidate in result.candidates)


def test_optimizer_baseline_does_not_bypass_dca_like_search_space(monkeypatch):
    prices = long_fixture_prices()

    def fake_price_history(symbol, start, end):
        return prices, "fixture", "cache-hit"

    monkeypatch.setattr("app.optimizer.get_price_history", fake_price_history)

    result = optimize_parameters(
        OptimizationRequest(
            symbol="QQQ",
            startDate=pd.Timestamp("2022-01-03").date(),
            endDate=pd.Timestamp("2024-12-31").date(),
            config=StrategyConfig(
                strategyType="composite_score",
                baseAmount=100,
                frequency="weekly",
                minMultiplier=0.2,
                maxMultiplier=2.5,
                params={},
            ),
        )
    )

    assert result.baselineConfig.minMultiplier == 0.2
    assert result.baselineConfig.maxMultiplier == 2.5
    assert result.recommendedConfig.minMultiplier >= 0.6
    assert result.recommendedConfig.maxMultiplier <= 1.5
    assert all(candidate.config.minMultiplier >= 0.6 for candidate in result.candidates)
    assert all(candidate.config.maxMultiplier <= 1.5 for candidate in result.candidates)


def test_optimizer_average_metrics_skips_none_versus_fixed(monkeypatch):
    """Regression test: scenarios where the fixed-DCA baseline is empty
    return versusFixedPct=None. _average_metrics must not silently treat
    those as 0% (a perfect tie), because a fragile candidate that "ties"
    on every empty scenario would otherwise float to the top.
    """

    from app.optimizer import _average_metrics

    healthy = BacktestMetrics(
        totalInvested=1000,
        endingValue=1100,
        returnPct=10,
        annualizedReturnPct=8,
        maxDrawdownPct=-5,
        buyCount=10,
        avgContribution=100,
        versusFixedPct=8,
    )
    no_baseline = BacktestMetrics(
        totalInvested=1000,
        endingValue=1100,
        returnPct=10,
        annualizedReturnPct=8,
        maxDrawdownPct=-5,
        buyCount=10,
        avgContribution=100,
        versusFixedPct=None,
    )

    averaged = _average_metrics([healthy, no_baseline])

    # Average should ignore the None baseline, not pull it toward 4 (= (8+0)/2).
    assert averaged.versusFixedPct == 8


def test_robust_score_penalizes_single_scenario_blowup():
    steady = BacktestMetrics(
        totalInvested=1000,
        endingValue=1200,
        returnPct=20,
        annualizedReturnPct=10,
        maxDrawdownPct=-8,
        buyCount=10,
        avgContribution=100,
        versusFixedPct=1,
        sharpeRatio=1,
    )
    blowup = BacktestMetrics(
        totalInvested=1000,
        endingValue=700,
        returnPct=-30,
        annualizedReturnPct=-20,
        maxDrawdownPct=-55,
        buyCount=10,
        avgContribution=100,
        versusFixedPct=-20,
        sharpeRatio=-1,
    )

    stable_score = _robust_score([10, 9, 8], [steady, steady, steady])
    fragile_score = _robust_score([30, 28, -20], [steady, steady, blowup])

    assert stable_score > fragile_score


def test_optimizer_counts_unavailable_scenarios(monkeypatch):
    prices = long_fixture_prices("2022-01-01", "2024-12-31")

    def fake_price_history(symbol, start, end):
        return prices, "fixture", "cache-hit"

    monkeypatch.setattr("app.optimizer.get_price_history", fake_price_history)
    monkeypatch.setattr("app.optimizer.MAX_CANDIDATES", 4)

    result = optimize_parameters(
        OptimizationRequest(
            symbol="QQQ",
            startDate=pd.Timestamp("2024-01-01").date(),
            endDate=pd.Timestamp("2024-12-31").date(),
            config=StrategyConfig(strategyType="historical_percentile", baseAmount=100, frequency="weekly"),
        )
    )

    assert result.skippedCount > 0


def test_optimizer_returns_top_five_candidates(monkeypatch):
    prices = long_fixture_prices()

    def fake_price_history(symbol, start, end):
        return prices, "fixture", "cache-hit"

    monkeypatch.setattr("app.optimizer.get_price_history", fake_price_history)
    monkeypatch.setattr("app.optimizer.MAX_CANDIDATES", 12)

    result = optimize_parameters(
        OptimizationRequest(
            symbol="QQQ",
            startDate=pd.Timestamp("2022-01-03").date(),
            endDate=pd.Timestamp("2024-12-31").date(),
            config=StrategyConfig(strategyType="ma_deviation", baseAmount=100, frequency="weekly"),
        )
    )

    assert len(result.candidates) == 5
    assert [candidate.rank for candidate in result.candidates] == [1, 2, 3, 4, 5]


def _job_metric() -> BacktestMetrics:
    return BacktestMetrics(
        totalInvested=1000,
        endingValue=1120,
        returnPct=12,
        annualizedReturnPct=8,
        maxDrawdownPct=-6,
        buyCount=10,
        avgContribution=100,
    )


def _job_result(request: OptimizationRequest) -> OptimizationResult:
    return OptimizationResult(
        symbol=request.symbol,
        objective=request.objective,
        baselineConfig=request.config,
        recommendedConfig=request.config,
        baselineSummary=_job_metric(),
        recommendedSummary=_job_metric(),
        candidates=[],
        scenarios=[],
        searchedCount=1,
        skippedCount=0,
    )


def _wait_for_job(job_id: str, wanted: set[str], timeout: float = 1.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = get_optimization_job(job_id)
        if status and status.status in wanted:
            return status
        time.sleep(0.01)
    return get_optimization_job(job_id)


def test_optimization_job_completes_with_result(monkeypatch):
    def fake_optimize(request, progress_callback=None, should_cancel=None):
        if progress_callback:
            progress_callback(
                {"evaluatedCount": 1, "totalCount": 2, "currentScenario": "当前选择区间", "bestSoFar": None}
            )
            progress_callback({"evaluatedCount": 2, "totalCount": 2, "currentScenario": None, "bestSoFar": None})
        return _job_result(request)

    monkeypatch.setattr("app.optimization_jobs.optimize_parameters", fake_optimize)
    job_id = create_optimization_job(OptimizationRequest(config=StrategyConfig(strategyType="ma_deviation")))

    status = _wait_for_job(job_id, {"completed"})

    assert status is not None
    assert status.status == "completed"
    assert status.progress == 100
    assert status.result is not None
    assert status.result.searchedCount == 1


def test_optimization_job_can_be_cancelled(monkeypatch):
    def fake_optimize(request, progress_callback=None, should_cancel=None):
        while should_cancel and not should_cancel():
            time.sleep(0.01)
        raise OptimizationCancelled()

    monkeypatch.setattr("app.optimization_jobs.optimize_parameters", fake_optimize)
    job_id = create_optimization_job(OptimizationRequest(config=StrategyConfig(strategyType="ma_deviation")))

    cancelled = cancel_optimization_job(job_id)
    status = _wait_for_job(job_id, {"cancelled"})

    assert cancelled is not None
    assert cancelled.status == "cancelled"
    assert status is not None
    assert status.status == "cancelled"
