import { useEffect, useMemo, useRef, useState } from "react";
import type { components } from "../api.generated";
import type {
  AppDefaults,
  Asset,
  AssetRange,
  Backtest,
  Decision,
  Frequency,
  MonteCarloResponse,
  OptimizationJobStatus,
  OptimizationResult,
  ParamValue,
  PresetMode,
  RecommendationResponse,
  StressTestResponse,
  StrategyConfigPayload,
  StrategyDef,
  StrategyOverride,
  UiError,
} from "../types";

type Schemas = components["schemas"];
import { API_BASE, ASSET_MARKETS, PRESSURE_SCENARIOS, QUICK_BACKTEST_PERIODS, SETTINGS_KEY, defaultStartDate, todayIso } from "../constants";
import {
  clampEndDate,
  clampToRange,
  multipliersForStrategy,
  normalizeAppDefaults,
  normalizeStrategyOverrides,
  presetFor,
  readSavedSettings,
  readUrlSettings,
  strategyConfigKey,
  syncUrlSettings,
  yearsBefore,
} from "../utils";
import { readJson, toUiError } from "../api";

type OptimizationRunContext = {
  configKey: string;
};

export function useBacktest() {
  // Single AbortController shared by every fetch the hook makes. When
  // the hook's effects re-run (or the component unmounts) we abort
  // the previous controller so an in-flight request can't clobber
  // newer state. This is the foundation of the P0-R01 fix.
  const inFlight = useRef<AbortController | null>(null);
  const abortInFlight = () => {
    if (inFlight.current) {
      inFlight.current.abort();
      inFlight.current = null;
    }
  };
  useEffect(() => {
    return () => {
      abortInFlight();
    };
  }, []);

  const savedSettings = useMemo(() => readSavedSettings(), []);
  const urlSettings = useMemo(() => readUrlSettings(), []);
  const initialSettings = useMemo(() => urlSettings ?? savedSettings ?? {}, [savedSettings, urlSettings]);
  const initialStrategyType = String(initialSettings.strategyType ?? "composite_score");
  const initialAppDefaults = useMemo(() => {
    const savedDefaults = normalizeAppDefaults(savedSettings?.appDefaults);
    return normalizeAppDefaults({
      ...savedDefaults,
      baseAmount: initialSettings.baseAmount ?? savedDefaults.baseAmount,
      frequency: initialSettings.frequency ?? savedDefaults.frequency,
      minMultiplier: savedDefaults.minMultiplier,
      maxMultiplier: savedDefaults.maxMultiplier,
      riskFreeRate: initialSettings.riskFreeRate ?? savedDefaults.riskFreeRate,
      feeRate: initialSettings.feeRate ?? savedDefaults.feeRate,
      slippageRate: initialSettings.slippageRate ?? savedDefaults.slippageRate,
    });
  }, [initialSettings, savedSettings]);
  const initialStrategyOverrides = useMemo(() => {
    const overrides = normalizeStrategyOverrides(savedSettings?.strategyOverrides);
    if (urlSettings) {
      const urlOverride: StrategyOverride = {};
      if (typeof urlSettings.minMultiplier === "number") urlOverride.minMultiplier = urlSettings.minMultiplier;
      if (typeof urlSettings.maxMultiplier === "number") urlOverride.maxMultiplier = urlSettings.maxMultiplier;
      if (urlSettings.params) urlOverride.params = urlSettings.params;
      if (Object.keys(urlOverride).length > 0) {
        overrides[initialStrategyType] = { ...overrides[initialStrategyType], ...urlOverride };
      }
    }
    return overrides;
  }, [initialStrategyType, savedSettings, urlSettings]);
  const initialMultipliers = multipliersForStrategy(initialStrategyType, initialAppDefaults, initialStrategyOverrides);

  // ─── Core state ──────────────────────────────────────────────────────────
  const [assets, setAssets] = useState<Asset[]>([]);
  // Per-symbol available date range (cached SQLite extents on the
  // backend, with hardcoded fallback). Used to set min/max on the
  // date inputs so users can't pick dates the cache won't cover.
  const [assetRange, setAssetRange] = useState<AssetRange | null>(null);
  const [strategies, setStrategies] = useState<StrategyDef[]>([]);
  const [darkMode, setDarkMode] = useState(Boolean(savedSettings?.darkMode));
  const [symbol, setSymbol] = useState(String(initialSettings.symbol ?? "QQQ"));
  const [strategyType, setStrategyType] = useState(initialStrategyType);
  const [appDefaults, setAppDefaults] = useState<AppDefaults>(initialAppDefaults);
  const [strategyOverrides, setStrategyOverrides] = useState<Record<string, StrategyOverride>>(initialStrategyOverrides);
  const [minMultiplier, setCurrentMinMultiplier] = useState(initialMultipliers.minMultiplier);
  const [maxMultiplier, setCurrentMaxMultiplier] = useState(initialMultipliers.maxMultiplier);
  const [startDate, setStartDate] = useState(String(initialSettings.startDate ?? defaultStartDate));
  const [endDate, setEndDate] = useState(clampEndDate(String(initialSettings.endDate ?? todayIso)));
  const [params, setParams] = useState<Record<string, number | string | boolean>>({});
  const [result, setResult] = useState<Backtest | null>(null);
  const [decisionContextKey, setDecisionContextKey] = useState("");
  const [quickDecision, setQuickDecision] = useState<Decision | null>(null);
  const [quickData, setQuickData] = useState<{ dataSource: string; cacheStatus: string } | null>(null);
  const [optimization, setOptimization] = useState<OptimizationResult | null>(null);
  const [optimizationJob, setOptimizationJob] = useState<OptimizationJobStatus | null>(null);
  const [optimizationContext, setOptimizationContext] = useState<OptimizationRunContext | null>(null);
  const [monteCarlo, setMonteCarlo] = useState<MonteCarloResponse | null>(null);
  const [monteCarloLoading, setMonteCarloLoading] = useState(false);
  const [stressTest, setStressTest] = useState<StressTestResponse | null>(null);
  const [stressTestLoading, setStressTestLoading] = useState(false);
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
  const baseAmount = appDefaults.baseAmount;
  const frequency = appDefaults.frequency;
  const riskFreeRate = appDefaults.riskFreeRate;
  // Fee and slippage are global user preferences, not strategy schema
  // params. They are merged into config.params only at the request
  // boundary so switching strategies cannot wipe them.
  const feeRate = appDefaults.feeRate;
  const slippageRate = appDefaults.slippageRate;

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
  const configKey = useMemo(() => strategyConfigKey(config), [config]);
  const recommendationContextKey = useMemo(
    () => JSON.stringify({ symbol, startDate, endDate, config }),
    [symbol, startDate, endDate, config],
  );
  const optimizationScopeKey = useMemo(
    () => JSON.stringify({ symbol, strategyType, startDate, endDate }),
    [symbol, strategyType, startDate, endDate],
  );
  const optimizationActive = optimizationJob?.status === "queued" || optimizationJob?.status === "running";
  const activeOptimizationCandidateRank = useMemo(() => {
    if (!optimization) return null;
    const match = optimization.candidates.find((candidate) => strategyConfigKey(candidate.config) === configKey);
    return match?.rank ?? null;
  }, [configKey, optimization]);
  const optimizationRecommendedActive = Boolean(
    optimization && strategyConfigKey(optimization.recommendedConfig) === configKey,
  );
  const optimizationBaselineActive = Boolean(optimization && optimizationContext?.configKey === configKey);
  const optimizationOutOfSync = Boolean(
    optimization && !optimizationBaselineActive && activeOptimizationCandidateRank === null,
  );
  const metadataReady = assets.length > 0 && strategies.length > 0;

  // ─── Effects ─────────────────────────────────────────────────────────────

  // Reset optimization only when the run scope changes. Parameter tweaks
  // should not cancel a long-running optimization; the result panel can
  // instead show that it was launched from a previous parameter set.
  useEffect(() => {
    setOptimization(null);
    setOptimizationContext(null);
    if (optimizationActive && optimizationJob) {
      fetch(`${API_BASE}/api/optimizations/jobs/${optimizationJob.jobId}`, { method: "DELETE" }).catch(() => undefined);
      setOptimizationLoading(false);
    }
    setOptimizationJob(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optimizationScopeKey]);

  // Load assets and strategies. Kept retryable because users commonly
  // start the Vite frontend before uvicorn is ready; in that case the
  // first /api/assets + /api/strategies request fails, and a plain
  // backtest refresh cannot recover because strategy metadata never
  // loaded.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([fetch(`${API_BASE}/api/assets`).then(readJson<Asset[]>), fetch(`${API_BASE}/api/strategies`).then(readJson<{ strategies: StrategyDef[] }>)])
      .then(([assetData, strategyData]) => {
        if (cancelled) return;
        setAssets(assetData);
        setStrategies(strategyData.strategies);
        const active =
          strategyData.strategies.find((item: StrategyDef) => item.type === strategyType) ??
          strategyData.strategies.find((item: StrategyDef) => item.type === "composite_score");
        const activeType = active?.type ?? strategyType;
        const preset = presetFor(active, presetMode);
        const override = initialStrategyOverrides[activeType];
        const nextMultipliers = multipliersForStrategy(activeType, initialAppDefaults, initialStrategyOverrides);
        setCurrentMinMultiplier(nextMultipliers.minMultiplier);
        setCurrentMaxMultiplier(nextMultipliers.maxMultiplier);
        setParams(override?.params ?? preset.params);
        if (active && active.type !== strategyType) {
          setStrategyType(active.type);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(toUiError(err));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metadataNonce]);

  // Load per-symbol date range whenever the symbol changes. The
  // response drives the `min`/`max` HTML attributes on the date
  // inputs and the "data available range" hint, so users can't pick
  // a window the local cache won't cover. Failures are silent — the
  // inputs just fall back to no constraint.
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    fetch(`${API_BASE}/api/assets/${symbol}/range`, { signal: controller.signal })
      .then(readJson<AssetRange>)
      .then((range) => {
        if (cancelled) return;
        setAssetRange(range);
      })
      .catch((err) => {
        if (cancelled || err?.name === "AbortError") return;
        setAssetRange(null);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [symbol]);

  // Reset params when strategy changes
  useEffect(() => {
    const preset = presetFor(selectedStrategy, presetMode === "custom" ? "balanced" : presetMode);
    const override = strategyOverrides[strategyType];
    setCurrentMinMultiplier(override?.minMultiplier ?? appDefaults.minMultiplier);
    setCurrentMaxMultiplier(override?.maxMultiplier ?? appDefaults.maxMultiplier);
    setParams(override?.params ?? preset.params);
    setComparisonStrategyTypes((current) => current.filter((item) => item !== strategyType));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategyType, selectedStrategy, appDefaults.minMultiplier, appDefaults.maxMultiplier, strategyOverrides]);

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
      appDefaults,
      strategyOverrides,
    };
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(persisted));
    syncUrlSettings({ ...persisted, strategy: selectedStrategy });
  }, [activeScenarioId, appDefaults, baseAmount, comparisonTypes, darkMode, endDate, feeRate, frequency, maxMultiplier, minMultiplier, params, presetMode, riskFreeRate, selectedStrategy, slippageRate, startDate, strategyOverrides, strategyType, symbol]);

  // Auto-run backtest
  useEffect(() => {
    if (!selectedStrategy) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      abortInFlight();
      const controller = new AbortController();
      inFlight.current = controller;
      // 60s covers the slowest path (multi-decade backtest with
      // comparison strategies + slow yfinance cold start). Without
      // a cap a half-open connection would freeze the UI for the
      // full OS-level TCP timeout (~120s on most platforms).
      const timeoutId = window.setTimeout(() => controller.abort(), 60_000);
      setLoading(true);
      setError(null);
      fetch(`${API_BASE}/api/backtests/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, startDate, endDate, config, comparisonStrategyTypes: comparisonTypes, riskFreeRate }),
        signal: controller.signal,
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
          setDecisionContextKey(recommendationContextKey);
        })
        .catch((err) => {
          if (cancelled || err?.name === "AbortError") return;
          setError(toUiError(err));
        })
        .finally(() => {
          window.clearTimeout(timeoutId);
          if (cancelled) return;
          setLoading(false);
        });
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [symbol, startDate, endDate, config, selectedStrategy, refreshNonce, comparisonTypes, riskFreeRate, recommendationContextKey]);

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

  const updateAppDefaults = (updates: Partial<AppDefaults>) => {
    setAppDefaults((current) => ({ ...current, ...updates }));
  };

  const setBaseAmount = (value: number) => updateAppDefaults({ baseAmount: value });
  const setFrequency = (value: Frequency) => updateAppDefaults({ frequency: value });
  const setRiskFreeRate = (value: number) => updateAppDefaults({ riskFreeRate: value });
  const setFeeRate = (value: number) => updateAppDefaults({ feeRate: value });
  const setSlippageRate = (value: number) => updateAppDefaults({ slippageRate: value });

  const setDefaultMinMultiplier = (value: number) => {
    updateAppDefaults({ minMultiplier: value });
    if (strategyOverrides[strategyType]?.minMultiplier === undefined) {
      setCurrentMinMultiplier(value);
    }
  };

  const setDefaultMaxMultiplier = (value: number) => {
    updateAppDefaults({ maxMultiplier: value });
    if (strategyOverrides[strategyType]?.maxMultiplier === undefined) {
      setCurrentMaxMultiplier(value);
    }
  };

  const setMinMultiplier = (value: number) => {
    setCurrentMinMultiplier(value);
    setStrategyOverrides((current) => ({
      ...current,
      [strategyType]: { ...current[strategyType], minMultiplier: value },
    }));
  };

  const setMaxMultiplier = (value: number) => {
    setCurrentMaxMultiplier(value);
    setStrategyOverrides((current) => ({
      ...current,
      [strategyType]: { ...current[strategyType], maxMultiplier: value },
    }));
  };

  const setStrategyParams = (nextParams: Record<string, ParamValue>) => {
    setParams(nextParams);
    setStrategyOverrides((current) => ({
      ...current,
      [strategyType]: { ...current[strategyType], params: nextParams },
    }));
  };

  const setStrategyParam = (key: string, value: ParamValue) => {
    const nextParams = { ...params, [key]: value };
    setStrategyParams(nextParams);
  };

  const applyPreset = (mode: PresetMode) => {
    setPresetMode(mode);
    if (mode === "custom") return;
    const preset = presetFor(selectedStrategy, mode);
    setCurrentMinMultiplier(appDefaults.minMultiplier);
    setCurrentMaxMultiplier(appDefaults.maxMultiplier);
    setParams(preset.params);
    setStrategyOverrides((current) => ({
      ...current,
      [strategyType]: { params: preset.params },
    }));
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

  // Track the latest recommendation-only call so a slow earlier
  // response can't clobber a newer one when the user clicks "refresh"
  // twice in quick succession.
  const recommendSeq = useRef(0);
  const monteCarloSeq = useRef(0);

  const runRecommendationOnly = () => {
    if (!selectedStrategy) return;
    const seq = ++recommendSeq.current;
    setRecommendationLoading(true);
    setError(null);
    abortInFlight();
    const controller = new AbortController();
    inFlight.current = controller;
    fetch(`${API_BASE}/api/recommendations/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, asOf: endDate, config }),
      signal: controller.signal,
    })
      .then(readJson<RecommendationResponse>)
      .then((data) => {
        if (seq !== recommendSeq.current) return;
        setQuickDecision(data.decision);
        setQuickData({ dataSource: data.dataSource, cacheStatus: data.cacheStatus });
        setDecisionContextKey(recommendationContextKey);
        setResult((current) =>
          current ? { ...current, recommendation: data.decision, dataSource: data.dataSource, cacheStatus: data.cacheStatus } : current,
        );
      })
      .catch((err) => {
        if (seq !== recommendSeq.current || err?.name === "AbortError") return;
        setError(toUiError(err));
      })
      .finally(() => {
        if (seq === recommendSeq.current) setRecommendationLoading(false);
      });
  };

  const runOptimization = () => {
    if (!selectedStrategy) return;
    setOptimizationLoading(true);
    setError(null);
    setOptimization(null);
    setOptimizationJob(null);
    setOptimizationContext({ configKey });
    fetch(`${API_BASE}/api/optimizations/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, startDate, endDate, config, objective: "robust_return" }),
    })
      .then(readJson<{ jobId: string }>)
      .then((data) => setOptimizationJob({ jobId: data.jobId, status: "queued", progress: 0, evaluatedCount: 0, totalCount: 0 }))
      .catch((err) => setError(toUiError(err)))
      .finally(() => {
        // On any failure of the create call the loading flag is
        // cleared; on success the polling effect takes over.
        if (!optimizationActive) setOptimizationLoading(false);
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
      .catch((err) => {
        setError(toUiError(err));
        // The DELETE itself failed; keep loading=false so the UI is
        // responsive and let the next polling cycle reconcile.
        setOptimizationLoading(false);
      });
  };

  const runMonteCarlo = (horizonMonths: number, numPaths: number, seed?: number) => {
    if (!selectedStrategy) return;
    const seq = ++monteCarloSeq.current;
    setMonteCarloLoading(true);
    setError(null);
    fetch(`${API_BASE}/api/simulations/montecarlo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, startDate, endDate, config, horizonMonths, numPaths, seed }),
    })
      .then(readJson<MonteCarloResponse>)
      .then((data) => {
        if (seq !== monteCarloSeq.current) return;
        setMonteCarlo(data);
      })
      .catch((err) => {
        if (seq !== monteCarloSeq.current) return;
        setError(toUiError(err));
      })
      .finally(() => {
        if (seq === monteCarloSeq.current) setMonteCarloLoading(false);
      });
  };

  const stressTestSeq = useRef(0);
  const runStressTest = (shape: string, totalChangePct: number, horizonMonths: number) => {
    if (!selectedStrategy) return;
    const seq = ++stressTestSeq.current;
    setStressTestLoading(true);
    setError(null);
    fetch(`${API_BASE}/api/stress-tests/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, startDate, endDate, config, shape, totalChangePct, horizonMonths }),
    })
      .then(readJson<StressTestResponse>)
      .then((data) => {
        if (seq !== stressTestSeq.current) return;
        setStressTest(data);
      })
      .catch((err) => {
        if (seq !== stressTestSeq.current) return;
        setError(toUiError(err));
      })
      .finally(() => {
        if (seq === stressTestSeq.current) setStressTestLoading(false);
      });
  };

  const applyOptimizedConfig = (optimizedConfig: StrategyConfigPayload | Schemas["StrategyConfig"]) => {
    setPresetMode("custom");
    setCurrentMinMultiplier(optimizedConfig.minMultiplier);
    setCurrentMaxMultiplier(optimizedConfig.maxMultiplier);
    // The optimizer payload's `params` come from the same backend
    // that produces the runtime values, so the unknown-typed entries
    // are always one of the ParamValue primitives.
    const nextParams = (optimizedConfig.params ?? {}) as Record<string, ParamValue>;
    setParams(nextParams);
    setStrategyOverrides((current) => ({
      ...current,
      [strategyType]: {
        ...current[strategyType],
        minMultiplier: optimizedConfig.minMultiplier,
        maxMultiplier: optimizedConfig.maxMultiplier,
        params: nextParams,
      },
    }));
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
  const decisionFresh = Boolean(decision && decisionContextKey === recommendationContextKey);
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
    appDefaults,
    strategyOverrides,
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
    setStrategyParam,
    result,
    optimization,
    optimizationJob,
    monteCarlo,
    monteCarloLoading,
    stressTest,
    stressTestLoading,
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
    setDefaultMinMultiplier,
    setDefaultMaxMultiplier,
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
    optimizationOutOfSync,
    optimizationRecommendedActive,
    activeOptimizationCandidateRank,
    metadataReady,
    activeAsset,
    decision,
    decisionFresh,
    recommendationContextKey,
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
    runMonteCarlo,
    runStressTest,
    applyOptimizedConfig,
    toggleComparison,
    refresh,
    retryError,
  };
}
