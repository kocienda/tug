/**
 * imposition-gap-live.test.ts — the card gap is one live number, and every
 * length derived from it follows.
 *
 * `IMPOSITION_GAP_PX` is the default's name; `impositionGapPx()` is the live
 * value a setting moves through `setImpositionGap`. The rail gutter is the gap
 * plus a fixed extra, the maker bottom gap is a fixed clearance plus the gap,
 * and the emitted CSS reads the gap by property with the default as fallback.
 * This file moves the gap and pins that each derived length — the gutter, the
 * span inset, the flow band edges, the flow strip, the bottom gaps, the
 * imposed rect — moves with it, and that the default is untouched.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_GAP,
  GAP_LABELS,
  GAP_PRESETS,
  GAP_PX,
  IMPOSITION_GAP_BOTTOM_CLEARANCE_PX,
  IMPOSITION_GAP_BOTTOM_MAKER_PX,
  IMPOSITION_GAP_BOTTOM_PROPERTY,
  IMPOSITION_GAP_PROPERTY,
  IMPOSITION_GAP_PX,
  RAIL_GUTTER_EXTRA_PX,
  RAIL_GUTTER_PROPERTY,
  RAIL_GUTTER_PX,
  flowBandEdges,
  flowStripPositions,
  imposeRect,
  imposeStyle,
  impositionGapBottomPx,
  impositionGapOf,
  impositionGapProperties,
  impositionGapPx,
  railGapBottomPx,
  railGutterPx,
  railSpanInsetPx,
  setImpositionGap,
  setImpositionGapBottom,
} from "../layout-imposer";

const CANVAS = 1659;
const RAIL = 420;
const WIDE = 20;

afterEach(() => {
  setImpositionGap(IMPOSITION_GAP_PX);
  setImpositionGapBottom(true);
});

describe("the default", () => {
  test("is roomy, and the derived constants hold today's numbers", () => {
    expect(DEFAULT_GAP).toBe("roomy");
    expect(IMPOSITION_GAP_PX).toBe(15);
    expect(impositionGapPx()).toBe(IMPOSITION_GAP_PX);
    expect(RAIL_GUTTER_PX).toBe(22);
    expect(RAIL_GUTTER_PX).toBe(IMPOSITION_GAP_PX + RAIL_GUTTER_EXTRA_PX);
    expect(IMPOSITION_GAP_BOTTOM_MAKER_PX).toBe(42);
    expect(IMPOSITION_GAP_BOTTOM_MAKER_PX).toBe(
      IMPOSITION_GAP_BOTTOM_CLEARANCE_PX + IMPOSITION_GAP_PX,
    );
    expect(railGutterPx()).toBe(RAIL_GUTTER_PX);
    expect(impositionGapBottomPx()).toBe(IMPOSITION_GAP_BOTTOM_MAKER_PX);
  });

  test("setting the same value reports no move", () => {
    expect(setImpositionGap(IMPOSITION_GAP_PX)).toBe(false);
    expect(setImpositionGap(WIDE)).toBe(true);
    expect(setImpositionGap(WIDE)).toBe(false);
  });
});

describe("the presets", () => {
  test("the default preset is today's gap, snug is the gap decks once stood at, and every preset has pixels and a label", () => {
    expect(GAP_PX[DEFAULT_GAP]).toBe(IMPOSITION_GAP_PX);
    expect(GAP_PRESETS).toContain(DEFAULT_GAP);
    expect(GAP_PX.snug).toBe(5);
    expect(GAP_PRESETS).toHaveLength(4);
    for (const preset of GAP_PRESETS) {
      expect(GAP_PX[preset]).toBeGreaterThan(0);
      expect(GAP_LABELS[preset]).toMatch(/^[A-Z][a-z]+$/);
    }
  });

  test("the presets ascend, so the picker reads tight to airy", () => {
    for (let i = 1; i < GAP_PRESETS.length; i += 1) {
      expect(GAP_PX[GAP_PRESETS[i]]).toBeGreaterThan(GAP_PX[GAP_PRESETS[i - 1]]);
    }
  });

  test("an imposition with no gap reads as the default", () => {
    expect(impositionGapOf({ sidebars: {} })).toBe(DEFAULT_GAP);
    expect(impositionGapOf({ sidebars: {}, gap: "airy" })).toBe("airy");
  });
});

describe("a moved gap", () => {
  test("moves the gutter by the same amount and keeps it wider than a gap", () => {
    setImpositionGap(WIDE);
    expect(railGutterPx()).toBe(WIDE + RAIL_GUTTER_EXTRA_PX);
    expect(railGutterPx()).toBeGreaterThan(impositionGapPx());
  });

  test("moves the rail span inset by the gutter's extra only", () => {
    const before = railSpanInsetPx(RAIL);
    setImpositionGap(WIDE);
    // `edge inset + width + gutter − gap` — the gap cancels against the
    // gutter's gap term, so the inset is the width plus the fixed extra at
    // every setting.
    expect(railSpanInsetPx(RAIL)).toBe(before);
    expect(railSpanInsetPx(RAIL)).toBe(RAIL + RAIL_GUTTER_EXTRA_PX);
  });

  test("moves the flow band's edges in by the gap", () => {
    setImpositionGap(WIDE);
    expect(flowBandEdges(CANVAS, {})).toEqual({
      start: WIDE,
      end: CANVAS - WIDE,
    });
    expect(flowBandEdges(CANVAS, { left: RAIL })).toEqual({
      start: railSpanInsetPx(RAIL) + WIDE,
      end: CANVAS - WIDE,
    });
  });

  test("spaces the flow strip by the gap", () => {
    setImpositionGap(WIDE);
    const strip = flowStripPositions([
      { slot: 0, width: 400 },
      { slot: 1, width: 300 },
      { slot: 2, width: 200 },
    ]);
    expect(strip.positions.get(0)).toBe(0);
    expect(strip.positions.get(1)).toBe(400 + WIDE);
    expect(strip.positions.get(2)).toBe(400 + WIDE + 300 + WIDE);
    expect(strip.width).toBe(400 + WIDE + 300 + WIDE + 200);
  });

  test("keeps one gap of air above the maker strip, and none on release", () => {
    setImpositionGap(WIDE);
    expect(impositionGapBottomPx()).toBe(IMPOSITION_GAP_BOTTOM_CLEARANCE_PX + WIDE);
    expect(railGapBottomPx()).toBe(IMPOSITION_GAP_BOTTOM_CLEARANCE_PX);
    setImpositionGapBottom(false);
    expect(impositionGapBottomPx()).toBe(WIDE);
    expect(railGapBottomPx()).toBe(0);
  });

  test("places an imposed rect one gap in from each edge", () => {
    setImpositionGap(WIDE);
    const span = { x: 0, width: CANVAS, height: 900 };
    // Slot 0 of three has no travel, so its x is the gap alone.
    const rect = imposeRect({ slot: 0, count: 3 }, 600, span);
    expect(rect.position.x).toBe(WIDE);
    expect(rect.position.y).toBe(WIDE);
    expect(rect.size.height).toBe(900 - WIDE - impositionGapBottomPx());
  });
});

describe("the CSS twin", () => {
  test("every emitted length reads the gap by property with the default as fallback", () => {
    const style = imposeStyle({ slot: 0, count: 3 }, 600);
    const gap = `var(${IMPOSITION_GAP_PROPERTY}, ${IMPOSITION_GAP_PX}px)`;
    expect(style.top).toBe(gap);
    expect(String(style.left)).toContain(gap);
    // The only literal gap left is the fallback inside a `var()`; none
    // stands bare as a term of its own.
    expect(String(style.left)).not.toMatch(new RegExp(`[+-] ${IMPOSITION_GAP_PX}px`));
  });

  test("the three properties stamp together from the live value", () => {
    setImpositionGap(WIDE);
    expect(impositionGapProperties()).toEqual([
      [IMPOSITION_GAP_PROPERTY, `${WIDE}px`],
      [RAIL_GUTTER_PROPERTY, `${WIDE + RAIL_GUTTER_EXTRA_PX}px`],
      [
        IMPOSITION_GAP_BOTTOM_PROPERTY,
        `${IMPOSITION_GAP_BOTTOM_CLEARANCE_PX + WIDE}px`,
      ],
    ]);
  });
});
