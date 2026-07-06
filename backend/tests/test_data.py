from datetime import date

import pandas as pd
import pytest
from yfinance.exceptions import YFRateLimitError

from app.data import PriceDataError, _close_series, _download_yfinance, get_price_history


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
    # 东财返回空，强制走 yfinance 路径
    monkeypatch.setattr("app.data._em_download", lambda symbol, start, end: pd.DataFrame(columns=["close"]))

    def fail_download(symbol, start, end):
        raise YFRateLimitError()

    monkeypatch.setattr("app.data._download_yfinance", fail_download)

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
    monkeypatch.setattr("app.data._em_download", lambda symbol, start, end: pd.DataFrame(columns=["close"]))
    monkeypatch.setattr("app.data._download_yfinance", lambda symbol, start, end: pd.DataFrame(columns=["close"]))

    with pytest.raises(PriceDataError) as exc_info:
        get_price_history("QQQ", date(2024, 1, 1), date(2026, 5, 17))

    assert exc_info.value.code == "stale_cache"


def test_price_history_offline_mode_never_downloads_when_cache_is_incomplete(monkeypatch):
    cached = pd.DataFrame(
        {"close": [100.0]},
        index=pd.to_datetime(["2024-01-02"]),
    )
    monkeypatch.setenv("DCA_OFFLINE_MODE", "1")
    monkeypatch.setattr("app.data._load_cached", lambda symbol, start, end: cached)

    def fail_download(*args, **kwargs):
        raise AssertionError("offline mode must not call yfinance")

    monkeypatch.setattr("app.data._download_yfinance", fail_download)

    with pytest.raises(PriceDataError) as exc_info:
        get_price_history("QQQ", date(2024, 1, 1), date(2024, 2, 1))

    assert exc_info.value.code == "offline_cache_miss"
    assert exc_info.value.retryable is False


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


def test_get_available_range_uses_cached_ceiling_in_offline_mode(monkeypatch):
    from app.data import get_available_range

    monkeypatch.setenv("DCA_OFFLINE_MODE", "1")
    monkeypatch.setattr("app.data.get_cached_range", lambda symbol: (date(2018, 1, 2), date(2024, 12, 31)))
    floor, ceiling = get_available_range("QQQ")
    assert floor == date(1999, 3, 10)
    assert ceiling == date(2024, 12, 31)


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


def test_new_us_etf_available_ranges_are_declared():
    from app.data import get_available_range

    assert get_available_range("VTI")[0] == date(2001, 5, 31)
    assert get_available_range("TQQQ")[0] == date(2010, 2, 11)
    assert get_available_range("IBIT")[0] == date(2024, 1, 11)


def test_new_cn_etf_available_ranges_are_declared():
    from app.data import get_available_range

    assert get_available_range("510050")[0] == date(2005, 2, 23)
    assert get_available_range("510300")[0] == date(2012, 5, 28)
    assert get_available_range("159915")[0] == date(2011, 12, 9)
    assert get_available_range("588000")[0] == date(2020, 11, 16)


def test_download_uses_provider_symbol_for_cn_etfs(monkeypatch):
    seen: dict[str, str] = {}

    def fake_download(symbol, **kwargs):
        seen["symbol"] = symbol
        return pd.DataFrame({"Close": [1.0, 1.1]}, index=pd.to_datetime(["2024-01-02", "2024-01-03"]))

    monkeypatch.setattr("app.data.yf.download", fake_download)

    frame = _download_yfinance("159915", date(2024, 1, 1), date(2024, 1, 5))

    assert seen["symbol"] == "159915.SZ"
    assert frame["close"].tolist() == [1.0, 1.1]


# ---------------------------------------------------------------------------
# East Money integration tests
# ---------------------------------------------------------------------------


def test_eastmoney_download_success(monkeypatch):
    """get_price_history 优先使用东方财富数据源。"""
    em_data = pd.DataFrame(
        {"close": [100.0, 101.0, 102.0]},
        index=pd.to_datetime(["2024-01-02", "2024-01-03", "2024-01-04"]),
    )
    monkeypatch.setattr("app.data._load_cached", lambda symbol, start, end: pd.DataFrame(columns=["close"]))
    monkeypatch.setattr("app.data._em_download", lambda symbol, start, end: em_data)
    # yfinance 不应被调用
    monkeypatch.setattr("app.data._download_yfinance", lambda *a, **k: (_ for _ in ()).throw(AssertionError("yfinance should not be called")))

    frame, source, status = get_price_history("QQQ", date(2024, 1, 1), date(2024, 1, 5))

    assert source == "东方财富"
    assert status == "fresh"
    assert frame["close"].tolist() == [100.0, 101.0, 102.0]


def test_fallback_to_yfinance_when_eastmoney_fails(monkeypatch):
    """东财下载异常时自动回退到 yfinance。"""
    yf_data = pd.DataFrame(
        {"close": [200.0, 201.0]},
        index=pd.to_datetime(["2024-01-02", "2024-01-03"]),
    )
    monkeypatch.setattr("app.data._load_cached", lambda symbol, start, end: pd.DataFrame(columns=["close"]))
    monkeypatch.setattr("app.data._em_download", lambda symbol, start, end: (_ for _ in ()).throw(RuntimeError("network error")))
    monkeypatch.setattr("app.data._download_yfinance", lambda symbol, start, end: yf_data)

    frame, source, status = get_price_history("QQQ", date(2024, 1, 1), date(2024, 1, 5))

    assert source == "Yahoo Finance"
    assert status == "fresh"
    assert frame["close"].tolist() == [200.0, 201.0]


def test_fallback_to_yfinance_when_eastmoney_empty(monkeypatch):
    """东财返回空数据时自动回退到 yfinance（处理 BND/TLT 等历史不足的情况）。"""
    yf_data = pd.DataFrame(
        {"close": [300.0]},
        index=pd.to_datetime(["2024-01-02"]),
    )
    monkeypatch.setattr("app.data._load_cached", lambda symbol, start, end: pd.DataFrame(columns=["close"]))
    monkeypatch.setattr("app.data._em_download", lambda symbol, start, end: pd.DataFrame(columns=["close"]))
    monkeypatch.setattr("app.data._download_yfinance", lambda symbol, start, end: yf_data)

    frame, source, _status = get_price_history("BND", date(2024, 1, 1), date(2024, 1, 5))

    assert source == "Yahoo Finance"
    assert frame["close"].tolist() == [300.0]


def test_eastmoney_510050_uses_no_adjust():
    """510050 使用 fqt=0（不复权），避免东财前复权 bug 产生负数价格。"""
    from app.eastmoney import _EM_FQT

    assert _EM_FQT["510050"] == 0
