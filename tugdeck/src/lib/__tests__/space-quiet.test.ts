/**
 * space-quiet.test.ts — when the cover a workspace switch holds may dissolve.
 *
 * The rule is pure over three facts and is tested as such; the gate around it
 * in `deck-canvas.tsx` needs a canvas, a `ResizeObserver` and an animation
 * clock, and what it does is call this with the three facts it holds.
 *
 * This file is also the quiet path's ONLY unconditional proof. The gate's
 * frame counter rides `requestAnimationFrame`, and a covered app-test window
 * suspends rAF — so an app-test asserting `quietReason === "quiet"` would be
 * green on an uncovered desktop and red on a busy one, for a reason that has
 * nothing to do with the product. The app-tests assert the BOUND; the quiet
 * path is proved here, where no window is involved.
 */

import { describe, expect, test } from "bun:test";

import {
  QUIET_FRAMES,
  SPACE_QUIET_BOUND_MS,
  spaceDissolveDue,
} from "@/lib/space-quiet";

describe("spaceDissolveDue", () => {
  test("a settled canvas silent for QUIET_FRAMES is due", () => {
    expect(
      spaceDissolveDue({
        settled: true,
        silentFrames: QUIET_FRAMES,
        boundElapsed: false,
      }),
    ).toBe(true);
  });

  test("silence short of QUIET_FRAMES is not due", () => {
    // One quiet frame is a gap in a commit train, not the end of one — the
    // recording measured four post-swap commits over about 100ms on a first
    // show, with tens of milliseconds between them.
    expect(
      spaceDissolveDue({
        settled: true,
        silentFrames: QUIET_FRAMES - 1,
        boundElapsed: false,
      }),
    ).toBe(false);
  });

  test("quiet frames with a settle still in flight are not due", () => {
    // A settle is about to move frames whether or not this frame was quiet,
    // and dissolving into it is exactly the motion-under-a-dissolve the hold
    // exists to remove.
    expect(
      spaceDissolveDue({
        settled: false,
        silentFrames: QUIET_FRAMES + 4,
        boundElapsed: false,
      }),
    ).toBe(false);
  });

  test("an expired bound is due whatever the other two say", () => {
    // Liveness ([L32]): the cover decides visibility, so it may never be the
    // thing that waits forever. A workspace whose content never settles gets
    // dissolved over anyway.
    expect(
      spaceDissolveDue({
        settled: false,
        silentFrames: 0,
        boundElapsed: true,
      }),
    ).toBe(true);
    expect(
      spaceDissolveDue({ settled: true, silentFrames: 0, boundElapsed: true }),
    ).toBe(true);
  });

  test("a canvas that never goes silent is never due short of the bound", () => {
    for (const settled of [true, false]) {
      expect(
        spaceDissolveDue({ settled, silentFrames: 0, boundElapsed: false }),
      ).toBe(false);
    }
  });

  test("the bound is short, and under the arrival reveal's quarter second", () => {
    // [P03]'s ruling, pinned: the wait is ADDED to the dissolve that follows
    // it, so the pair has to stay under the ceiling a single reveal gets.
    expect(SPACE_QUIET_BOUND_MS).toBeGreaterThan(0);
    expect(SPACE_QUIET_BOUND_MS).toBeLessThan(250);
    // And long enough to cover what the recording saw the arriving layer
    // write: a composer line box at 73ms and a pane rect at 116ms.
    expect(SPACE_QUIET_BOUND_MS).toBeGreaterThan(116);
  });

  test("QUIET_FRAMES is a real bar rather than a formality", () => {
    expect(QUIET_FRAMES).toBeGreaterThanOrEqual(2);
  });
});
