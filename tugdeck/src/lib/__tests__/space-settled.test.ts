/**
 * space-settled.test.ts — when a workspace switch's epoch closes.
 *
 * The rule is pure over three facts and is tested as such; the gate around it
 * in `deck-canvas.tsx` needs a canvas, a `ResizeObserver` and an animation
 * clock, and what it does is call this with the three facts it holds.
 *
 * This file is also the settled path's ONLY unconditional proof. The gate's
 * frame counter rides `requestAnimationFrame`, and a covered app-test window
 * suspends rAF — so an app-test asserting `epochReason === "settled"` would be
 * green on an uncovered desktop and red on a busy one, for a reason that has
 * nothing to do with the product. The app-tests assert the BOUND; the settled
 * path is proved here, where no window is involved.
 */

import { describe, expect, test } from "bun:test";

import {
  EPOCH_SILENT_FRAMES,
  SPACE_EPOCH_BOUND_MS,
  spaceEpochClosed,
} from "@/lib/space-settled";

describe("spaceEpochClosed", () => {
  test("a settled canvas silent for EPOCH_SILENT_FRAMES is closed", () => {
    expect(
      spaceEpochClosed({
        settled: true,
        silentFrames: EPOCH_SILENT_FRAMES,
        boundElapsed: false,
      }),
    ).toBe(true);
  });

  test("silence short of EPOCH_SILENT_FRAMES is not closed", () => {
    // One quiet frame is a gap in a commit train, not the end of one — the
    // recording measured four post-swap commits over about 100ms on a first
    // show, with tens of milliseconds between them.
    expect(
      spaceEpochClosed({
        settled: true,
        silentFrames: EPOCH_SILENT_FRAMES - 1,
        boundElapsed: false,
      }),
    ).toBe(false);
  });

  test("quiet frames with a settle still in flight are not closed", () => {
    // A settle is about to move frames whether or not this frame was quiet, and
    // closing the epoch into it hands those frames to the imposer — exactly the
    // unasked-for motion the mark exists to stand down.
    expect(
      spaceEpochClosed({
        settled: false,
        silentFrames: EPOCH_SILENT_FRAMES + 4,
        boundElapsed: false,
      }),
    ).toBe(false);
  });

  test("an expired bound is closed whatever the other two say", () => {
    // Liveness ([L32]): the mark decides whether motion is allowed, so it may
    // never be the thing that waits forever. A workspace whose content never
    // settles gets its epoch closed anyway.
    expect(
      spaceEpochClosed({
        settled: false,
        silentFrames: 0,
        boundElapsed: true,
      }),
    ).toBe(true);
    expect(
      spaceEpochClosed({ settled: true, silentFrames: 0, boundElapsed: true }),
    ).toBe(true);
  });

  test("a canvas that never goes silent is never closed short of the bound", () => {
    for (const settled of [true, false]) {
      expect(
        spaceEpochClosed({ settled, silentFrames: 0, boundElapsed: false }),
      ).toBe(false);
    }
  });

  test("the bound clears what the arriving layer was measured writing", () => {
    // [P06]'s ruling, pinned from the FLOOR rather than from a ceiling. Under
    // the cover this assertion also held the bound under the arrival reveal's
    // quarter second, because the wait was added to a 240ms dissolve that
    // followed it. The cut removes that addend, so the ceiling is gone and only
    // the floor is left: the recording saw a composer line box at 73ms and the
    // last pane rect at 116ms on the SMALL workspace, and the bound has to sit
    // clear of the same writes on a workspace four times the size.
    expect(SPACE_EPOCH_BOUND_MS).toBeGreaterThan(116);
    // Still a liveness bound rather than a settling estimate, so it stays
    // within a span a reader would not call a hang.
    expect(SPACE_EPOCH_BOUND_MS).toBeLessThanOrEqual(500);
  });

  test("EPOCH_SILENT_FRAMES is a real bar rather than a formality", () => {
    expect(EPOCH_SILENT_FRAMES).toBeGreaterThanOrEqual(2);
  });
});
