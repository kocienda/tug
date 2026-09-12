/**
 * tug-progress-squeeze — unit tests for the pure helper behind the squeeze
 * glyph's static poses.
 *
 * The running breath is a CSS `@keyframes` loop and the component's render
 * path is exercised downstream via HMR + the gallery card, per the no-fake-DOM
 * testing convention. What is worth pinning here is the seam between the two:
 * the inline pose the band renders with for every non-running state, which has
 * to equal the loop's 0% keyframe or `running` starts with a jump.
 */

import { describe, expect, test } from "bun:test";

import { SQUEEZE_TO, staticScale } from "../tug-progress-squeeze";

describe("staticScale — pose for non-running states", () => {
  test.each(["running", "paused", "stopped", "aborted"] as const)(
    "%s rests OPEN, which is the loop's 0%% keyframe",
    (state) => {
      expect(staticScale(state)).toBe(1);
    },
  );

  test("completed rests PRESSED — what the operation left behind", () => {
    expect(staticScale("completed")).toBe(SQUEEZE_TO);
  });
});

describe("SQUEEZE_TO — the breath's tightest extent", () => {
  test("presses in without closing: a band, never a line", () => {
    expect(SQUEEZE_TO).toBeGreaterThan(0);
    expect(SQUEEZE_TO).toBeLessThan(1);
  });

  // The CSS keyframe carries this number literally (`scaleX(0.4)` at 50%),
  // because a keyframe cannot read a TS constant. This is the pin that says
  // the two are still the same number: a change here without the matching
  // edit in `tug-progress-squeeze.css` fails the test rather than silently
  // making `completed` land somewhere the breath never reaches.
  test("is the 0.4 the keyframe's midpoint is written with", () => {
    expect(SQUEEZE_TO).toBe(0.4);
  });
});
