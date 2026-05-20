from typing import Any

import pandas as pd

from app.indicators import IndicatorSettings, add_indicators, clamp, linear_multiplier
from app.models import StrategyConfig, StrategyDecision


def _param(config: StrategyConfig, key: str, default: Any) -> Any:
    return config.params.get(key, default)


def _bounded_amount(config: StrategyConfig, score: float) -> tuple[float, float]:
    multiplier = linear_multiplier(score, config.minMultiplier, config.maxMultiplier)
    return round(config.baseAmount * multiplier, 2), round(multiplier, 4)


def _row_float(row: pd.Series, key: str, default: float) -> float:
    value = row.get(key, default)
    if pd.isna(value):
        return float(default)
    return float(value)


def _row_optional_float(row: pd.Series, key: str) -> float | None:
    """Return the row value as a float, or None if the indicator is NaN.

    Used by strategy signals so they can distinguish 'indicator is still
    warming up' (return None and let the caller fall back to neutral with a
    warmup flag) from 'indicator computed normally'.
    """

    if key not in row:
        return None
    value = row.get(key)
    if value is None or pd.isna(value):
        return None
    return float(value)


def _settings(config: StrategyConfig) -> IndicatorSettings:
    return IndicatorSettings(
        high_window=int(_param(config, "lookbackDays", 252)),
        ma_window=int(_param(config, "maWindow", 200)),
        percentile_window=int(_param(config, "percentileWindow", 756)),
        rsi_window=int(_param(config, "rsiWindow", 14)),
        grid_window=int(_param(config, "gridWindow", 252)),
    )


def prepare_market(prices: pd.DataFrame, config: StrategyConfig) -> pd.DataFrame:
    if prices.empty:
        raise ValueError("No price data available.")
    frame = prices.sort_index()
    return add_indicators(frame, _settings(config))


def _latest_row(frame: pd.DataFrame, as_of: pd.Timestamp | None = None) -> tuple[pd.Timestamp, pd.Series]:
    if as_of is not None:
        pos = frame.index.searchsorted(as_of, side="right") - 1
        if pos < 0:
            raise ValueError("No usable price data before requested date.")
        idx = frame.index[pos]
        return idx, frame.iloc[pos]
    usable = frame.dropna(subset=["close"])
    if usable.empty:
        raise ValueError("No usable price data before requested date.")
    idx = usable.index[-1]
    return idx, usable.iloc[-1]


WARMUP_REASON = "指标预热不足，本期按基础金额执行。"


def _signal_drawdown(row: pd.Series, config: StrategyConfig) -> tuple[float, str, bool]:
    raw = _row_optional_float(row, "drawdown_pct")
    if raw is None:
        return 0.5, WARMUP_REASON, True
    max_drawdown = float(_param(config, "maxDrawdownPct", 30))
    drawdown_depth = max(0.0, -raw / 100)
    score = clamp(drawdown_depth / max(max_drawdown / 100, 0.0001), 0, 1)
    return score, f"近窗口回撤 {drawdown_depth * 100:.1f}%，回撤越深投入越高。", False


def _signal_ma(row: pd.Series, config: StrategyConfig) -> tuple[float, str, bool]:
    raw = _row_optional_float(row, "sma_deviation_pct")
    if raw is None:
        return 0.5, WARMUP_REASON, True
    threshold = float(_param(config, "deviationPct", 15))
    cheapness = clamp(0.5 - raw / max(2 * threshold, 0.0001), 0, 1)
    direction = "低于" if raw < 0 else "高于"
    return cheapness, f"价格{direction}均线 {abs(raw):.1f}%，按均线偏离调整投入。", False


def _signal_percentile(row: pd.Series) -> tuple[float, str, bool]:
    raw = _row_optional_float(row, "percentile")
    if raw is None:
        return 0.5, WARMUP_REASON, True
    cheapness = clamp(1 - raw / 100, 0, 1)
    return cheapness, f"当前价格位于历史 {raw:.0f}% 分位，分位越低投入越高。", False


def _signal_rsi(row: pd.Series, config: StrategyConfig) -> tuple[float, str, bool]:
    raw = _row_optional_float(row, "rsi")
    if raw is None:
        return 0.5, WARMUP_REASON, True
    oversold = float(_param(config, "oversold", 30))
    overbought = float(_param(config, "overbought", 70))
    cheapness = clamp((overbought - raw) / max(1, overbought - oversold), 0, 1)
    return cheapness, f"RSI 为 {raw:.1f}，越接近超卖区投入越高。", False


def _signal_grid(row: pd.Series, config: StrategyConfig) -> tuple[float, int, str, bool]:
    close = _row_float(row, "close", 0)
    low_raw = _row_optional_float(row, "rolling_low")
    high_raw = _row_optional_float(row, "grid_high")
    if low_raw is None or high_raw is None:
        grid_count = max(1, int(_param(config, "gridCount", 8)))
        return 0.5, (grid_count // 2) + 1, WARMUP_REASON, True
    grid_count = max(1, int(_param(config, "gridCount", 8)))
    if high_raw <= low_raw:
        position = 0.5
    else:
        position = clamp((close - low_raw) / (high_raw - low_raw), 0, 1)
    bucket = int(clamp(position, 0, 0.9999) * grid_count) + 1
    cheapness = 1 - position
    return cheapness, bucket, f"价格处于滚动区间第 {bucket}/{grid_count} 档，越靠低档投入越高。", False


def _raw_signals(row: pd.Series, config: StrategyConfig) -> dict[str, float | int | str | None]:
    grid_score, bucket, _, _ = _signal_grid(row, config)
    return {
        "price": round(_row_float(row, "close", 0), 4),
        "sma": None if pd.isna(row.get("sma")) else round(float(row.get("sma")), 4),
        "smaDeviationPct": None
        if pd.isna(row.get("sma_deviation_pct"))
        else round(float(row.get("sma_deviation_pct")), 4),
        "drawdownPct": None if pd.isna(row.get("drawdown_pct")) else round(float(row.get("drawdown_pct")), 4),
        "percentile": None if pd.isna(row.get("percentile")) else round(float(row.get("percentile")), 4),
        "rsi": None if pd.isna(row.get("rsi")) else round(float(row.get("rsi")), 4),
        "gridBucket": bucket,
        "gridScore": round(grid_score, 4),
    }


def evaluate_strategy(
    strategy_type: str,
    config: StrategyConfig,
    prices: pd.DataFrame,
    as_of: pd.Timestamp | None = None,
) -> StrategyDecision:
    frame = prepare_market(prices, config)
    return evaluate_prepared_strategy(strategy_type, config, frame, as_of)


def evaluate_prepared_strategy(
    strategy_type: str,
    config: StrategyConfig,
    frame: pd.DataFrame,
    as_of: pd.Timestamp | None = None,
) -> StrategyDecision:
    idx, row = _latest_row(frame, as_of)

    reasons: list[str] = []
    warmup = False
    if strategy_type == "fixed_dca":
        score = 0.5
        amount = round(config.baseAmount, 2)
        multiplier = 1.0
        reasons.append("固定定投策略：本期投入基础金额，不根据市场状态调整。")
    elif strategy_type == "drawdown_boost":
        score, reason, warmup = _signal_drawdown(row, config)
        amount, multiplier = _bounded_amount(config, score)
        reasons.append(reason)
    elif strategy_type == "ma_deviation":
        score, reason, warmup = _signal_ma(row, config)
        amount, multiplier = _bounded_amount(config, score)
        reasons.append(reason)
    elif strategy_type == "historical_percentile":
        score, reason, warmup = _signal_percentile(row)
        amount, multiplier = _bounded_amount(config, score)
        reasons.append(reason)
    elif strategy_type == "rsi_sentiment":
        score, reason, warmup = _signal_rsi(row, config)
        amount, multiplier = _bounded_amount(config, score)
        reasons.append(reason)
    elif strategy_type == "grid_weighted":
        score, _, reason, warmup = _signal_grid(row, config)
        if not warmup and bool(_param(config, "smooth", True)):
            score = clamp(score * 0.85 + 0.5 * 0.15, 0, 1)
            reason += " 已启用平滑，避免相邻网格导致金额剧烈跳变。"
        amount, multiplier = _bounded_amount(config, score)
        reasons.append(reason)
    elif strategy_type == "composite_score":
        drawdown_score, drawdown_reason, drawdown_warmup = _signal_drawdown(row, config)
        ma_score, ma_reason, ma_warmup = _signal_ma(row, config)
        percentile_score, percentile_reason, percentile_warmup = _signal_percentile(row)
        rsi_score, rsi_reason, rsi_warmup = _signal_rsi(row, config)
        grid_score, _, grid_reason, grid_warmup = _signal_grid(row, config)
        components = [
            (drawdown_score, drawdown_reason, float(_param(config, "drawdownWeight", 1)), drawdown_warmup),
            (ma_score, ma_reason, float(_param(config, "maWeight", 1)), ma_warmup),
            (percentile_score, percentile_reason, float(_param(config, "percentileWeight", 1)), percentile_warmup),
            (rsi_score, rsi_reason, float(_param(config, "rsiWeight", 1)), rsi_warmup),
            (grid_score, grid_reason, float(_param(config, "gridWeight", 1)), grid_warmup),
        ]
        # Drop NaN-only signals from the weighted average so a half-warmed
        # market doesn't get pulled toward neutral by inactive signals.
        active = [item for item in components if item[2] > 0 and not item[3]]
        total_weight = sum(item[2] for item in active)
        if total_weight <= 0:
            score = 0.5
            warmup = True
            if all(item[3] for item in components):
                reasons.append(WARMUP_REASON)
            else:
                reasons.append("组合评分权重全为 0，回退为中性倍率。")
        else:
            score = sum(item[0] * item[2] for item in active) / total_weight
            reasons.extend([item[1] for item in active])
            inactive_warmup = [item for item in components if item[2] > 0 and item[3]]
            if inactive_warmup:
                warmup = False  # at least one signal computed
                reasons.append(f"{len(inactive_warmup)} 个子信号预热不足，本期已自动剔除。")
        amount, multiplier = _bounded_amount(config, score)
    else:
        raise ValueError(f"Unsupported strategy type: {strategy_type}")

    if warmup:
        amount = round(config.baseAmount, 2)
        multiplier = 1.0

    raw = _raw_signals(row, config)
    raw["strategyType"] = strategy_type
    return StrategyDecision(
        date=idx.date().isoformat(),
        price=round(float(row["close"]), 4),
        recommendedAmount=amount,
        multiplier=multiplier,
        score=round(float(score), 4),
        rawSignals=raw,
        reasons=reasons,
        warmup=warmup,
    )
