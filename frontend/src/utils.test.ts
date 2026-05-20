import { describe, it, expect } from "vitest";

// Inline copies of utility functions from main.tsx for unit testing.
// Once B1 (split main.tsx) is done, these will import from src/utils/*.ts.

function pairSeries<T extends { date: string }>(
  events: T[] | undefined,
  valueOf: (event: T) => number | null | undefined,
) {
  if (!events) return [];
  return events.map((event) => [event.date, valueOf(event)]);
}

function accountDrawdown(event: { accountDrawdownPct?: number; drawdownPct: number }) {
  return event.accountDrawdownPct ?? event.drawdownPct;
}

function metric(value: number | null | undefined, suffix = "") {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
}

function csvEscape(value: number | string | null | undefined) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

describe("pairSeries", () => {
  it("returns empty array for undefined events", () => {
    expect(pairSeries(undefined, () => 0)).toEqual([]);
  });

  it("maps events to [date, value] tuples", () => {
    const events = [
      { date: "2024-01-01", amount: 100 },
      { date: "2024-01-08", amount: 120 },
    ];
    expect(pairSeries(events, (e) => e.amount)).toEqual([
      ["2024-01-01", 100],
      ["2024-01-08", 120],
    ]);
  });
});

describe("accountDrawdown", () => {
  it("prefers accountDrawdownPct when present", () => {
    expect(accountDrawdown({ accountDrawdownPct: -5, drawdownPct: -10 })).toBe(-5);
  });

  it("falls back to drawdownPct when accountDrawdownPct is undefined", () => {
    expect(accountDrawdown({ drawdownPct: -8 })).toBe(-8);
  });
});

describe("metric", () => {
  it("formats a number with suffix", () => {
    expect(metric(12.345, "%")).toBe("12.35%");
  });

  it("returns dash for null", () => {
    expect(metric(null)).toBe("-");
  });

  it("returns dash for undefined", () => {
    expect(metric(undefined)).toBe("-");
  });

  it("returns dash for NaN", () => {
    expect(metric(NaN)).toBe("-");
  });
});

describe("csvEscape", () => {
  it("wraps value in double quotes", () => {
    expect(csvEscape("hello")).toBe('"hello"');
  });

  it("escapes internal double quotes", () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });

  it("handles null as empty string", () => {
    expect(csvEscape(null)).toBe('""');
  });

  it("handles numbers", () => {
    expect(csvEscape(42)).toBe('"42"');
  });
});
