/**
 * The pending workspace: what New Workspace builds while the naming modal asks
 * for its name. Held out of the list and every save, mounted unshown, and
 * closed by one of two verbs: discard, which leaves the deck exactly as it
 * was, and adopt, which puts it first in the list and shows it.
 *
 * The store's half over a bare `SpacesStore`; the manager's over a real
 * `DeckManager` mounted into a jsdom container.
 *
 * @covers tugdeck/src/spaces-store.ts
 * @covers tugdeck/src/deck-manager.ts
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { getAllRegistrations, getRegistration, registerCard } from "../card-registry";

import { FACTORY_RAIL_ORDER, type DeckManager } from "../deck-manager";
import type { DeckState } from "../layout-tree";
import { nextSpaceName } from "../spaces";
import { SpacesStore } from "../spaces-store";
import { installJsdom, mountDeck, onePaneDeck, unmountDeck, type JsdomSubstrate } from "./jsdom-deck";

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

describe("SpacesStore's pending workspace", () => {
  function seeded(): SpacesStore {
    const store = new SpacesStore();
    store.seed(
      [
        { id: "a", name: "Main", deck: null },
        { id: "b", name: "Side", deck: deck("cb") },
      ],
      "a",
    );
    return store;
  }

  test("is mounted unshown, first, and in no list or save", () => {
    const store = seeded();
    store.setPending({ id: "n", name: "Workspace 3", deck: deck("cn") });
    const snapshot = store.getSnapshot();
    expect(snapshot.spaces.map((s) => s.id)).toEqual(["a", "b"]);
    expect(snapshot.pendingSpaceId).toBe("n");
    expect(snapshot.mountedSpaceIds).toEqual(["n", "a"]);
    expect(snapshot.mountedDecks.get("n")?.cards[0].id).toBe("cn");
    expect(store.persistable(deck("ca")).spaces.map((s) => s.id)).toEqual(["a", "b"]);
    // Its cards answer to it, and the orphan sweep sees them.
    expect(store.spaceOf("cn", deck("ca"))).toBe("n");
    expect(store.deckOf("n", deck("ca"))?.cards[0].id).toBe("cn");
    expect(store.allCardIds(deck("ca")).has("cn")).toBe(true);
  });

  test("discarded, leaves the snapshot it found", () => {
    const store = seeded();
    const before = store.getSnapshot();
    store.setPending({ id: "n", name: "Workspace 3", deck: deck("cn") });
    expect(store.discardPending()?.id).toBe("n");
    expect(store.getSnapshot()).toEqual(before);
    expect(store.spaceOf("cn", deck("ca"))).toBeNull();
    expect(store.discardPending()).toBeNull();
  });

  test("adopted, joins the top of the list still mounted, in one notify", () => {
    const store = seeded();
    store.setPending({ id: "n", name: "Workspace 3", deck: deck("cn") });
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.adoptPending();
    expect(calls).toBe(1);
    const snapshot = store.getSnapshot();
    expect(snapshot.spaces.map((s) => s.id)).toEqual(["n", "a", "b"]);
    expect(snapshot.pendingSpaceId).toBeUndefined();
    expect(snapshot.mountedSpaceIds).toEqual(["n", "a"]);
    expect(store.persistable(deck("ca")).spaces.map((s) => s.id)).toEqual(["n", "a", "b"]);
  });
});

describe("DeckManager's pending workspace", () => {
  // The rail a new workspace is built with: registered here, for this file
  // alone, so the pending deck carries its five cards.
  const registered: string[] = [];
  beforeAll(() => {
    for (const componentId of FACTORY_RAIL_ORDER) {
      if (getRegistration(componentId) !== undefined) continue;
      registerCard({ componentId, contentFactory: () => null, defaultMeta: { title: componentId, closable: false } });
      registered.push(componentId);
    }
  });
  afterAll(() => {
    for (const componentId of registered) getAllRegistrations().delete(componentId);
  });

  let substrate: JsdomSubstrate;
  let manager: DeckManager;

  beforeEach(async () => {
    substrate = installJsdom();
    manager = await mountDeck(substrate, onePaneDeck("hello", ["card-1"]));
  });

  afterEach(async () => {
    await unmountDeck(substrate, manager);
  });

  test("begins built whole under the next name, and changes nothing on screen", () => {
    const home = manager.getSpacesSnapshot().activeSpaceId;
    const picture = manager.getSnapshot();
    const proposed = nextSpaceName(manager.getSpacesSnapshot().spaces.map((s) => s.name));
    const { id, name } = manager.beginPendingSpace();
    const spaces = manager.getSpacesSnapshot();
    expect(name).toBe(proposed);
    expect(spaces.spaces.map((s) => s.id)).toEqual([home]);
    expect(spaces.activeSpaceId).toBe(home);
    expect(spaces.pendingSpaceId).toBe(id);
    expect(spaces.mountedSpaceIds).toContain(id);
    expect(manager.getSpaceDeck(id)?.cards.map((c) => c.componentId).sort()).toEqual([...FACTORY_RAIL_ORDER].sort());
    expect(manager.getSnapshot()).toBe(picture);
  });

  test("discarded, leaves the deck exactly as it was", () => {
    const before = manager.getSpacesSnapshot();
    const ids = manager.allSpaceCardIds();
    const picture = manager.getSnapshot();
    const { id } = manager.beginPendingSpace();
    const pendingCards = manager.getSpaceDeck(id)?.cards.map((c) => c.id) ?? [];
    expect(pendingCards.length).toBe(FACTORY_RAIL_ORDER.length);
    manager.discardPendingSpace();
    expect(manager.getSpacesSnapshot()).toEqual(before);
    expect(manager.allSpaceCardIds()).toEqual(ids);
    expect(manager.getSnapshot()).toBe(picture);
    expect(manager.getSpaceDeck(id)).toBeNull();
    for (const cardId of pendingCards) expect(manager.spaceOf(cardId)).toBeNull();
  });

  test("adopted, is named, first in the list, and shown", () => {
    const home = manager.getSpacesSnapshot().activeSpaceId;
    const { id } = manager.beginPendingSpace();
    expect(manager.adoptPendingSpace("  Notes  ")).toBe(id);
    const spaces = manager.getSpacesSnapshot();
    expect(spaces.spaces.map((s) => s.id)).toEqual([id, home]);
    expect(spaces.spaces[0].name).toBe("Notes");
    expect(spaces.activeSpaceId).toBe(id);
    expect(spaces.pendingSpaceId).toBeUndefined();
    expect(manager.adoptPendingSpace("Again")).toBeNull();
  });

  test("adopted with an empty name, keeps the proposed one", () => {
    const { name } = manager.beginPendingSpace();
    manager.adoptPendingSpace("   ");
    expect(manager.getSpacesSnapshot().spaces[0].name).toBe(name);
  });

  test("begun again, replaces the one already pending", () => {
    const first = manager.beginPendingSpace();
    const second = manager.beginPendingSpace();
    expect(second.id).not.toBe(first.id);
    expect(manager.getSpacesSnapshot().pendingSpaceId).toBe(second.id);
    expect(manager.getSpaceDeck(first.id)).toBeNull();
  });
});
