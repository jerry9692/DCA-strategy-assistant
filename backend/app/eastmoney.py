"""东方财富（East Money）价格数据下载模块。

作为 yfinance 的国内替代主数据源，通过东方财富 K 线 API 获取
ETF 历史收盘价。接口无需 API Key，国内访问速度快且稳定。

返回格式与 data.py._download_yfinance 完全一致：
    DataFrame(index=datetime(去时区), columns=["close"])，dropna + 升序。
"""

import json
import logging
import urllib.request
from datetime import date, timedelta

import pandas as pd

logger = logging.getLogger(__name__)

# 东财 secid 市场代码映射（已实测验证全部 31 个标的）
_EM_MARKET_CODE: dict[str, int] = {
    # NASDAQ (105)
    "QQQ": 105, "VXUS": 105, "BND": 105, "TLT": 105, "IEF": 105,
    "SOXX": 105, "SMH": 105, "TQQQ": 105, "IBIT": 105,
    # AMEX / NYSE (107)
    "SPY": 107, "VOO": 107, "VTI": 107, "DIA": 107, "IWM": 107,
    "SCHD": 107, "VYM": 107, "VTV": 107, "VUG": 107, "VEA": 107,
    "VWO": 107, "AGG": 107, "GLD": 107, "XLK": 107, "QLD": 107,
    "UPRO": 107, "SSO": 107,
    # 上交所 (1)
    "510050": 1, "510300": 1, "510500": 1, "588000": 1,
    # 深交所 (0)
    "159915": 0,
}

# 复权方式：510050 用不复权（前复权有 bug 会产生负数），其余用前复权
_EM_FQT: dict[str, int] = {
    "510050": 0,  # 不复权
}
_DEFAULT_FQT = 1  # 前复权

_API_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
_TIMEOUT = 30


def download(symbol: str, start: date, end: date) -> pd.DataFrame:
    """从东方财富下载日线收盘价。

    Args:
        symbol: 标的代码（如 QQQ、510050），必须在 _EM_MARKET_CODE 中。
        start: 起始日期（含）。
        end: 结束日期（含）。

    Returns:
        DataFrame(index=datetime(去时区), columns=["close"])，dropna + 升序。
        无数据时返回空 DataFrame（含 close 列）。

    Raises:
        Exception: 网络错误、JSON 解析失败等。由调用方捕获后回退 yfinance。
    """
    market = _EM_MARKET_CODE.get(symbol)
    if market is None:
        logger.warning("eastmoney: symbol %s not in market code map", symbol)
        return pd.DataFrame(columns=["close"])

    fqt = _EM_FQT.get(symbol, _DEFAULT_FQT)
    secid = f"{market}.{symbol}"
    beg = start.strftime("%Y%m%d")
    end_str = (end + timedelta(days=1)).strftime("%Y%m%d")

    params = (
        f"?secid={secid}"
        f"&fields1=f1,f2,f3,f4,f5,f6"
        f"&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61"
        f"&klt=101"      # 日线
        f"&fqt={fqt}"    # 复权方式
        f"&beg={beg}"
        f"&end={end_str}"
    )
    url = f"{_API_URL}{params}"

    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
        raw = resp.read()
        data = json.loads(raw)

    klines = data.get("data", {}).get("klines", [])
    if not klines:
        logger.info("eastmoney: no klines returned for %s (%s ~ %s)", symbol, beg, end_str)
        return pd.DataFrame(columns=["close"])

    # 每行格式: "date,open,close,high,low,volume,amount,amplitude,pct_change,change,turnover"
    records = []
    for line in klines:
        parts = line.split(",")
        if len(parts) < 3:
            continue
        d = parts[0]
        close = float(parts[2])
        # 防御性过滤：跳过非正数收盘价（东财 510050 前复权 bug 已通过 fqt=0 规避，
        # 这里作为额外安全网）
        if close <= 0:
            continue
        records.append({"date": d, "close": close})

    if not records:
        return pd.DataFrame(columns=["close"])

    frame = pd.DataFrame(records)
    frame["date"] = pd.to_datetime(frame["date"])
    frame = frame.set_index("date").sort_index()
    return frame.dropna()
