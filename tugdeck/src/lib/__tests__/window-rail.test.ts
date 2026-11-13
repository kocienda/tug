/**
 * The window rail ([B09], Spec S05): split and join are inverses, the
 * migration keeps the active workspace's rail and drops every other copy,
 * and a parked deck arranged with the rail joined stands its content where
 * the shown deck does.
 */

import { describe, test, expect } from "bun:test";
import { registerCard } from "../../card-registry";
import type { CardState, DeckState, TugPaneState } from "../../layout-tree";
import { validateDeckState } from "../../layout-tree";
import { deckColumnsOf, sidebarRailsOf } from "../../deck-store-selectors";
import type { SpacesState } from "../../spaces";
import {
  EMPTY_WINDOW_RAIL,
  holdsRail,
  joinRail,
  lastingRail,
  migrateToWindowRail,
  splitRail,
} from "../window-rail";

for (const componentId of ["wr-cards", "wr-layout"]) {
  registerCard({
    componentId,
    contentFactory: () => null,
    defaultMeta: { title: componentId, closable: true },
    layoutRole: "sidebar",
  });
}
registerCard({
  componentId: "wr-text",
  contentFactory: () => null,
  defaultMeta: { title: "Text", closable: true },
});

function card(id: string, componentId: string): CardState {
  return { id, componentId, title: id, closable: true };
}

function pane(id: string, cardIds: string[], extra: Partial<TugPaneState> = {}): TugPaneState {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width: 300, height: 600 },
    cardIds,
    activeCardId: cardIds[0],
    title: id,
    acceptsFamilies: [],
    ...extra,
  };
}

/** A workspace deck: `prefix`'s two content cards in two slots, and a rail on each side. */
function deck(prefix: string, opts: { railActive?: boolean; hidden?: boolean } = {}): DeckState {
  return {
    cards: [
      card(`${prefix}-t1`, "wr-text"),
      card(`${prefix}-t2`, "wr-text"),
      card(`${prefix}-cards`, "wr-cards"),
      card(`${prefix}-layout`, "wr-layout"),
    ],
    panes: [
      pane(`${prefix}-p1`, [`${prefix}-t1`], { slot: 0 }),
      pane(`${prefix}-p2`, [`${prefix}-t2`], { slot: 1 }),
      pane(`${prefix}-rc`, [`${prefix}-cards`], { size: { width: 260, height: 600 } }),
      pane(`${prefix}-rl`, [`${prefix}-layout`], { size: { width: 320, height: 600 } }),
    ],
    activePaneId: opts.railActive === true ? `${prefix}-rc` : `${prefix}-p2`,
    imposition: {
      kind: "two-up",
      sidebars: { "wr-cards": { side: "left" }, "wr-layout": { side: "right" } },
      rails: {
        left: { order: ["wr-cards"] },
        right: opts.hidden === true ? { hidden: ["wr-layout"] } : { order: ["wr-layout"] },
      },
    },
    hasFocus: true,
  };
}

describe("splitRail / joinRail", () => {
  test("round trips a deck with a rail on both sides", () => {
    const d = deck("a");
    validateDeckState(d);
    const { deck: bare, rail } = splitRail(d);
    expect(holdsRail(bare)).toBe(false);
    expect(bare.panes.map((p) => p.id)).toEqual(["a-p1", "a-p2"]);
    expect(bare.imposition.sidebars).toEqual({});
    expect(bare.imposition.rails).toBeUndefined();
    expect(rail.cards.map((c) => c.id)).toEqual(["a-cards", "a-layout"]);
    validateDeckState(bare);
    expect(joinRail(bare, rail)).toEqual(d);
  });

  test("round trips a deck whose rail is hidden", () => {
    const d = deck("a", { hidden: true });
    const { deck: bare, rail } = splitRail(d);
    expect(rail.rails?.right?.hidden).toEqual(["wr-layout"]);
    expect(joinRail(bare, rail)).toEqual(d);
  });

  test("round trips a deck whose active pane is a rail pane", () => {
    const d = deck("a", { railActive: true });
    const { deck: bare, rail } = splitRail(d);
    expect(bare.activePaneId).toBeUndefined();
    expect(rail.activePaneId).toBe("a-rc");
    validateDeckState(bare);
    expect(joinRail(bare, rail)).toEqual(d);
  });

  test("carries a rail member's session records and leaves the content's", () => {
    const d: DeckState = {
      ...deck("a"),
      railOffsets: { left: 12 },
      sheetReservations: { "wr-cards": 200, "a-p1": 300 },
      openingBids: { "wr-layout": 150 },
    };
    const { deck: bare, rail } = splitRail(d);
    expect(bare.sheetReservations).toEqual({ "a-p1": 300 });
    expect(bare.openingBids).toBeUndefined();
    expect(bare.railOffsets).toBeUndefined();
    expect(rail.sheetReservations).toEqual({ "wr-cards": 200 });
    expect(lastingRail(rail).sheetReservations).toBeUndefined();
    expect(joinRail(bare, rail)).toEqual(d);
  });

  test("a deck with no rail splits to an empty rail and joins back unchanged", () => {
    const d: DeckState = {
      ...deck("a"),
      cards: deck("a").cards.slice(0, 2),
      panes: deck("a").panes.slice(0, 2),
      imposition: { kind: "two-up", sidebars: {} },
    };
    const { deck: bare, rail } = splitRail(d);
    expect(rail).toEqual(EMPTY_WINDOW_RAIL);
    expect(joinRail(bare, rail)).toEqual(d);
  });

  test("joins one workspace's rail into another's deck", () => {
    const { rail } = splitRail(deck("a"));
    const { deck: other } = splitRail(deck("b"));
    const joined = joinRail(other, rail);
    validateDeckState(joined);
    expect(joined.cards.map((c) => c.id)).toEqual(["b-t1", "b-t2", "a-cards", "a-layout"]);
    expect(joined.activePaneId).toBe("b-p2");
  });
});

describe("parked parity", () => {
  test("a parked deck joined with the rail stands its content as the shown deck does", () => {
    const shown = deck("a");
    const runs = { rail: 800, column: 700 };
    const { deck: parked, rail } = splitRail(shown);
    const joined = joinRail(parked, rail);
    const widths = (d: DeckState) => sidebarRailsOf(d, runs).map((r) => [r.side, r.width]);
    expect(widths(joined)).toEqual(widths(shown));
    expect(deckColumnsOf(joined, runs.column)).toEqual(deckColumnsOf(shown, runs.column));
    // Without the rail the content would stand on the whole canvas.
    expect(sidebarRailsOf(parked, runs)).toEqual([]);
  });
});

describe("migrateToWindowRail", () => {
  test("keeps the active workspace's rail and removes every other copy", () => {
    const names = ["a", "b", "c", "d", "e"];
    const state: SpacesState = {
      spaces: names.map((n) => ({
        id: n,
        name: n,
        deck: deck(n, { railActive: n === "d" }),
        focusedCardId: n === "e" ? "e-cards" : `${n}-t1`,
      })),
      activeSpaceId: "c",
    };
    const migrated = migrateToWindowRail(state);
    expect(migrated.rail?.cards.map((c) => c.id)).toEqual(["c-cards", "c-layout"]);
    expect(migrated.rail?.sidebars).toEqual(deck("c").imposition.sidebars);
    for (const space of migrated.spaces) {
      expect(holdsRail(space.deck)).toBe(false);
      validateDeckState(space.deck);
    }
    // A workspace whose active pane was a rail pane falls back to its frontmost content pane.
    expect(migrated.spaces.find((s) => s.id === "d")?.deck.activePaneId).toBe("d-p2");
    // A remembered focus on a removed rail card is forgotten.
    expect(migrated.spaces.find((s) => s.id === "e")?.focusedCardId).toBeUndefined();
    expect(migrated.spaces.find((s) => s.id === "a")?.focusedCardId).toBe("a-t1");
    // The active deck joined with the rail is the active workspace as it was.
    const active = migrated.spaces.find((s) => s.id === "c")!;
    expect(joinRail(active.deck, migrated.rail!)).toEqual(deck("c"));
  });
});
