import type { Backtest, Contribution, Frequency, ParamValue, PresetMode, StrategyConfigPayload, StrategyDef } from "./types";
import { FREQUENCY_OPTIONS, PARAMETER_PRESETS, SETTINGS_KEY, todayIso } from "./constants";

export type ShareableSettings = {
  symbol?: string;
  strategyType?: string;
  baseAmount?: number;
  frequency?: Frequency;
  minMultiplier?: number;
  maxMultiplier?: number;
  startDate?: string;
  endDate?: string;
  params?: Record<string, ParamValue>;
  presetMode?: PresetMode;
  activeScenarioId?: string | null;
  comparisonStrategyTypes?: string[];
  riskFreeRate?: number;
  feeRate?: number;
  slippageRate?: number;
};

export type ShareableSearchSettings = Required<Pick<
  ShareableSettings,
  | "symbol"
  | "strategyType"
  | "baseAmount"
  | "frequency"
  | "minMultiplier"
  | "maxMultiplier"
  | "startDate"
  | "endDate"
  | "params"
  | "presetMode"
  | "comparisonStrategyTypes"
  | "riskFreeRate"
  | "feeRate"
  | "slippageRate"
>> & {
  activeScenarioId?: string | null;
  strategy?: StrategyDef;
};

// ─── Date helpers ────────────────────────────────────────────────────────────

export function isoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseDateInput(value: string): Date {
  const parsed = new Date(`${value}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export function yearsBefore(dateText: string, years: number): string {
  const date = parseDateInput(dateText);
  date.setFullYear(date.getFullYear() - years);
  return isoDate(date);
}

export function clampEndDate(value: string): string {
  return value > todayIso ? todayIso : value;
}

// Generalized clamp for date inputs that have a per-symbol available
// range. Used by start and end date controls so picking 1990 on a
// VOO-only symbol doesn't quietly produce a "cache doesn't cover" error.
export function clampToRange(
  value: string,
  range: { minDate: string; maxDate: string } | null | undefined,
): string {
  let result = value;
  if (range?.minDate && result < range.minDate) result = range.minDate;
  if (range?.maxDate && result > range.maxDate) result = range.maxDate;
  if (result > todayIso) result = todayIso;
  return result;
}

// ─── Frequency ───────────────────────────────────────────────────────────────

export function normalizeFrequency(value: unknown): Frequency {
  return FREQUENCY_OPTIONS.includes(value as Frequency) ? (value as Frequency) : "weekly";
}

// ─── Strategy presets ────────────────────────────────────────────────────────

export function defaultsFor(strategy?: StrategyDef): Record<string, ParamValue> {
  const params: Record<string, ParamValue> = {};
  strategy?.parameters.forEach((param) => {
    // StrategyParameter.default is `Any` on the backend → `unknown` in
    // the generated schema. The runtime values are always one of the
    // three primitives ParamValue allows; cast at this single boundary
    // so the rest of the UI sees a concrete type.
    params[param.key] = param.default as ParamValue;
  });
  return params;
}

export function presetFor(strategy: StrategyDef | undefined, mode: PresetMode) {
  const base = defaultsFor(strategy);
  if (mode === "custom") {
    return {
      minMultiplier: PARAMETER_PRESETS.balanced.minMultiplier,
      maxMultiplier: PARAMETER_PRESETS.balanced.maxMultiplier,
      params: base,
    };
  }

  const preset = PARAMETER_PRESETS[mode];
  const params = { ...base };
  if (mode === "conservative") {
    if ("maxDrawdownPct" in params) params.maxDrawdownPct = 40;
    if ("deviationPct" in params) params.deviationPct = 25;
    if ("oversold" in params) params.oversold = 25;
    if ("overbought" in params) params.overbought = 75;
    if ("smooth" in params) params.smooth = true;
  }
  if (mode === "aggressive") {
    if ("maxDrawdownPct" in params) params.maxDrawdownPct = 20;
    if ("deviationPct" in params) params.deviationPct = 10;
    if ("oversold" in params) params.oversold = 35;
    if ("overbought" in params) params.overbought = 65;
    if ("smooth" in params) params.smooth = false;
    if ("drawdownWeight" in params) params.drawdownWeight = 1.5;
    if ("maWeight" in params) params.maWeight = 1.2;
    if ("rsiWeight" in params) params.rsiWeight = 1.2;
  }
  return { minMultiplier: preset.minMultiplier, maxMultiplier: preset.maxMultiplier, params };
}

// ─── Settings persistence ────────────────────────────────────────────────────

export function readSavedSettings() {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ─── URL state ──────────────────────────────────────────────────────────────

const URL_KEYS = [
  "symbol",
  "strategy",
  "start",
  "end",
  "amount",
  "frequency",
  "min",
  "max",
  "preset",
  "scenario",
  "compare",
  "riskFree",
  "fee",
  "slippage",
];

function finiteNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function dateText(value: string | null): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  return value;
}

function parsePreset(value: string | null): PresetMode | undefined {
  return value === "conservative" || value === "balanced" || value === "aggressive" || value === "custom" ? value : undefined;
}

function parseParamValue(value: string): ParamValue {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

export function readUrlSettings(search = window.location.search): ShareableSettings | null {
  const query = new URLSearchParams(search);
  const hasUrlState = URL_KEYS.some((key) => query.has(key)) || Array.from(query.keys()).some((key) => key.startsWith("p."));
  if (!hasUrlState) return null;

  const params: Record<string, ParamValue> = {};
  query.forEach((value, key) => {
    if (key.startsWith("p.") && key.length > 2) {
      params[key.slice(2)] = parseParamValue(value);
    }
  });

  const comparisonStrategyTypes = (query.get("compare") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const frequency = normalizeFrequency(query.get("frequency"));
  const riskFreeRate = finiteNumber(query.get("riskFree"));
  const feeRate = finiteNumber(query.get("fee"));
  const slippageRate = finiteNumber(query.get("slippage"));

  return {
    symbol: query.get("symbol") || undefined,
    strategyType: query.get("strategy") || undefined,
    baseAmount: finiteNumber(query.get("amount")),
    frequency,
    minMultiplier: finiteNumber(query.get("min")),
    maxMultiplier: finiteNumber(query.get("max")),
    startDate: dateText(query.get("start")),
    endDate: dateText(query.get("end")),
    params: Object.keys(params).length > 0 ? params : undefined,
    presetMode: parsePreset(query.get("preset")),
    activeScenarioId: query.get("scenario") || null,
    comparisonStrategyTypes: comparisonStrategyTypes.length > 0 ? comparisonStrategyTypes : undefined,
    riskFreeRate,
    feeRate,
    slippageRate,
  };
}

function isDefaultValue(value: unknown, defaultValue: unknown): boolean {
  return String(value) === String(defaultValue);
}

export function buildShareableSearch(settings: ShareableSearchSettings): string {
  const query = new URLSearchParams();
  // Dates are kept even when they match defaults because they define
  // the exact backtest window. Everything else is written only when it
  // differs from the app defaults, keeping shared links readable.
  query.set("start", settings.startDate);
  query.set("end", settings.endDate);
  if (settings.symbol !== "QQQ") query.set("symbol", settings.symbol);
  if (settings.strategyType !== "composite_score") query.set("strategy", settings.strategyType);
  if (settings.baseAmount !== 100) query.set("amount", String(settings.baseAmount));
  if (settings.frequency !== "weekly") query.set("frequency", settings.frequency);
  if (settings.minMultiplier !== PARAMETER_PRESETS.balanced.minMultiplier) query.set("min", String(settings.minMultiplier));
  if (settings.maxMultiplier !== PARAMETER_PRESETS.balanced.maxMultiplier) query.set("max", String(settings.maxMultiplier));
  if (settings.presetMode !== "balanced") query.set("preset", settings.presetMode);
  if (settings.riskFreeRate !== 0.04) query.set("riskFree", String(settings.riskFreeRate));
  if (settings.feeRate !== 0) query.set("fee", String(settings.feeRate));
  if (settings.slippageRate !== 0) query.set("slippage", String(settings.slippageRate));
  if (settings.activeScenarioId) query.set("scenario", settings.activeScenarioId);
  if (settings.comparisonStrategyTypes.length > 0) query.set("compare", settings.comparisonStrategyTypes.join(","));
  const defaultParams = defaultsFor(settings.strategy);
  Object.entries(settings.params)
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([key, value]) => {
      if (key === "feeRate" || key === "slippageRate") return;
      if (key in defaultParams && isDefaultValue(value, defaultParams[key])) return;
      query.set(`p.${key}`, String(value));
    });
  return query.toString();
}

export function syncUrlSettings(settings: ShareableSearchSettings) {
  const nextSearch = buildShareableSearch(settings);
  const nextUrl = `${window.location.pathname}?${nextSearch}${window.location.hash}`;
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextUrl !== currentUrl) {
    window.history.replaceState(null, "", nextUrl);
  }
}

// ─── Formatting ──────────────────────────────────────────────────────────────

export function csvEscape(value: number | string | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export function metric(value: number | null | undefined, suffix = ""): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
}

export function currencySymbol(currency: string | null | undefined): string {
  if (currency === "CNY") return "¥";
  if (currency === "USD" || !currency) return "$";
  return `${currency} `;
}

export function strategyConfigKey(
  config: StrategyConfigPayload | { strategyType?: string; baseAmount?: number; frequency?: string; minMultiplier: number; maxMultiplier: number; params?: Record<string, unknown> | null },
): string {
  const params = Object.fromEntries(Object.entries(config.params ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify({
    strategyType: config.strategyType,
    baseAmount: config.baseAmount,
    frequency: config.frequency,
    minMultiplier: config.minMultiplier,
    maxMultiplier: config.maxMultiplier,
    params,
  });
}

// Accepts both the narrowed UI payload and the raw OpenAPI shape so
// optimization candidates (which come straight off the wire) can be
// rendered without extra type juggling.
export function describeConfig(config: StrategyConfigPayload | { strategyType?: string; minMultiplier: number; maxMultiplier: number; params?: Record<string, unknown> | null }): string {
  const params = config.params ?? {};
  const items = [
    `最低 ${config.minMultiplier}x`,
    `最高 ${config.maxMultiplier}x`,
    ...Object.entries(params).map(([key, value]) => `${key}: ${String(value)}`),
  ];
  return items.join(" · ");
}

// Accepts any object that has the two drawdown fields; narrower
// shape than Contribution so call sites in tests can pass a partial
// mock without conjuring required fields like `shares` and
// `totalShares`. Production callers pass real Contribution events.
export function accountDrawdown(event: { drawdownPct: number; accountDrawdownPct?: number | null }): number {
  // The backend's _chart_contributions populates accountDrawdownPct
  // for every event, so the fallback path is here just to defend
  // against partial mocks. Production payloads always provide the
  // explicit value.
  return event.accountDrawdownPct ?? event.drawdownPct;
}

// ─── Chart data helpers ──────────────────────────────────────────────────────

export function pairSeries<T extends { date: string }>(events: T[] | undefined, valueOf: (event: T) => number | null | undefined) {
  if (!events) return [];
  return events.map((event) => [event.date, valueOf(event)]);
}

// ─── Export ──────────────────────────────────────────────────────────────────

type ExportSeries = {
  label: string;
  events: Contribution[];
};

export function downloadText(filename: string, content: string, type = "text/csv;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function seriesLabel(raw: string): string {
  return raw.replace(/[,\r\n"]/g, " ").replace(/\s+/g, " ").trim();
}

function exportSeries(result: Backtest): ExportSeries[] {
  return [
    { label: "本策略", events: result.contributions },
    { label: "固定DCA", events: result.fixedContributions },
    { label: "一次性买入", events: result.lumpSumContributions },
    ...result.strategyComparisons.map((item) => ({ label: seriesLabel(item.name), events: item.contributions })),
  ];
}

export function buildBacktestCsv(result: Backtest): string {
  const fields = [
    ["price", "价格"],
    ["amount", "投入金额"],
    ["portfolioValue", "组合价值"],
    ["multiplier", "投入倍率"],
    ["score", "评分"],
    ["drawdownPct", "持仓回撤%"],
    ["accountDrawdownPct", "账户回撤%"],
  ] as const;
  const series = exportSeries(result);
  const header = ["date", ...series.flatMap((item) => fields.map(([, label]) => `${item.label}_${label}`))];
  const byDate = new Map<string, Record<string, number | string>>();

  series.forEach((item) => {
    item.events.forEach((event) => {
      const row = byDate.get(event.date) ?? { date: event.date };
      fields.forEach(([key, label]) => {
        row[`${item.label}_${label}`] = key === "accountDrawdownPct" ? accountDrawdown(event) : event[key];
      });
      byDate.set(event.date, row);
    });
  });

  const rows = Array.from(byDate.values())
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((row) => header.map((column) => row[column] ?? ""));
  return [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
}

export function exportBacktestCsv(result: Backtest | null) {
  if (!result) return;
  const csv = buildBacktestCsv(result);
  downloadText(`dca-backtest-${result.symbol}-${result.strategyType}-${result.recommendation.date}.csv`, csv);
}
