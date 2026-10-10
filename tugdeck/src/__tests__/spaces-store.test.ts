/**
 * The spaces store's `useSyncExternalStore` contract ([L02]).
 *
 * `useSyncExternalStore` compares snapshots by identity, so the contract has
 * two halves and both are pinned here: a read with no change in between hands
 * back the same object (otherwise React re-renders forever), and every list
 * mutation hands back a new one and tells the subscribers (otherwise a
 * Workspaces row draws a list that has moved on). A no-op mutation does
 * neither — a fresh identity for the same list is a re-render bought for
 * nothing.
 */

import { describe, test, expect } from "bun:test";
import { SpacesStore } from "../spaces-store";
import type { DeckState } from "../layout-tree";

const deck = (cardId: string): DeckState => ({
  cards: [{ id: cardId, componentId: "terminal", title: "T", closable: true }],
  panes: [
    {
      id: `p-${cardId}`,
      position: { x: 0, y: 0 },
      size: { width: 400, height: 300 },
      cardIds: [cardId],
      activeCardId: cardId,
      title: "",
      acceptsFamilies: ["standard"],
    },
  ],
  activePaneId: `p-${cardId}`,
  imposition: { sidebars: {} },
  hasFocus: true,
});

function seeded(): { store: SpacesStore; calls: () => number } {
  const store = new SpacesStore();
  store.seed(
    [
      { id: "a", name: "Main", deck: null },
      { id: "b", name: "Side", deck: deck("cb") },
    ],
    "a",
  );
  let count = 0;
  store.subscribe(() => {
    count += 1;
  });
  return { store, calls: () => count };
}

describe("SpacesStore snapshot identity", () => {
  test("is stable across reads with no change between them", () => {
    const { store } = seeded();
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  test("a list mutation mints a new snapshot and notifies once", () => {
    const { store, calls } = seeded();
    const before = store.getSnapshot();
    store.rename("b", "Renamed");
    const after = store.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.spaces.map((s) => s.name)).toEqual(["Main", "Renamed"]);
    expect(calls()).toBe(1);
    expect(store.getSnapshot()).toBe(after);
  });

  test("a no-op rename keeps the identity and notifies nobody", () => {
    const { store, calls } = seeded();
    const before = store.getSnapshot();
    expect(store.rename("b", "  Side  ")).toBe(false);
    expect(store.getSnapshot()).toBe(before);
    expect(calls()).toBe(0);
  });

  test("focus is not a list change: no notify, same identity", () => {
    const { store, calls } = seeded();
    const before = store.getSnapshot();
    expect(store.setActiveFocusedCard("x")).toBe(true);
    expect(store.setActiveFocusedCard("x")).toBe(false);
    expect(store.getSnapshot()).toBe(before);
    expect(calls()).toBe(0);
  });
});

describe("SpacesStore mounting and the live deck", () => {
  test("only the active space is mounted at boot, and its deck is not in the snapshot", () => {
    const { store } = seeded();
    const snap = store.getSnapshot();
    expect(snap.activeSpaceId).toBe("a");
    expect(snap.mountedSpaceIds).toEqual(["a"]);
    expect(snap.mountedDecks.size).toBe(0);
  });

  test("activate mounts the space for good; a parked mounted deck is carried", () => {
    const { store } = seeded();
    // The manager parks the outgoing deck and clears the incoming one first.
    store.find("a")!.deck = deck("ca");
    store.find("b")!.deck = null;
    store.activate("b");
    const snap = store.getSnapshot();
    expect(snap.activeSpaceId).toBe("b");
    expect(snap.mountedSpaceIds).toEqual(["a", "b"]);
    expect([...snap.mountedDecks.keys()]).toEqual(["a"]);
  });

  test("readers take the live deck for the active space", () => {
    const { store } = seeded();
    const live = deck("live");
    expect(store.spaceOf("live", live)).toBe("a");
    expect(store.spaceOf("cb", live)).toBe("b");
    expect(store.spaceOf("nobody", live)).toBeNull();
    expect(store.deckOf("a", live)).toBe(live);
    expect([...store.allCardIds(live)].sort()).toEqual(["cb", "live"]);
    expect(store.persistable(live).spaces[0].deck).toBe(live);
  });

  test("reorder keeps unnamed spaces at the end; remove unmounts", () => {
    const { store } = seeded();
    store.insert({ id: "c", name: "Third", deck: deck("cc") });
    store.reorder(["c"]);
    expect(store.list.map((s) => s.id)).toEqual(["c", "a", "b"]);
    store.remove("c");
    expect(store.list.map((s) => s.id)).toEqual(["a", "b"]);
    expect(store.getSnapshot().mountedSpaceIds).toEqual(["a"]);
  });
});
