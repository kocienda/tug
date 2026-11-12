/**
 * The arc notices speak once per answer, and go when the answer goes.
 *
 * Every arc notice controller — a refused press, a replay's outcome, a refused
 * bind — posts through one sequence gate. Keyed on the store's sequence rather
 * than the words, a second identical refusal still speaks (it was a second
 * press), the same answer seen again on a later notification says nothing,
 * and a cleared answer takes its notice down. This pins that gate.
 */

import { describe, test, expect } from "bun:test";

import { nextBulletinAction } from "@/components/tugways/cards/use-sequenced-bulletin";

describe("the sequence gate", () => {
  test("a first answer posts", () => {
    expect(nextBulletinAction(null, { seq: 1 })).toBe("post");
  });

  test("a new sequence posts, even after another", () => {
    expect(nextBulletinAction(1, { seq: 2 })).toBe("post");
  });

  test("the sequence already posted is ignored", () => {
    expect(nextBulletinAction(3, { seq: 3 })).toBe("none");
  });

  test("a cleared answer dismisses what was posted", () => {
    expect(nextBulletinAction(3, null)).toBe("dismiss");
  });

  test("a cleared answer with nothing posted does nothing", () => {
    expect(nextBulletinAction(null, null)).toBe("none");
  });
});
