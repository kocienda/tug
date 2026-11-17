/**
 * focus-trail — the record Back and Forward step along.
 *
 * Every case drives the trail with landings and steps and reads the visits
 * and the cursor back, with "which cards stand" given as a plain set.
 */

import { describe, expect, test } from "bun:test";
import {
  FOCUS_TRAIL_LIMIT,
  FocusTrail,
  type FocusTrailStands,
} from "@/lib/focus-trail";

const all: FocusTrailStands = () => true;
const except =
  (...closed: string[]): FocusTrailStands =>
  (cardId) =>
    !closed.includes(cardId);

function trailOf(...cardIds: string[]): FocusTrail {
  const trail = new FocusTrail();
  for (const cardId of cardIds) trail.land(cardId);
  return trail;
}

describe("FocusTrail landings", () => {
  test("an empty trail has no current card and refuses both ways", () => {
    const trail = new FocusTrail();
    expect(trail.current).toBeNull();
    expect(trail.cursor).toBe(-1);
    expect(trail.canStep("back", all)).toBe(false);
    expect(trail.canStep("forward", all)).toBe(false);
    expect(trail.step("back", all)).toBeNull();
    expect(trail.step("forward", all)).toBeNull();
  });

  test("a landing appends a visit and moves the cursor to it", () => {
    const trail = trailOf("a", "b", "c");
    expect(trail.visits).toEqual(["a", "b", "c"]);
    expect(trail.current).toBe("c");
  });

  test("a repeat visit to an earlier card is kept in order", () => {
    const trail = trailOf("a", "b", "a");
    expect(trail.visits).toEqual(["a", "b", "a"]);
  });

  test("a landing on the cursor's own card records nothing", () => {
    const trail = trailOf("a", "b");
    trail.land("b");
    expect(trail.visits).toEqual(["a", "b"]);
    expect(trail.cursor).toBe(1);
  });

  test("a landing on the cursor's card after going back keeps what is ahead", () => {
    const trail = trailOf("a", "b", "c");
    trail.step("back", all);
    trail.land("b");
    expect(trail.visits).toEqual(["a", "b", "c"]);
    expect(trail.canStep("forward", all)).toBe(true);
  });

  test("a landing made behind the end drops everything ahead of the cursor", () => {
    const trail = trailOf("a", "b", "c", "d");
    trail.step("back", all);
    trail.step("back", all);
    trail.land("e");
    expect(trail.visits).toEqual(["a", "b", "e"]);
    expect(trail.current).toBe("e");
    expect(trail.canStep("forward", all)).toBe(false);
  });

  test("the trail holds the limit and drops the oldest past it", () => {
    const trail = new FocusTrail();
    for (let i = 0; i < FOCUS_TRAIL_LIMIT + 3; i++) trail.land(`card-${i}`);
    const visits = trail.visits;
    expect(visits.length).toBe(FOCUS_TRAIL_LIMIT);
    expect(visits[0]).toBe("card-3");
    expect(trail.current).toBe(`card-${FOCUS_TRAIL_LIMIT + 2}`);
    expect(trail.cursor).toBe(FOCUS_TRAIL_LIMIT - 1);
  });
});

describe("FocusTrail steps", () => {
  test("back and forward move the cursor and record no visit", () => {
    const trail = trailOf("a", "b", "c");
    expect(trail.step("back", all)).toBe("b");
    expect(trail.step("back", all)).toBe("a");
    expect(trail.step("forward", all)).toBe("b");
    expect(trail.step("forward", all)).toBe("c");
    expect(trail.visits).toEqual(["a", "b", "c"]);
  });

  test("a step is refused at either end and leaves the cursor where it was", () => {
    const trail = trailOf("a", "b");
    expect(trail.canStep("forward", all)).toBe(false);
    expect(trail.step("forward", all)).toBeNull();
    expect(trail.current).toBe("b");
    trail.step("back", all);
    expect(trail.canStep("back", all)).toBe(false);
    expect(trail.step("back", all)).toBeNull();
    expect(trail.current).toBe("a");
    expect(trail.visits).toEqual(["a", "b"]);
  });

  test("back skips a closed card, prunes it, and carries on the same way", () => {
    const trail = trailOf("a", "b", "c");
    expect(trail.step("back", except("b"))).toBe("a");
    expect(trail.visits).toEqual(["a", "c"]);
    expect(trail.cursor).toBe(0);
    expect(trail.step("forward", all)).toBe("c");
  });

  test("forward skips a closed card, prunes it, and carries on the same way", () => {
    const trail = trailOf("a", "b", "c");
    trail.step("back", all);
    trail.step("back", all);
    expect(trail.step("forward", except("b"))).toBe("c");
    expect(trail.visits).toEqual(["a", "c"]);
    expect(trail.cursor).toBe(1);
  });

  test("a step with only closed cards its way is refused, and they are gone", () => {
    const trail = trailOf("a", "b", "c");
    expect(trail.canStep("back", except("a", "b"))).toBe(false);
    expect(trail.step("back", except("a", "b"))).toBeNull();
    expect(trail.visits).toEqual(["c"]);
    expect(trail.current).toBe("c");
  });

  test("pruning that joins two visits to one card folds them", () => {
    const trail = trailOf("a", "b", "x", "b");
    // With x closed the visit behind the cursor is b again, the card the
    // reader is on; a step there would move nothing, so it lands on a.
    expect(trail.step("back", except("x"))).toBe("a");
    expect(trail.visits).toEqual(["a", "b"]);
    expect(trail.step("forward", all)).toBe("b");
  });

  test("canStep reads without pruning", () => {
    const trail = trailOf("a", "b", "c");
    expect(trail.canStep("back", except("b"))).toBe(true);
    expect(trail.canStep("back", except("a", "b"))).toBe(false);
    expect(trail.visits).toEqual(["a", "b", "c"]);
  });

  test("canStep agrees with step when the only card that way is the current one", () => {
    const trail = trailOf("b", "x", "b");
    expect(trail.canStep("back", except("x"))).toBe(false);
    expect(trail.step("back", except("x"))).toBeNull();
    expect(trail.visits).toEqual(["b"]);
  });
});

describe("FocusTrail arrivals", () => {
  test("the next chosen landing takes an arrival's place", () => {
    const trail = trailOf("a");
    trail.land("b1", { arrival: true });
    expect(trail.visits).toEqual(["a", "b1"]);
    trail.land("b2");
    expect(trail.visits).toEqual(["a", "b2"]);
    expect(trail.step("back", all)).toBe("a");
  });

  test("choosing the card one arrived on keeps it", () => {
    const trail = trailOf("a");
    trail.land("b1", { arrival: true });
    trail.land("b1");
    trail.land("b2");
    expect(trail.visits).toEqual(["a", "b1", "b2"]);
  });

  test("an arrival the reader stayed on is kept by a step", () => {
    const trail = trailOf("a");
    trail.land("b1", { arrival: true });
    expect(trail.step("back", all)).toBe("a");
    expect(trail.step("forward", all)).toBe("b1");
    trail.land("b2");
    expect(trail.visits).toEqual(["a", "b1", "b2"]);
  });

  test("an arrival the reader stayed on is kept by the next arrival", () => {
    const trail = trailOf("a");
    trail.land("b1", { arrival: true });
    trail.land("c1", { arrival: true });
    expect(trail.visits).toEqual(["a", "b1", "c1"]);
    trail.land("c2");
    expect(trail.visits).toEqual(["a", "b1", "c2"]);
  });

  test("an arrival on the cursor's own card records nothing and marks nothing", () => {
    const trail = trailOf("a", "b");
    trail.land("b", { arrival: true });
    trail.land("c");
    expect(trail.visits).toEqual(["a", "b", "c"]);
  });

  test("a chosen landing on the card behind a dropped arrival adds no visit", () => {
    const trail = trailOf("a");
    trail.land("b1", { arrival: true });
    trail.land("a");
    expect(trail.visits).toEqual(["a"]);
    expect(trail.cursor).toBe(0);
  });

  test("an arrival that is the trail's only visit can be replaced", () => {
    const trail = new FocusTrail();
    trail.land("b1", { arrival: true });
    trail.land("b2");
    expect(trail.visits).toEqual(["b2"]);
    expect(trail.cursor).toBe(0);
  });
});
