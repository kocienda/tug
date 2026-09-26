/**
 * fold-crossing.test.ts — the two rules in the crossing module that are pure
 * functions: a re-mark never lowers the height an interior is held at, and the
 * height an interior is held at is in the layout's px, not the viewport's.
 *
 * The doors themselves write attributes and inline properties on a frame, and
 * there is no DOM substrate under `bun test`; what they do to a real frame is
 * gated in the app, by `at0563-session-fold-still-picture.test.ts`.
 */

import { describe, expect, test } from "bun:test";

import { heldHeightOnMark, layoutPxOf } from "../fold-crossing";

describe("heldHeightOnMark", () => {
  test("a frame not yet held takes the new height", () => {
    expect(heldHeightOnMark(null, 412)).toBe(412);
  });

  test("a smaller re-mark does not lower the held height", () => {
    // A fold in landing inside an unfold: First is read mid-tween, so the
    // larger of the retarget's two heights is below the open box.
    expect(heldHeightOnMark(640, 371.5)).toBe(640);
  });

  test("a larger re-mark raises it", () => {
    expect(heldHeightOnMark(371.5, 640)).toBe(640);
  });

  test("a standing height of zero is a standing height", () => {
    expect(heldHeightOnMark(0, 0)).toBe(0);
    expect(heldHeightOnMark(0, 28)).toBe(28);
  });
});

describe("layoutPxOf", () => {
  // `contentBoxHeight` reads a `getBoundingClientRect`, which is in viewport
  // px, and the number it returns is written to `--tugx-still-held-height`
  // and resolved by a `height:` rule under `body { zoom: var(--tug-zoom) }`,
  // which is in layout px. The two agree only at zoom 1.
  test("at zoom 1 the reading is the held height", () => {
    expect(layoutPxOf(842.5, 1)).toBe(842.5);
  });

  test("at a zoom other than 1 the reading is divided back into layout px", () => {
    // A content box laid out 600px tall under zoom 1.5 measures 900px on the
    // viewport; the rule must hold it at 600, or the picture is clipped a
    // half-box below the edge it was measured to.
    expect(layoutPxOf(900, 1.5)).toBe(600);
    expect(layoutPxOf(510, 0.85)).toBe(600);
  });

  test("a zoom that is not a positive finite number is no zoom", () => {
    expect(layoutPxOf(600, 0)).toBe(600);
    expect(layoutPxOf(600, Number.NaN)).toBe(600);
    expect(layoutPxOf(600, Number.POSITIVE_INFINITY)).toBe(600);
  });
});
