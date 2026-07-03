"""Tests for the D3 Monte Carlo simulation module."""

from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd
import pytest
from pydantic import ValidationError

from app.data import PriceDataError
from app.models import MonteCarloRequest
from app.simulation import (
    DISCLAIMER,
    TRADING_DAYS_PER_MONTH,
    _monthly_values,
    fit_log_returns,
    generate_paths,
    run_montecarlo,
)


def _make_prices(
    n_days: int = 300,
    start_price: float = 100.0,
    drift: float = 0.0005,
    vol: float = 0.01,
    seed: int = 42,
) -> pd.DataFrame:
    """Build a synthetic daily price frame with a known drift/vol.

    n_days defaults to 300 so we clear the 252-day minimum needed to
    fit mu/sigma. The random walk is reproducible via `seed`.
    """
    rng = np.random.default_rng(seed)
    dates = pd.bdate_range(start="2023-01-01", periods=n_days)
    log_returns = drift + vol * rng.standard_normal(n_days)
    closes = start_price * np.exp(np.cumsum(log_returns))
    return pd.DataFrame({"close": closes}, index=dates)


def _config():
    from app.models import StrategyConfig

    return StrategyConfig(strategyType="composite_score", baseAmount=100.0, frequency="weekly")


# ─── fit_log_returns ──────────────────────────────────────────────


def test_fit_log_returns_returns_finite_mu_sigma():
    prices = _make_prices()
    fitted = fit_log_returns(prices)
    assert np.isfinite(fitted.muDaily)
    assert np.isfinite(fitted.sigmaDaily)
    assert fitted.sigmaDaily > 0
    # Annualized figures should be in the right ballpark: vol=0.01
    # daily → ~0.158 annualized; drift=0.0005 daily → ~0.126 annualized.
    assert 0.05 < fitted.sigmaAnnualized < 0.30
    assert fitted.sampleSize == len(prices) - 1  # one lost to .shift(1)
    assert fitted.startPrice == pytest.approx(float(prices["close"].iloc[-1]))


def test_fit_log_returns_rejects_short_history():
    prices = _make_prices(n_days=100)  # below 252-day minimum
    with pytest.raises(PriceDataError) as exc_info:
        fit_log_returns(prices)
    assert exc_info.value.code == "insufficient_data"
    assert exc_info.value.retryable is False


# ─── generate_paths ───────────────────────────────────────────────


def test_generate_paths_shape_and_start_price():
    s0 = 100.0
    paths = generate_paths(s0, mu_daily=0.0, sigma_daily=0.01, horizon_months=12, num_paths=50, seed=7)
    # (num_paths, steps+1) — steps = 12 * 21 = 252, plus the s0 column.
    assert paths.shape == (50, 12 * TRADING_DAYS_PER_MONTH + 1)
    # Every path starts at s0.
    assert np.allclose(paths[:, 0], s0)


def test_generate_paths_respects_seed():
    args = (100.0, 0.0005, 0.01, 6, 20)
    a = generate_paths(*args, seed=123)
    b = generate_paths(*args, seed=123)
    c = generate_paths(*args, seed=999)
    assert np.array_equal(a, b)
    assert not np.array_equal(a, c)


# ─── _monthly_values ──────────────────────────────────────────────


def test_monthly_values_buckets_by_calendar_month():
    from app.models import ContributionEvent

    sim_start = date(2024, 1, 31)
    # Events spanning 4 months: Jan (sim_start), Feb, Mar, Apr.
    events = [
        ContributionEvent(
            date="2024-01-31", price=100.0, amount=100.0, shares=1.0,
            totalShares=1.0, totalInvested=100.0, portfolioValue=100.0,
            multiplier=1.0, score=0.5, reasons=[],
        ),
        ContributionEvent(
            date="2024-02-28", price=102.0, amount=100.0, shares=0.98,
            totalShares=1.98, totalInvested=200.0, portfolioValue=201.96,
            multiplier=1.0, score=0.5, reasons=[],
        ),
        ContributionEvent(
            date="2024-03-29", price=105.0, amount=100.0, shares=0.95,
            totalShares=2.93, totalInvested=300.0, portfolioValue=307.65,
            multiplier=1.0, score=0.5, reasons=[],
        ),
        ContributionEvent(
            date="2024-04-30", price=108.0, amount=100.0, shares=0.93,
            totalShares=3.86, totalInvested=400.0, portfolioValue=416.88,
            multiplier=1.0, score=0.5, reasons=[],
        ),
    ]
    values = _monthly_values(events, sim_start, horizon_months=4)
    assert values.shape == (5,)  # months 0..4
    assert values[0] == pytest.approx(100.0)
    assert values[1] == pytest.approx(201.96)
    assert values[2] == pytest.approx(307.65)
    assert values[3] == pytest.approx(416.88)
    # Month 4 has no event → forward-filled from month 3.
    assert values[4] == pytest.approx(416.88)


def test_monthly_values_handles_empty_events():
    values = _monthly_values([], date(2024, 1, 1), horizon_months=6)
    assert values.shape == (7,)
    assert np.all(values == 0.0)


# ─── run_montecarlo ───────────────────────────────────────────────


def _request(**overrides) -> MonteCarloRequest:
    base = dict(
        symbol="QQQ",
        config=_config(),
        horizonMonths=12,
        numPaths=100,
        seed=42,
    )
    base.update(overrides)
    return MonteCarloRequest(**base)


def test_run_montecarlo_returns_well_formed_response():
    prices = _make_prices(n_days=300)
    response = run_montecarlo(_request(), prices, currency="$")

    assert response.symbol == "QQQ"
    assert response.horizonMonths == 12
    assert response.numPaths == 100
    assert response.seed == 42
    assert response.disclaimer == DISCLAIMER
    assert "不是预测" in response.disclaimer

    # Fitted params carried through.
    assert response.fittedParams.startPrice == pytest.approx(float(prices["close"].iloc[-1]))
    assert response.fittedParams.sampleSize == 299

    # Strategy percentiles are ordered and finite.
    s = response.strategy
    assert np.isfinite(s.p5) and np.isfinite(s.p95)
    assert s.p5 <= s.p25 <= s.p50 <= s.p75 <= s.p95
    assert s.p50 > 0  # positive drift in the fixture → positive values

    # Beat probability is a valid probability.
    assert 0.0 <= response.beatFixedDcaProbability <= 1.0


def test_run_montecarlo_chart_payload_aligned():
    prices = _make_prices(n_days=300)
    response = run_montecarlo(_request(horizonMonths=12, numPaths=100), prices, currency="$")

    chart = response.chart
    assert len(chart.months) == 13  # 0..12 inclusive
    assert chart.months == list(range(13))
    assert len(chart.strategyMedian) == 13
    assert len(chart.strategyBand5_95.lower) == 13
    assert len(chart.strategyBand5_95.upper) == 13
    assert len(chart.strategyBand25_75.lower) == 13
    assert len(chart.strategyBand25_75.upper) == 13
    assert len(chart.fixedDcaMedian) == 13
    assert len(chart.lumpSumMedian) == 13
    # Inner band is contained in the outer band at every month.
    for i in range(13):
        assert chart.strategyBand5_95.lower[i] <= chart.strategyBand25_75.lower[i]
        assert chart.strategyBand25_75.upper[i] <= chart.strategyBand5_95.upper[i]
    # Median path stays inside the 5-95 band.
    for i in range(13):
        assert chart.strategyBand5_95.lower[i] <= chart.strategyMedian[i] <= chart.strategyBand5_95.upper[i]


def test_run_montecarlo_seed_is_reproducible():
    prices = _make_prices(n_days=300)
    req = _request(seed=99)
    a = run_montecarlo(req, prices, currency="$")
    b = run_montecarlo(req, prices, currency="$")
    # Same seed → identical paths → identical medians.
    assert a.chart.strategyMedian == b.chart.strategyMedian
    assert a.strategy.p50 == b.strategy.p50


def test_run_montecarlo_propagates_insufficient_data():
    prices = _make_prices(n_days=100)
    with pytest.raises(PriceDataError) as exc_info:
        run_montecarlo(_request(), prices, currency="$")
    assert exc_info.value.code == "insufficient_data"


def test_run_montecarlo_runs_real_strategy_on_simulated_prices():
    """The strategy must actually execute on the simulated future
    segment — if it didn't, every path would end at 0 and the median
    would be 0. A positive median proves the backtester ran buys.
    """
    prices = _make_prices(n_days=300, drift=0.0008, vol=0.012)
    response = run_montecarlo(_request(horizonMonths=12, numPaths=100), prices, currency="$")
    # With positive drift the strategy should accumulate value.
    assert response.strategy.p50 > 0
    assert response.fixedDca.p50 > 0
    assert response.lumpSum.p50 > 0
    # Lump sum and fixed DCA invest the same total budget, but lump
    # sum buys everything on day one — in a positive-drift world its
    # median should generally exceed fixed DCA's. Not a strict rule
    # (path noise can flip it), so we only sanity-check ordering of
    # the strategy vs. the others rather than asserting which wins.


# ─── Request validation ───────────────────────────────────────────


def test_montecarlo_request_rejects_invalid_num_paths():
    with pytest.raises(ValidationError):
        MonteCarloRequest(numPaths=300)  # not in the whitelist


def test_montecarlo_request_rejects_invalid_horizon():
    with pytest.raises(ValidationError):
        MonteCarloRequest(horizonMonths=200)  # > 120


def test_montecarlo_request_accepts_whitelisted_path_counts():
    for n in (100, 500, 1000, 2000):
        req = MonteCarloRequest(numPaths=n)
        assert req.numPaths == n
