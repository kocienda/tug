/**
 * A clamp that reads a canvas box of no area refuses instead of clamping
 * ([B03] of the sheet-shade-placement brief).
 *
 * The defect this guards is one that went quietly wrong rather than loudly: a
 * `display: contents` workspace wrapper generates no box, so a lookup that
 * landed on one answered a rect of zeros, and the sheet clamps computed a
 * downward floor and an upward ceiling from the VIEWPORT ORIGIN. Both wrote a
 * cap. The panel they capped was standing hundreds of pixels away, and nothing
 * in the arithmetic could tell — `Math.min(0, innerHeight)` is a number like
 * any other.
 *
 * `visibleCanvasBand` is where that class of reading is refused now, and it is
 * the whole of the arithmetic both clamps share, factored to take a box so it
 * can be asked these questions without a DOM. What the clamps add on top of it
 * — the shortfall, the floor, the ceiling — is geometry over a band that is
 * known good by the time it runs.
 *
 * The behavioral half is `at0558-sheet-visibility.test.ts`, which drives the
 * real sheet against the real canvas.
 */

import { describe, expect, test } from "bun:test";

import { visibleCanvasBand } from "@/components/chrome/space-layer";

/** A box in the shape `getBoundingClientRect` returns one. */
function box(top: number, bottom: number, width = 1200): {
  top: number;
  bottom: number;
  width: number;
  height: number;
} {
  return { top, bottom, width, height: bottom - top };
}

describe("visibleCanvasBand", () => {
  test("an ordinary canvas inside the window is its own band", () => {
    expect(visibleCanvasBand(box(0, 900), 1000)).toEqual({ top: 0, bottom: 900 });
  });

  test("a canvas taller than the window is clipped to the window", () => {
    expect(visibleCanvasBand(box(-200, 1400), 1000)).toEqual({ top: 0, bottom: 1000 });
  });

  test("a canvas below the fold keeps its own top", () => {
    expect(visibleCanvasBand(box(300, 2000), 1000)).toEqual({ top: 300, bottom: 1000 });
  });

  // The defect itself: `display: contents` on a shown workspace wrapper, a
  // deck that has not been laid out, a subtree under `display: none`. Every
  // one of them reads as this box, and every one of them must refuse.
  test("a rect of zeros refuses", () => {
    expect(visibleCanvasBand(box(0, 0, 0), 1000)).toBeNull();
  });

  test("a box with width but no height refuses", () => {
    expect(visibleCanvasBand(box(0, 0), 1000)).toBeNull();
  });

  test("a box with height but no width refuses", () => {
    expect(visibleCanvasBand(box(0, 900, 0), 1000)).toBeNull();
  });

  test("no canvas at all refuses", () => {
    expect(visibleCanvasBand(null, 1000)).toBeNull();
  });

  // Not zero-area, but nothing of it is on screen, so every edge the clamps
  // would measure to is a point the panel cannot be placed against.
  test("a canvas scrolled entirely above the window refuses", () => {
    expect(visibleCanvasBand(box(-1600, -400), 1000)).toBeNull();
  });

  test("a canvas entirely below the window refuses", () => {
    expect(visibleCanvasBand(box(1200, 2400), 1000)).toBeNull();
  });

  test("a canvas showing a single pixel is a band, not a refusal", () => {
    expect(visibleCanvasBand(box(999, 1800), 1000)).toEqual({ top: 999, bottom: 1000 });
  });

  // The clamps read the band's edges directly, so a refusal has to be
  // distinguishable from a band by its type rather than by a sentinel number:
  // `{top: 0, bottom: 0}` is exactly what the defect produced.
  test("a refusal is null, never a zero band", () => {
    const refused = visibleCanvasBand(box(0, 0), 1000);
    expect(refused).not.toEqual({ top: 0, bottom: 0 });
    expect(refused).toBeNull();
  });
});
