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
