/**
 * tolerances.test.ts — the table carries the numbers the corpus used before it
 * existed. A test that imports a name asserts what it asserted when the number
 * was written beside it, so changing a value here is a change to every one of
 * those assertions and has to be argued as one.
 */

import { describe, expect, test } from "bun:test";

import {
  PIXEL_TOL,
  QUIESCE_DRAIN_DEADLINE_MS,
  QUIESCE_TEARDOWN_DEADLINE_MS,
  RESTORE_TOL_PX,
  SCROLL_TOL_PX,
  STATE_SETTLE_MS,
  SUBPIXEL_TOL,
} from "./tolerances";

describe("the house tolerances", () => {
  test("hold the values the local constants they replaced held", () => {
    expect(PIXEL_TOL).toBe(1.5);
    expect(SUBPIXEL_TOL).toBe(0.5);
    expect(SCROLL_TOL_PX).toBe(8);
    expect(RESTORE_TOL_PX).toBe(2);
  });

  test("keep the timing budgets the harness ran under", () => {
    expect(QUIESCE_TEARDOWN_DEADLINE_MS).toBe(8000);
    expect(QUIESCE_DRAIN_DEADLINE_MS).toBe(4000);
    if (process.env.TUGAPP_STATE_SETTLE_MS === undefined) expect(STATE_SETTLE_MS).toBe(500);
  });
});
