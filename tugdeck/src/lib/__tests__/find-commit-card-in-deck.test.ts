import { describe, expect, test } from "bun:test";

import { findCommitCardInDeck } from "../open-commit-in-card";

const ROOT = "/u/src/tug";

function store(cards: Array<{ id: string; componentId: string; content?: unknown }>) {
  return {
    getSnapshot: () => ({ cards: cards.map(({ id, componentId }) => ({ id, componentId })) }) as never,
    getCardState: (cardId: string) => {
      const card = cards.find((c) => c.id === cardId);
      return card?.content === undefined ? undefined : ({ content: card.content } as never);
    },
  };
}

describe("findCommitCardInDeck", () => {
  test("finds the commit card whose bag holds the target, by sha prefix either way", () => {
    const deck = store([
      { id: "S", componentId: "session", content: { target: { root: ROOT, sha: "ee264c3ef" } } },
      { id: "C", componentId: "commit", content: { target: { root: ROOT, sha: "ee264c3ef" } } },
    ]);
    expect(findCommitCardInDeck(deck, { root: ROOT, sha: "ee264c3ef41aad3559b31e4e374f4a1c33501aea" })).toBe("C");
    expect(findCommitCardInDeck(deck, { root: ROOT, sha: "ee264c3e" })).toBe("C");
  });

  test("another root, another sha, or a bag with no target is no match", () => {
    const deck = store([
      { id: "C1", componentId: "commit", content: { target: { root: ROOT, sha: "ee264c3ef" } } },
      { id: "C2", componentId: "commit", content: { hint: { subject: "no target" } } },
      { id: "C3", componentId: "commit" },
    ]);
    expect(findCommitCardInDeck(deck, { root: "/elsewhere", sha: "ee264c3ef" })).toBeNull();
    expect(findCommitCardInDeck(deck, { root: ROOT, sha: "d4845ff02" })).toBeNull();
  });
});
