import { useEffect, useMemo, useState } from "react";
import type { components } from "../api.generated";
import type {
  Asset,
  AssetRange,
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
import { clampEndDate, clampToRange, normalizeFrequency, presetFor, readSavedSettings, readUrlSettings, syncUrlSettings, yearsBefore } from "../utils";
import { readJson, toUiError } from "../api";

export function useBacktest() {
  const savedSettings = useMemo(() => readSavedSettings(), []);
  const urlSettings = useMemo(() => readUrlSettings(), []);
  const initialSettings = urlSettings ?? savedSettings ?? {};

  // ─── Core state ──────────────────────────────────────────────────────────
  const [assets, setAssets] = useState<Asset[]>([]);
  // Per-symbol available date range (cached SQLite extents on the
  // backend, with hardcoded fallback). Used to set min/max on the
  // date inputs so users can't pick dates the cache won't cover.
  const [assetRange, setAssetRange] = useState<AssetRange | null>(null);
  const [strategies, setStrategies] = useState<StrategyDef[]>([]);
  const [darkMode, setDarkMode] = useState(Boolean(savedSettings?.darkMode));
  const [symbol, setSymbol] = useState(String(initialSettings.symbol ?? "QQQ"));
  const [strategyType, setStrategyType] = useState(String(initialSettings.strategyType ?? "composite_score"));
  const [baseAmount, setBaseAmount] = useState(Number(initialSettings.baseAmount ?? 100));
  const [frequency, setFrequency] = useState<Frequency>(normalizeFrequency(initialSettings.frequency));
  const [minMultiplier, setMinMultiplier] = useState(Number(initialSettings.minMultiplier ?? 0.8));
  const [maxMultiplier, setMaxMultiplier] = useState(Number(initialSettings.maxMultiplier ?? 1.2));
  const [startDate, setStartDate] = useState(String(initialSettings.startDate ?? defaultStartDate));
  const [endDate, setEndDate] = useState(clampEndDate(String(initialSettings.endDate ?? todayIso)));
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
  const [metadataNonce, setMetadataNonce] = useState(0);
  const [showAllReasons, setShowAllReasons] = useState(false);
  const [presetMode, setPresetMode] = useState<PresetMode>((initialSettings.presetMode as PresetMode) ?? "balanced");
  const [activeScenarioId, setActiveScenarioId] = useState<string | null>(String(initialSettings.activeScenarioId ?? "") || null);
  const [comparisonStrategyTypes, setComparisonStrategyTypes] = useState<string[]>(
    Array.isArray(initialSettings.comparisonStrategyTypes) ? initialSettings.comparisonStrategyTypes : ["drawdown_boost", "ma_deviation"],
  );
  const [riskFreeRate, setRiskFreeRate] = useState<number>(typeof initialSettings.riskFreeRate === "number" ? initialSettings.riskFreeRate : 0.04);
  // Fee and slippage are user preferences (like riskFreeRate), not part
  // of any strategy's parameter schema, so we keep them as top-level
  // state and merge them into config.params at request time. Otherwise
  // they would be wiped whenever the user switches strategy or preset
  // (which calls setParams(preset.params) and replaces the whole dict).
  const [feeRate, setFeeRate] = useState<number>(typeof initialSettings.feeRate === "number" ? initialSettings.feeRate : 0);
  const [slippageRate, setSlippageRate] = useState<number>(typeof initialSettings.slippageRate === "number" ? initialSettings.slippageRate : 0);

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
    (): StrategyConfigPayload => ({
      strategyType,
      baseAmount,
      frequency,
      minMultiplier,
      maxMultiplier,
      // Merge fee/slippage into params at the request boundary so they
      // travel with the strategy config without bleeding into the
      // preset's "real" parameter set.
      params: { ...params, feeRate, slippageRate },
    }),
    [strategyType, baseAmount, frequency, minMultiplier, maxMultiplier, params, feeRate, slippageRate],
  );
  const optimizationActive = optimizationJob?.status === "queued" || optimizationJob?.status === "running";
  const metadataReady = assets.length > 0 && strategies.length > 0;

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

  // Load assets and strategies. Kept retryable because users commonly
  // start the Vite frontend before uvicorn is ready; in that case the
  // first /api/assets + /api/strategies request fails, and a plain
  // backtest refresh cannot recover because strategy metadata never
  // loaded.
  useEffect(() => {
    setError(null);
    Promise.all([fetch(`${API_BASE}/api/assets`).then(readJson<Asset[]>), fetch(`${API_BASE}/api/strategies`).then(readJson<{ strategies: StrategyDef[] }>)])
      .then(([assetData, strategyData]) => {
        setAssets(assetData);
        setStrategies(strategyData.strategies);
        const active =
          strategyData.strategies.find((item: StrategyDef) => item.type === strategyType) ??
          strategyData.strategies.find((item: StrategyDef) => item.type === "composite_score");
        if (initialSettings.params && (!initialSettings.strategyType || initialSettings.strategyType === strategyType)) {
          setParams(initialSettings.params as Record<string, string | number | boolean>);
        } else {
          const preset = presetFor(active, presetMode);
          setMinMultiplier(preset.minMultiplier);
          setMaxMultiplier(preset.maxMultiplier);
          setParams(preset.params);
        }
        if (active && active.type !== strategyType) {
          setStrategyType(active.type);
        }
      })
      .catch((err) => setError(toUiError(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metadataNonce]);

  // Load per-symbol date range whenever the symbol changes. The
  // response drives the `min`/`max` HTML attributes on the date
  // inputs and the "data available range" hint, so users can't pick
  // a window the local cache won't cover. Failures are silent — the
  // inputs just fall back to no constraint.
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/assets/${symbol}/range`)
      .then(readJson<AssetRange>)
      .then((range) => {
        if (cancelled) return;
        setAssetRange(range);
      })
      .catch(() => {
        if (cancelled) return;
        setAssetRange(null);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

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

  // Cross-field guard: end must not be before start. Whenever they
  // get inverted (e.g. user types 1995 into the end input while
  // start is at 2000, or applies a long quick-period that shifts
  // start past end), pin end to start so the request stays valid.
  // Backend validation would catch it, but the UX is much better if
  // the inputs self-correct rather than throwing a "请求参数不合法".
  useEffect(() => {
    if (endDate < startDate) {
      setEndDate(startDate);
      setActiveScenarioId(null);
    }
  }, [startDate, endDate]);

  // Persist settings
  useEffect(() => {
    if (!selectedStrategy || Object.keys(params).length === 0) return;
    const persisted = {
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
      feeRate,
      slippageRate,
    };
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(persisted));
    syncUrlSettings({ ...persisted, strategy: selectedStrategy });
  }, [activeScenarioId, baseAmount, comparisonTypes, darkMode, endDate, feeRate, frequency, maxMultiplier, minMultiplier, params, presetMode, riskFreeRate, selectedStrategy, slippageRate, startDate, strategyType, symbol]);

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
    // Compute candidate start = end - years, then clamp to the
    // symbol's available range so a 10y shortcut on a 2000 end date
    // doesn't quietly select 1990 (before QQQ existed). If the floor
    // would push start past end, give up and pin both to the floor.
    const candidate = yearsBefore(endDate, years);
    const clampedStart = clampToRange(candidate, assetRange);
    setStartDate(clampedStart);
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
  const retryError = () => {
    if (!metadataReady) {
      setMetadataNonce((v) => v + 1);
      return;
    }
    refresh();
  };

  // ─── Computed values for UI ──────────────────────────────────────────────
  const activeAsset = assets.find((item) => item.symbol === symbol);
  const decision = quickDecision ?? result?.recommendation;
  const reasons = decision?.reasons ?? [];
  const dataSource = quickData?.dataSource ?? result?.dataSource ?? "-";
  const cacheStatus = quickData?.cacheStatus ?? result?.cacheStatus ?? "-";

  return {
    // State
    assets,
    assetRange,
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
    feeRate,
    setFeeRate,
    slippageRate,
    setSlippageRate,

    // Derived
    selectedStrategy,
    strategyNameByType,
    comparisonTypes,
    pressureScenarios,
    activeScenario,
    activePeriodId,
    config,
    optimizationActive,
    metadataReady,
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
    retryError,
  };
}
