/**
 * crossing-apply.test.ts — which writes a list view's crossing door makes,
 * decided from the record its measure half took, held as data.
 *
 * The door's write half acts on a record rather than on the live scroller,
 * because the settle engine reads every interior before it writes any. The
 * decision of what to write is the half that can be wrong without anybody
 * seeing it: a settled door that skipped its answer would let the first
 * frame's own resize delivery re-window mid-motion, and a land door that
 * wrote on an unchanged size would force a layout into every land.
 */

import { describe, expect, test } from "bun:test";

import { planCrossingApply } from "../crossing-apply";
import type { Measured } from "../fold-crossing";

const record = (over: Partial<Measured> = {}): Measured => ({
  w: 640,
  h: 900,
  scrollTop: 4000,
  scrollHeight: 4900,
  clientHeight: 900,
  ...over,
});

describe("planCrossingApply", () => {
  test("a settled crossing whose size changed pins, restores, records the size and re-windows", () => {
    const plan = planCrossingApply("settled", record({ h: 1200, clientHeight: 1200 }), {
      owedRebase: false,
      answered: { w: 640, h: 900 },
    });
    expect(plan).toEqual({
      rebase: false,
      pin: true,
      restore: true,
      answer: { w: 640, h: 1200 },
      tick: true,
    });
  });

  test("an owed rebase runs from the record when the scrollport has a height", () => {
    expect(
      planCrossingApply("settled", record(), { owedRebase: true, answered: null }).rebase,
    ).toBe(true);
    expect(
      planCrossingApply("closed", record(), {
        owedRebase: true,
        answered: { w: 640, h: 900 },
      }).rebase,
    ).toBe(true);
  });

  test("an owed rebase against a scrollport with no height is dropped", () => {
    expect(
      planCrossingApply("settled", record({ h: 0, clientHeight: 0 }), {
        owedRebase: true,
        answered: null,
      }).rebase,
    ).toBe(false);
  });

  test("the land door with an unchanged answered size makes no writes", () => {
    expect(
      planCrossingApply("closed", record(), {
        owedRebase: false,
        answered: { w: 640, h: 900 },
      }),
    ).toEqual({ rebase: false, pin: false, restore: false, answer: null, tick: false });
  });

  test("the land door pays the land when the scroller lands at another size", () => {
    const plan = planCrossingApply("closed", record({ h: 700, clientHeight: 700 }), {
      owedRebase: false,
      answered: { w: 640, h: 900 },
    });
    expect(plan.pin && plan.restore && plan.tick).toBe(true);
    expect(plan.answer).toEqual({ w: 640, h: 700 });
  });

  test("the land door never pays against a size that was never answered", () => {
    const plan = planCrossingApply("closed", record({ h: 700 }), {
      owedRebase: false,
      answered: null,
    });
    expect(plan).toEqual({ rebase: false, pin: false, restore: false, answer: null, tick: false });
  });
});
