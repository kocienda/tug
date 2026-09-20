/**
 * open-diff-in-card.reuse.test.ts — descriptor-keyed reuse ([P20]): opening a
 * descriptor already shown by a Diff card activates and re-points that card;
 * a novel descriptor opens a fresh Diff card.
 *
 * Only the diff-card open registry and the focus-transfer seam are mocked
 * (both used solely by `open-diff-in-card`); `transferFocusForActivation` is
 * reduced to running its `commitMutation` so no DOM is needed.
 */

import { describe, test, expect, mock, beforeAll } from "bun:test";
import type { DiffDescriptor } from "@/lib/git-diff-store";

let existing:
  | { cardId: string; entry: { getKey: () => string | null; setDescriptor: (d: DiffDescriptor) => void } }
  | null = null;

mock.module("@/lib/diff-card-open-registry", () => ({
  findDiffCardByKey: () => existing,
}));
mock.module("@/focus-transfer", () => ({
  transferFocusForActivation: ({ commitMutation }: { commitMutation: () => void }) =>
    commitMutation(),
}));

let openDiffInCard: typeof import("@/lib/open-diff-in-card").openDiffInCard;
beforeAll(async () => {
  ({ openDiffInCard } = await import("@/lib/open-diff-in-card"));
});

const DESCRIPTOR: DiffDescriptor = { kind: "head", root: "/repo", paths: ["a.ts"] };

function makeStore() {
  const calls: { addCard: unknown[][]; activated: string[] } = { addCard: [], activated: [] };
  const store = {
    getFirstResponderCardId: () => null,
    // `openDiffInCard` flashes the arriving card's pane. No pane holds these
    // ids, which is silence rather than a warning — the reuse behavior under
    // test is unaffected either way.
    getSnapshot: () => ({ panes: [] }),
    activateCard: (id: string) => calls.activated.push(id),
    addCard: (...args: unknown[]) => {
      calls.addCard.push(args);
      return "cNew";
    },
  };
  return { store, calls };
}

describe("open-diff-in-card ([P20])", () => {
  test("a novel descriptor opens a fresh Diff card seeded with it", () => {
    existing = null;
    const { store, calls } = makeStore();
    openDiffInCard(store as never, DESCRIPTOR);
    expect(calls.addCard).toHaveLength(1);
    // The third argument names where the gesture came from. With no outgoing
    // card the origin is null, and the deck anchors the placement itself.
    expect(calls.addCard[0]).toEqual([
      "diff",
      { descriptor: DESCRIPTOR },
      { origin: null },
    ]);
  });

  test("an already-open descriptor activates and re-points the existing card", () => {
    const setDescriptor = mock((_d: DiffDescriptor) => {});
    existing = { cardId: "d1", entry: { getKey: () => "head:/repo:a.ts", setDescriptor } };
    const { store, calls } = makeStore();
    openDiffInCard(store as never, DESCRIPTOR);
    expect(calls.addCard).toHaveLength(0);
    expect(calls.activated).toEqual(["d1"]);
    expect(setDescriptor).toHaveBeenCalledTimes(1);
  });
});
