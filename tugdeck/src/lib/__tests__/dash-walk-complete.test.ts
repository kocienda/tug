/**
 * When a full step counter means the walk is over.
 *
 * `implementing (12/12)` is still step twelve being worked; the same counter
 * on a stage past the walk is twelve steps that landed. The distinction is the
 * whole rule, and it is a pure function of two numbers and a word — so it is a
 * table test rather than anything that mounts.
 *
 * The word that matters most here is `ready`: a declared run whose final step
 * is done rests there, with nobody ever having typed `mark built` ([D147]).
 * Before that word joined the set, a finished run's ring stayed mid-walk
 * forever.
 */

import { describe, test, expect } from "bun:test";

import { dashWalkComplete } from "@/lib/dash-meta-facts";

describe("a full counter, read against the stage", () => {
  test("a finished run resting at `ready` reads as a completed walk", () => {
    expect(dashWalkComplete("ready", 8, 8)).toBe(true);
  });

  test("the declared stages past the walk agree", () => {
    for (const stage of ["built", "audited", "draft-ready", "joining", "landing"]) {
      expect(dashWalkComplete(stage, 8, 8)).toBe(true);
    }
  });

  test("the same counter mid-walk is the last step being worked", () => {
    expect(dashWalkComplete("implementing", 8, 8)).toBe(false);
  });

  test("a partial counter is never a finished walk, whatever the stage", () => {
    expect(dashWalkComplete("ready", 7, 8)).toBe(false);
    expect(dashWalkComplete("built", 7, 8)).toBe(false);
  });

  test("a dash with no plan has no walk to finish", () => {
    // A plan-less dash arms on its rounds alone, so it reaches `ready` with no
    // counter at all — and an absent counter must not read as a full one.
    expect(dashWalkComplete("ready", null, null)).toBe(false);
    expect(dashWalkComplete("ready", undefined, undefined)).toBe(false);
  });
});
