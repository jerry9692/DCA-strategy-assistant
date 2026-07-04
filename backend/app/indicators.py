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
    """RSI via numpy cumsum — numerically identical to the pandas
    rolling.mean path but avoids the per-step Series allocation
    overhead (diff → clip → rolling → replace → divide → fillna each
    created a new Series). On 2000-row frames this is ~5x faster,
    which matters for Monte Carlo (one call per simulated path).
    """
    arr = close.to_numpy(dtype=float)
    n = len(arr)
    if n == 0:
        return pd.Series([], dtype=float, index=close.index)
    delta = np.zeros(n)
    delta[1:] = np.diff(arr)
    gain = np.where(delta > 0, delta, 0.0)
    loss = np.where(delta < 0, -delta, 0.0)
    min_periods = max(2, window // 2)
    result = np.full(n, 50.0)
    if n < 2:
        return pd.Series(result, index=close.index)
    cg = np.cumsum(gain)
    cl = np.cumsum(loss)
    # Full windows: i >= window → mean over exactly `window` samples.
    if n > window:
        g_full = (cg[window:] - cg[:-window]) / window
        l_full = (cl[window:] - cl[:-window]) / window
        # RSI convention:
        # - avg_loss == 0 and avg_gain == 0 → undefined, keep default 50.
        # - avg_loss == 0 and avg_gain  > 0 → perfect uptrend, RSI = 100.
        # - avg_loss  > 0 → standard formula.
        pure_up = (l_full == 0.0) & (g_full > 0.0)
        mixed = l_full > 0.0
        rs = np.where(mixed, g_full / np.where(mixed, l_full, 1.0), 0.0)
        rsi_vals = 100.0 - 100.0 / (1.0 + rs)
        result[window:] = np.where(pure_up, 100.0, np.where(mixed, rsi_vals, 50.0))
    # Partial windows: min_periods <= i < window → mean over i+1 samples.
    # Small loop (at most `window - min_periods` iterations, typically 7).
    for i in range(min_periods, min(window, n)):
        g = gain[: i + 1].mean()
        avg_loss = loss[: i + 1].mean()
        if avg_loss == 0.0 and g > 0.0:
            result[i] = 100.0
        elif avg_loss > 0.0:
            result[i] = 100.0 - 100.0 / (1.0 + g / avg_loss)
    return pd.Series(result, index=close.index)


def rolling_percentile(close: pd.Series, window: int) -> pd.Series:
    # `rolling.rank(pct=True)` is the C-implemented equivalent of
    # `apply(pct_rank)` — "fraction of window at or below current".
    # Tried numpy sliding_window_view + vectorized compare; it was
    # ~2.5x *slower* than the pandas C path on 2000-row frames
    # (the (n, 756) boolean array + row-wise sum dominates). Keeping
    # the pandas implementation — it's already the fast path.
    min_periods = max(20, min(window, window // 3))
    return (close.rolling(window, min_periods=min_periods).rank(pct=True) * 100).fillna(50)


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
    # rolling_high and grid_high default to the same window (252); avoid
    # computing the same rolling.max twice when they're equal — this is
    # a hot path in Monte Carlo (one call per simulated path).
    frame["rolling_high"] = close.rolling(settings.high_window, min_periods=5).max()
    if settings.grid_window == settings.high_window:
        frame["grid_high"] = frame["rolling_high"]
    else:
        frame["grid_high"] = close.rolling(settings.grid_window, min_periods=5).max()
    frame["rolling_low"] = close.rolling(settings.grid_window, min_periods=5).min()
    frame["drawdown_pct"] = (close / frame["rolling_high"] - 1) * 100
    frame["sma_deviation_pct"] = (close / frame["sma"] - 1) * 100
    frame["rsi"] = rsi(close, settings.rsi_window)
    frame["percentile"] = rolling_percentile(close, settings.percentile_window)
    return frame.replace([np.inf, -np.inf], np.nan)
