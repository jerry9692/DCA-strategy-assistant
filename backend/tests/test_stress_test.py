"""Tests for the D5 Stress Test (What-if) module."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from pydantic import ValidationError

from app.data import PriceDataError
from app.models import StrategyConfig, StressTestRequest
from app.stress_test import (
    DISCLAIMER,
    TRADING_DAYS_PER_MONTH,
    generate_stress_path,
    run_stress_test,
)


def _make_prices(
    n_days: int = 300,
    start_price: float = 100.0,
    drift: float = 0.0005,
    vol: float = 0.01,
    seed: int = 42,
) -> pd.DataFrame:
    """Build a synthetic daily price frame with a known drift/vol.

    n_days defaults to 300 so we clear the 252-day minimum. The random
    walk is reproducible via `seed`.
    """
    rng = np.random.default_rng(seed)
    dates = pd.bdate_range(start="2023-01-01", periods=n_days)
    log_returns = drift + vol * rng.standard_normal(n_days)
    closes = start_price * np.exp(np.cumsum(log_returns))
    return pd.DataFrame({"close": closes}, index=dates)


def _config(strategy: str = "composite_score") -> StrategyConfig:
    return StrategyConfig(strategyType=strategy, baseAmount=100.0, frequency="weekly")


# ─── generate_stress_path ─────────────────────────────────────────


def test_generate_path_one_time_drop():
    s0 = 100.0
    path = generate_stress_path(s0, "one_time", -20.0, 3)
    steps = 3 * TRADING_DAYS_PER_MONTH
    jump_idx = max(1, steps // 4)
    # Length = steps + 1 (including s0 at index 0)
    assert len(path) == steps + 1
    # First point is s0
    assert path[0] == pytest.approx(s0)
    # Points before and at jump_idx stay at s0 (calm before the shock)
    for i in range(1, jump_idx + 1):
        assert path[i] == pytest.approx(s0, rel=1e-9)
    # Points after jump_idx = s0 * 0.8 (post-jump floor)
    target = s0 * 0.8
    for i in range(jump_idx + 1, len(path)):
        assert path[i] == pytest.approx(target, rel=1e-9)


def test_generate_path_gradual_decline():
    s0 = 100.0
    path = generate_stress_path(s0, "gradual", -20.0, 3)
    # First point is s0, last point is s0 * 0.8
    assert path[0] == pytest.approx(s0)
    assert path[-1] == pytest.approx(s0 * 0.8, rel=1e-9)
    # Monotonically decreasing for a negative change
    assert np.all(np.diff(path) < 0)


def test_generate_path_v_shape_midpoint_extreme():
    s0 = 100.0
    path = generate_stress_path(s0, "v_shape", -20.0, 3)
    steps = 3 * TRADING_DAYS_PER_MONTH
    midpoint = steps // 2
    # First and last points ≈ s0
    assert path[0] == pytest.approx(s0)
    assert path[-1] == pytest.approx(s0, rel=1e-9)
    # The minimum sits at the midpoint region. For odd `steps` the true
    # peak of the triangle (factor=1) falls between two integer indices,
    # so the sampled minimum is within one step of the geometric midpoint
    # and within ~0.5% of the target price s0*(1+change).
    assert np.argmin(path) == pytest.approx(midpoint, abs=2)
    assert np.min(path) == pytest.approx(s0 * 0.8, rel=5e-3)
    # Endpoints return to s0 (the V recovers).
    assert np.max(path) == pytest.approx(s0, rel=1e-9)


def test_generate_path_positive_change_is_jump():
    s0 = 100.0
    path = generate_stress_path(s0, "one_time", 30.0, 1)
    steps = 1 * TRADING_DAYS_PER_MONTH
    jump_idx = max(1, steps // 4)
    target = s0 * 1.3
    # Points 0..jump_idx stay at s0 (calm before the spike)
    for i in range(0, jump_idx + 1):
        assert path[i] == pytest.approx(s0, rel=1e-9)
    # Points after jump_idx jump to target
    for i in range(jump_idx + 1, len(path)):
        assert path[i] == pytest.approx(target, rel=1e-9)


# ─── run_stress_test ──────────────────────────────────────────────


def test_stress_test_returns_future_contributions():
    prices = _make_prices(n_days=300)
    request = StressTestRequest(
        symbol="QQQ",
        config=_config(),
        shape="v_shape",
        totalChangePct=-20.0,
        horizonMonths=3,
    )
    response = run_stress_test(request, prices, "USD")

    # All returned contribution events should fall after the last
    # historical date.
    last_hist_date = prices.index[-1].date()
    for ev in response.strategyContributions:
        assert pd.Timestamp(ev.date).date() > last_hist_date
    for ev in response.fixedDcaContributions:
        assert pd.Timestamp(ev.date).date() > last_hist_date

    # The response carries the scenario metadata.
    assert response.shape == "v_shape"
    assert response.totalChangePct == -20.0
    assert response.horizonMonths == 3
    assert response.startPrice == pytest.approx(float(prices["close"].iloc[-1]), rel=1e-4)
    assert response.disclaimer == DISCLAIMER


def test_stress_test_max_floating_loss_is_negative_on_drop():
    prices = _make_prices(n_days=300)
    request = StressTestRequest(
        config=_config(),
        shape="gradual",
        totalChangePct=-30.0,
        horizonMonths=3,
    )
    response = run_stress_test(request, prices, "USD")
    # In a gradual decline the price keeps dropping after each buy, so
    # the portfolio value falls below the cash invested at some point.
    assert response.strategyMetrics.maxFloatingLossPct < 0
    assert response.fixedDcaMetrics.maxFloatingLossPct < 0


def test_stress_test_one_time_drop_shows_floating_loss():
    """With the delayed-jump path (calm for ~1/4 horizon then crash),
    at least one weekly buy happens at s0 before the shock, so the
    portfolio must show a negative floating loss after the drop."""
    prices = _make_prices(n_days=300)
    request = StressTestRequest(
        config=_config(),
        shape="one_time",
        totalChangePct=-35.0,
        horizonMonths=6,
    )
    response = run_stress_test(request, prices, "USD")
    assert response.strategyMetrics.maxFloatingLossPct < 0
    assert response.fixedDcaMetrics.maxFloatingLossPct < 0
    assert response.lumpSumMetrics.maxFloatingLossPct < 0


def test_stress_test_rejects_invalid_shape():
    with pytest.raises(ValidationError, match="shape"):
        StressTestRequest(shape="invalid_shape")


def test_stress_test_rejects_invalid_change_pct():
    with pytest.raises(ValidationError, match="totalChangePct"):
        StressTestRequest(totalChangePct=70)
    with pytest.raises(ValidationError, match="totalChangePct"):
        StressTestRequest(totalChangePct=-70)


def test_stress_test_rejects_invalid_horizon():
    with pytest.raises(ValidationError, match="horizonMonths"):
        StressTestRequest(horizonMonths=7)


def test_stress_test_rejects_short_history():
    prices = _make_prices(n_days=100)  # below 252-day minimum
    request = StressTestRequest(config=_config())
    with pytest.raises(PriceDataError) as exc_info:
        run_stress_test(request, prices, "USD")
    assert exc_info.value.code == "insufficient_data"


def test_stress_test_strategy_buys_more_on_drawdown():
    """drawdown_boost should buy more (multiplier > 1) when the price
    has dropped significantly from its rolling high."""
    prices = _make_prices(n_days=300)
    config = StrategyConfig(
        strategyType="drawdown_boost",
        baseAmount=100.0,
        frequency="weekly",
        minMultiplier=0.8,
        maxMultiplier=1.2,
    )
    request = StressTestRequest(
        config=config,
        shape="one_time",
        totalChangePct=-25.0,
        horizonMonths=3,
    )
    response = run_stress_test(request, prices, "USD")

    # In a 25% drop, drawdown_boost should fire with multiplier > 1
    # on at least some buys. Filter out the MTM event (multiplier=0).
    real_buys = [ev for ev in response.strategyContributions if ev.amount > 0]
    assert len(real_buys) > 0
    multipliers = [ev.multiplier for ev in real_buys]
    # At least one buy should be above base (multiplier > 1).
    assert max(multipliers) > 1.0, f"Expected multiplier > 1 in a 25% drop, got {multipliers}"


def test_stress_test_future_price_series_matches_shape():
    prices = _make_prices(n_days=300)
    request = StressTestRequest(
        config=_config(),
        shape="gradual",
        totalChangePct=-20.0,
        horizonMonths=1,
    )
    response = run_stress_test(request, prices, "USD")
    # The future price series should start near s0 and end near s0*0.8.
    assert len(response.futurePriceSeries) > 0
    first = response.futurePriceSeries[0].close
    last = response.futurePriceSeries[-1].close
    s0 = response.startPrice
    assert first == pytest.approx(s0, rel=1e-3)
    assert last == pytest.approx(s0 * 0.8, rel=1e-3)
    # minPrice should be the last point for a gradual decline.
    assert response.minPrice == pytest.approx(s0 * 0.8, rel=1e-3)


def test_stress_test_v_shape_endpoints_match_start():
    prices = _make_prices(n_days=300)
    request = StressTestRequest(
        config=_config(),
        shape="v_shape",
        totalChangePct=-20.0,
        horizonMonths=3,
    )
    response = run_stress_test(request, prices, "USD")
    # V-shape returns to s0 at the end.
    assert response.endPrice == pytest.approx(response.startPrice, rel=1e-6)
    # minPrice should be below s0.
    assert response.minPrice < response.startPrice
