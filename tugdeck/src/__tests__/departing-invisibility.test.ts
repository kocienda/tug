/**
 * departing-invisibility.test.ts — a departing pane is invisible to every
 * reader that lists or counts.
 *
 * The store publishes a closed pane, its cards and a `departing` mark for the
 * one settle that carries it out (`lib/departing.ts`). For that half second
 * the pane is still in `panes`, so any reader that walks the array would count
 * it, seat it, ring it, menu it or list it. The rule is that such a reader
 * begins with `standingDeck`, and this is the property that holds it to the
 * rule: over a deck `D` and each pane `X` in it, every reader returns for the
 * composed deck `Dd = composeDeparting(D − X, [entry(X)])` exactly what it
 * returns for `D − X`.
 *
 * The readers are named one by one rather than discovered, so a new one that
 * lists or counts is a line added here. A by-id lookup is deliberately not
 * here: a departing card's own content reads itself that way and must still
 * find itself. The one by-id reader that IS here is `panePlaceFactsOf`, whose
 * answer for the departing pane is read as if it still stood, so its badge
 * does not change mid-fade.
 *
 * Real registrations via `registerCard`, because a rail is derived from
 * `layoutRole: "sidebar"` and sorted into registration order.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";

import { registerCard } from "../card-registry";
import type { CardState, DeckState, TugPaneState } from "../layout-tree";
import { composeDeparting, type DepartingEntry } from "../lib/departing";
import {
  bullseyePaneIdOf,
  columnAllocationOf,
  columnBadgeFactsOf,
  columnMembersOf,
  columnMoveOrder,
  countWorkCards,
  deckColumnsOf,
  deckFlowStrip,
  deckSlotStrip,
  deckVacancyExtent,
  findSidebarPanes,
  parkedSidebarPaneIds,
  placeMembers,
  railAllocationOf,
  railMembersOf,
  railMembersToPark,
  sidebarRailsOf,
  slotStackOf,
  workspacePanes,
} from "../deck-store-selectors";
import { stepCardRing, visibleCardCount, visibleCardRing } from "../lib/card-ring";
import { projectDeckState } from "../lib/host-menu-state";
import { resolveCloseSuccessor } from "../lib/close-successor";
import { focusTravelDirections, resolveDirectionalFocus } from "../lib/directional-focus";
import {
  contentCardsInLayoutSelection,
  resolveColumnMenuFact,
  resolveLayoutSelection,
} from "../lib/layout-selection";
import { panePlaceFactsOf, slotStacksOf } from "../components/chrome/pane-place-facts";
import { buildCardsRows, type LensCardsInputs } from "../components/cards/cards-data-source";
import { readOpeningDeck } from "../lib/opening-placement";
import { enumerateDropZones, type DropZoneMeasurements } from "../lib/drop-zones";
import { frontPaneOfSlot } from "../components/layout/miniature-gestures";
import { setLayoutCursorCard } from "../components/cards/cards-selection-store";
import type { IDeckManagerStore } from "../deck-manager-store";
import type { Rect } from "../snap";

beforeAll(() => {
  for (const componentId of ["invTop", "invBottom"]) {
    registerCard({
      componentId,
      contentFactory: () => null,
      defaultMeta: { title: componentId, closable: true },
      layoutRole: "sidebar",
    });
  }
  registerCard({
    componentId: "invContent",
    contentFactory: () => null,
    defaultMeta: { title: "Content", closable: true },
  });
});

afterEach(() => setLayoutCursorCard(null));

function card(id: string, componentId: string): CardState {
  return { id, componentId, title: id, closable: true };
}

function pane(id: string, cardIds: readonly string[], extra: Partial<TugPaneState> = {}): TugPaneState {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width: 320, height: 600 },
    cardIds,
    activeCardId: cardIds[0],
    title: "",
    acceptsFamilies: ["standard"],
    ...extra,
  };
}

/**
 * A flow strip of three slots: slot 0 a split column of three members, slot 1
 * one card holding two tabs, slot 2 one card; and a two-member left rail.
 */
const D: DeckState = {
  cards: [
    card("c-top", "invTop"),
    card("c-bottom", "invBottom"),
    card("c-a", "invContent"),
    card("c-b", "invContent"),
    card("c-c", "invContent"),
    card("c-d", "invContent"),
    card("c-d2", "invContent"),
    card("c-e", "invContent"),
  ],
  panes: [
    pane("p-top", ["c-top"], { acceptsFamilies: [] }),
    pane("p-bottom", ["c-bottom"], { acceptsFamilies: [] }),
    pane("p-a", ["c-a"], { slot: 0 }),
    pane("p-b", ["c-b"], { slot: 0 }),
    pane("p-c", ["c-c"], { slot: 0 }),
    pane("p-d", ["c-d", "c-d2"], { slot: 1, size: { width: 480, height: 600 } }),
    pane("p-e", ["c-e"], { slot: 2 }),
  ],
  activePaneId: "p-b",
  bullseyePaneId: "p-b",
  imposition: {
    kind: "three-up",
    layout: "flow",
    sidebars: {
      invTop: { side: "left", pinned: true },
      invBottom: { side: "left", pinned: true },
    },
    columns: { 0: { mode: "split", order: ["p-a", "p-b", "p-c"] } },
  },
  hasFocus: true,
};

/** `D` with `paneId` closed, and the entry the deck manager would record for it. */
function closed(paneId: string): { standing: DeckState; entry: DepartingEntry } {
  const index = D.panes.findIndex((p) => p.id === paneId);
  const leaving = D.panes[index];
  const gone = new Set(leaving.cardIds);
  const standing: DeckState = {
    ...D,
    panes: D.panes.filter((p) => p.id !== paneId),
    cards: D.cards.filter((c) => !gone.has(c.id)),
  };
  if (standing.activePaneId === paneId) delete standing.activePaneId;
  if (standing.bullseyePaneId === paneId) delete standing.bullseyePaneId;
  return {
    standing,
    entry: { pane: leaving, cards: D.cards.filter((c) => gone.has(c.id)), index },
  };
}

function storeOver(state: DeckState): IDeckManagerStore {
  return {
    getSnapshot: () => state,
    getFirstResponderCardId: () => {
      if (state.activePaneId === undefined) return null;
      return state.panes.find((p) => p.id === state.activePaneId)?.activeCardId ?? null;
    },
  } as unknown as IDeckManagerStore;
}

function cardsInputs(state: DeckState): LensCardsInputs {
  return {
    spaces: [{ id: "s1", name: "Main", active: true, expanded: true, deck: state }],
    cardsRowOrder: { sessions: [], files: [], tools: [] },
    groupOrder: [],
    collapsedGroups: [],
    filterQuery: "",
    registryVersion: 0,
    bindings: new Map(),
    tagVersion: 0,
    nameVersion: 0,
    changesets: null,
    bindingsCache: new Map(),
  } as unknown as LensCardsInputs;
}

const RECT = (x: number): Rect => ({ x, y: 0, width: 320, height: 600 });

const MEASURED: DropZoneMeasurements = {
  slots: new Map([
    [0, RECT(400)],
    [1, RECT(740)],
    [2, RECT(1240)],
  ]),
  panes: new Map(D.panes.map((p, i) => [p.id, RECT(i * 100)])),
  tabBars: new Map(),
  rails: [{ side: "left", members: ["p-top", "p-bottom"] }],
  members: new Map(),
  runs: { column: 900, rail: 900 },
  draggedAtStart: RECT(740),
  railVacancies: {},
} as unknown as DropZoneMeasurements;

const RUNS = { rail: 900, column: 900 };
const DIRECTIONS = ["left", "right", "above", "below"] as const;

/** Every reader in the list, as a name and what it answers over one deck. */
function readers(paneIds: readonly string[], cardIds: readonly string[]): [string, (s: DeckState) => unknown][] {
  // A gesture names a pane that is still there, so the drag is always of one
  // that is not departing.
  const dragged = (s: DeckState) => (s.departing?.["p-d"] === true || !s.panes.some((p) => p.id === "p-d") ? "p-e" : "p-d");
  return [
    ["findSidebarPanes", (s) => findSidebarPanes(s)],
    ["workspacePanes", (s) => workspacePanes(s)],
    ["parkedSidebarPaneIds", (s) => [...parkedSidebarPaneIds(s)]],
    ["railMembersToPark", (s) => railMembersToPark(s, "left")],
    ["slotStackOf", (s) => [0, 1, 2].map((slot) => slotStackOf(s, slot))],
    ["bullseyePaneIdOf", (s) => bullseyePaneIdOf(s)],
    ["deckFlowStrip", (s) => deckFlowStrip(s)],
    ["deckSlotStrip", (s) => deckSlotStrip(s, 1600)],
    ["deckVacancyExtent", (s) => deckVacancyExtent(s)],
    ["deckColumnsOf", (s) => deckColumnsOf(s, 900)],
    ["columnMembersOf", (s) => [0, 1, 2].map((slot) => columnMembersOf(s, slot))],
    ["placeMembers", (s) => placeMembers(s, "column", ["p-a", "p-b", "p-c"], undefined)],
    ["railMembersOf", (s) => railMembersOf(s, "left")],
    ["railAllocationOf", (s) => railAllocationOf(s, "left", 900)],
    ["columnAllocationOf", (s) => columnAllocationOf(s, 0, 900)],
    ["columnBadgeFactsOf", (s) => cardIds.map((id) => columnBadgeFactsOf(s, id))],
    ["columnMoveOrder", (s) => paneIds.map((id) => columnMoveOrder(s, id))],
    ["countWorkCards", (s) => countWorkCards(s)],
    ["sidebarRailsOf", (s) => sidebarRailsOf(s, RUNS)],
    ["visibleCardRing", (s) => visibleCardRing(s)],
    ["visibleCardCount", (s) => visibleCardCount(s)],
    ["stepCardRing", (s) => cardIds.flatMap((id) => [stepCardRing(s, id, 1), stepCardRing(s, id, -1)])],
    ["projectDeckState", (s) => projectDeckState(s)],
    ["resolveCloseSuccessor", (s) => paneIds.map((id) => resolveCloseSuccessor(s, RUNS, id))],
    [
      "resolveDirectionalFocus",
      (s) => cardIds.flatMap((id) => DIRECTIONS.map((d) => resolveDirectionalFocus(s, RUNS, id, d))),
    ],
    ["focusTravelDirections", (s) => cardIds.map((id) => focusTravelDirections(s, RUNS, id))],
    ["resolveLayoutSelection", (s) => resolveLayoutSelection(storeOver(s))],
    [
      "resolveLayoutSelection (cursor)",
      (s) =>
        cardIds.map((id) => {
          setLayoutCursorCard(id);
          return resolveLayoutSelection(storeOver(s));
        }),
    ],
    [
      "resolveColumnMenuFact",
      (s) =>
        cardIds.map((id) => {
          setLayoutCursorCard(id);
          return resolveColumnMenuFact(storeOver(s));
        }),
    ],
    [
      "contentCardsInLayoutSelection",
      (s) =>
        cardIds.map((id) => {
          setLayoutCursorCard(id);
          return contentCardsInLayoutSelection(storeOver(s));
        }),
    ],
    ["slotStacksOf", (s) => [...slotStacksOf(s).entries()]],
    ["buildCardsRows", (s) => buildCardsRows(cardsInputs(s), { icon: () => null })],
    ["readOpeningDeck", (s) => readOpeningDeck(s, { run: 900, band: 1600 })],
    ["enumerateDropZones", (s) => enumerateDropZones(s, dragged(s), MEASURED)],
    ["frontPaneOfSlot", (s) => [0, 1, 2].map((slot) => frontPaneOfSlot(s, slot))],
  ];
}

describe("a departing pane is invisible to every reader that lists or counts", () => {
  const paneIds = D.panes.map((p) => p.id);
  const cardIds = D.cards.map((c) => c.id);

  for (const x of paneIds) {
    describe(`with ${x} departing`, () => {
      const { standing, entry } = closed(x);
      const composed = composeDeparting(standing, [entry]);

      test("the composed deck really does carry it", () => {
        expect(composed.panes.some((p) => p.id === x)).toBe(true);
        expect(composed.departing).toEqual({ [x]: true });
      });

      for (const [name, read] of readers(paneIds, cardIds)) {
        test(name, () => {
          expect(read(composed)).toEqual(read(standing));
        });
      }

      test("panePlaceFactsOf answers the departing pane as if it still stood", () => {
        expect(panePlaceFactsOf(composed, x)).toEqual(panePlaceFactsOf(D, x));
      });
    });
  }
});
