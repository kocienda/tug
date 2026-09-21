/**
 * fold-crossing.test.ts — the one rule in the crossing module that is a pure
 * function: a re-mark never lowers the height an interior is held at.
 *
 * The doors themselves write attributes and inline properties on a frame, and
 * there is no DOM substrate under `bun test`; what they do to a real frame is
 * gated in the app, by `at0563-session-fold-still-picture.test.ts`.
 */

import { describe, expect, test } from "bun:test";

import { heldHeightOnMark } from "../fold-crossing";

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
