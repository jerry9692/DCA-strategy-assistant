from datetime import date

import pandas as pd
import pytest
from yfinance.exceptions import YFRateLimitError

from app.data import PriceDataError, _close_series, get_price_history


def test_close_series_handles_yfinance_multi_index_columns():
    columns = pd.MultiIndex.from_tuples([("Close", "QQQ"), ("Open", "QQQ")])
    data = pd.DataFrame([[101.5, 100.0], [102.25, 101.0]], columns=columns)

    close = _close_series(data)

    assert close.tolist() == [101.5, 102.25]


def test_price_history_raises_rate_limit_when_cache_is_stale(monkeypatch):
    cached = pd.DataFrame(
        {"close": [100.0, 101.0]},
        index=pd.to_datetime(["2024-03-27", "2024-03-28"]),
    )

    monkeypatch.setattr("app.data._load_cached", lambda symbol, start, end: cached)

    def fail_download(symbol, start, end):
        raise YFRateLimitError()

    monkeypatch.setattr("app.data._download", fail_download)

    with pytest.raises(PriceDataError) as exc_info:
        get_price_history("QQQ", date(2024, 1, 1), date(2026, 5, 17))

    assert exc_info.value.code == "rate_limited"
    assert "2024-03-28" in exc_info.value.message


def test_price_history_does_not_return_incomplete_cache_after_empty_download(monkeypatch):
    cached = pd.DataFrame(
        {"close": [100.0]},
        index=pd.to_datetime(["2024-03-28"]),
    )

    monkeypatch.setattr("app.data._load_cached", lambda symbol, start, end: cached)
    monkeypatch.setattr("app.data._download", lambda symbol, start, end: pd.DataFrame(columns=["close"]))

    with pytest.raises(PriceDataError) as exc_info:
        get_price_history("QQQ", date(2024, 1, 1), date(2026, 5, 17))

    assert exc_info.value.code == "stale_cache"


def test_get_available_range_uses_hardcoded_floor_regardless_of_cache(monkeypatch):
    """The available range floor must be the symbol's true earliest
    date on yfinance, not the earliest entry in the local cache —
    those are completely different things. The cache only reflects
    what users happened to have queried; data is available much
    earlier and a fresh request will backfill the cache.
    """

    from app.data import get_available_range

    # Even with a cache that starts in 2018, the UI floor for QQQ
    # should be 1999-03-10 (its real Yahoo Finance inception).
    monkeypatch.setattr("app.data.get_cached_range", lambda symbol: (date(2018, 1, 2), date(2026, 5, 13)))
    floor, ceiling = get_available_range("QQQ")
    assert floor == date(1999, 3, 10)
    assert ceiling == date.today()


def test_get_available_range_falls_back_when_no_hardcoded_entry(monkeypatch):
    """Symbols outside the hardcoded map fall back to a generic
    1990-01-01 floor so the date input still has a non-trivial bound.
    """

    from app.data import get_available_range

    # Patch validate_symbol's allow-list and clear the per-symbol
    # earliest dates so VTI hits the generic fallback path.
    monkeypatch.setattr("app.data._YFINANCE_EARLIEST_AVAILABLE", {})
    monkeypatch.setattr("app.data.SUPPORTED_ASSETS", {"VTI": "Vanguard Total Stock Market"})
    floor, ceiling = get_available_range("VTI")
    assert floor == date(1990, 1, 1)
    assert ceiling == date.today()
