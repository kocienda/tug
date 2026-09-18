/**
 * commit-card-open-registry.test.ts — the prefix match that decides whether a
 * commit already has a card.
 *
 * The rule exists because a commit wears two spellings: prose writes eight
 * characters and the reply returns forty. Under exact-string keying the two
 * spellings of one commit open two cards, and the reader is left with two
 * cards about the same thing — which is exactly what the reuse index exists to
 * prevent. Everything here is about which pairs are the same commit.
 */

import { describe, test, expect, afterEach } from "bun:test";

import {
  findCommitCardByTarget,
  registerOpenCommitCard,
  sameCommitTarget,
  unregisterOpenCommitCard,
} from "@/lib/commit-card-open-registry";

const FULL = "d877cc104e40e4e1da977dce69b5a93129c14ce9";
const SHORT = FULL.slice(0, 8);
const ROOT = "/work/repo";

afterEach(() => unregisterOpenCommitCard("card"));

describe("sameCommitTarget", () => {
  test("a short sha and the full one it abbreviates are the same commit", () => {
    expect(sameCommitTarget({ root: ROOT, sha: SHORT }, { root: ROOT, sha: FULL })).toBe(
      true,
    );
    expect(sameCommitTarget({ root: ROOT, sha: FULL }, { root: ROOT, sha: SHORT })).toBe(
      true,
    );
  });

  test("case is git's, not the reader's", () => {
    expect(
      sameCommitTarget({ root: ROOT, sha: SHORT.toUpperCase() }, { root: ROOT, sha: FULL }),
    ).toBe(true);
  });

  test("a different commit is a different commit, however close the prefix", () => {
    const sibling = `${FULL.slice(0, 7)}f${FULL.slice(8)}`;
    expect(sameCommitTarget({ root: ROOT, sha: FULL }, { root: ROOT, sha: sibling })).toBe(
      false,
    );
  });

  test("the same sha in two checkouts is two commits", () => {
    // The root is not a display detail: it is what the card's fetch and its
    // menu's Open Diff are both scoped by.
    expect(
      sameCommitTarget({ root: ROOT, sha: FULL }, { root: "/work/other", sha: FULL }),
    ).toBe(false);
  });

  test("an empty sha matches nothing, itself included", () => {
    // Otherwise every card would match a card that has not been seeded yet.
    expect(sameCommitTarget({ root: ROOT, sha: "" }, { root: ROOT, sha: FULL })).toBe(
      false,
    );
    expect(sameCommitTarget({ root: ROOT, sha: "" }, { root: ROOT, sha: "" })).toBe(false);
  });
});

describe("findCommitCardByTarget", () => {
  test("a card showing the full sha answers to the short one", () => {
    registerOpenCommitCard("card", {
      getTarget: () => ({ root: ROOT, sha: FULL }),
      setTarget: () => {},
    });
    expect(findCommitCardByTarget({ root: ROOT, sha: SHORT })?.cardId).toBe("card");
    expect(findCommitCardByTarget({ root: ROOT, sha: "0000000" })).toBeNull();
  });

  test("a card that has not been seeded yet is never the answer", () => {
    registerOpenCommitCard("card", {
      getTarget: () => null,
      setTarget: () => {},
    });
    expect(findCommitCardByTarget({ root: ROOT, sha: FULL })).toBeNull();
  });

  test("an unregistered card stops answering", () => {
    registerOpenCommitCard("card", {
      getTarget: () => ({ root: ROOT, sha: FULL }),
      setTarget: () => {},
    });
    unregisterOpenCommitCard("card");
    expect(findCommitCardByTarget({ root: ROOT, sha: FULL })).toBeNull();
  });
});
