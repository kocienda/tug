/**
 * The `card-context` the shell sends a body reads the card's own deck: a
 * parked card's fold is its parked record's, and the card a warm workspace's
 * first visit will make key is told so (`parkedKey`) — only in a workspace
 * nobody has shown, so a visited workspace's key card is deactivated when it
 * parks, as ever.
 *
 * @covers tugdeck/src/lib/body-shell.ts
 */
import { describe, expect, test } from "bun:test";

import type { IDeckManagerStore } from "../../deck-manager-store";
import type { DeckState, TugPaneState } from "../../layout-tree";
import { cardContextFor } from "../body-shell";

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

/** A shell with `one` shown and `two` parked, warm unless `visited`. */
function shell(options: { visited?: boolean; folded?: string[] } = {}): IDeckManagerStore {
  const live = deckOf(["a"], "p-a");
  const parked = deckOf(["k", "n"], "p-k", options.folded ?? []);
  const spaces = {
    spaces: [
      { id: "one", name: "One" },
      { id: "two", name: "Two" },
    ],
    activeSpaceId: "one",
    mountedSpaceIds: ["one", "two"],
    warmSpaceIds: options.visited === true ? [] : ["two"],
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
  test("a warm workspace's key card is told it is the parked key, and nothing else there is", () => {
    const deck = shell();
    expect(cardContextFor(deck, "k")).toEqual({
      folded: false,
      arriving: false,
      firstResponderCardId: "a",
      layerShown: false,
      spaceId: "two",
      parkedKey: true,
    });
    expect(cardContextFor(deck, "n").parkedKey).toBeUndefined();
    expect(cardContextFor(deck, "a").parkedKey).toBeUndefined();
  });

  test("a visited workspace's key card is not the parked key", () => {
    expect(cardContextFor(shell({ visited: true }), "k").parkedKey).toBeUndefined();
  });

  test("a parked card's fold is its own deck's", () => {
    expect(cardContextFor(shell({ folded: ["n"] }), "n").folded).toBe(true);
  });
});
