/**
 * tooltip-delay — one time, in milliseconds, for every tooltip.
 *
 * The rules that matter: an absent, mistyped or out-of-range stored value is
 * the 900 ms a label tooltip has always waited; the choices Settings offers
 * are written as seconds a reader can take at their word; and a tip tuned to
 * answer sooner (a chart mark, a Layout place) never waits longer than the
 * setting, nor longer than its own delay.
 */
import { describe, expect, it } from "bun:test";

import { TOOLTIP_DELAY_CHOICES_MS, formatTooltipDelay } from "@/lib/tooltip-delay";
import { DEFAULT_TOOLTIP_DELAY_MS, MAX_TOOLTIP_DELAY_MS, parseTooltipDelay } from "@/settings-api";

describe("parseTooltipDelay", () => {
  it("reads a stored delay in milliseconds", () => {
    expect(parseTooltipDelay({ kind: "i64", value: 0 })).toBe(0);
    expect(parseTooltipDelay({ kind: "i64", value: 300 })).toBe(300);
    expect(parseTooltipDelay({ kind: "i64", value: MAX_TOOLTIP_DELAY_MS })).toBe(MAX_TOOLTIP_DELAY_MS);
  });

  it("reads absent, mistyped and out-of-range values as the default", () => {
    expect(DEFAULT_TOOLTIP_DELAY_MS).toBe(900);
    expect(parseTooltipDelay(undefined)).toBe(900);
    expect(parseTooltipDelay({ kind: "string", value: "300" })).toBe(900);
    expect(parseTooltipDelay({ kind: "i64", value: -1 })).toBe(900);
    expect(parseTooltipDelay({ kind: "i64", value: MAX_TOOLTIP_DELAY_MS + 1 })).toBe(900);
    expect(parseTooltipDelay({ kind: "i64", value: 12.5 })).toBe(900);
  });
});

describe("the choices Settings offers", () => {
  it("include the default and run shortest first", () => {
    expect(TOOLTIP_DELAY_CHOICES_MS).toContain(DEFAULT_TOOLTIP_DELAY_MS);
    expect([...TOOLTIP_DELAY_CHOICES_MS].sort((a, b) => a - b)).toEqual([...TOOLTIP_DELAY_CHOICES_MS]);
  });

  it("are written as seconds", () => {
    expect(TOOLTIP_DELAY_CHOICES_MS.map(formatTooltipDelay)).toEqual(["0 s", "0.3 s", "0.6 s", "0.9 s", "1.5 s"]);
    expect(formatTooltipDelay(1250)).toBe("1.25 s");
  });
});
