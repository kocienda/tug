/**
 * The departing mark's pure helpers (`lib/departing.ts`).
 *
 * The store publishes `composeDeparting(standing, record)` and every reader
 * that lists or counts reads `standingDeck` of it, so the two have to be exact
 * inverses: a composed deck stripped is the standing deck it came from. And the
 * mark is session state, so neither a park nor a save may carry it.
 */

import { describe, test, expect } from "bun:test";
import {
  composeDeparting,
  isPaneDeparting,
  standingDeck,
  withDepartingStanding,
  type DepartingEntry,
} from "../lib/departing";
import {
  validateDeckState,
  type CardState,
  type DeckState,
  type TugPaneState,
} from "../layout-tree";
import { parkedDeck, wrapAsMainSpace } from "../spaces";
import { serialize } from "../serialization";

function card(id: string): CardState {
  return { id, componentId: "terminal", title: id, closable: true };
}

function pane(id: string, cardIds: readonly string[]): TugPaneState {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    cardIds,
    activeCardId: cardIds[0],
    title: "",
    acceptsFamilies: ["standard"],
  };
}

/** Five panes, `pa` holding two cards, so a removal has more than one card to carry. */
const full: DeckState = {
  cards: ["ca", "ca2", "cb", "cc", "cd", "ce"].map(card),
  panes: [
    pane("pa", ["ca", "ca2"]),
    pane("pb", ["cb"]),
    pane("pc", ["cc"]),
    pane("pd", ["cd"]),
    pane("pe", ["ce"]),
  ],
  activePaneId: "pa",
  imposition: { sidebars: {} },
  hasFocus: true,
};

/** `deck` with `paneId` closed, and the entry the deck manager would record for it. */
function close(deck: DeckState, paneId: string): { standing: DeckState; entry: DepartingEntry } {
  const index = deck.panes.findIndex((p) => p.id === paneId);
  const closed = deck.panes[index];
  const gone = new Set(closed.cardIds);
  return {
    standing: {
      ...deck,
      panes: deck.panes.filter((p) => p.id !== paneId),
      cards: deck.cards.filter((c) => !gone.has(c.id)),
    },
    entry: { pane: closed, cards: deck.cards.filter((c) => gone.has(c.id)), index },
  };
}

describe("composeDeparting", () => {
  test("returns the standing deck itself when nothing departs", () => {
    expect(composeDeparting(full, [])).toBe(full);
  });

  test("puts a departing pane back at its index, with its cards, marked, and valid", () => {
    const { standing, entry } = close(full, "pb");
    const composed = composeDeparting(standing, [entry]);
    expect(composed.panes.map((p) => p.id)).toEqual(["pa", "pb", "pc", "pd", "pe"]);
    expect(composed.cards.map((c) => c.id).sort()).toEqual(full.cards.map((c) => c.id).sort());
    expect(composed.departing).toEqual({ pb: true });
    expect(isPaneDeparting(composed, "pb")).toBe(true);
    expect(isPaneDeparting(composed, "pc")).toBe(false);
    expect(() => validateDeckState(composed)).not.toThrow();
  });

  test("clamps an index past the end of the standing deck", () => {
    const { standing, entry } = close(full, "pe");
    const shorter = { ...standing, panes: standing.panes.slice(0, 2), cards: standing.cards };
    const composed = composeDeparting(shorter, [{ ...entry, index: 99 }]);
    expect(composed.panes.map((p) => p.id)).toEqual(["pa", "pb", "pe"]);
  });

  test("two panes closed in sequence compose at their own indices", () => {
    const first = close(full, "pb");
    const second = close(first.standing, "pd");
    const composed = composeDeparting(second.standing, [first.entry, second.entry]);
    expect(composed.panes.map((p) => p.id)).toEqual(["pa", "pb", "pc", "pd", "pe"]);
    expect(composed.departing).toEqual({ pb: true, pd: true });
    expect(() => validateDeckState(composed)).not.toThrow();
  });

  test("landing one of two departures leaves the other composed where it stood", () => {
    const first = close(full, "pb");
    const second = close(first.standing, "pd");
    const firstLanded = composeDeparting(second.standing, [second.entry]);
    expect(firstLanded.panes.map((p) => p.id)).toEqual(["pa", "pc", "pd", "pe"]);
    expect(firstLanded.departing).toEqual({ pd: true });
    const secondLanded = composeDeparting(second.standing, [first.entry]);
    expect(secondLanded.panes.map((p) => p.id)).toEqual(["pa", "pb", "pc", "pe"]);
    expect(secondLanded.departing).toEqual({ pb: true });
  });
});

describe("standingDeck", () => {
  test("is the identity when nothing departs", () => {
    expect(standingDeck(full)).toBe(full);
  });

  test("strips a composed deck back to the standing deck it came from, stably", () => {
    const first = close(full, "pa");
    const second = close(first.standing, "pd");
    const composed = composeDeparting(second.standing, [first.entry, second.entry]);
    const stripped = standingDeck(composed);
    expect(stripped).toEqual(second.standing);
    expect("departing" in stripped).toBe(false);
    expect(standingDeck(composed)).toBe(stripped);
  });
});

describe("withDepartingStanding", () => {
  test("keeps the departing panes and drops only the mark", () => {
    const { standing, entry } = close(full, "pc");
    const composed = composeDeparting(standing, [entry]);
    const asIf = withDepartingStanding(composed);
    expect(asIf.panes).toBe(composed.panes);
    expect(asIf.cards).toBe(composed.cards);
    expect("departing" in asIf).toBe(false);
    expect(withDepartingStanding(full)).toBe(full);
  });
});

describe("the mark is session state", () => {
  const { standing, entry } = close(full, "pc");
  const composed = composeDeparting(standing, [entry]);

  test("serialize writes no departing key", () => {
    const json = JSON.stringify(serialize(wrapAsMainSpace(composed)));
    expect(json).not.toContain("departing");
  });

  test("a parked deck carries no departing mark", () => {
    expect("departing" in parkedDeck(composed)).toBe(false);
  });
});
