/**
 * Pure-logic tests for the session telemetry formatters. The
 * renderer components that display them render React nodes and are
 * exercised through the real-app harness; here we pin the
 * deterministic value-formatting helpers so future tuning can
 * change them deliberately.
 */

import { describe, expect, it } from "bun:test";

import {
  formatDurationMs,
  formatTimeMinutesSeconds,
  formatTokenCap,
  formatTokens,
  formatUsd,
} from "@/lib/session-telemetry-format";

describe("formatTokens", () => {
  it("returns an integer string under 1k", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1)).toBe("1");
    expect(formatTokens(999)).toBe("999");
  });

  it("collapses thousands to one decimal `Nk`", () => {
    expect(formatTokens(1_000)).toBe("1.0k");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(999_999)).toBe("1000.0k");
  });

  it("collapses millions to two decimals `N.NNM`", () => {
    expect(formatTokens(1_000_000)).toBe("1.00M");
    expect(formatTokens(1_234_567)).toBe("1.23M");
  });

  it("guards against NaN / negatives", () => {
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(-1)).toBe("0");
  });
});

describe("formatTokenCap", () => {
  it("drops the decimals a round ceiling never needs", () => {
    // The whole point: a context window is a number the model shipped with, so
    // its tenths and hundredths are always zeros. `200.0K` and `1.00M` spend
    // four characters of a status row that has none to spare saying nothing.
    expect(formatTokenCap(200_000)).toBe("200K");
    expect(formatTokenCap(1_000_000)).toBe("1M");
    expect(formatTokenCap(128_000)).toBe("128K");
  });

  it("keeps a fraction that is real", () => {
    // Only the trailing zeros go. A cap that genuinely falls between the round
    // numbers still reads as itself.
    expect(formatTokenCap(1_500_000)).toBe("1.5M");
    expect(formatTokenCap(1_048_576)).toBe("1M");
    expect(formatTokenCap(32_768)).toBe("32.8K");
  });

  it("returns an integer string under 1k", () => {
    expect(formatTokenCap(0)).toBe("0");
    expect(formatTokenCap(999)).toBe("999");
  });

  it("guards against NaN / negatives", () => {
    expect(formatTokenCap(Number.NaN)).toBe("0");
    expect(formatTokenCap(-1)).toBe("0");
  });
});

describe("formatDurationMs", () => {
  it("renders sub-second as `Nms`", () => {
    expect(formatDurationMs(0)).toBe("0ms");
    expect(formatDurationMs(250)).toBe("250ms");
  });

  it("renders sub-10s as `N.Ds`", () => {
    expect(formatDurationMs(1_000)).toBe("1.0s");
    expect(formatDurationMs(2_500)).toBe("2.5s");
    expect(formatDurationMs(9_900)).toBe("9.9s");
  });

  it("renders 10s..1m as whole seconds", () => {
    expect(formatDurationMs(10_000)).toBe("10s");
    expect(formatDurationMs(59_499)).toBe("59s");
  });

  it("renders minutes as `Nm SSs` with zero-padded seconds", () => {
    expect(formatDurationMs(60_000)).toBe("1m 00s");
    expect(formatDurationMs(125_500)).toBe("2m 05s");
  });

  it("renders hours as `Nh MMm` with zero-padded minutes", () => {
    expect(formatDurationMs(3_600_000)).toBe("1h 00m");
    expect(formatDurationMs(3_660_000)).toBe("1h 01m");
    expect(formatDurationMs(7_320_000)).toBe("2h 02m");
  });

  it("guards against NaN / negatives", () => {
    expect(formatDurationMs(Number.NaN)).toBe("0s");
    expect(formatDurationMs(-1)).toBe("0s");
  });
});

describe("formatTimeMinutesSeconds", () => {
  it("renders sub-hour spans as `Mm SSs`", () => {
    expect(formatTimeMinutesSeconds(0)).toBe("0m 00s");
    expect(formatTimeMinutesSeconds(7_000)).toBe("0m 07s");
    expect(formatTimeMinutesSeconds(65_000)).toBe("1m 05s");
    expect(formatTimeMinutesSeconds(599_000)).toBe("9m 59s");
  });

  it("surfaces hours once a span crosses the hour mark, with zero-padded minutes", () => {
    expect(formatTimeMinutesSeconds(3_600_000)).toBe("1h 00m 00s");
    expect(formatTimeMinutesSeconds(3_667_000)).toBe("1h 01m 07s");
    expect(formatTimeMinutesSeconds(9_000_000)).toBe("2h 30m 00s");
  });

  it("guards against NaN / negatives", () => {
    expect(formatTimeMinutesSeconds(Number.NaN)).toBe("0m 00s");
    expect(formatTimeMinutesSeconds(-1)).toBe("0m 00s");
  });
});

describe("formatUsd", () => {
  it("renders sub-dollar with 4 decimals", () => {
    expect(formatUsd(0)).toBe("$0.0000");
    expect(formatUsd(0.0012)).toBe("$0.0012");
    expect(formatUsd(0.9999)).toBe("$0.9999");
  });

  it("renders ≥ $1 with 2 decimals", () => {
    expect(formatUsd(1)).toBe("$1.00");
    expect(formatUsd(12.345)).toBe("$12.35");
  });

  it("guards against NaN / negatives", () => {
    expect(formatUsd(Number.NaN)).toBe("$0");
    expect(formatUsd(-1)).toBe("$0");
  });
});
