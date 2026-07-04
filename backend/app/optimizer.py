from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, timedelta
from itertools import product
from statistics import median
from typing import Any

import pandas as pd

from app.backtester import DcaBacktester
from app.data import get_price_history, validate_symbol
from app.models import (
    BacktestMetrics,
    OptimizationCandidate,
    OptimizationObjective,
    OptimizationRequest,
    OptimizationResult,
    OptimizationScenarioMetrics,
    OptimizationScenarioResult,
    StrategyConfig,
)
from app.strategies import clear_prepare_cache, prepare_market

COMMON_MIN_MULTIPLIERS = [0.6, 0.7, 0.8]
COMMON_MAX_MULTIPLIERS = [1.2, 1.3, 1.4, 1.5]
MAX_CANDIDATES = 600
MIN_BUYS_PER_SCENARIO = 6
OptimizationProgressCallback = Callable[[dict[str, Any]], None]
OptimizationCancelCheck = Callable[[], bool]

COMPOSITE_WEIGHT_PRESETS = [
    {},
    {"drawdownWeight": 2, "maWeight": 1, "percentileWeight": 1, "rsiWeight": 1, "gridWeight": 1},
    {"drawdownWeight": 1, "maWeight": 2, "percentileWeight": 1, "rsiWeight": 1, "gridWeight": 1},
    {"drawdownWeight": 1, "maWeight": 1, "percentileWeight": 2, "rsiWeight": 1, "gridWeight": 1},
    {"drawdownWeight": 1, "maWeight": 1, "percentileWeight": 1, "rsiWeight": 2, "gridWeight": 1},
    {"drawdownWeight": 1, "maWeight": 1, "percentileWeight": 1, "rsiWeight": 1, "gridWeight": 2},
    {"drawdownWeight": 1.5, "maWeight": 1.5, "percentileWeight": 1, "rsiWeight": 0.5, "gridWeight": 0.5},
    {"drawdownWeight": 0.5, "maWeight": 0.5, "percentileWeight": 1.5, "rsiWeight": 1.5, "gridWeight": 1},
]


@dataclass(frozen=True)
class Scenario:
    id: str
    name: str
    start: date
    end: date


class OptimizationCancelled(Exception):
    pass


def _empty_metrics() -> BacktestMetrics:
    return BacktestMetrics(
        totalInvested=0,
        endingValue=0,
        returnPct=0,
        annualizedReturnPct=0,
        maxDrawdownPct=0,
        buyCount=0,
        avgContribution=0,
    )


def _average_metrics(items: list[BacktestMetrics]) -> BacktestMetrics:
    if not items:
        return _empty_metrics()

    def avg(key: str) -> float:
        return round(sum(float(getattr(item, key) or 0) for item in items) / len(items), 2)

    def avg_optional(key: str) -> float | None:
        values = [getattr(item, key) for item in items if getattr(item, key) is not None]
        if not values:
            return None
        return round(sum(float(value) for value in values) / len(values), 2)

    sharpe_items = [item.sharpeRatio for item in items if item.sharpeRatio is not None]
    sortino_items = [item.sortinoRatio for item in items if item.sortinoRatio is not None]
    return BacktestMetrics(
        totalInvested=avg("totalInvested"),
        endingValue=avg("endingValue"),
        returnPct=avg("returnPct"),
        annualizedReturnPct=avg("annualizedReturnPct"),
        maxDrawdownPct=avg("maxDrawdownPct"),
        buyCount=round(sum(item.buyCount for item in items) / len(items)),
        avgContribution=avg("avgContribution"),
        # versusFixedPct can be None on scenarios where the fixed-DCA
        # baseline is empty. Treating None as zero would silently mark
        # those scenarios as "tied with fixed DCA" and could push a fragile
        # candidate to the top of the leaderboard.
        versusFixedPct=avg_optional("versusFixedPct"),
        versusLumpSumPct=None,
        sharpeRatio=round(sum(sharpe_items) / len(sharpe_items), 2) if sharpe_items else None,
        sortinoRatio=round(sum(sortino_items) / len(sortino_items), 2) if sortino_items else None,
    )


def _with_fixed_comparison(metrics: BacktestMetrics, fixed_metrics: BacktestMetrics) -> BacktestMetrics:
    fixed_vs = None
    if fixed_metrics.endingValue > 0:
        fixed_vs = round((metrics.endingValue / fixed_metrics.endingValue - 1) * 100, 2)
    return BacktestMetrics(**{**metrics.model_dump(), "versusFixedPct": fixed_vs})


def _single_score(metrics: BacktestMetrics, objective: OptimizationObjective) -> float:
    sharpe = metrics.sharpeRatio or 0
    drawdown = abs(metrics.maxDrawdownPct)
    if objective == "max_return":
        return metrics.annualizedReturnPct
    if objective == "min_drawdown":
        return -drawdown + metrics.annualizedReturnPct * 0.1
    return metrics.annualizedReturnPct + 5 * sharpe - 0.5 * drawdown


def _robust_score(scenario_scores: list[float], scenario_metrics: list[BacktestMetrics]) -> float:
    if not scenario_scores:
        return float("-inf")
    center = median(scenario_scores)
    worst_gap = center - min(scenario_scores)
    penalty = 0.0
    for metrics in scenario_metrics:
        if metrics.versusFixedPct is not None and metrics.versusFixedPct < -5:
            penalty += abs(metrics.versusFixedPct + 5) * 0.5
        if abs(metrics.maxDrawdownPct) > 35:
            penalty += (abs(metrics.maxDrawdownPct) - 35) * 0.5
    return center - worst_gap * 0.5 - penalty


def _copy_config(
    base: StrategyConfig, params: dict[str, Any], min_multiplier: float, max_multiplier: float
) -> StrategyConfig:
    return StrategyConfig(
        strategyType=base.strategyType,
        baseAmount=base.baseAmount,
        frequency=base.frequency,
        minMultiplier=min_multiplier,
        maxMultiplier=max_multiplier,
        params={**base.params, **params},
    )


def _candidate_configs(base: StrategyConfig) -> tuple[list[StrategyConfig], int]:
    if base.strategyType == "fixed_dca":
        raise ValueError("固定定投没有可调参数，无法做自动调优。")

    grids: list[dict[str, Any]]
    if base.strategyType == "drawdown_boost":
        grids = [
            {"lookbackDays": lookback, "maxDrawdownPct": drawdown}
            for lookback, drawdown in product([126, 252, 504], [15, 25, 35, 50])
        ]
    elif base.strategyType == "ma_deviation":
        grids = [
            {"maWindow": window, "deviationPct": deviation}
            for window, deviation in product([100, 150, 200, 250, 300], [8, 12, 15, 20, 30])
        ]
    elif base.strategyType == "historical_percentile":
        grids = [{"percentileWindow": window} for window in [252, 504, 756, 1008, 1260]]
    elif base.strategyType == "rsi_sentiment":
        grids = [
            {"rsiWindow": window, "oversold": oversold, "overbought": overbought}
            for window, oversold, overbought in product([10, 14, 21, 30], [25, 30, 35], [65, 70, 75])
        ]
    elif base.strategyType == "grid_weighted":
        grids = [
            {"gridWindow": window, "gridCount": count, "smooth": smooth}
            for window, count, smooth in product([126, 252, 504, 756], [5, 8, 12, 16], [True, False])
        ]
    elif base.strategyType == "composite_score":
        grids = COMPOSITE_WEIGHT_PRESETS
    else:
        raise ValueError(f"Unsupported strategy type: {base.strategyType}")

    raw_configs = [
        _copy_config(base, params, min_multiplier, max_multiplier)
        for params, min_multiplier, max_multiplier in product(grids, COMMON_MIN_MULTIPLIERS, COMMON_MAX_MULTIPLIERS)
        if min_multiplier < max_multiplier
    ]
    seen = set()
    unique: list[StrategyConfig] = []
    for config in raw_configs:
        key = (
            config.strategyType,
            config.baseAmount,
            config.frequency,
            config.minMultiplier,
            config.maxMultiplier,
            tuple(sorted(config.params.items())),
        )
        if key in seen:
            continue
        seen.add(key)
        unique.append(config)

    skipped = max(0, len(unique) - MAX_CANDIDATES)
    return unique[:MAX_CANDIDATES], skipped


def _scenarios(start: date, end: date) -> list[Scenario]:
    recent_start = max(start, end - timedelta(days=365))
    return [
        Scenario("selected", "当前选择区间", start, end),
        Scenario("brexit_2016", "2016 Brexit 冲击", date(2016, 6, 23), date(2016, 7, 15)),
        Scenario("q4_selloff_2018", "2018 Q4 紧缩杀跌", date(2018, 10, 3), date(2018, 12, 24)),
        Scenario("covid_2020", "2020 熔断冲击", date(2020, 2, 18), date(2020, 5, 29)),
        Scenario("liquidity_rally_2021", "2021 流动性牛市", date(2021, 1, 4), date(2021, 12, 31)),
        Scenario("rate_hike_2022", "2022 加息长熊", date(2022, 1, 3), date(2022, 12, 30)),
        Scenario("ai_rebound_2023", "2023 科技股修复", date(2023, 1, 3), date(2023, 8, 31)),
        Scenario("ai_momentum_2024", "2024 AI 集中行情", date(2023, 10, 27), date(2024, 7, 10)),
        Scenario("recent_12m", "最近 12 个月", recent_start, end),
    ]


def _execution_rates(params: dict[str, Any]) -> tuple[float, float, float]:
    """Extract fee/slippage/risk-free rates from config params.

    The frontend merges feeRate and slippageRate into config.params at
    the request boundary. If they are absent (older callers, tests), we
    fall back to the defaults that match the backtester.run defaults.
    """
    fee_rate = float(params.get("feeRate", 0.0))
    slippage_rate = float(params.get("slippageRate", 0.0))
    risk_free_rate = float(params.get("riskFreeRate", 0.04))
    return fee_rate, slippage_rate, risk_free_rate


def _fixed_for_scenario(
    backtester: DcaBacktester, scenario: Scenario, config: StrategyConfig
) -> BacktestMetrics | None:
    fee_rate, slippage_rate, risk_free_rate = _execution_rates(config.params)
    fixed_events, fixed_metrics = backtester.run(
        "fixed_dca",
        StrategyConfig(
            strategyType="fixed_dca",
            baseAmount=config.baseAmount,
            frequency=config.frequency,
            minMultiplier=1,
            maxMultiplier=1.0001,
            params={},
        ),
        scenario.start,
        scenario.end,
        fee_rate=fee_rate,
        slippage_rate=slippage_rate,
        risk_free_rate=risk_free_rate,
    )
    if len(fixed_events) < MIN_BUYS_PER_SCENARIO:
        return None
    return fixed_metrics


def _run_candidate(
    backtester: DcaBacktester,
    prepared: pd.DataFrame,
    scenario: Scenario,
    config: StrategyConfig,
    fixed_metrics: BacktestMetrics,
) -> BacktestMetrics | None:
    fee_rate, slippage_rate, risk_free_rate = _execution_rates(config.params)
    events, metrics = backtester.run(
        config.strategyType,
        config,
        scenario.start,
        scenario.end,
        fee_rate=fee_rate,
        slippage_rate=slippage_rate,
        risk_free_rate=risk_free_rate,
        prepared=prepared,
    )
    if len(events) < MIN_BUYS_PER_SCENARIO:
        return None
    return _with_fixed_comparison(metrics, fixed_metrics)


def _ranked_copy(candidate: OptimizationCandidate, rank: int) -> OptimizationCandidate:
    return OptimizationCandidate(**{**candidate.model_dump(), "rank": rank})


def optimize_parameters(
    request: OptimizationRequest,
    progress_callback: OptimizationProgressCallback | None = None,
    should_cancel: OptimizationCancelCheck | None = None,
) -> OptimizationResult:
    def raise_if_cancelled() -> None:
        if should_cancel and should_cancel():
            raise OptimizationCancelled("参数调优已取消。")

    symbol = validate_symbol(request.symbol)
    end = request.endDate or date.today()
    start = request.startDate or (end - timedelta(days=365 * 5))
    candidates, skipped_count = _candidate_configs(request.config)

    # Clear the prepare_market cache so stale entries from a previous
    # optimization (with a different prices DataFrame) don't leak in.
    clear_prepare_cache()
    if progress_callback:
        progress_callback(
            {"evaluatedCount": 0, "totalCount": len(candidates), "currentScenario": "准备验证场景", "bestSoFar": None}
        )
    scenario_defs = _scenarios(start, end)
    max_end = max(item.end for item in scenario_defs)
    min_start = min(item.start for item in scenario_defs) - timedelta(days=365 * 3)
    raise_if_cancelled()
    prices, _, _ = get_price_history(symbol, min_start, max_end)
    backtester = DcaBacktester(prices)
    fixed_by_scenario = {
        scenario.id: _fixed_for_scenario(backtester, scenario, request.config) for scenario in scenario_defs
    }

    unavailable_scenarios = sum(1 for metrics in fixed_by_scenario.values() if metrics is None)

    def evaluate_config(
        config: StrategyConfig,
        evaluated_count: int | None = None,
        total_count: int | None = None,
        best_so_far: OptimizationCandidate | None = None,
    ) -> OptimizationCandidate | None:
        prepared = prepare_market(prices, config)
        scenario_results: list[OptimizationScenarioMetrics] = []
        scores: list[float] = []
        metrics_for_summary: list[BacktestMetrics] = []
        for scenario in scenario_defs:
            raise_if_cancelled()
            if progress_callback and evaluated_count is not None:
                progress_callback(
                    {
                        "evaluatedCount": evaluated_count,
                        "totalCount": total_count or 0,
                        "currentScenario": scenario.name,
                        "bestSoFar": best_so_far,
                    }
                )
            fixed_metrics = fixed_by_scenario[scenario.id]
            if fixed_metrics is None:
                continue
            metrics = _run_candidate(backtester, prepared, scenario, config, fixed_metrics)
            if metrics is None:
                continue
            score = _single_score(metrics, request.objective)
            scores.append(score)
            metrics_for_summary.append(metrics)
            scenario_results.append(
                OptimizationScenarioMetrics(
                    id=scenario.id,
                    name=scenario.name,
                    startDate=scenario.start,
                    endDate=scenario.end,
                    metrics=metrics,
                    fixedMetrics=fixed_metrics,
                    score=round(score, 2),
                )
            )
        if not scenario_results:
            return None
        total_score = (
            _robust_score(scores, metrics_for_summary) if request.objective == "robust_return" else median(scores)
        )
        return OptimizationCandidate(
            rank=0,
            score=round(total_score, 2),
            config=config,
            scenarios=scenario_results,
            summary=_average_metrics(metrics_for_summary),
        )

    baseline = evaluate_config(request.config)
    ranked: list[OptimizationCandidate] = []
    best_so_far: OptimizationCandidate | None = None
    for index, config in enumerate(candidates, start=1):
        candidate = evaluate_config(config, index - 1, len(candidates), best_so_far)
        if candidate is not None:
            ranked.append(candidate)
            best_so_far = max(ranked, key=lambda item: item.score)
        if progress_callback:
            progress_callback(
                {
                    "evaluatedCount": index,
                    "totalCount": len(candidates),
                    "currentScenario": None,
                    "bestSoFar": _ranked_copy(best_so_far, 1) if best_so_far else None,
                }
            )

    if not ranked or baseline is None:
        raise ValueError("所有验证场景都没有足够数据，无法生成稳健参数建议。")

    ranked.sort(key=lambda item: item.score, reverse=True)
    top_candidates = [_ranked_copy(item, index + 1) for index, item in enumerate(ranked[:5])]
    recommended = top_candidates[0]
    scenario_rows: list[OptimizationScenarioResult] = []
    for recommended_scenario in recommended.scenarios:
        baseline_scenario = next((item for item in baseline.scenarios if item.id == recommended_scenario.id), None)
        if baseline_scenario is None:
            continue
        scenario_rows.append(
            OptimizationScenarioResult(
                id=recommended_scenario.id,
                name=recommended_scenario.name,
                startDate=recommended_scenario.startDate,
                endDate=recommended_scenario.endDate,
                baselineMetrics=baseline_scenario.metrics,
                recommendedMetrics=recommended_scenario.metrics,
                fixedMetrics=recommended_scenario.fixedMetrics,
            )
        )

    return OptimizationResult(
        symbol=symbol,
        objective=request.objective,
        baselineConfig=request.config,
        recommendedConfig=recommended.config,
        baselineSummary=baseline.summary,
        recommendedSummary=recommended.summary,
        candidates=top_candidates,
        scenarios=scenario_rows,
        searchedCount=len(candidates),
        skippedCount=skipped_count + unavailable_scenarios,
    )
