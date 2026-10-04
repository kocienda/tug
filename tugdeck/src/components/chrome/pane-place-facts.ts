/**
 * pane-place-facts — a pane's place in its run, for the badge that draws it.
 *
 * Every pane standing in a slot or a rail draws a badge naming the place: how
 * many panes share it, this one's band in a split, and the picker rows that
 * list the others. Those facts change on EVERY member when one member comes or
 * goes, so handing them to `TugPane` as props re-rendered each survivor's
 * frame, and its whole title bar with it, for a close that moved nothing but a
 * number on a chip. They are read here instead, by the badge, through the
 * deck store ([L02]), and the frame keeps only the geometry it lays out.
 *
 * `slotStacksOf` is the deck's one reading of who shares which place — the
 * canvas's derivation, moved here so the badge and the canvas cannot disagree.
 * A picker row is named with the title bar's own text, which folds in a
 * per-card title override the deck cannot see, so the reading is cached per
 * deck snapshot AND per `cardTitleStore` version.
 *
 * A pane is read from the deck that holds it: the live deck for the shown
 * workspace, its parked record for a hidden one. A switch then moves nothing
 * a badge reads — the arriving deck's facts are the parked record's facts —
 * so no badge of either layer renders for it.
 *
 * @module components/chrome/pane-place-facts
 */

import { getRegistration } from "@/card-registry";
import {
  columnDrawsSplit,
  deckColumnsOf,
  findSidebarPanes,
  parkedSidebarPaneIds,
  sidebarRailsOf,
  type PlaceRuns,
  type SlotStackEntry,
} from "@/deck-store-selectors";
import type { DeckState, TugPaneState } from "@/layout-tree";
import { isPaneDeparting, standingDeck, withDepartingStanding } from "@/lib/departing";
import { cardTitleStore } from "@/lib/card-title-store";
import {
  isSidebarSeated,
  sidebarSide,
  withEveryHideCleared,
  type SidebarSide,
} from "@/lib/layout-imposer";
import { paneTitleBarTextFor } from "@/lib/pane-title";
import type { DerivableStore } from "@/lib/use-store-derived";
import type { IDeckManagerStore } from "@/deck-manager-store";
import type { SpacesSnapshot } from "@/spaces";

const UNMEASURED_RUNS: PlaceRuns = { rail: null, column: null };

/** What a pane's place badge draws. */
export interface PanePlaceFacts {
  /** Every pane sharing the place, topmost first, resolved for display. */
  readonly slotStack: readonly SlotStackEntry[];
  /** This pane's band in a split, topmost first; 0 in a stack. */
  readonly index: number;
  /** How many panes share the place. */
  readonly count: number;
}

const EMPTY_SLOT_STACK: readonly SlotStackEntry[] = [];

/** A pane that shares no place: nothing behind it, nobody beside it. */
export const NO_PLACE_FACTS: PanePlaceFacts = {
  slotStack: EMPTY_SLOT_STACK,
  index: 0,
  count: 0,
};

/**
 * Every pane's slot stack, keyed by pane id: the panes sharing its slot or
 * its pinned rail, topmost first for a stack and in band order for a divided
 * rail. A pane in no place is absent.
 */
export function slotStacksOf(deck: DeckState): Map<string, readonly SlotStackEntry[]> {
  const { panes, cards, imposition } = deck;
  const cardsForTitles = new Map(cards.map((c) => [c.id, c]));
  const rails = sidebarRailsOf(deck, UNMEASURED_RUNS);
  const railSideOf = new Map<string, SidebarSide>();
  for (const { componentId, pane } of findSidebarPanes(deck)) {
    if (!isSidebarSeated(imposition, componentId)) continue;
    railSideOf.set(pane.id, sidebarSide(imposition, componentId));
  }
  const byPlace = new Map<string, TugPaneState[]>();
  for (const pane of panes) {
    const railSide = railSideOf.get(pane.id);
    const place =
      railSide !== undefined
        ? `rail:${railSide}`
        : pane.slot === undefined
          ? undefined
          : `slot:${pane.slot}`;
    if (place === undefined) continue;
    const members = byPlace.get(place);
    if (members) members.push(pane);
    else byPlace.set(place, [pane]);
  }
  const paneById = new Map(panes.map((pane) => [pane.id, pane]));
  const map = new Map<string, readonly SlotStackEntry[]>();
  for (const [place, members] of byPlace.entries()) {
    const splitRail = rails.find((rail) => `rail:${rail.side}` === place);
    const ordered =
      splitRail === undefined
        ? // Topmost first, matching the host menu-state convention.
          [...members].reverse()
        : splitRail.members
            .map((member) => paneById.get(member.paneId))
            .filter((pane): pane is TugPaneState => pane !== undefined);
    const entries: SlotStackEntry[] = ordered.map((pane, i) => {
      const activeCard = cardsForTitles.get(pane.activeCardId);
      const icon = activeCard
        ? getRegistration(activeCard.componentId)?.defaultMeta.icon
        : undefined;
      return {
        paneId: pane.id,
        cardId: pane.activeCardId,
        title: paneTitleBarTextFor(pane, cardsForTitles),
        ...(icon === undefined ? {} : { icon }),
        selected:
          splitRail === undefined ? i === 0 : pane.id === deck.activePaneId,
      };
    });
    for (const pane of members) map.set(pane.id, entries);
  }
  return map;
}

/**
 * Every pane's place facts, in one walk of the deck.
 *
 * A PARKED rail member — its rail hidden whole — stands in no place, but its
 * badge is hidden with it and has nothing to redraw, so it keeps the facts of
 * the seat it would stand in: those of the same deck with every hide's memory
 * cleared. The show that stands it again then moves nothing its badge reads.
 */
function placeFactsOf(deck: DeckState): Map<string, PanePlaceFacts> {
  const facts = seatedPlaceFactsOf(deck);
  const parked = parkedSidebarPaneIds(deck);
  if (parked.size === 0) return facts;
  const standing = seatedPlaceFactsOf({ ...deck, imposition: withEveryHideCleared(deck.imposition) });
  for (const paneId of parked) {
    const seat = standing.get(paneId);
    if (seat !== undefined) facts.set(paneId, seat);
  }
  return facts;
}

/** {@link placeFactsOf} over the panes the deck seats, parked members left out. */
function seatedPlaceFactsOf(deck: DeckState): Map<string, PanePlaceFacts> {
  const stacks = slotStacksOf(deck);
  const facts = new Map<string, PanePlaceFacts>();
  for (const [paneId, slotStack] of stacks) {
    facts.set(paneId, { slotStack, index: 0, count: slotStack.length });
  }
  // A divided column names each member's band. A stacked one has no member
  // record and needs none: every pane in the stack draws the same depth.
  for (const column of deckColumnsOf(deck, null)) {
    if (!columnDrawsSplit(column)) continue;
    column.members.forEach((paneId, index) => {
      facts.set(paneId, {
        slotStack: stacks.get(paneId) ?? EMPTY_SLOT_STACK,
        index,
        count: column.members.length,
      });
    });
  }
  for (const rail of sidebarRailsOf(deck, UNMEASURED_RUNS)) {
    rail.members.forEach((member, index) => {
      facts.set(member.paneId, {
        slotStack: stacks.get(member.paneId) ?? EMPTY_SLOT_STACK,
        index,
        count: rail.members.length,
      });
    });
  }
  return facts;
}

const cache = new WeakMap<DeckState, { version: number; facts: Map<string, PanePlaceFacts> }>();

/**
 * A pane's place facts on `deck`, read once per snapshot for every pane.
 *
 * A departing pane is answered over the deck as if it still stood, so its
 * badge does not change in the middle of its fade; every other pane is
 * answered over the standing deck, which a departing pane is not part of.
 * Both decks are memoized on `deck`, so the cache below still hits.
 */
export function panePlaceFactsOf(deck: DeckState, paneId: string): PanePlaceFacts {
  deck = isPaneDeparting(deck, paneId) ? withDepartingStanding(deck) : standingDeck(deck);
  const version = cardTitleStore.version();
  let hit = cache.get(deck);
  if (hit === undefined || hit.version !== version) {
    hit = { version, facts: placeFactsOf(deck) };
    cache.set(deck, hit);
  }
  return hit.facts.get(paneId) ?? NO_PLACE_FACTS;
}

/** The live deck, the parked ones, and the title-override version, as one snapshot. */
export interface PlaceSnapshot {
  readonly deck: DeckState;
  readonly spaces: SpacesSnapshot;
  readonly titleVersion: number;
}

/** The deck holding `paneId`: the live one, else the parked record that does. */
function deckHolding(snapshot: PlaceSnapshot, paneId: string): DeckState | null {
  if (snapshot.deck.panes.some((pane) => pane.id === paneId)) return snapshot.deck;
  for (const parked of snapshot.spaces.mountedDecks.values()) {
    if (parked.panes.some((pane) => pane.id === paneId)) return parked;
  }
  return null;
}

/** A pane's place facts, read from the deck that holds it. */
export function placeFactsFor(snapshot: PlaceSnapshot, paneId: string): PanePlaceFacts {
  const deck = deckHolding(snapshot, paneId);
  return deck === null ? NO_PLACE_FACTS : panePlaceFactsOf(deck, paneId);
}

/** The store doors a place reading needs. */
export type PlaceStore = Pick<
  IDeckManagerStore,
  "subscribe" | "getPicture" | "subscribeSpaces" | "getSpacesSnapshot"
>;

/**
 * The store a place badge derives from: the deck's picture, the workspaces
 * and `cardTitleStore` together, so a title override renames a picker row
 * without a deck commit. The picture, because a departing pane's own badge
 * is read through here for the length of its fade. The snapshot keeps its
 * identity until one of the three moves.
 */
export function placeSource(store: PlaceStore): DerivableStore<PlaceSnapshot> {
  let last: PlaceSnapshot | null = null;
  return {
    subscribe: (callback) => {
      const offDeck = store.subscribe(callback);
      const offSpaces = store.subscribeSpaces(callback);
      const offTitles = cardTitleStore.subscribe(callback);
      return () => {
        offDeck();
        offSpaces();
        offTitles();
      };
    },
    getSnapshot: () => {
      const deck = store.getPicture();
      const spaces = store.getSpacesSnapshot();
      const titleVersion = cardTitleStore.version();
      if (
        last === null ||
        last.deck !== deck ||
        last.spaces !== spaces ||
        last.titleVersion !== titleVersion
      ) {
        last = { deck, spaces, titleVersion };
      }
      return last;
    },
  };
}
