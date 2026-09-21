/**
 * The resume predicate — the one expression three surfaces read.
 *
 * It is pinned here rather than at any of its callers because it now has
 * more than one: the right-click menu, the annotation registry's disabled
 * state, and the citation pill's click. A wrong answer shows on all three at
 * once, and the failure it is written against is subtler than a wrong answer
 * — it is two surfaces over the same session disagreeing, a pill offering a
 * resume the menu on that pill greys out.
 */

import { describe, expect, test } from "bun:test";

import { isSessionResumable } from "@/lib/session-resume";

const DIR = "/u/src/tugtool";

describe("isSessionResumable", () => {
  test("a closed session with a project is resumable", () => {
    expect(
      isSessionResumable({ state: "closed", background: false, projectDir: DIR }),
    ).toBe(true);
  });

  test("a live session held by a card is not — that is a second claim", () => {
    expect(
      isSessionResumable({ state: "live", background: false, projectDir: DIR }),
    ).toBe(false);
  });

  test("a live session held by a BACKGROUND owner is — the adoption case", () => {
    // There is no card to send the user to, so seating it is the only way to
    // reach it, and the supervisor admits such a session without re-spawning.
    expect(
      isSessionResumable({ state: "live", background: true, projectDir: DIR }),
    ).toBe(true);
  });

  test("no project directory, no resume — it would open nowhere", () => {
    expect(
      isSessionResumable({ state: "closed", background: false, projectDir: "" }),
    ).toBe(false);
    expect(
      isSessionResumable({ state: "live", background: true, projectDir: "" }),
    ).toBe(false);
  });

  test("a state nothing has reported yet is not treated as live", () => {
    // `null` is "nobody has said", and refusing on it would refuse the gesture
    // for every session a listing has not reached.
    expect(
      isSessionResumable({ state: null, background: false, projectDir: DIR }),
    ).toBe(true);
  });
});
