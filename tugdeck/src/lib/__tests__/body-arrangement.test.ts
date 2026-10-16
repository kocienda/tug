/**
 * The arrangement the shell sends a body that lists or moves the whole deck:
 * plain JSON that survives the bus unchanged, every workspace's deck but the
 * live one, the binding and title of every card it holds and of no other,
 * and — as the body sees it — the shell's deck with only the body's own pane
 * re-keyed to the body's pane id. The deck calls a body may make are exactly
 * the seven moves, and never a workspace delete.
 *
 * The arrangement also carries the session phase each card's body reported,
 * for the cards it holds and no other, so a body that lists every card can
 * draw a live dot for a session it has no store for.
 *
 * @covers tugdeck/src/lib/body-arrangement.ts
 */
import { describe, expect, test } from "bun:test";
import type { DeckState, TugPaneState } from "../../layout-tree";
import type { CardSessionBinding } from "../card-session-binding-store";
import {
  BODY_DECK_CALLS,
  arrangementSnapshot,
  isBodyDeckCall,
  projectActivities,
  projectArrangement,
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

const BINDING: CardSessionBinding = {
  tugSessionId: "tug-a",
  lineId: "line-a",
  workspaceKey: "wk",
  projectDir: "/p",
  sessionMode: "resume",
};

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

const projected = () =>
  projectArrangement(
    deck,
    (id) => (id === "a" || id === "elsewhere" ? BINDING : undefined),
    (id) => (id === "b" ? { title: "tug/odd-kiln", masthead: null } : id === "elsewhere" ? { title: "x", masthead: null } : null),
    (id) => (id === "b" ? { title: "notes.md", path: "/p/notes.md", unsaved: true } : id === "elsewhere" ? { title: "y" } : null),
    activityOf,
  );

const activityOf = (id: string): string | null =>
  id === "a" ? "streaming" : id === "b" ? "idle" : id === "elsewhere" ? "tool_work" : null;

describe("projectArrangement", () => {
  test("round-trips through JSON unchanged", () => {
    const arrangement = projected();
    expect(JSON.parse(JSON.stringify(arrangement))).toEqual(arrangement);
  });

  test("carries every workspace's deck but the live one, and the per-workspace counts", () => {
    const { spaces, deck: live, bandWidth, columnRunHeight, railRunHeight } = projected();
    expect(live).toBe(LIVE);
    expect(Object.keys(spaces.decks)).toEqual(["s2"]);
    expect(spaces.spaces).toEqual([{ id: "s1", name: "Main", theme: "ironclad" }, { id: "s2", name: "Side" }]);
    expect(spaces.liveSessions).toEqual({ s1: 1, s2: 0 });
    expect(spaces.cardCounts).toEqual({ s1: 2, s2: 1 });
    expect([bandWidth, columnRunHeight, railRunHeight]).toEqual([1600, 900, 880]);
  });

  test("carries the binding, title and live identity of every card it holds, across workspaces, and of no other", () => {
    const { bindings, titles, identities } = projected();
    expect(Object.keys(bindings)).toEqual(["a"]);
    expect(titles).toEqual({ b: { title: "tug/odd-kiln", masthead: null } });
    expect(identities).toEqual({ b: { title: "notes.md", path: "/p/notes.md", unsaved: true } });
  });

  test("carries the reported phase of every card it holds that has one, across workspaces, and of no other", () => {
    const { activities } = projected();
    expect(activities).toEqual({ a: "streaming", b: "idle" });
    // The same projection the shell fingerprints to resend only on a phase change.
    expect(projectActivities(deck, activityOf)).toEqual(activities);
    expect(JSON.stringify(projectActivities(deck, activityOf))).toBe(JSON.stringify(projectActivities(deck, activityOf)));
  });

  test("a card whose body has not reported is absent, never idle by assumption", () => {
    expect(projectActivities(deck, () => null)).toEqual({});
    expect(Object.keys(projectArrangement(deck, () => undefined, () => null, () => null, () => null).activities)).toEqual([]);
  });
});

describe("arrangementSnapshot", () => {
  test("re-keys only the card's own pane, and the marks that name it", () => {
    const seen = arrangementSnapshot(projected(), "cards", "body-pane-cards");
    expect(seen.panes.map((p) => p.id)).toEqual(["body-pane-cards", "p-a"]);
    expect(seen.activePaneId).toBe("body-pane-cards");
    expect(seen.arriving).toEqual({ "body-pane-cards": true });
    expect(seen.bullseyePaneId).toBe("p-a");
    expect(seen.cards).toBe(LIVE.cards);
  });

  test("a card the deck does not hold sees the deck as it is", () => {
    expect(arrangementSnapshot(projected(), "nowhere", "body-pane-nowhere")).toBe(LIVE);
  });
});

describe("the deck calls a body may make", () => {
  test("are exactly the seven moves, and never a workspace delete", () => {
    expect([...BODY_DECK_CALLS].sort() as string[]).toEqual(
      [
        "activateSpace",
        "chooseSpaceTheme",
        "moveCardToSpace",
        "previewFlowOffset",
        "renameSpace",
        "reorderSpaces",
        "setFlowOffset",
      ].sort(),
    );
    expect(isBodyDeckCall("deleteSpace")).toBe(false);
    expect(isBodyDeckCall("setFlowOffset")).toBe(true);
  });
});
