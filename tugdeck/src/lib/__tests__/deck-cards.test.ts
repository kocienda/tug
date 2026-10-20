/**
 * `deck.cards`, the one record per card every page reads of a card it does
 * not show: the shell's projection of it, the tab label both pages compose
 * from it, which of a page store's facts moved between two of them, and a
 * body's page stores answering another card's id from the replica with
 * nothing copied into them.
 *
 * @covers tugdeck/src/lib/deck-cards.ts
 * @covers tugdeck/src/lib/body-arrangement.ts
 */

import { afterEach, describe, expect, test } from "bun:test";

import { getRegistration, registerCard } from "../../card-registry";
import { deckCards, type DeckCardFacts } from "../../bus/declarations/deck";
import { _resetPageForTest, installPage } from "../../bus/page";
import { createTestBus, type TestBus } from "../../bus/test-bus";
import type { DeckState, TugPaneState } from "../../layout-tree";
import { projectDeckCards, type ArrangementDeck, type DeckCardReaders } from "../body-arrangement";
import { cardTitleStore } from "../card-title-store";
import type { CardSessionBinding } from "../card-session-binding-store";
import { deckCardIcon, deckCardTabTitle, movedFacets } from "../deck-cards";
import { composePaneTitleBarText } from "../pane-title";

registerCard({
  componentId: "deck-cards-doc",
  contentFactory: () => null,
  defaultMeta: { title: "Doc", icon: "FileText", closable: true },
});
registerCard({
  componentId: "deck-cards-session",
  contentFactory: () => null,
  defaultMeta: { title: "Session", closable: true },
});

const BINDING: CardSessionBinding = {
  tugSessionId: "tug-a",
  lineId: "line-a",
  workspaceKey: "wk",
  projectDir: "/p",
  sessionMode: "resume",
};

function pane(id: string, cardIds: string[]): TugPaneState {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 600 },
    cardIds,
    activeCardId: cardIds[0],
    title: "",
    acceptsFamilies: ["standard"],
  };
}

function deckOf(cards: Array<[string, string]>): DeckState {
  return {
    cards: cards.map(([id, componentId]) => ({ id, componentId, title: "", closable: true })),
    panes: cards.map(([id]) => pane(`p-${id}`, [id])),
    imposition: { sidebars: {} },
    hasFocus: true,
  };
}

/** Two cards shown, one parked in a second workspace. */
const LIVE = deckOf([
  ["a", "deck-cards-session"],
  ["b", "deck-cards-doc"],
]);
const PARKED = deckOf([["c", "deck-cards-session"]]);
const DECK = {
  getSnapshot: () => LIVE,
  getSpacesSnapshot: () => ({
    spaces: [
      { id: "s1", name: "Main" },
      { id: "s2", name: "Side" },
    ],
    activeSpaceId: "s1",
    mountedSpaceIds: ["s1", "s2"],
    warmSpaceIds: [],
    mountedDecks: new Map([["s2", PARKED]]),
  }),
  getSpaceDeck: (id: string) => (id === "s1" ? LIVE : id === "s2" ? PARKED : null),
} as unknown as ArrangementDeck;

const READERS: DeckCardReaders = {
  title: (id) => (id === "b" ? "notes.md" : null),
  masthead: () => null,
  identity: (id) => (id === "b" ? { title: "notes.md", path: "/p/notes.md" } : null),
  activity: (id) => (id === "a" ? "streaming" : null),
  binding: (id) => (id === "a" ? BINDING : null),
  parkedTitle: (id) => (id === "c" ? "tug/odd-kiln" : null),
  waivesClose: (id) => id === "a",
};

/** A record, every fact absent but the ones given. */
function entry(over: Partial<DeckCardFacts> = {}): DeckCardFacts {
  return {
    componentId: "deck-cards-session",
    title: null,
    masthead: null,
    identity: null,
    activity: null,
    binding: null,
    parkedTitle: null,
    waivesClose: false,
    ...over,
  };
}

describe("projectDeckCards", () => {
  test("carries every card of every workspace, with its kind and what the shell knows of it", () => {
    const cards = projectDeckCards(DECK, READERS);
    expect(Object.keys(cards)).toEqual(["a", "b", "c"]);
    expect(cards.a).toEqual(entry({ activity: "streaming", binding: BINDING, waivesClose: true }));
    expect(cards.b).toEqual(
      entry({ componentId: "deck-cards-doc", title: "notes.md", identity: { title: "notes.md", path: "/p/notes.md" } }),
    );
    expect(cards.c).toEqual(entry({ parkedTitle: "tug/odd-kiln" }));
    expect(JSON.parse(JSON.stringify(cards))).toEqual(cards);
  });
});

describe("deckCardTabTitle", () => {
  /** What `paneChromeFor` composed for a tab before tabs went by id. */
  const before = (componentId: string, titleOf: string | null, identityOf: string | null): string =>
    composePaneTitleBarText({
      metaTitle: getRegistration(componentId)?.defaultMeta.title ?? "",
      titleOverride: titleOf ?? identityOf,
    });

  test("names a card with an override, a parked identity, or neither exactly as the projection did", () => {
    const doc = getRegistration("deck-cards-doc");
    const session = getRegistration("deck-cards-session");
    expect(deckCardTabTitle(entry({ componentId: "deck-cards-doc", title: "notes.md" }), doc)).toBe(
      before("deck-cards-doc", "notes.md", null),
    );
    expect(deckCardTabTitle(entry({ parkedTitle: "tug/odd-kiln" }), session)).toBe(
      before("deck-cards-session", null, "tug/odd-kiln"),
    );
    expect(deckCardTabTitle(entry(), session)).toBe(before("deck-cards-session", null, null));
    expect(deckCardTabTitle(entry(), session)).toBe("Session");
  });

  test("an icon is its kind's", () => {
    expect(deckCardIcon(entry(), getRegistration("deck-cards-doc"))).toBe("FileText");
    expect(deckCardIcon(entry(), getRegistration("deck-cards-session"))).toBeNull();
  });
});

describe("movedFacets", () => {
  test("names each facet some other card's record moved, and nothing for the page's own card", () => {
    const prev = { a: entry(), own: entry() };
    expect([...movedFacets(prev, { ...prev, a: entry({ title: "x" }) }, "own")]).toEqual(["title"]);
    expect([...movedFacets(prev, { ...prev, a: entry({ activity: "idle", binding: BINDING }) }, "own")].sort()).toEqual([
      "activity",
      "binding",
    ]);
    expect([...movedFacets(prev, { ...prev, own: entry({ title: "x", activity: "idle" }) }, "own")]).toEqual([]);
    expect([...movedFacets(prev, { own: entry() }, "own")].sort()).toEqual([]);
    expect([...movedFacets(prev, { ...prev, n: entry({ identity: { title: "n" } }) }, "own")]).toEqual(["identity"]);
  });
});

describe("a body's page stores, over the replica", () => {
  let bus: TestBus | undefined;
  afterEach(() => {
    bus?.dispose();
    bus = undefined;
    _resetPageForTest();
  });

  test("a sibling's title set in the shell reaches the body's cardTitleStore with no copy written", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const body = bus.body("own", "deck-cards-session");
    installPage({ role: "body", cardId: "own", componentId: "deck-cards-session" });
    bus.install(body);
    await bus.flush();
    expect(cardTitleStore.get("sib")).toBeNull();

    deckCards.on(shell.bus).set({ sib: entry({ title: "tug/odd-kiln" }), own: entry({ title: "shell's word" }) });
    await bus.flush();
    expect(cardTitleStore.get("sib")).toBe("tug/odd-kiln");
    // The page's own card is the page's: its record is not read.
    expect(cardTitleStore.get("own")).toBeNull();

    // Nothing was copied: the same store, read as the shell, holds nothing for the sibling.
    _resetPageForTest();
    expect(cardTitleStore.get("sib")).toBeNull();
  });
});
