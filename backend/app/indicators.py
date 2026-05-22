import math
from dataclasses import dataclass

import numpy as np
import pandas as pd


def clamp(value: float, low: float, high: float) -> float:
    if math.isnan(value):
        return low
    return max(low, min(high, value))


def linear_multiplier(score: float, min_multiplier: float, max_multiplier: float) -> float:
    bounded = clamp(score, 0, 1)
    return min_multiplier + bounded * (max_multiplier - min_multiplier)


def rsi(close: pd.Series, window: int) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0).rolling(window, min_periods=max(2, window // 2)).mean()
    loss = -delta.clip(upper=0).rolling(window, min_periods=max(2, window // 2)).mean()
    rs = gain / loss.replace(0, np.nan)
    values = 100 - (100 / (1 + rs))
    return values.fillna(50)


def rolling_percentile(close: pd.Series, window: int) -> pd.Series:
    def pct_rank(values: np.ndarray) -> float:
        if len(values) == 0:
            return 50.0
        current = values[-1]
        return float((values <= current).sum() / len(values) * 100)

    min_periods = max(20, min(window, window // 3))
    return close.rolling(window, min_periods=min_periods).apply(pct_rank, raw=True).fillna(50)


@dataclass(frozen=True)
class IndicatorSettings:
    high_window: int = 252
    ma_window: int = 200
    percentile_window: int = 756
    rsi_window: int = 14
    grid_window: int = 252


def add_indicators(prices: pd.DataFrame, settings: IndicatorSettings) -> pd.DataFrame:
    frame = prices.copy()
    close = frame["close"]
    frame["sma"] = close.rolling(settings.ma_window, min_periods=max(5, settings.ma_window // 4)).mean()
    frame["rolling_high"] = close.rolling(settings.high_window, min_periods=5).max()
    frame["rolling_low"] = close.rolling(settings.grid_window, min_periods=5).min()
    frame["grid_high"] = close.rolling(settings.grid_window, min_periods=5).max()
    frame["drawdown_pct"] = (close / frame["rolling_high"] - 1) * 100
    frame["sma_deviation_pct"] = (close / frame["sma"] - 1) * 100
    frame["rsi"] = rsi(close, settings.rsi_window)
    frame["percentile"] = rolling_percentile(close, settings.percentile_window)
    return frame.replace([np.inf, -np.inf], np.nan)
