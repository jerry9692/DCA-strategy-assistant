import type { Backtest, Contribution, Frequency, ParamValue, PresetMode, StrategyConfigPayload, StrategyDef } from "./types";
import { FREQUENCY_OPTIONS, PARAMETER_PRESETS, SETTINGS_KEY, todayIso } from "./constants";

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

// ─── Formatting ──────────────────────────────────────────────────────────────

export function csvEscape(value: number | string | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export function metric(value: number | null | undefined, suffix = ""): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
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

export function exportBacktestCsv(result: Backtest | null) {
  if (!result) return;
  const rows = [["series", "date", "price", "amount", "portfolioValue", "multiplier", "score", "holdingDrawdownPct", "accountDrawdownPct"]];
  const append = (series: string, events: Contribution[] | undefined) => {
    if (!events) return;
    events.forEach((event) => {
      rows.push([
        series,
        event.date,
        String(event.price),
        String(event.amount),
        String(event.portfolioValue),
        String(event.multiplier),
        String(event.score),
        String(event.drawdownPct),
        String(accountDrawdown(event)),
      ]);
    });
  };
  append("strategy", result.contributions);
  append("fixed_dca", result.fixedContributions);
  append("lump_sum", result.lumpSumContributions);
  result.strategyComparisons?.forEach((item) => append(item.strategyType, item.contributions));
  const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\n");
  downloadText(`dca-backtest-${result.symbol}-${result.strategyType}-${result.recommendation.date}.csv`, csv);
}
