from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf
from sqlmodel import Field, Session, SQLModel, create_engine, select
from yfinance.exceptions import YFRateLimitError

from app.models import SUPPORTED_ASSETS


class PriceDataError(Exception):
    def __init__(self, message: str, code: str = "price_data_error", retryable: bool = True):
        super().__init__(message)
        self.message = message
        self.code = code
        self.retryable = retryable


DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DATA_DIR.mkdir(exist_ok=True)
YFINANCE_CACHE_DIR = DATA_DIR / "yfinance-cache"
YFINANCE_CACHE_DIR.mkdir(exist_ok=True)
yf.set_tz_cache_location(str(YFINANCE_CACHE_DIR))
DB_PATH = DATA_DIR / "dca_assistant.sqlite"
engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"check_same_thread": False})


class PriceBar(SQLModel, table=True):
    symbol: str = Field(primary_key=True, index=True)
    bar_date: date = Field(primary_key=True, index=True)
    close: float
    source: str = "yfinance"
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


SQLModel.metadata.create_all(engine)


def validate_symbol(symbol: str) -> str:
    normalized = symbol.upper()
    if normalized not in SUPPORTED_ASSETS:
        raise PriceDataError("v0.4 only supports the built-in ETF list.", code="invalid_symbol", retryable=False)
    return normalized


def _provider_symbol(symbol: str) -> str:
    meta = SUPPORTED_ASSETS.get(symbol, {})
    if isinstance(meta, dict):
        return str(meta.get("providerSymbol") or symbol)
    # SUPPORTED_ASSETS is always dict-shaped in production, but a
    # handful of legacy tests monkeypatch it to {symbol: name_str}; the
    # str fallback keeps those green without complicating the runtime.
    return symbol


def _load_cached(symbol: str, start: date, end: date) -> pd.DataFrame:
    with Session(engine) as session:
        rows = session.exec(
            select(PriceBar)
            .where(PriceBar.symbol == symbol)
            .where(PriceBar.bar_date >= start)
            .where(PriceBar.bar_date <= end)
            .order_by(PriceBar.bar_date)
        ).all()
    if not rows:
        return pd.DataFrame(columns=["close"])
    frame = pd.DataFrame([{"date": row.bar_date, "close": row.close} for row in rows])
    frame["date"] = pd.to_datetime(frame["date"])
    return frame.set_index("date").sort_index()


# Hardcoded earliest available date per symbol on Yahoo Finance. Used
# only when the local SQLite cache is empty for that symbol so the UI
# can still show a sensible "data starts from" hint without hitting
# yfinance just to discover the floor.
_YFINANCE_EARLIEST_AVAILABLE = {
    "QQQ": date(1999, 3, 10),
    "SPY": date(1993, 1, 29),
    "VOO": date(2010, 9, 9),
    "VTI": date(2001, 5, 31),
    "DIA": date(1998, 1, 14),
    "IWM": date(2000, 5, 26),
    "SCHD": date(2011, 10, 20),
    "VYM": date(2006, 11, 10),
    "VTV": date(2004, 1, 30),
    "VUG": date(2004, 1, 30),
    "VXUS": date(2011, 1, 26),
    "VEA": date(2007, 7, 26),
    "VWO": date(2005, 3, 10),
    "BND": date(2007, 4, 10),
    "AGG": date(2003, 9, 26),
    "TLT": date(2002, 7, 30),
    "IEF": date(2002, 7, 30),
    "GLD": date(2004, 11, 18),
    "XLK": date(1998, 12, 22),
    "SOXX": date(2001, 7, 10),
    "SMH": date(2000, 6, 5),
    "TQQQ": date(2010, 2, 11),
    "QLD": date(2006, 6, 21),
    "UPRO": date(2009, 6, 25),
    "SSO": date(2006, 6, 21),
    "IBIT": date(2024, 1, 11),
    "510050": date(2005, 2, 23),
    "510300": date(2012, 5, 28),
    "510500": date(2013, 3, 15),
    "159915": date(2011, 12, 9),
    "588000": date(2020, 11, 16),
}


def get_cached_range(symbol: str) -> tuple[date | None, date | None]:
    """Return (min_date, max_date) of the symbol's cached PriceBars,
    or (None, None) if the cache is empty.
    """
    normalized = validate_symbol(symbol)
    with Session(engine) as session:
        min_row = session.exec(
            select(PriceBar.bar_date).where(PriceBar.symbol == normalized).order_by(PriceBar.bar_date).limit(1)
        ).first()
        max_row = session.exec(
            select(PriceBar.bar_date).where(PriceBar.symbol == normalized).order_by(PriceBar.bar_date.desc()).limit(1)
        ).first()
    return min_row, max_row


def get_available_range(symbol: str) -> tuple[date, date]:
    """Return (min_date, max_date) the UI can present as the date-input
    floor/ceiling.

    Floor: the hardcoded earliest date yfinance has on file for this
    symbol. The local SQLite cache's earliest entry is *not* used here
    — that's just where the user happened to start pulling, not what's
    available. Picking a date before the cache only triggers a one-off
    yfinance fetch that backfills the cache.

    Ceiling: today's date. The cache might lag a few days behind; when
    the user picks a date past the cache the backend tries to fetch
    fresh data from yfinance. The data layer's existing rate-limit /
    stale-cache errors handle the case where that fetch fails.
    """
    normalized = validate_symbol(symbol)
    floor = _YFINANCE_EARLIEST_AVAILABLE.get(normalized, date(1990, 1, 1))
    ceiling = date.today()
    return floor, ceiling


def _save_prices(symbol: str, frame: pd.DataFrame) -> None:
    rows = []
    for idx, row in frame.iterrows():
        close = float(row["close"])
        if pd.isna(close):
            continue
        rows.append(PriceBar(symbol=symbol, bar_date=idx.date(), close=close))
    if not rows:
        return
    with Session(engine) as session:
        for item in rows:
            session.merge(item)
        session.commit()


def _download(symbol: str, start: date, end: date) -> pd.DataFrame:
    # yfinance end date is exclusive; add one day so requested end is included.
    # auto_adjust=True returns dividend-and-split adjusted close. That price
    # series is mathematically equivalent to "reinvest every cash dividend on
    # the ex-date at that day's close", so backtests built on it already
    # include dividend reinvestment in their return, annualized return and
    # drawdown numbers. The user-facing docs reflect this assumption.
    provider_symbol = _provider_symbol(symbol)
    data = yf.download(
        provider_symbol,
        start=start.isoformat(),
        end=(end + timedelta(days=1)).isoformat(),
        auto_adjust=True,
        progress=False,
        timeout=15,
    )
    if data.empty:
        return pd.DataFrame(columns=["close"])
    close = _close_series(data)
    frame = close.rename("close").to_frame()
    frame.index = pd.to_datetime(frame.index).tz_localize(None)
    return frame.dropna().sort_index()


def _close_series(data: pd.DataFrame) -> pd.Series:
    if isinstance(data.columns, pd.MultiIndex):
        for level in range(data.columns.nlevels):
            if "Close" in data.columns.get_level_values(level):
                close = data.xs("Close", axis=1, level=level)
                if isinstance(close, pd.DataFrame):
                    return close.iloc[:, 0]
                return close
        raise PriceDataError(
            "Yahoo Finance response did not include close prices.", code="missing_close", retryable=True
        )

    if "Close" not in data.columns:
        # Defensive: yfinance has been observed to drop the "Close" column
        # under certain auto_adjust + repair combinations and only emit
        # "Adj Close". Fall back to that rather than crashing with KeyError.
        if "Adj Close" in data.columns:
            close = data["Adj Close"]
            if isinstance(close, pd.DataFrame):
                return close.iloc[:, 0]
            return close
        raise PriceDataError(
            "Yahoo Finance response did not include close prices.",
            code="missing_close",
            retryable=True,
        )

    close = data["Close"]
    if isinstance(close, pd.DataFrame):
        return close.iloc[:, 0]
    return close


def _cache_covers(frame: pd.DataFrame, start: date, end: date) -> bool:
    if frame.empty:
        return False
    first = frame.index.min().date()
    last = frame.index.max().date()
    # Allow small gaps for weekends, market holidays, and delayed daily bars.
    return first <= start + timedelta(days=7) and last >= end - timedelta(days=7)


def _cache_range_text(frame: pd.DataFrame) -> str:
    if frame.empty:
        return "本地无可用缓存"
    first = frame.index.min().date().isoformat()
    last = frame.index.max().date().isoformat()
    return f"本地缓存范围为 {first} 至 {last}"


def get_price_history(symbol: str, start: date | None = None, end: date | None = None) -> tuple[pd.DataFrame, str, str]:
    normalized = validate_symbol(symbol)
    final_end = end or date.today()
    final_start = start or (final_end - timedelta(days=365 * 10))

    cached = _load_cached(normalized, final_start, final_end)
    if _cache_covers(cached, final_start, final_end):
        return cached, "Yahoo Finance cache", "cache-hit"

    try:
        downloaded = _download(normalized, final_start, final_end)
        if not downloaded.empty:
            _save_prices(normalized, downloaded)
            return downloaded, "Yahoo Finance", "fresh"
        if not cached.empty:
            raise PriceDataError(
                f"Yahoo Finance returned no new price data, and {_cache_range_text(cached)}，无法覆盖所选区间。",
                code="stale_cache",
                retryable=True,
            )
    except Exception as exc:
        if isinstance(exc, PriceDataError):
            raise
        if isinstance(exc, YFRateLimitError):
            raise PriceDataError(
                f"Yahoo Finance 当前限流，且 {_cache_range_text(cached)}，无法覆盖所选区间。请稍后重试，或把结束日期调到缓存范围内。",
                code="rate_limited",
                retryable=True,
            ) from exc
        if not cached.empty:
            raise PriceDataError(
                f"Yahoo Finance 数据获取失败，且 {_cache_range_text(cached)}，无法覆盖所选区间。请稍后重试，或把结束日期调到缓存范围内。",
                code="stale_cache",
                retryable=True,
            ) from exc
        raise PriceDataError(
            "Unable to fetch Yahoo Finance data and no local cache is available. Check the network connection and retry.",
            code="network_unavailable",
            retryable=True,
        ) from exc

    raise PriceDataError(
        f"Yahoo Finance returned no price data for {normalized}.",
        code="no_price_data",
        retryable=True,
    )
