/**
 * The arrangement the shell projects for its bodies: plain JSON that survives
 * the bus unchanged, every workspace's deck but the live one, and — as the
 * body sees it — the shell's deck with only the body's own pane re-keyed to
 * the body's pane id. Every card's record (`projectDeckCards`) is
 * `deck-cards.test.ts`'s.
 *
 * @covers tugdeck/src/lib/body-arrangement.ts
 */
import { describe, expect, test } from "bun:test";
import type { DeckState, TugPaneState } from "../../layout-tree";
import {
  arrangementSnapshot,
  projectArrangementDeck,
  projectArrangementSpaces,
  type ArrangementDeck,
} from "../body-arrangement";

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

function deckOf(panes: TugPaneState[], extra: Partial<DeckState> = {}): DeckState {
  return {
    cards: panes.flatMap((p) => p.cardIds.map((id) => ({ id, componentId: "session", title: "", closable: true }))),
    panes,
    imposition: { sidebars: {} },
    hasFocus: true,
    ...extra,
  };
}

const LIVE = deckOf([pane("p-cards", ["cards"]), pane("p-a", ["a"])], {
  activePaneId: "p-cards",
  arriving: { "p-cards": true },
  bullseyePaneId: "p-a",
});
const PARKED = deckOf([pane("p-b", ["b"])]);

const deck: ArrangementDeck = {
  getSnapshot: () => LIVE,
  getSpacesSnapshot: () => ({
    spaces: [{ id: "s1", name: "Main", theme: "ironclad" }, { id: "s2", name: "Side" }],
    activeSpaceId: "s1",
    mountedSpaceIds: ["s1", "s2"],
    mountedDecks: new Map([["s2", PARKED]]),
  }),
  getSpaceDeck: (id) => (id === "s1" ? LIVE : id === "s2" ? PARKED : null),
  spaceHoldsLiveSessions: (id) => (id === "s1" ? 1 : 0),
  spaceCardCount: (id) => (id === "s1" ? 2 : 1),
  getBandWidth: () => 1600,
  getColumnRunHeight: () => 900,
  getRailRunHeight: () => 880,
};

describe("the arrangement projections", () => {
  test("round-trip through JSON unchanged", () => {
    for (const projected of [projectArrangementDeck(deck), projectArrangementSpaces(deck)]) {
      expect(JSON.parse(JSON.stringify(projected))).toEqual(projected);
    }
  });

  test("carry every workspace's deck but the live one, and the per-workspace counts", () => {
    const { deck: live, bandWidth, columnRunHeight, railRunHeight } = projectArrangementDeck(deck);
    const spaces = projectArrangementSpaces(deck);
    expect(live).toBe(LIVE);
    expect(Object.keys(spaces.decks)).toEqual(["s2"]);
    expect(spaces.spaces).toEqual([{ id: "s1", name: "Main", theme: "ironclad" }, { id: "s2", name: "Side" }]);
    expect(spaces.liveSessions).toEqual({ s1: 1, s2: 0 });
    expect(spaces.cardCounts).toEqual({ s1: 2, s2: 1 });
    expect([bandWidth, columnRunHeight, railRunHeight]).toEqual([1600, 900, 880]);
  });
});

describe("arrangementSnapshot", () => {
  test("re-keys only the card's own pane, and the marks that name it", () => {
    const seen = arrangementSnapshot(LIVE, "cards", "body-pane-cards");
    expect(seen.panes.map((p) => p.id)).toEqual(["body-pane-cards", "p-a"]);
    expect(seen.activePaneId).toBe("body-pane-cards");
    expect(seen.arriving).toEqual({ "body-pane-cards": true });
    expect(seen.bullseyePaneId).toBe("p-a");
    expect(seen.cards).toBe(LIVE.cards);
  });

  test("a card the deck does not hold sees the deck as it is", () => {
    expect(arrangementSnapshot(LIVE, "nowhere", "body-pane-nowhere")).toBe(LIVE);
  });
});
