"""东方财富（East Money）价格数据下载模块。

作为 yfinance 的国内替代主数据源，通过东方财富 K 线 API 获取
ETF 历史收盘价。接口无需 API Key，国内访问速度快且稳定。

返回格式与 data.py._download_yfinance 完全一致：
    DataFrame(index=datetime(去时区), columns=["close"])，dropna + 升序。
"""

import json
import logging
import socket
import time
import urllib.request
from datetime import date, timedelta

import pandas as pd

logger = logging.getLogger(__name__)

_EM_MARKET_CODE: dict[str, int] = {
    "QQQ": 105,
    "VXUS": 105,
    "BND": 105,
    "TLT": 105,
    "IEF": 105,
    "SOXX": 105,
    "SMH": 105,
    "TQQQ": 105,
    "IBIT": 105,
    "SPY": 107,
    "VOO": 107,
    "VTI": 107,
    "DIA": 107,
    "IWM": 107,
    "SCHD": 107,
    "VYM": 107,
    "VTV": 107,
    "VUG": 107,
    "VEA": 107,
    "VWO": 107,
    "AGG": 107,
    "GLD": 107,
    "XLK": 107,
    "QLD": 107,
    "UPRO": 107,
    "SSO": 107,
    "510050": 1,
    "510300": 1,
    "510500": 1,
    "588000": 1,
    "159915": 0,
}

_DEFAULT_FQT = 1

_API_URL = "push2his.eastmoney.com/api/qt/stock/kline/get"
_TIMEOUT = 20
_RETRIES = 3
_RETRY_DELAY = 1.5


def _ipv4_getaddrinfo(original):
    def wrapper(host, port, family=0, type=0, proto=0, flags=0):
        return original(host, port, socket.AF_INET, type, proto, flags)

    return wrapper


def _fetch_url(url: str, timeout: int = _TIMEOUT) -> bytes:
    """Fetch URL content with IPv4-only and retries.

    东方财富 push2his.eastmoney.com 的 IPv6 端点存在连接后无响应的问题，
    因此强制使用 IPv4。同时加入重试机制处理间歇性网络故障。
    优先尝试 HTTP（更快、更稳定），失败后尝试 HTTPS。
    """
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36",
        "Referer": "https://quote.eastmoney.com/",
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }

    # Try HTTP first (faster, more stable for eastmoney), then HTTPS as fallback
    last_exc = None
    for scheme in ("http", "https"):
        full_url = f"{scheme}://{url}"
        for attempt in range(_RETRIES):
            try:
                original_gai = socket.getaddrinfo
                socket.getaddrinfo = _ipv4_getaddrinfo(original_gai)
                try:
                    req = urllib.request.Request(full_url, headers=headers)
                    with urllib.request.urlopen(req, timeout=timeout) as resp:
                        return resp.read()
                finally:
                    socket.getaddrinfo = original_gai
            except Exception as exc:
                last_exc = exc
                if attempt < _RETRIES - 1:
                    time.sleep(_RETRY_DELAY * (attempt + 1))
                continue

    raise last_exc if last_exc else ConnectionError("Failed to fetch from eastmoney")


def download(symbol: str, start: date, end: date) -> pd.DataFrame:
    """从东方财富下载日线收盘价。"""
    market = _EM_MARKET_CODE.get(symbol)
    if market is None:
        logger.warning("eastmoney: symbol %s not in market code map", symbol)
        return pd.DataFrame(columns=["close"])

    fqt = _DEFAULT_FQT
    secid = f"{market}.{symbol}"
    beg = start.strftime("%Y%m%d")
    end_str = (end + timedelta(days=1)).strftime("%Y%m%d")

    params = (
        f"?secid={secid}"
        f"&ut=fa5fd1943c7b386f172d6893dbfba10b"
        f"&fields1=f1,f2,f3,f4,f5,f6"
        f"&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61"
        f"&klt=101"
        f"&fqt={fqt}"
        f"&beg={beg}"
        f"&end={end_str}"
    )
    url = f"{_API_URL}{params}"

    try:
        raw = _fetch_url(url)
        data = json.loads(raw)
    except Exception as exc:
        logger.warning("eastmoney download failed for %s: %s", symbol, exc)
        return pd.DataFrame(columns=["close"])

    klines = (data.get("data") or {}).get("klines", [])
    if not klines:
        logger.info("eastmoney: no klines returned for %s (%s ~ %s)", symbol, beg, end_str)
        return pd.DataFrame(columns=["close"])

    records = []
    for line in klines:
        parts = line.split(",")
        if len(parts) < 3:
            continue
        d = parts[0]
        close = float(parts[2])
        if close <= 0:
            continue
        records.append({"date": d, "close": close})

    if not records:
        return pd.DataFrame(columns=["close"])

    frame = pd.DataFrame(records)
    frame["date"] = pd.to_datetime(frame["date"])
    frame = frame.set_index("date").sort_index()
    return frame.dropna()
