import pandas as pd
import pytest

from app.backtester import DcaBacktester, _next_trading_day, _schedule
from app.main import _chart_prices, _market_state
from app.models import StrategyConfig
from app.strategies import evaluate_prepared_strategy, evaluate_strategy


def fixture_prices(values):
    index = pd.bdate_range("2020-01-01", periods=len(values))
    return pd.DataFrame({"close": values}, index=index)


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
    assert evaluate_strategy("composite_score", drawdown_heavy, prices).score != evaluate_strategy("composite_score", base, prices).score


def test_backtester_runs_weekly_events():
    prices = fixture_prices([100 + i * 0.1 for i in range(120)])
    config = StrategyConfig(strategyType="fixed_dca", baseAmount=100, frequency="weekly")
    events, metrics = DcaBacktester(prices).run("fixed_dca", config, pd.Timestamp("2020-01-01").date(), pd.Timestamp("2020-03-31").date())
    assert events
    assert metrics.buyCount == len(events)
    assert metrics.totalInvested == 100 * len(events)


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
    assert decision.score == 0.5
    assert decision.recommendedAmount == 135


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


def test_chart_prices_filters_with_timestamp_boundary():
    prices = pd.DataFrame(
        {"close": [100, 101, 102]},
        index=pd.to_datetime(["2021-09-30", "2021-10-01", "2021-10-04"]),
    )
    chart = _chart_prices(prices, pd.Timestamp("2021-10-01").date())
    assert [point["date"] for point in chart] == ["2021-10-01", "2021-10-04"]


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
    assert decision.rawSignals["percentile"] == 50
    assert decision.rawSignals["rsi"] == 50


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
