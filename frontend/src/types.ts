// Type definitions for DCA Strategy Assistant.
//
// API-facing types (anything that crosses the wire to the FastAPI backend)
// are sourced from `api.generated.ts`, which is regenerated via
// `npm run generate:api` from `backend/openapi.json`. CI runs the
// generator and fails if the produced file drifts from what's checked
// in, so this layer cannot fall out of sync silently.
//
// A few API types are *narrowed* below: Pydantic's `Any` and
// `default_factory=list` show up in OpenAPI as `unknown` and
// `optional`, but the UI knows the actual runtime shape and treats
// these fields concretely. We keep the narrowed aliases here so the
// rest of the frontend doesn't need to sprinkle non-null assertions.
//
// Local-only types (UI presets, pressure scenarios, frequency literals
// used by `<select>` controls) live below the divider — they have no
// backend counterpart.

import type { components } from "./api.generated";

type Schemas = components["schemas"];

// Concrete runtime shape of the parameter values flowing between
// `<input>` controls and `StrategyConfig.params`. The backend stores
// these as Pydantic `Any` so the wire schema is `unknown`, but the UI
// only ever produces these three primitives.
export type ParamValue = string | number | boolean;

// ─── API types (sourced from generated OpenAPI) ─────────────────────────────

export type Asset = Schemas["Asset"];
export type AssetRange = Schemas["AssetRange"];
export type StrategyDef = Schemas["StrategyDefinition"];
export type Decision = Schemas["StrategyDecision"];
export type Metrics = Schemas["BacktestMetrics"];
export type MarketState = Schemas["MarketState"];
export type RollingPerformancePoint = Schemas["RollingPerformancePoint"];
export type RecommendationResponse = Schemas["RecommendationResponse"];
export type ExplanationResponse = Schemas["ExplanationResponse"];
export type LlmSettings = Schemas["LlmSettings"];
export type ChatMessage = Schemas["ChatMessage"];
export type ChatResponse = Schemas["ChatResponse"];
export type OptimizationScenarioMetric = Schemas["OptimizationScenarioMetrics"];
export type OptimizationCandidate = Schemas["OptimizationCandidate"];
export type OptimizationScenarioResult = Schemas["OptimizationScenarioResult"];
export type OptimizationResult = Schemas["OptimizationResult"];
export type OptimizationJobStatus = Schemas["OptimizationJobStatus"];
export type MonteCarloRequest = Schemas["MonteCarloRequest"];
export type MonteCarloResponse = Schemas["MonteCarloResponse"];
export type MonteCarloChartData = Schemas["MonteCarloChartData"];
export type FittedParams = Schemas["FittedParams"];
export type ScenarioStats = Schemas["ScenarioStats"];
export type StressTestRequest = Schemas["StressTestRequest"];
export type StressTestResponse = Schemas["StressTestResponse"];
export type StressTestMetrics = Schemas["StressTestMetrics"];

// `Param.default` is `Any` in the backend → `unknown` in the generated
// type. Some defaults are booleans (toggles), others are numbers
// (ranges) or strings (selects), so we leave the wide unknown here.
// ParamControl narrows at the point of use via Number/Boolean/String
// coercion based on `param.type`.
export type Param = Omit<Schemas["StrategyParameter"], "type"> & {
  type: "number" | "range" | "select" | "toggle";
};

// `StrategyConfig.params` is `dict[str, Any]` → `Record<string, unknown>`
// in OpenAPI; `Field(default_factory=dict)` makes it optional. Narrow
// to ParamValue here so the rest of the UI can pass these payloads
// through without re-asserting the value type.
export type StrategyConfigPayload = Omit<Schemas["StrategyConfig"], "params"> & {
  params?: Record<string, ParamValue>;
};

// `Contribution` matches the backend ContributionEvent. We narrow
// reasons (always populated) and accountDrawdownPct (always set on
// chart payloads).
export type Contribution = Omit<Schemas["ContributionEvent"], "reasons" | "accountDrawdownPct"> & {
  reasons: string[];
  accountDrawdownPct: number;
};

// `BacktestResult` has several `default_factory=list` fields that come
// out as optional in OpenAPI. The endpoint always populates them, so
// narrow to required for the UI.
export type StrategyComparison = Omit<Schemas["StrategyComparison"], "contributions"> & {
  contributions: Contribution[];
};

export type Backtest = Omit<
  Schemas["BacktestResult"],
  "contributions" | "fixedContributions" | "lumpSumContributions" | "strategyComparisons" | "rollingPerformance"
> & {
  contributions: Contribution[];
  fixedContributions: Contribution[];
  lumpSumContributions: Contribution[];
  strategyComparisons: StrategyComparison[];
  rollingPerformance: RollingPerformancePoint[];
};

// ─── Local-only UI types ────────────────────────────────────────────────────

export type UiError = { message: string; code?: string; retryable: boolean };

export type PresetMode = "conservative" | "balanced" | "aggressive" | "custom";

// Frequency is also part of StrategyConfig in the generated schema, but
// the literal-union form is more useful for `<select>` change handlers.
export type Frequency = "weekly" | "biweekly" | "monthly";

export type AppDefaults = {
  baseAmount: number;
  frequency: Frequency;
  minMultiplier: number;
  maxMultiplier: number;
  riskFreeRate: number;
  feeRate: number;
  slippageRate: number;
};

export type StrategyOverride = {
  minMultiplier?: number;
  maxMultiplier?: number;
  params?: Record<string, ParamValue>;
};

export type MarketCode = "us" | "cn";

export type PressureScenario = {
  id: string;
  market: MarketCode;
  name: string;
  startDate: string;
  endDate: string;
  summary: string;
};
