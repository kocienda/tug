/**
 * Tests for tug-format — TugFormatter interface and TugNumberFormatter.
 *
 * Covers:
 * - Decimal style — formatting, grouping, custom decimals, round-trip
 * - Integer style — rounding, no fractional digits, round-trip
 * - Percent style — 0-1 input range, ×100 display, round-trip, edge cases
 * - Compact style — K/M/B/T suffix formatting and parsing
 * - Currency style — symbol handling, grouping strip, round-trip
 * - Unit style — Intl unit formatting and parsing
 * - Custom style — prefix/suffix, round-trip
 * - Edge cases — NaN, Infinity, negative, zero, empty/whitespace parse
 * - Round-trip property — parse(format(value)) returns original value
 */
import { describe, it, expect } from "bun:test";
import { createNumberFormatter } from "../lib/tug-format";
import type { TugFormatter } from "../lib/tug-format";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert parse(format(value)) returns the original value within tolerance. */
function assertRoundTrip(
  fmt: TugFormatter<number>,
  value: number,
  tolerance = 1e-9,
): void {
  const formatted = fmt.format(value);
  const parsed = fmt.parse(formatted);
  expect(parsed).not.toBeNull();
  expect(Math.abs((parsed as number) - value)).toBeLessThanOrEqual(tolerance);
}

// ---------------------------------------------------------------------------
// 1. Decimal style
// ---------------------------------------------------------------------------

describe("decimal style", () => {
  const fmt = createNumberFormatter();

  it("formats with grouping separator", () => {
    expect(fmt.format(1234.5)).toBe("1,234.5");
  });

  it("formats zero", () => {
    expect(fmt.format(0)).toBe("0");
  });

  it("formats negative numbers", () => {
    expect(fmt.format(-1234.5)).toBe("-1,234.5");
  });

  it("formats large numbers", () => {
    expect(fmt.format(1000000)).toBe("1,000,000");
  });

  it("parses grouping separator correctly", () => {
    expect(fmt.parse("1,234.5")).toBe(1234.5);
  });

  it("parses plain number string", () => {
    expect(fmt.parse("42")).toBe(42);
  });

  it("parses negative number string", () => {
    expect(fmt.parse("-1,234.5")).toBe(-1234.5);
  });

  it("respects custom decimals option", () => {
    const f = createNumberFormatter({ decimals: 2 });
    expect(f.format(1.5)).toBe("1.50");
    expect(f.format(1234.567)).toBe("1,234.57");
  });

  it("respects minDecimals option", () => {
    const f = createNumberFormatter({ decimals: 3, minDecimals: 2 });
    expect(f.format(1.5)).toBe("1.50");
    expect(f.format(1.567)).toBe("1.567");
  });

  it("respects grouping: false", () => {
    const f = createNumberFormatter({ grouping: false });
    expect(f.format(1234567)).toBe("1234567");
  });

  it("round-trips 1234.5", () => assertRoundTrip(fmt, 1234.5));
  it("round-trips 0", () => assertRoundTrip(fmt, 0));
  it("round-trips -999.99", () => assertRoundTrip(fmt, -999.99));
});

// ---------------------------------------------------------------------------
// 2. Integer style
// ---------------------------------------------------------------------------

describe("integer style", () => {
  const fmt = createNumberFormatter({ style: "integer" });

  it("rounds up correctly", () => {
    expect(fmt.format(1234.7)).toBe("1,235");
  });

  it("rounds down correctly", () => {
    expect(fmt.format(1234.4)).toBe("1,234");
  });

  it("formats whole numbers without decimals", () => {
    expect(fmt.format(1234)).toBe("1,234");
  });

  it("formats zero", () => {
    expect(fmt.format(0)).toBe("0");
  });

  it("formats negative", () => {
    expect(fmt.format(-1234.7)).toBe("-1,235");
  });

  it("parses integer string", () => {
    expect(fmt.parse("1,235")).toBe(1235);
  });

  it("parses string without grouping", () => {
    expect(fmt.parse("1235")).toBe(1235);
  });

  it("round-trips 1235", () => assertRoundTrip(fmt, 1235));
  it("round-trips 0", () => assertRoundTrip(fmt, 0));
  it("round-trips -42", () => assertRoundTrip(fmt, -42));
});

// ---------------------------------------------------------------------------
// 3. Percent style
// ---------------------------------------------------------------------------

describe("percent style", () => {
  const fmt = createNumberFormatter({ style: "percent" });

  it("formats 0.75 as 75%", () => {
    expect(fmt.format(0.75)).toBe("75%");
  });

  it("formats 0 as 0%", () => {
    expect(fmt.format(0)).toBe("0%");
  });

  it("formats 1 as 100%", () => {
    expect(fmt.format(1)).toBe("100%");
  });

  it("formats values > 1 correctly", () => {
    expect(fmt.format(1.5)).toBe("150%");
  });

  it("formats 0.5 as 50%", () => {
    expect(fmt.format(0.5)).toBe("50%");
  });

  it("parses '75%' to 0.75", () => {
    expect(fmt.parse("75%")).toBeCloseTo(0.75, 10);
  });

  it("parses '0%' to 0", () => {
    expect(fmt.parse("0%")).toBe(0);
  });

  it("parses '100%' to 1", () => {
    expect(fmt.parse("100%")).toBeCloseTo(1, 10);
  });

  it("parses '150%' to 1.5", () => {
    expect(fmt.parse("150%")).toBeCloseTo(1.5, 10);
  });

  it("parses '50%' to 0.5", () => {
    expect(fmt.parse("50%")).toBeCloseTo(0.5, 10);
  });

  it("round-trips 0.75", () => assertRoundTrip(fmt, 0.75, 1e-10));
  it("round-trips 0", () => assertRoundTrip(fmt, 0, 1e-10));
  it("round-trips 1", () => assertRoundTrip(fmt, 1, 1e-10));
  it("round-trips 0.12 (within default 0-decimal precision)", () => assertRoundTrip(fmt, 0.12, 1e-3));
});

// ---------------------------------------------------------------------------
// 4. Compact style
// ---------------------------------------------------------------------------

describe("compact style", () => {
  it("formats thousands as K", () => {
    const fmt = createNumberFormatter({ style: "compact" });
    const result = fmt.format(1200);
    // Intl compact for en-US: "1.2K"
    expect(result).toMatch(/1[.,]?2K?/i);
    expect(result.toLowerCase()).toContain("k");
  });

  it("formats millions as M", () => {
    const fmt = createNumberFormatter({ style: "compact", decimals: 2 });
    const result = fmt.format(1230000);
    expect(result.toLowerCase()).toContain("m");
    expect(result).toMatch(/1[.,]?2[0-9]*M/i);
  });

  it("formats billions as B", () => {
    const fmt = createNumberFormatter({ style: "compact", decimals: 2 });
    const result = fmt.format(5400000000);
    expect(result.toLowerCase()).toContain("b");
  });

  it("formats trillions as T", () => {
    const fmt = createNumberFormatter({ style: "compact" });
    const result = fmt.format(1e12);
    expect(result.toLowerCase()).toContain("t");
  });

  it("parses K suffix to thousands", () => {
    const fmt = createNumberFormatter({ style: "compact" });
    const result = fmt.parse("1.2K");
    expect(result).not.toBeNull();
    expect(result as number).toBeCloseTo(1200, 0);
  });

  it("parses M suffix to millions", () => {
    const fmt = createNumberFormatter({ style: "compact" });
    const result = fmt.parse("1.23M");
    expect(result).not.toBeNull();
    expect(result as number).toBeCloseTo(1230000, 0);
  });

  it("parses B suffix to billions", () => {
    const fmt = createNumberFormatter({ style: "compact" });
    const result = fmt.parse("5.4B");
    expect(result).not.toBeNull();
    expect(result as number).toBeCloseTo(5400000000, 0);
  });

  it("parses T suffix to trillions", () => {
    const fmt = createNumberFormatter({ style: "compact" });
    const result = fmt.parse("1T");
    expect(result).not.toBeNull();
    expect(result as number).toBeCloseTo(1e12, 0);
  });

  it("parses lowercase suffix (case-insensitive)", () => {
    const fmt = createNumberFormatter({ style: "compact" });
    expect(fmt.parse("1.5m")).toBeCloseTo(1500000, 0);
    expect(fmt.parse("2.3k")).toBeCloseTo(2300, 0);
  });

  it("parses number without suffix as raw value", () => {
    const fmt = createNumberFormatter({ style: "compact" });
    expect(fmt.parse("42")).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// 5. Currency style
// ---------------------------------------------------------------------------

describe("currency style", () => {
  const fmt = createNumberFormatter({ style: "currency", currency: "USD" });

  it("formats 42 as $42.00", () => {
    expect(fmt.format(42)).toBe("$42.00");
  });

  it("formats 1234.5 with grouping", () => {
    expect(fmt.format(1234.5)).toBe("$1,234.50");
  });

  it("formats 0 as $0.00", () => {
    expect(fmt.format(0)).toBe("$0.00");
  });

  it("formats negative values", () => {
    const result = fmt.format(-42);
    // Negative currency may use -$42.00 or ($42.00) depending on locale/version
    expect(result).toContain("42.00");
  });

  it("parses '$42.00' to 42", () => {
    expect(fmt.parse("$42.00")).toBeCloseTo(42, 5);
  });

  it("parses '$1,234.50' to 1234.5", () => {
    expect(fmt.parse("$1,234.50")).toBeCloseTo(1234.5, 5);
  });

  it("parses '$0.00' to 0", () => {
    expect(fmt.parse("$0.00")).toBe(0);
  });

  it("round-trips 42", () => assertRoundTrip(fmt, 42, 1e-5));
  it("round-trips 1234.5", () => assertRoundTrip(fmt, 1234.5, 1e-5));
  it("round-trips 0", () => assertRoundTrip(fmt, 0, 1e-5));
});

// ---------------------------------------------------------------------------
// 6. Unit style
// ---------------------------------------------------------------------------

describe("unit style", () => {
  it("formats seconds with short display", () => {
    const fmt = createNumberFormatter({ style: "unit", unit: "second", decimals: 1 });
    const result = fmt.format(2.5);
    expect(result).toContain("2.5");
    expect(result.toLowerCase()).toMatch(/s|sec/);
  });

  it("formats gigabytes", () => {
    const fmt = createNumberFormatter({ style: "unit", unit: "gigabyte", decimals: 1 });
    const result = fmt.format(5.4);
    expect(result).toContain("5.4");
    expect(result.toLowerCase()).toMatch(/gb|gigabyte/);
  });

  it("parses seconds back to number", () => {
    const fmt = createNumberFormatter({ style: "unit", unit: "second", decimals: 1 });
    const formatted = fmt.format(2.5);
    const parsed = fmt.parse(formatted);
    expect(parsed).toBeCloseTo(2.5, 5);
  });

  it("parses gigabytes back to number", () => {
    const fmt = createNumberFormatter({ style: "unit", unit: "gigabyte", decimals: 1 });
    const formatted = fmt.format(5.4);
    const parsed = fmt.parse(formatted);
    expect(parsed).toBeCloseTo(5.4, 5);
  });

  it("round-trips 2.5 seconds", () => {
    const fmt = createNumberFormatter({ style: "unit", unit: "second", decimals: 1 });
    assertRoundTrip(fmt, 2.5, 1e-5);
  });

  it("round-trips 5.4 gigabytes", () => {
    const fmt = createNumberFormatter({ style: "unit", unit: "gigabyte", decimals: 1 });
    assertRoundTrip(fmt, 5.4, 1e-5);
  });
});

// ---------------------------------------------------------------------------
// 7. Custom style
// ---------------------------------------------------------------------------

describe("custom style", () => {
  it("appends suffix", () => {
    const fmt = createNumberFormatter({ style: "custom", suffix: " pts" });
    expect(fmt.format(1234)).toBe("1,234 pts");
  });

  it("prepends prefix", () => {
    const fmt = createNumberFormatter({ style: "custom", prefix: "~" });
    expect(fmt.format(42)).toBe("~42");
  });

  it("uses both prefix and suffix", () => {
    const fmt = createNumberFormatter({ style: "custom", prefix: "[", suffix: "]" });
    expect(fmt.format(100)).toBe("[100]");
  });

  it("formats zero with suffix", () => {
    const fmt = createNumberFormatter({ style: "custom", suffix: " pts" });
    expect(fmt.format(0)).toBe("0 pts");
  });

  it("parses suffix-only format", () => {
    const fmt = createNumberFormatter({ style: "custom", suffix: " pts" });
    expect(fmt.parse("1,234 pts")).toBe(1234);
  });

  it("parses prefix-only format", () => {
    const fmt = createNumberFormatter({ style: "custom", prefix: "~" });
    expect(fmt.parse("~42")).toBe(42);
  });

  it("parses both prefix and suffix", () => {
    const fmt = createNumberFormatter({ style: "custom", prefix: "[", suffix: "]" });
    expect(fmt.parse("[100]")).toBe(100);
  });

  it("round-trips 1234 with suffix", () => {
    const fmt = createNumberFormatter({ style: "custom", suffix: " pts" });
    assertRoundTrip(fmt, 1234);
  });

  it("round-trips 0 with prefix and suffix", () => {
    const fmt = createNumberFormatter({ style: "custom", prefix: "~", suffix: "x" });
    assertRoundTrip(fmt, 0);
  });
});

// ---------------------------------------------------------------------------
// 8. Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  const fmt = createNumberFormatter();

  it("format(NaN) returns empty string", () => {
    expect(fmt.format(NaN)).toBe("");
  });

  it("format(Infinity) returns empty string", () => {
    expect(fmt.format(Infinity)).toBe("");
  });

  it("format(-Infinity) returns empty string", () => {
    expect(fmt.format(-Infinity)).toBe("");
  });

  it("parse('') returns null", () => {
    expect(fmt.parse("")).toBeNull();
  });

  it("parse('   ') returns null", () => {
    expect(fmt.parse("   ")).toBeNull();
  });

  it("parse non-numeric string returns null", () => {
    expect(fmt.parse("abc")).toBeNull();
  });

  it("formats negative numbers", () => {
    expect(fmt.format(-42)).toBe("-42");
  });

  it("parses negative numbers", () => {
    expect(fmt.parse("-42")).toBe(-42);
  });

  it("formats zero", () => {
    expect(fmt.format(0)).toBe("0");
  });

  it("parses '0' to 0", () => {
    expect(fmt.parse("0")).toBe(0);
  });

  it("handles very large numbers", () => {
    const result = fmt.format(1e15);
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });

  it("returns frozen object", () => {
    expect(Object.isFrozen(fmt)).toBe(true);
  });

  it("percent: parse('') returns null", () => {
    const pct = createNumberFormatter({ style: "percent" });
    expect(pct.parse("")).toBeNull();
  });

  it("percent: parse non-numeric returns null", () => {
    const pct = createNumberFormatter({ style: "percent" });
    expect(pct.parse("xyz%")).toBeNull();
  });

  it("compact: parse empty string returns null", () => {
    const compact = createNumberFormatter({ style: "compact" });
    expect(compact.parse("")).toBeNull();
  });

  it("currency: parse empty string returns null", () => {
    const usd = createNumberFormatter({ style: "currency", currency: "USD" });
    expect(usd.parse("")).toBeNull();
  });

  it("unit: parse empty string returns null", () => {
    const unit = createNumberFormatter({ style: "unit", unit: "second" });
    expect(unit.parse("")).toBeNull();
  });

  it("custom: parse empty string returns null", () => {
    const custom = createNumberFormatter({ style: "custom", suffix: " pts" });
    expect(custom.parse("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 9. Round-trip property — each style
// ---------------------------------------------------------------------------

describe("round-trip property", () => {
  it("decimal: multiple values", () => {
    const fmt = createNumberFormatter({ decimals: 2 });
    for (const v of [0, 1, -1, 1234.56, -999.99, 0.01]) {
      assertRoundTrip(fmt, v, 1e-5);
    }
  });

  it("integer: multiple values", () => {
    const fmt = createNumberFormatter({ style: "integer" });
    for (const v of [0, 1, -1, 1234, -999, 1000000]) {
      assertRoundTrip(fmt, v);
    }
  });

  it("percent: values in 0-1 range", () => {
    const fmt = createNumberFormatter({ style: "percent" });
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      assertRoundTrip(fmt, v, 1e-3);
    }
  });

  it("currency: common values", () => {
    const fmt = createNumberFormatter({ style: "currency", currency: "USD" });
    for (const v of [0, 1, 42, 1234.5]) {
      assertRoundTrip(fmt, v, 1e-5);
    }
  });

  it("custom: with suffix", () => {
    const fmt = createNumberFormatter({ style: "custom", suffix: " dB" });
    for (const v of [0, 1, 100, 1234]) {
      assertRoundTrip(fmt, v);
    }
  });
});
