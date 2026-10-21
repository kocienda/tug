/**
 * The `card.context` the shell publishes for a body reads the card's own deck: a
 * parked card's fold is its parked record's, and a parked card is never key
 * there: the shell's first responder stays the shown workspace's. It carries
 * the moves and resizes the shell counted for the card, which its body fires
 * its own events from.
 *
 * @covers tugdeck/src/lib/body-shell.ts
 */
import { describe, expect, test } from "bun:test";

import type { IDeckManagerStore } from "../../deck-manager-store";
import type { DeckState, TugPaneState } from "../../layout-tree";
import { cardContextFor, createCardGeometryCounts, crossingForBody } from "../body-shell";
import type { CrossingMirror } from "../fold-crossing";

function pane(id: string, cardId: string, folded = false): TugPaneState {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 600 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["standard"],
    ...(folded ? { folded: true } : {}),
  };
}

function deckOf(cards: string[], activePaneId: string, folded: string[] = []): DeckState {
  return {
    cards: cards.map((id) => ({ id, componentId: "session", title: "", closable: true })),
    panes: cards.map((id) => pane(`p-${id}`, id, folded.includes(id))),
    activePaneId,
    imposition: { sidebars: {} },
    hasFocus: true,
  };
}

/** A shell with `one` shown and `two` parked and visited. */
function shell(options: { folded?: string[] } = {}): IDeckManagerStore {
  const live = deckOf(["a"], "p-a");
  const parked = deckOf(["k", "n"], "p-k", options.folded ?? []);
  const spaces = {
    spaces: [
      { id: "one", name: "One" },
      { id: "two", name: "Two" },
    ],
    activeSpaceId: "one",
    mountedSpaceIds: ["one", "two"],
    mountedDecks: new Map([["two", parked]]),
  };
  return {
    getSnapshot: () => live,
    getSpacesSnapshot: () => spaces,
    getFirstResponderCardId: () => "a",
    spaceOf: (cardId: string) => (live.cards.some((c) => c.id === cardId) ? "one" : "two"),
    getSpaceDeck: (spaceId: string) => (spaceId === "one" ? live : parked),
  } as unknown as IDeckManagerStore;
}

describe("cardContextFor", () => {
  test("a parked workspace's key card is told its own layer is hidden and another card is first responder", () => {
    expect(cardContextFor(shell(), "k")).toEqual({
      folded: false,
      arriving: false,
      firstResponderCardId: "a",
      layerShown: false,
      spaceId: "two",
      geometry: { moves: 0, resizes: 0 },
    });
  });

  test("a parked card's fold is its own deck's", () => {
    expect(cardContextFor(shell({ folded: ["n"] }), "n").folded).toBe(true);
  });

  test("a committed move bumps the moves the card's published context carries, and a resize its resizes", () => {
    const deck = shell();
    const published: Array<{ cardId: string; moves: number; resizes: number }> = [];
    const counts = createCardGeometryCounts((cardId) => {
      published.push({ cardId, ...cardContextFor(deck, cardId, counts.of(cardId)).geometry });
    });
    expect(cardContextFor(deck, "a", counts.of("a")).geometry).toEqual({ moves: 0, resizes: 0 });
    counts.count("a", "moves");
    counts.count("a", "resizes");
    counts.count("k", "moves");
    expect(published).toEqual([
      { cardId: "a", moves: 1, resizes: 0 },
      { cardId: "a", moves: 1, resizes: 1 },
      { cardId: "k", moves: 1, resizes: 0 },
    ]);
    counts.forget("a");
    expect(counts.of("a")).toEqual({ moves: 0, resizes: 0 });
  });
});

describe("crossingForBody", () => {
  const still = (stamp: number, settled: boolean, held: string): CrossingMirror => ({
    still: stamp,
    settled,
    width: false,
    heightFree: false,
    fold: null,
    held: { "--tugx-still-held-height": held },
  });

  test("a still crossing is sent once it has settled, not while it holds the First size", () => {
    expect(crossingForBody(still(5, false, "509px"), null)).toBeNull();
    const settled = still(7, true, "950px");
    expect(crossingForBody(settled, null)).toBe(settled);
    // A retarget re-arms: until it settles, the body keeps what it was sent.
    expect(crossingForBody(still(9, false, "950px"), settled)).toBe(settled);
  });

  test("a fold and the crossing's end go at once", () => {
    const fold: CrossingMirror = { ...still(5, false, "509px"), fold: 3 };
    expect(crossingForBody(fold, null)).toBe(fold);
    expect(crossingForBody(null, still(7, true, "950px"))).toBeNull();
  });
});
