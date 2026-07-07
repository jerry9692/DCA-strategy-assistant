import logging
import os
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf
from sqlmodel import Field, Session, SQLModel, create_engine, select
from yfinance.exceptions import YFRateLimitError

from app.eastmoney import download as _em_download
from app.models import SUPPORTED_ASSETS

logger = logging.getLogger(__name__)


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


def _offline_mode() -> bool:
    value = os.getenv("DCA_OFFLINE_MODE", "")
    return value.lower() in {"1", "true", "yes", "on"}


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


def _cached_source_label(symbol: str) -> str:
    """Return a human-readable label for the data source of cached bars."""
    with Session(engine) as session:
        rows = session.exec(
            select(PriceBar.source)
            .where(PriceBar.symbol == symbol)
        ).all()
    if not rows:
        return "本地缓存"
    sources = set(rows)
    if sources == {"eastmoney"}:
        return "东方财富缓存"
    if sources == {"yfinance"}:
        return "Yahoo Finance 缓存"
    if "eastmoney" in sources and "yfinance" in sources:
        return "混合缓存(东方财富+Yahoo)"
    return f"本地缓存({','.join(sorted(sources))})"


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


def count_cached_bars() -> int:
    """Total row count across all symbols in the price cache.

    Used by the /api/health endpoint to surface cache size. Must never
    raise — a missing DB file or empty table means "no data cached yet",
    not an unhealthy app. We read directly instead of going through
    get_cached_range (which validates against SUPPORTED_ASSETS) so the
    count reflects every row ever written, including retired symbols.
    """
    if not DB_PATH.exists():
        return 0
    try:
        with Session(engine) as session:
            return len(session.exec(select(PriceBar)).all())
    except Exception:
        return 0


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
    _, cached_ceiling = get_cached_range(normalized)
    ceiling = cached_ceiling if _offline_mode() and cached_ceiling is not None else date.today()
    return floor, ceiling


def _save_prices(symbol: str, frame: pd.DataFrame, source: str = "yfinance") -> None:
    rows = []
    for idx, row in frame.iterrows():
        close = float(row["close"])
        if pd.isna(close):
            continue
        rows.append(PriceBar(symbol=symbol, bar_date=idx.date(), close=close, source=source))
    if not rows:
        return
    with Session(engine) as session:
        for item in rows:
            session.merge(item)
        session.commit()


def _sanitize_prices(frame: pd.DataFrame) -> pd.DataFrame:
    """Remove obvious bad ticks before they enter the cache.

    yfinance/eastmoney occasionally emit corrupted close values
    (e.g. QQQ shown at 102 instead of ~400 for a few days in Jan 2024).
    We drop rows with non-positive prices or single-day moves beyond
    a very wide threshold. 80% covers 3x leveraged ETFs while still
    catching split/dividend-adjustment garbage.
    """
    if frame.empty:
        return frame
    cleaned = frame[frame["close"] > 0].dropna().copy()
    if len(cleaned) < 3:
        return cleaned
    prev = cleaned["close"].shift(1)
    daily_return = (cleaned["close"] - prev) / prev
    # Keep the first row (prev is NaN) and rows within the threshold.
    mask = daily_return.abs().le(0.80) | prev.isna()
    removed = (~mask).sum()
    if removed:
        logger.warning("sanitized %d bad price tick(s) from %s", int(removed), frame.index[0])
    return cleaned.loc[mask].copy()


def _download_yfinance(symbol: str, start: date, end: date) -> pd.DataFrame:
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
    return _sanitize_prices(frame.dropna().sort_index())


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


def get_price_history(
    symbol: str,
    start: date | None = None,
    end: date | None = None,
    allow_partial_cache: bool = False,
) -> tuple[pd.DataFrame, str, str]:
    normalized = validate_symbol(symbol)
    final_end = end or date.today()
    final_start = start or (final_end - timedelta(days=365 * 10))

    cached = _load_cached(normalized, final_start, final_end)
    if _cache_covers(cached, final_start, final_end):
        return cached, _cached_source_label(normalized), "cache-hit"

    # If we allow partial cache and have at least ~1 year of data before
    # end, return what we have. This covers rate-limited / offline
    # scenarios where enough history exists for indicator warmup (SMA200
    # needs ~1 year, 1 year gives comfortable margin).
    if allow_partial_cache and not cached.empty:
        cached_start = cached.index[0].date()
        warmup_cutoff = final_end - timedelta(days=365)
        if cached_start <= warmup_cutoff:
            logger.info(
                "partial cache for %s (%s to %s, requested %s to %s), using cached data",
                normalized, cached_start, cached.index[-1].date(), final_start, final_end,
            )
            trimmed = cached.loc[cached.index <= pd.Timestamp(final_end)]
            if not trimmed.empty:
                return trimmed, "本地缓存", "cache-partial"

    if _offline_mode():
        raise PriceDataError(
            f"当前为离线模式，且 {_cache_range_text(cached)}，无法覆盖所选区间。请导入更新的缓存补丁，或把回测日期调到缓存范围内。",
            code="offline_cache_miss",
            retryable=False,
        )

    # Step 1: 尝试东方财富（国内快速、稳定的主数据源）
    em_partial: pd.DataFrame = pd.DataFrame(columns=["close"])
    try:
        em_data = _sanitize_prices(_em_download(normalized, final_start, final_end))
        if not em_data.empty:
            _save_prices(normalized, em_data, source="eastmoney")
            if not cached.empty:
                em_merged = pd.concat([cached, em_data]).sort_index()
                em_merged = em_merged[~em_merged.index.duplicated(keep="last")]
            else:
                em_merged = em_data
            if _cache_covers(em_merged, final_start, final_end):
                return em_merged, "东方财富", "fresh"
            logger.info(
                "eastmoney returned partial data for %s (covers %s to %s, requested %s to %s), falling back to yfinance",
                normalized,
                em_merged.index[0].date(),
                em_merged.index[-1].date(),
                final_start,
                final_end,
            )
            em_partial = em_merged
        else:
            logger.info("eastmoney returned empty for %s, falling back to yfinance", normalized)
    except Exception as exc:
        logger.warning("eastmoney download failed for %s: %s, falling back to yfinance", normalized, exc)

    # Step 2: 东财失败或空数据，回退 yfinance（保留原有重试逻辑）
    downloaded: pd.DataFrame = pd.DataFrame(columns=["close"])
    last_exc: Exception | None = None
    yf_ratelimited = False
    for attempt in range(2):
        try:
            downloaded = _sanitize_prices(_download_yfinance(normalized, final_start, final_end))
            last_exc = None
            break
        except YFRateLimitError as exc:
            last_exc = exc
            yf_ratelimited = True
            break
        except Exception as exc:
            last_exc = exc
            if attempt == 0:
                logger.warning("yfinance download failed for %s (attempt 1), retrying: %s", normalized, exc)
                time.sleep(1.5)
            continue

    # yfinance 下载成功：合并缓存后返回，避免丢弃缓存中的旧数据
    if not downloaded.empty:
        _save_prices(normalized, downloaded)
        if not cached.empty:
            merged = pd.concat([cached, downloaded]).sort_index()
            merged = merged[~merged.index.duplicated(keep="last")]
        else:
            merged = downloaded
        if _cache_covers(merged, final_start, final_end):
            return merged, "Yahoo Finance", "fresh"
        # yfinance 返回部分数据，用 merged 继续后续处理而不是报错
        downloaded = merged
    elif not em_partial.empty:
        # yfinance 完全失败，但东财有部分数据：用东财数据
        downloaded = em_partial

    # 所有数据源都未能获取完整数据。如果缓存距离终点在 7 天以内
    # （周末、节假日、或临时网络故障），直接返回缓存而不是报错。
    if not cached.empty:
        cached_last = cached.index.max().date()
        if cached_last >= final_end - timedelta(days=7):
            logger.info(
                "all downloads failed/partial for %s but cache is recent (%s, requested end %s), using cache",
                normalized, cached_last, final_end,
            )
            # downloaded 已经是与缓存合并后的结果（如果有下载数据），直接使用
            if not downloaded.empty:
                src = "混合(东方财富+缓存)" if not em_partial.empty else "Yahoo Finance"
                return downloaded, src, "cache-partial"
            return cached, "本地缓存", "cache-hit"

    if last_exc is not None:
        # yfinance 抛出异常。如果有东财部分数据且足够新，优先使用。
        if not downloaded.empty:
            # downloaded 可能是 em_partial（东财部分+缓存）
            dl_last = downloaded.index.max().date()
            if dl_last >= final_end - timedelta(days=7):
                logger.info(
                    "yfinance failed for %s but partial download covers up to %s (end %s), using partial data",
                    normalized, dl_last, final_end,
                )
                src = "东方财富(部分)" if not em_partial.empty else "Yahoo Finance(部分)"
                return downloaded, src, "cache-partial"
            if allow_partial_cache:
                cached_start = downloaded.index[0].date()
                warmup_cutoff = final_end - timedelta(days=365)
                if cached_start <= warmup_cutoff:
                    src = "东方财富(部分)" if not em_partial.empty else "Yahoo Finance(部分)"
                    return downloaded, src, "cache-partial"

        if allow_partial_cache and not cached.empty:
            cached_start = cached.index[0].date()
            warmup_cutoff = final_end - timedelta(days=365)
            if cached_start <= warmup_cutoff:
                logger.info(
                    "download failed for %s (%s), falling back to partial cache (%s to %s)",
                    normalized, last_exc, cached_start, cached.index[-1].date(),
                )
                trimmed = cached.loc[cached.index <= pd.Timestamp(final_end)]
                if not trimmed.empty:
                    return trimmed, "本地缓存", "cache-partial"
        if yf_ratelimited:
            if not cached.empty:
                raise PriceDataError(
                    f"东方财富与 Yahoo Finance 均无法获取新数据（Yahoo 限流），且 {_cache_range_text(cached)}，无法覆盖所选区间。请稍后重试，或把结束日期调到缓存范围内。",
                    code="rate_limited",
                    retryable=True,
                ) from last_exc
            raise PriceDataError(
                "东方财富与 Yahoo Finance 均无法获取数据（Yahoo 限流），请稍后重试。",
                code="rate_limited",
                retryable=True,
            ) from last_exc
        if not cached.empty:
            raise PriceDataError(
                f"东方财富与 Yahoo Finance 数据获取失败，且 {_cache_range_text(cached)}，无法覆盖所选区间。请稍后重试，或把结束日期调到缓存范围内。",
                code="stale_cache",
                retryable=True,
            ) from last_exc
        raise PriceDataError(
            "东方财富与 Yahoo Finance 均无法获取数据，且本地无缓存。请检查网络连接后重试。",
            code="network_unavailable",
            retryable=True,
        ) from last_exc

    # downloaded 可能是 yfinance 新数据、与缓存合并后的部分数据，或东财部分数据
    if not downloaded.empty:
        if _cache_covers(downloaded, final_start, final_end):
            return downloaded, "Yahoo Finance", "fresh"
        # 部分数据：allow_partial_cache 时返回
        if allow_partial_cache:
            cached_start = downloaded.index[0].date()
            warmup_cutoff = final_end - timedelta(days=365)
            if cached_start <= warmup_cutoff:
                trimmed = downloaded.loc[downloaded.index <= pd.Timestamp(final_end)]
                if not trimmed.empty:
                    src = "东方财富(部分)" if not em_partial.empty else "Yahoo Finance(部分)"
                    return trimmed, src, "cache-partial"
        if not cached.empty:
            raise PriceDataError(
                f"东方财富与 Yahoo Finance 均只返回了部分数据，且 {_cache_range_text(cached)}，无法覆盖所选区间。",
                code="stale_cache",
                retryable=True,
            )
        raise PriceDataError(
            f"No price data returned for {normalized}.",
            code="no_price_data",
            retryable=True,
        )

    if not cached.empty:
        if allow_partial_cache:
            cached_start = cached.index[0].date()
            warmup_cutoff = final_end - timedelta(days=365)
            if cached_start <= warmup_cutoff:
                trimmed = cached.loc[cached.index <= pd.Timestamp(final_end)]
                if not trimmed.empty:
                    return trimmed, "本地缓存", "cache-partial"
        raise PriceDataError(
            f"东方财富与 Yahoo Finance 均未返回新数据，且 {_cache_range_text(cached)}，无法覆盖所选区间。",
            code="stale_cache",
            retryable=True,
        )

    raise PriceDataError(
        f"东方财富与 Yahoo Finance 均未返回数据且无本地缓存（{normalized}）。",
        code="no_price_data",
        retryable=True,
    )
