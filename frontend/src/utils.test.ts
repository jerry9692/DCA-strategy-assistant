import { describe, it, expect } from "vitest";
import {
  pairSeries,
  accountDrawdown,
  metric,
  currencySymbol,
  strategyConfigKey,
  csvEscape,
  buildBacktestCsv,
  withUtf8Bom,
  readUrlSettings,
  buildShareableSearch,
} from "./utils";
import type { Backtest, Contribution } from "./types";

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

describe("currencySymbol", () => {
  it("formats supported asset currencies", () => {
    expect(currencySymbol("USD")).toBe("$");
    expect(currencySymbol("CNY")).toBe("¥");
  });

  it("falls back to an ISO-code prefix for unknown currencies", () => {
    expect(currencySymbol("HKD")).toBe("HKD ");
  });
});

describe("strategyConfigKey", () => {
  it("is stable when params are ordered differently", () => {
    const first = strategyConfigKey({
      strategyType: "composite_score",
      baseAmount: 100,
      frequency: "weekly",
      minMultiplier: 0.8,
      maxMultiplier: 1.2,
      params: { rsiWeight: 1.2, drawdownWeight: 2 },
    });
    const second = strategyConfigKey({
      strategyType: "composite_score",
      baseAmount: 100,
      frequency: "weekly",
      minMultiplier: 0.8,
      maxMultiplier: 1.2,
      params: { drawdownWeight: 2, rsiWeight: 1.2 },
    });

    expect(first).toBe(second);
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

function contribution(partial: Partial<Contribution> & Pick<Contribution, "date">): Contribution {
  return {
    date: partial.date,
    price: partial.price ?? 100,
    amount: partial.amount ?? 100,
    shares: partial.shares ?? 1,
    totalShares: partial.totalShares ?? 1,
    totalInvested: partial.totalInvested ?? 100,
    portfolioValue: partial.portfolioValue ?? 100,
    multiplier: partial.multiplier ?? 1,
    score: partial.score ?? 0.5,
    reasons: partial.reasons ?? [],
    drawdownPct: partial.drawdownPct ?? 0,
    accountDrawdownPct: partial.accountDrawdownPct ?? 0,
  };
}

describe("buildBacktestCsv", () => {
  it("exports a wide table keyed by date", () => {
    const result = {
      symbol: "QQQ",
      strategyType: "composite_score",
      recommendation: { date: "2024-01-08" },
      contributions: [
        contribution({ date: "2024-01-01", amount: 80, portfolioValue: 80, accountDrawdownPct: 0 }),
        contribution({ date: "2024-01-08", amount: 120, portfolioValue: 205, accountDrawdownPct: -2 }),
      ],
      fixedContributions: [contribution({ date: "2024-01-01", amount: 100, portfolioValue: 100 })],
      lumpSumContributions: [contribution({ date: "2024-01-01", amount: 200, portfolioValue: 200 })],
      strategyComparisons: [
        {
          strategyType: "ma_deviation",
          name: "均线,偏离",
          metrics: {},
          contributions: [contribution({ date: "2024-01-08", amount: 90, portfolioValue: 190 })],
        },
      ],
    } as unknown as Backtest;

    const csv = buildBacktestCsv(result);
    const lines = csv.split("\n");

    expect(lines[0]).toContain('"本策略_投入金额"');
    expect(lines[0]).toContain('"固定DCA_组合价值"');
    expect(lines[0]).toContain('"均线 偏离_投入金额"');
    expect(lines[1]).toContain('"2024-01-01"');
    expect(lines[1]).toContain('"80"');
    expect(lines[2]).toContain('"2024-01-08"');
    expect(lines[2]).toContain('"120"');
    expect(lines[2]).toContain('"-2"');
  });

  it("uses Windows-friendly CRLF line endings", () => {
    const result = {
      symbol: "QQQ",
      strategyType: "composite_score",
      recommendation: { date: "2024-01-01" },
      contributions: [contribution({ date: "2024-01-01" })],
      fixedContributions: [],
      lumpSumContributions: [],
      strategyComparisons: [],
    } as unknown as Backtest;

    expect(buildBacktestCsv(result)).toContain("\r\n");
  });
});

describe("withUtf8Bom", () => {
  it("prepends a UTF-8 BOM for Excel", () => {
    expect(withUtf8Bom('"date","本策略_投入金额"')).toBe('\uFEFF"date","本策略_投入金额"');
  });

  it("does not duplicate an existing BOM", () => {
    expect(withUtf8Bom('\uFEFF"date"')).toBe('\uFEFF"date"');
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
