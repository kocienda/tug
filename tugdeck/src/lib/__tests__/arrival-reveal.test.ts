/**
 * arrival-reveal.test.ts — when a hidden card's reveal commit is due ([B03]).
 *
 * The rule is pure over three booleans and is tested as such; the watch
 * around it in `DeckManager` needs a store, a sheet, and a clock, and what
 * it does is call this with the three facts it holds.
 */

import { describe, expect, test } from "bun:test";

import {
  ARRIVAL_REVEAL_BOUND_MS,
  arrivalRevealDue,
} from "@/lib/arrival-reveal";

describe("arrivalRevealDue", () => {
  test("quiet content with a height reported is due", () => {
    expect(
      arrivalRevealDue({ reported: true, quiet: true, boundElapsed: false }),
    ).toBe(true);
  });

  test("quiet content with NO report yet is not due — nothing to reveal at", () => {
    expect(
      arrivalRevealDue({ reported: false, quiet: true, boundElapsed: false }),
    ).toBe(false);
  });

  test("a report over content still moving is not due", () => {
    // The listing's second frame, or a synopsis, can still change the
    // height; revealing now would be the third motion.
    expect(
      arrivalRevealDue({ reported: true, quiet: false, boundElapsed: false }),
    ).toBe(false);
  });

  test("an expired bound is due whatever the other two say", () => {
    // Liveness: a source that never settles cannot hold the card hostage,
    // and a sheet that never reported reveals at its policy floor.
    expect(
      arrivalRevealDue({ reported: false, quiet: false, boundElapsed: true }),
    ).toBe(true);
    expect(
      arrivalRevealDue({ reported: true, quiet: false, boundElapsed: true }),
    ).toBe(true);
  });

  test("the bound is short — frames to a few hundred milliseconds, not a scan", () => {
    // [B05]'s ruling, pinned so a later tuning cannot drift it back toward
    // the 2s the retired `ensureListed` carried.
    expect(ARRIVAL_REVEAL_BOUND_MS).toBeGreaterThan(0);
    expect(ARRIVAL_REVEAL_BOUND_MS).toBeLessThan(1000);
  });
});
