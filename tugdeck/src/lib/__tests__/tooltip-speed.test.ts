/**
 * tooltip-speed — one speed, scaling every kind of tip's own base delay.
 *
 * The rules that matter: an absent or unknown stored value is Standard, so a
 * user who never touches the setting sees the delays tips always had;
 * Standard leaves every base exactly as tuned; the order between the kinds
 * (chart mark < Layout place < label) holds at every speed but Instant, which
 * is zero for all of them; and the OS tooltip's base is AppKit's own default.
 */
import { describe, expect, it } from "bun:test";

import {
  NATIVE_TOOLTIP_BASE_MS,
  TOOLTIP_SPEED_FACTOR,
  nativeTooltipDelayMs,
  scaleTooltipDelay,
} from "@/lib/tooltip-speed";
import { parseTooltipSpeed, type TooltipSpeed } from "@/settings-api";

const SPEEDS: readonly TooltipSpeed[] = ["slow", "standard", "fast", "instant"];

describe("parseTooltipSpeed", () => {
  it("reads each stored speed", () => {
    for (const s of SPEEDS) expect(parseTooltipSpeed({ kind: "string", value: s })).toBe(s);
  });

  it("reads absent, unknown and mistyped values as standard", () => {
    expect(parseTooltipSpeed(undefined)).toBe("standard");
    expect(parseTooltipSpeed({ kind: "string", value: "ludicrous" })).toBe("standard");
    expect(parseTooltipSpeed({ kind: "i64", value: 0 })).toBe("standard");
  });
});

describe("scaleTooltipDelay", () => {
  it("leaves every base where it was tuned at standard", () => {
    expect(scaleTooltipDelay(900, "standard")).toBe(900);
    expect(scaleTooltipDelay(450, "standard")).toBe(450);
    expect(scaleTooltipDelay(150, "standard")).toBe(150);
  });

  it("writes the table the setting promises", () => {
    expect(SPEEDS.map((s) => scaleTooltipDelay(900, s))).toEqual([1350, 900, 450, 0]);
    expect(SPEEDS.map((s) => scaleTooltipDelay(450, s))).toEqual([675, 450, 225, 0]);
    expect(SPEEDS.map((s) => scaleTooltipDelay(150, s))).toEqual([225, 150, 75, 0]);
  });

  it("keeps the order between the kinds at every speed but instant", () => {
    for (const s of SPEEDS) {
      if (s === "instant") continue;
      expect(scaleTooltipDelay(150, s)).toBeLessThan(scaleTooltipDelay(450, s));
      expect(scaleTooltipDelay(450, s)).toBeLessThan(scaleTooltipDelay(900, s));
    }
  });

  it("orders the speeds slowest first", () => {
    const factors = SPEEDS.map((s) => TOOLTIP_SPEED_FACTOR[s]);
    expect([...factors].sort((a, b) => b - a)).toEqual(factors);
  });
});

describe("nativeTooltipDelayMs", () => {
  it("leaves the OS tooltip at AppKit's own default at standard", () => {
    expect(NATIVE_TOOLTIP_BASE_MS).toBe(1500);
    expect(nativeTooltipDelayMs("standard")).toBe(1500);
    expect(nativeTooltipDelayMs("instant")).toBe(0);
  });
});
