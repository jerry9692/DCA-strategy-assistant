import { describe, it, expect } from "vitest";
import { pairSeries, accountDrawdown, metric, csvEscape, readUrlSettings, buildShareableSearch } from "./utils";

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

describe("URL state", () => {
  it("returns null when the URL has no shareable state", () => {
    expect(readUrlSettings("?utm_source=test")).toBeNull();
  });

  it("parses shareable settings and strategy params", () => {
    const settings = readUrlSettings(
      "?symbol=SPY&strategy=ma_deviation&start=2020-01-01&end=2024-12-31&amount=250&frequency=monthly&min=0.8&max=1.2&p.maWindow=200&p.smooth=true&compare=drawdown_boost,rsi_sentiment&riskFree=0.03&fee=0.001&slippage=0.0005",
    );

    expect(settings).toMatchObject({
      symbol: "SPY",
      strategyType: "ma_deviation",
      startDate: "2020-01-01",
      endDate: "2024-12-31",
      baseAmount: 250,
      frequency: "monthly",
      minMultiplier: 0.8,
      maxMultiplier: 1.2,
      comparisonStrategyTypes: ["drawdown_boost", "rsi_sentiment"],
      riskFreeRate: 0.03,
      feeRate: 0.001,
      slippageRate: 0.0005,
      params: { maWindow: 200, smooth: true },
    });
  });

  it("omits default values from shareable query strings", () => {
    const query = buildShareableSearch({
      symbol: "QQQ",
      strategyType: "composite_score",
      baseAmount: 100,
      frequency: "weekly",
      minMultiplier: 0.8,
      maxMultiplier: 1.2,
      startDate: "2021-01-01",
      endDate: "2024-12-31",
      params: {},
      presetMode: "balanced",
      activeScenarioId: null,
      comparisonStrategyTypes: [],
      riskFreeRate: 0.04,
      feeRate: 0,
      slippageRate: 0,
    });

    expect(query).toBe("start=2021-01-01&end=2024-12-31");
  });

  it("builds a deterministic shareable query string for non-default values", () => {
    const query = buildShareableSearch({
      symbol: "QQQ",
      strategyType: "composite_score",
      baseAmount: 100,
      frequency: "weekly",
      minMultiplier: 0.8,
      maxMultiplier: 1.2,
      startDate: "2021-01-01",
      endDate: "2024-12-31",
      params: { rsiWeight: 1.2, smooth: false },
      presetMode: "custom",
      activeScenarioId: null,
      comparisonStrategyTypes: ["drawdown_boost"],
      riskFreeRate: 0.04,
      feeRate: 0,
      slippageRate: 0,
    });

    expect(query).toBe(
      "start=2021-01-01&end=2024-12-31&preset=custom&compare=drawdown_boost&p.rsiWeight=1.2&p.smooth=false",
    );
  });
});
