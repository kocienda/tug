/**
 * join-offer-reveal — the unbidden Changes reveal's gate.
 *
 * Pins the one thing the gate exists to decide: which conditions defer the
 * reveal, that a folded card is one of them ([B06]), and that every deferral
 * is a deferral rather than a refusal — the caller spends the arc head only on
 * a `true`, so the table below is also the record of what does NOT spend it.
 */

import { describe, expect, test } from "bun:test";

import {
  shouldRevealJoinOffer,
  type JoinOfferRevealInput,
} from "../join-offer-reveal";

/** A quiet, open card with an unseen offer — the one state that reveals. */
function quiet(over: Partial<JoinOfferRevealInput> = {}): JoinOfferRevealInput {
  return {
    alreadyRevealed: false,
    turnInFlight: false,
    anyLandingActive: false,
    composerEmpty: true,
    shadeShowing: false,
    folded: false,
    ...over,
  };
}

describe("shouldRevealJoinOffer", () => {
  test("a quiet open card with an unseen offer reveals", () => {
    expect(shouldRevealJoinOffer(quiet())).toBe(true);
  });

  test("a folded card defers — the room has no door in the folded form", () => {
    expect(shouldRevealJoinOffer(quiet({ folded: true }))).toBe(false);
  });

  test("the fold defers a card that is otherwise entirely quiet", () => {
    // The point of [B06]: every other condition holding is exactly the case the
    // old gate fired on, and it is the case that opened a room behind Z2.
    expect(shouldRevealJoinOffer(quiet({ folded: true }))).toBe(false);
    expect(shouldRevealJoinOffer(quiet({ folded: false }))).toBe(true);
  });

  test.each([
    ["a head already revealed on this mount", { alreadyRevealed: true }],
    ["a turn in flight", { turnInFlight: true }],
    ["a landing already up", { anyLandingActive: true }],
    ["a half-typed composer", { composerEmpty: false }],
    ["a shade already showing", { shadeShowing: true }],
    ["a folded card", { folded: true }],
  ] as const)("%s defers", (_name, over) => {
    expect(shouldRevealJoinOffer(quiet(over))).toBe(false);
  });

  test("the unfold is what re-opens it — same inputs, fold flipped", () => {
    const folded = quiet({ folded: true });
    expect(shouldRevealJoinOffer(folded)).toBe(false);
    expect(shouldRevealJoinOffer({ ...folded, folded: false })).toBe(true);
  });

  test("the fold does not outrank the once-per-head memory", () => {
    // Unfolding must not re-open the room for work already shown: the memory is
    // what says "you have seen this", and no other condition overrides it.
    expect(
      shouldRevealJoinOffer(quiet({ alreadyRevealed: true, folded: false })),
    ).toBe(false);
  });
});
