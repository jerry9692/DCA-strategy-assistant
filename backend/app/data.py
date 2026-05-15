from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf
from sqlmodel import Field, Session, SQLModel, create_engine, select

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
        raise PriceDataError("v0.1 only supports QQQ, VOO and SPY.", code="invalid_symbol", retryable=False)
    return normalized


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
    data = yf.download(
        symbol,
        start=start.isoformat(),
        end=(end + timedelta(days=1)).isoformat(),
        auto_adjust=True,
        progress=False,
        timeout=15,
    )
    if data.empty:
        return pd.DataFrame(columns=["close"])
    close = data["Close"]
    if isinstance(close, pd.DataFrame):
        close = close.iloc[:, 0]
    frame = close.rename("close").to_frame()
    frame.index = pd.to_datetime(frame.index).tz_localize(None)
    return frame.dropna().sort_index()


def _cache_covers(frame: pd.DataFrame, start: date, end: date) -> bool:
    if frame.empty:
        return False
    first = frame.index.min().date()
    last = frame.index.max().date()
    # Allow small gaps for weekends, market holidays, and delayed daily bars.
    return first <= start + timedelta(days=7) and last >= end - timedelta(days=7)


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
    except Exception as exc:
        if not cached.empty:
            return cached, "Yahoo Finance cache", "cache-fallback"
        raise PriceDataError(
            "Unable to fetch Yahoo Finance data and no local cache is available. Check the network connection and retry.",
            code="network_unavailable",
            retryable=True,
        ) from exc

    if not cached.empty:
        return cached, "Yahoo Finance cache", "cache-only"
    raise PriceDataError(
        f"Yahoo Finance returned no price data for {normalized}.",
        code="no_price_data",
        retryable=True,
    )
