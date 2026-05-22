import { useEffect, useMemo, useState } from "react";
import type { components } from "../api.generated";
import type {
  Asset,
  Backtest,
  Decision,
  Frequency,
  OptimizationJobStatus,
  OptimizationResult,
  ParamValue,
  PresetMode,
  RecommendationResponse,
  StrategyConfigPayload,
  StrategyDef,
  UiError,
} from "../types";

type Schemas = components["schemas"];
import { API_BASE, ASSET_MARKETS, PRESSURE_SCENARIOS, QUICK_BACKTEST_PERIODS, SETTINGS_KEY, defaultStartDate, todayIso } from "../constants";
import { clampEndDate, normalizeFrequency, presetFor, readSavedSettings, yearsBefore } from "../utils";
import { readJson, toUiError } from "../api";

export function useBacktest() {
  const savedSettings = useMemo(() => readSavedSettings(), []);

  // ─── Core state ──────────────────────────────────────────────────────────
  const [assets, setAssets] = useState<Asset[]>([]);
  const [strategies, setStrategies] = useState<StrategyDef[]>([]);
  const [darkMode, setDarkMode] = useState(Boolean(savedSettings?.darkMode));
  const [symbol, setSymbol] = useState(String(savedSettings?.symbol ?? "QQQ"));
  const [strategyType, setStrategyType] = useState(String(savedSettings?.strategyType ?? "composite_score"));
  const [baseAmount, setBaseAmount] = useState(Number(savedSettings?.baseAmount ?? 100));
  const [frequency, setFrequency] = useState<Frequency>(normalizeFrequency(savedSettings?.frequency));
  const [minMultiplier, setMinMultiplier] = useState(Number(savedSettings?.minMultiplier ?? 0.8));
  const [maxMultiplier, setMaxMultiplier] = useState(Number(savedSettings?.maxMultiplier ?? 1.2));
  const [startDate, setStartDate] = useState(String(savedSettings?.startDate ?? defaultStartDate));
  const [endDate, setEndDate] = useState(clampEndDate(String(savedSettings?.endDate ?? todayIso)));
  const [params, setParams] = useState<Record<string, number | string | boolean>>({});
  const [result, setResult] = useState<Backtest | null>(null);
  const [quickDecision, setQuickDecision] = useState<Decision | null>(null);
  const [quickData, setQuickData] = useState<{ dataSource: string; cacheStatus: string } | null>(null);
  const [optimization, setOptimization] = useState<OptimizationResult | null>(null);
  const [optimizationJob, setOptimizationJob] = useState<OptimizationJobStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [recommendationLoading, setRecommendationLoading] = useState(false);
  const [optimizationLoading, setOptimizationLoading] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [showAllReasons, setShowAllReasons] = useState(false);
  const [presetMode, setPresetMode] = useState<PresetMode>((savedSettings?.presetMode as PresetMode) ?? "balanced");
  const [activeScenarioId, setActiveScenarioId] = useState<string | null>(String(savedSettings?.activeScenarioId ?? "") || null);
  const [comparisonStrategyTypes, setComparisonStrategyTypes] = useState<string[]>(
    Array.isArray(savedSettings?.comparisonStrategyTypes) ? savedSettings.comparisonStrategyTypes : ["drawdown_boost", "ma_deviation"],
  );
  const [riskFreeRate, setRiskFreeRate] = useState<number>(typeof savedSettings?.riskFreeRate === "number" ? savedSettings.riskFreeRate : 0.04);

  // ─── Derived state ───────────────────────────────────────────────────────
  const selectedStrategy = useMemo(() => strategies.find((item) => item.type === strategyType), [strategies, strategyType]);
  const strategyNameByType = useMemo(() => new Map(strategies.map((s) => [s.type, s.name])), [strategies]);
  const comparisonTypes = useMemo(
    () => comparisonStrategyTypes.filter((item, index, source) => item !== strategyType && source.indexOf(item) === index),
    [comparisonStrategyTypes, strategyType],
  );
  const activeMarket = ASSET_MARKETS[symbol] ?? "us";
  const pressureScenarios = useMemo(() => PRESSURE_SCENARIOS.filter((s) => s.market === activeMarket), [activeMarket]);
  const activeScenario = useMemo(() => pressureScenarios.find((s) => s.id === activeScenarioId) ?? null, [activeScenarioId, pressureScenarios]);
  const activePeriodId = useMemo(
    () => QUICK_BACKTEST_PERIODS.find((p) => yearsBefore(endDate, p.years) === startDate)?.id ?? null,
    [endDate, startDate],
  );
  const config = useMemo(
    (): StrategyConfigPayload => ({ strategyType, baseAmount, frequency, minMultiplier, maxMultiplier, params }),
    [strategyType, baseAmount, frequency, minMultiplier, maxMultiplier, params],
  );
  const optimizationActive = optimizationJob?.status === "queued" || optimizationJob?.status === "running";

  // ─── Effects ─────────────────────────────────────────────────────────────

  // Reset optimization when key inputs change
  useEffect(() => {
    setOptimization(null);
    if (optimizationActive && optimizationJob) {
      fetch(`${API_BASE}/api/optimizations/jobs/${optimizationJob.jobId}`, { method: "DELETE" }).catch(() => undefined);
      setOptimizationLoading(false);
    }
    setOptimizationJob(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, strategyType, startDate, endDate, config]);

  // Load assets and strategies on mount
  useEffect(() => {
    Promise.all([fetch(`${API_BASE}/api/assets`).then(readJson<Asset[]>), fetch(`${API_BASE}/api/strategies`).then(readJson<{ strategies: StrategyDef[] }>)])
      .then(([assetData, strategyData]) => {
        setAssets(assetData);
        setStrategies(strategyData.strategies);
        const active =
          strategyData.strategies.find((item: StrategyDef) => item.type === strategyType) ??
          strategyData.strategies.find((item: StrategyDef) => item.type === "composite_score");
        if (savedSettings?.params && savedSettings?.strategyType === strategyType) {
          setParams(savedSettings.params as Record<string, string | number | boolean>);
        } else {
          const preset = presetFor(active, presetMode);
          setMinMultiplier(preset.minMultiplier);
          setMaxMultiplier(preset.maxMultiplier);
          setParams(preset.params);
        }
      })
      .catch((err) => setError(toUiError(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset params when strategy changes
  useEffect(() => {
    const preset = presetFor(selectedStrategy, presetMode === "custom" ? "balanced" : presetMode);
    setMinMultiplier(preset.minMultiplier);
    setMaxMultiplier(preset.maxMultiplier);
    setParams(preset.params);
    setComparisonStrategyTypes((current) => current.filter((item) => item !== strategyType));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategyType]);

  // Clear invalid scenario
  useEffect(() => {
    if (activeScenarioId && !activeScenario) setActiveScenarioId(null);
  }, [activeScenario, activeScenarioId]);

  // Clamp end date
  useEffect(() => {
    if (endDate > todayIso) {
      setEndDate(todayIso);
      setActiveScenarioId(null);
    }
  }, [endDate]);

  // Persist settings
  useEffect(() => {
    if (!selectedStrategy || Object.keys(params).length === 0) return;
    window.localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        darkMode,
        symbol,
        strategyType,
        baseAmount,
        frequency,
        minMultiplier,
        maxMultiplier,
        startDate,
        endDate,
        params,
        presetMode,
        activeScenarioId,
        comparisonStrategyTypes: comparisonTypes,
        riskFreeRate,
      }),
    );
  }, [activeScenarioId, baseAmount, comparisonTypes, darkMode, endDate, frequency, maxMultiplier, minMultiplier, params, presetMode, riskFreeRate, selectedStrategy, startDate, strategyType, symbol]);

  // Auto-run backtest
  useEffect(() => {
    if (!selectedStrategy) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      fetch(`${API_BASE}/api/backtests/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, startDate, endDate, config, comparisonStrategyTypes: comparisonTypes, riskFreeRate }),
      })
        .then((res) => readJson<Backtest>(res))
        .then((data) => {
          // Drop the result if a newer request superseded this one
          // while it was in flight. Without this guard a slow earlier
          // request (e.g. with comparison strategies) can race past a
          // faster later request and re-populate strategyComparisons
          // after the user already unchecked them, so the chart shows
          // ghost lines.
          if (cancelled) return;
          setResult(data);
          setQuickDecision(null);
          setQuickData(null);
        })
        .catch((err) => {
          if (cancelled) return;
          setError(toUiError(err));
        })
        .finally(() => {
          if (cancelled) return;
          setLoading(false);
        });
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [symbol, startDate, endDate, config, selectedStrategy, refreshNonce, comparisonTypes, riskFreeRate]);

  // Poll optimization job
  useEffect(() => {
    if (!optimizationJob || !optimizationActive) return;
    let stopped = false;
    const poll = () => {
      fetch(`${API_BASE}/api/optimizations/jobs/${optimizationJob.jobId}`)
        .then(readJson<OptimizationJobStatus>)
        .then((job) => {
          if (stopped) return;
          setOptimizationJob(job);
          if (job.status === "completed") {
            if (job.result) setOptimization(job.result);
            setOptimizationLoading(false);
          }
          if (job.status === "failed") {
            setError({ message: job.error || "参数调优失败，请重试。", retryable: true });
            setOptimizationLoading(false);
          }
          if (job.status === "cancelled") {
            setOptimizationLoading(false);
          }
        })
        .catch((err) => {
          if (stopped) return;
          setError(toUiError(err));
          setOptimizationLoading(false);
        });
    };
    poll();
    const handle = window.setInterval(poll, 1000);
    return () => {
      stopped = true;
      window.clearInterval(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optimizationJob?.jobId, optimizationActive]);

  // ─── Actions ─────────────────────────────────────────────────────────────

  const applyPreset = (mode: PresetMode) => {
    setPresetMode(mode);
    if (mode === "custom") return;
    const preset = presetFor(selectedStrategy, mode);
    setMinMultiplier(preset.minMultiplier);
    setMaxMultiplier(preset.maxMultiplier);
    setParams(preset.params);
  };

  const markCustom = () => {
    setPresetMode("custom");
    setActiveScenarioId(null);
  };

  const applyScenario = (scenarioId: string) => {
    if (!scenarioId) {
      setActiveScenarioId(null);
      return;
    }
    const scenario = pressureScenarios.find((item) => item.id === scenarioId);
    if (!scenario) return;
    setActiveScenarioId(scenario.id);
    setStartDate(scenario.startDate);
    setEndDate(scenario.endDate);
  };

  const applyBacktestPeriod = (years: number) => {
    setStartDate(yearsBefore(endDate, years));
    setActiveScenarioId(null);
  };

  const runRecommendationOnly = () => {
    if (!selectedStrategy) return;
    setRecommendationLoading(true);
    setError(null);
    fetch(`${API_BASE}/api/recommendations/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, asOf: endDate, config }),
    })
      .then(readJson<RecommendationResponse>)
      .then((data) => {
        setQuickDecision(data.decision);
        setQuickData({ dataSource: data.dataSource, cacheStatus: data.cacheStatus });
        setResult((current) =>
          current ? { ...current, recommendation: data.decision, dataSource: data.dataSource, cacheStatus: data.cacheStatus } : current,
        );
      })
      .catch((err) => setError(toUiError(err)))
      .finally(() => setRecommendationLoading(false));
  };

  const runOptimization = () => {
    if (!selectedStrategy) return;
    setOptimizationLoading(true);
    setError(null);
    setOptimization(null);
    setOptimizationJob(null);
    fetch(`${API_BASE}/api/optimizations/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, startDate, endDate, config, objective: "robust_return" }),
    })
      .then(readJson<{ jobId: string }>)
      .then((data) => setOptimizationJob({ jobId: data.jobId, status: "queued", progress: 0, evaluatedCount: 0, totalCount: 0 }))
      .catch((err) => {
        setError(toUiError(err));
        setOptimizationLoading(false);
      });
  };

  const cancelOptimization = () => {
    if (!optimizationJob || !optimizationActive) return;
    fetch(`${API_BASE}/api/optimizations/jobs/${optimizationJob.jobId}`, { method: "DELETE" })
      .then(readJson<OptimizationJobStatus>)
      .then((job) => {
        setOptimizationJob(job);
        setOptimizationLoading(false);
      })
      .catch((err) => setError(toUiError(err)));
  };

  const applyOptimizedConfig = (optimizedConfig: StrategyConfigPayload | Schemas["StrategyConfig"]) => {
    setPresetMode("custom");
    setMinMultiplier(optimizedConfig.minMultiplier);
    setMaxMultiplier(optimizedConfig.maxMultiplier);
    // The optimizer payload's `params` come from the same backend
    // that produces the runtime values, so the unknown-typed entries
    // are always one of the ParamValue primitives.
    setParams((optimizedConfig.params ?? {}) as Record<string, ParamValue>);
  };

  const toggleComparison = (type: string) => {
    setComparisonStrategyTypes((current) => {
      if (current.includes(type)) return current.filter((item) => item !== type);
      if (current.length >= 3) return current;
      return [...current, type];
    });
  };

  const refresh = () => setRefreshNonce((v) => v + 1);

  // ─── Computed values for UI ──────────────────────────────────────────────
  const activeAsset = assets.find((item) => item.symbol === symbol);
  const decision = quickDecision ?? result?.recommendation;
  const reasons = decision?.reasons ?? [];
  const dataSource = quickData?.dataSource ?? result?.dataSource ?? "-";
  const cacheStatus = quickData?.cacheStatus ?? result?.cacheStatus ?? "-";

  return {
    // State
    assets,
    strategies,
    darkMode,
    setDarkMode,
    symbol,
    setSymbol,
    strategyType,
    setStrategyType,
    baseAmount,
    setBaseAmount,
    frequency,
    setFrequency,
    minMultiplier,
    setMinMultiplier,
    maxMultiplier,
    setMaxMultiplier,
    startDate,
    setStartDate,
    endDate,
    setEndDate,
    params,
    setParams,
    result,
    optimization,
    optimizationJob,
    loading,
    recommendationLoading,
    optimizationLoading,
    error,
    showAllReasons,
    setShowAllReasons,
    presetMode,
    activeScenarioId,
    setActiveScenarioId,
    riskFreeRate,
    setRiskFreeRate,

    // Derived
    selectedStrategy,
    strategyNameByType,
    comparisonTypes,
    pressureScenarios,
    activeScenario,
    activePeriodId,
    config,
    optimizationActive,
    activeAsset,
    decision,
    reasons,
    dataSource,
    cacheStatus,

    // Actions
    applyPreset,
    markCustom,
    applyScenario,
    applyBacktestPeriod,
    runRecommendationOnly,
    runOptimization,
    cancelOptimization,
    applyOptimizedConfig,
    toggleComparison,
    refresh,
  };
}
