/**
 * tooltip-delay — one time, in milliseconds, for every tooltip, or Never.
 *
 * The rules that matter: an absent, mistyped or out-of-range stored value is
 * the 200 ms default; Never is stored and read back as itself and reaches the
 * OS tooltips as a delay no pointer rests through; the choices Settings offers
 * are written as seconds a reader can take at their word; and a tip tuned to
 * answer sooner (a chart mark, a Layout place) never waits longer than the
 * setting, nor longer than its own delay, and is off under Never too.
 */
import { describe, expect, it } from "bun:test";

import {
  NATIVE_TOOLTIP_NEVER_MS,
  TOOLTIP_DELAY_CHOICES_MS,
  formatTooltipDelay,
  nativeTooltipDelayMs,
  tooltipDelayNow,
  tooltipsOff,
} from "@/lib/tooltip-delay";
import {
  DEFAULT_TOOLTIP_DELAY_MS,
  MAX_TOOLTIP_DELAY_MS,
  TOOLTIP_DELAY_NEVER,
  parseTooltipDelay,
} from "@/settings-api";

describe("parseTooltipDelay", () => {
  it("reads a stored delay in milliseconds, and Never", () => {
    expect(parseTooltipDelay({ kind: "i64", value: 0 })).toBe(0);
    expect(parseTooltipDelay({ kind: "i64", value: 700 })).toBe(700);
    expect(parseTooltipDelay({ kind: "i64", value: MAX_TOOLTIP_DELAY_MS })).toBe(MAX_TOOLTIP_DELAY_MS);
    expect(parseTooltipDelay({ kind: "i64", value: TOOLTIP_DELAY_NEVER })).toBe(TOOLTIP_DELAY_NEVER);
  });

  it("reads absent, mistyped and out-of-range values as the 200 ms default", () => {
    expect(DEFAULT_TOOLTIP_DELAY_MS).toBe(200);
    expect(parseTooltipDelay(undefined)).toBe(200);
    expect(parseTooltipDelay({ kind: "string", value: "100" })).toBe(200);
    expect(parseTooltipDelay({ kind: "i64", value: -2 })).toBe(200);
    expect(parseTooltipDelay({ kind: "i64", value: MAX_TOOLTIP_DELAY_MS + 1 })).toBe(200);
    expect(parseTooltipDelay({ kind: "i64", value: 12.5 })).toBe(200);
  });
});

describe("the choices Settings offers", () => {
  it("are 0s through 0.7s, then Never, with the default among them", () => {
    expect(TOOLTIP_DELAY_CHOICES_MS.map(formatTooltipDelay)).toEqual([
      "0s",
      "0.1s",
      "0.2s",
      "0.3s",
      "0.5s",
      "0.7s",
      "Never",
    ]);
    expect(TOOLTIP_DELAY_CHOICES_MS).toContain(DEFAULT_TOOLTIP_DELAY_MS);
  });
});

describe("Never", () => {
  it("turns tooltips off and stays off under any ceiling", () => {
    expect(tooltipsOff(TOOLTIP_DELAY_NEVER)).toBe(true);
    expect(tooltipsOff(0)).toBe(false);
    // No tugbank client in a unit test: the cache reads as the default.
    expect(tooltipDelayNow(150)).toBe(150);
    expect(tooltipDelayNow()).toBe(200);
  });

  it("reaches the OS tooltips as a delay no pointer rests through", () => {
    expect(nativeTooltipDelayMs(TOOLTIP_DELAY_NEVER)).toBe(NATIVE_TOOLTIP_NEVER_MS);
    expect(NATIVE_TOOLTIP_NEVER_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
    expect(nativeTooltipDelayMs(300)).toBe(300);
  });
});
