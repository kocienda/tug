/**
 * imposition-sweep.test.ts — the imposition half of the registration filter.
 *
 * A deck's imposition records placements by `componentId`, and those records
 * outlive the cards that earned them on purpose: a rail's `order` still names
 * a member the user closed a week ago, so reopening it puts it back where it
 * was ([L23]). That deliberate persistence is exactly what left the retired
 * card standing in the record long after it was gone — the user's own deck
 * carried a `rails.right.order` naming an id no registration answered for,
 * beside a `shares` map that did not agree with that same `order`.
 *
 * `sweepImposition` is the correction, and its whole design is which of those
 * two facts it keys on: **registration**, never standing. An unregistered id
 * can never stand again, so dropping it costs nothing; a registered id that
 * merely is not standing keeps every byte of its place.
 *
 * Pure over `(imposition, isRegistered)` — no registry, no DOM.
 */

import { describe, expect, test } from "bun:test";

import { filterDeckStateByRegistration, sweepImposition } from "../deck-manager";
import type { DeckImposition } from "../lib/layout-imposer";
import type { DeckState } from "../layout-tree";

/** Registration by membership of a fixed set — the predicate under test. */
function registered(...ids: string[]): (componentId: string) => boolean {
  const live = new Set(ids);
  return (componentId) => live.has(componentId);
}

describe("sweepImposition", () => {
  test("drops a sidebars entry no registration answers for", () => {
    const swept = sweepImposition(
      {
        sidebars: {
          cards: { side: "right" },
          wires: { side: "right" },
        },
      },
      registered("cards"),
    );
    expect(swept.sidebars).toEqual({ cards: { side: "right" } });
  });

  test("clears the user's deck: a dead id in `order`, and `shares` naming two", () => {
    // The shape read off `dev.tugapp.deck.layout` before this landed, with
    // the two dead ids it carried.
    const swept = sweepImposition(
      {
        sidebars: {
          cards: { side: "right" },
          pulses: { side: "right" },
          wires: { side: "right" },
        },
        rails: {
          right: {
            mode: "split",
            order: ["cards", "pulses"],
            shares: { pulses: 1.5255, wires: 0.4744 },
          },
        },
      },
      registered("cards"),
    );
    expect(swept.sidebars).toEqual({ cards: { side: "right" } });
    // `mode` describes the side, not its membership, so it is never touched.
    expect(swept.rails).toEqual({ right: { mode: "split", order: ["cards"] } });
  });

  test("a registered id that is not standing survives both passes", () => {
    // The [L23] boundary. `jots` is closed — nothing on the deck stands for it
    // — but it is registered, so its position and its height are its own.
    const imposition: DeckImposition = {
      sidebars: { overview: { side: "left" } },
      rails: {
        left: { order: ["jots", "overview"], shares: { jots: 0.62, overview: 1.38 } },
      },
    };
    const swept = sweepImposition(imposition, registered("jots", "overview"));
    expect(swept).toBe(imposition);
  });

  test("a side with `shares` and no `order` keeps its registered weights", () => {
    // Nothing to reconcile against, so the second pass must not fire: dropping
    // these weights would erase a real arrangement.
    const swept = sweepImposition(
      {
        sidebars: {},
        rails: { right: { shares: { cards: 1.4, wires: 0.6 } } },
      },
      registered("cards"),
    );
    expect(swept.rails).toEqual({ right: { shares: { cards: 1.4 } } });
  });

  test("a `shares` key absent from a surviving `order` is dropped", () => {
    // Both ids are registered, so pass one keeps them; only the `order` the
    // side actually stores says `dashes` is not a member of this rail.
    const swept = sweepImposition(
      {
        sidebars: {},
        rails: { right: { order: ["cards"], shares: { cards: 1.4, dashes: 0.6 } } },
      },
      registered("cards", "dashes"),
    );
    expect(swept.rails).toEqual({ right: { order: ["cards"], shares: { cards: 1.4 } } });
  });

  test("an `order`, a `shares`, a side and the whole record empty out rather than linger", () => {
    const swept = sweepImposition(
      {
        sidebars: { wires: { side: "right" } },
        rails: { right: { order: ["wires"], shares: { wires: 1 } } },
      },
      registered("cards"),
    );
    expect(swept.sidebars).toEqual({});
    expect("rails" in swept).toBe(false);
  });

  test("an imposition with nothing to sweep comes back by reference", () => {
    const imposition: DeckImposition = {
      kind: "four-up",
      contentWidth: "slim",
      sidebars: { cards: { side: "right" } },
      rails: { right: { mode: "stack", order: ["cards"] } },
    };
    expect(sweepImposition(imposition, registered("cards"))).toBe(imposition);
  });
});

describe("filterDeckStateByRegistration carries the sweep", () => {
  /** A deck whose cards are all live and whose imposition is not. */
  function deckWithDeadPlacement(): DeckState {
    return {
      cards: [{ id: "A", componentId: "cards", title: "Cards", closable: true }],
      panes: [
        {
          id: "p1",
          position: { x: 8, y: 8 },
          size: { width: 416, height: 900 },
          cardIds: ["A"],
          activeCardId: "A",
          title: "Cards",
          acceptsFamilies: [],
        },
      ],
      imposition: {
        sidebars: { cards: { side: "right" }, wires: { side: "right" } },
        rails: { right: { mode: "stack", order: ["cards", "wires"] } },
      },
      hasFocus: true,
    };
  }

  test("an imposition-only edit still returns a new state", () => {
    // A dead id outlives every card that named it, so `changed` cannot be
    // read off the card and pane passes alone — the record would go
    // uncorrected and, because nothing changed, unsaved.
    const state = deckWithDeadPlacement();
    const filtered = filterDeckStateByRegistration(state, registered("cards"));
    expect(filtered).not.toBe(state);
    expect(filtered.imposition.sidebars).toEqual({ cards: { side: "right" } });
    expect(filtered.imposition.rails).toEqual({
      right: { mode: "stack", order: ["cards"] },
    });
    // The cards and panes are untouched — nothing was dropped there.
    expect(filtered.cards).toEqual(state.cards);
    expect(filtered.panes).toEqual(state.panes);
  });

  test("a deck with nothing dead anywhere comes back by reference", () => {
    const state = deckWithDeadPlacement();
    const clean: DeckState = {
      ...state,
      imposition: {
        sidebars: { cards: { side: "right" } },
        rails: { right: { mode: "stack", order: ["cards"] } },
      },
    };
    expect(filterDeckStateByRegistration(clean, registered("cards"))).toBe(clean);
  });
});
