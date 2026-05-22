import { describe, it, expect } from "vitest";
import { pairSeries, accountDrawdown, metric, csvEscape } from "./utils";

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
    expect(accountDrawdown({ drawdownPct: -10, accountDrawdownPct: -5 })).toBe(-5);
  });

  it("falls back to drawdownPct when accountDrawdownPct is undefined", () => {
    expect(accountDrawdown({ drawdownPct: -8 })).toBe(-8);
  });

  it("falls back to drawdownPct when accountDrawdownPct is null", () => {
    expect(accountDrawdown({ drawdownPct: -3, accountDrawdownPct: null })).toBe(-3);
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
