/**
 * The window rail: one set of sidebar cards for the whole window, outside
 * every workspace.
 *
 * Every workspace once kept its own rail, so a switch showed a different
 * Cards card, a different Layout card and a different Workspaces list on
 * each side of the cut — each with its own scroll, its own filter and its own
 * page. The rail is the window's now: one record, which the ACTIVE deck holds
 * joined while its workspace is shown and no parked deck holds at all. A
 * switch splits the rail out of the deck being left and joins it into the one
 * arriving, so every rail code path keeps working on the live deck, and a
 * parked deck is arranged as if the rail were joined to it, so its content
 * stands where it will stand once shown.
 *
 * Pure: no store, no registry beyond `isSidebarCard`, no DOM.
 */

import type { CardState, DeckState, TugPaneState } from "../layout-tree";
import { isSidebarCard } from "../card-registry";
import type { DeckImposition } from "./layout-imposer";
import type { SpaceState, SpacesState } from "../spaces";

/** The window's rail: its cards, the panes holding them, and how they stand. */
export interface WindowRail {
  /** The rail's cards, every one in a rail pane. */
  readonly cards: readonly CardState[];
  /** The panes holding the rail's cards, each with every card it holds. */
  readonly panes: readonly TugPaneState[];
  /** Where each sidebar card stands, keyed by componentId. */
  readonly sidebars: DeckImposition["sidebars"];
  /** Each side's order, shares and hidden memory; absent when no side has one. */
  readonly rails?: DeckImposition["rails"];
  /**
   * Session state that names the rail and rides with it while the deck holding
   * it is shown, none of it serialized: the rail pane that was the deck's
   * active pane, each side's strip offset, and the sheet floors and opening
   * bids keyed by a rail member's componentId.
   */
  readonly activePaneId?: string;
  readonly railOffsets?: DeckState["railOffsets"];
  readonly sheetReservations?: DeckState["sheetReservations"];
  readonly openingBids?: DeckState["openingBids"];
}

/** A window with no rail at all. */
export const EMPTY_WINDOW_RAIL: WindowRail = { cards: [], panes: [], sidebars: {} };

/** The rail's panes: every pane holding a sidebar card. */
function railPaneIdsOf(deck: DeckState): Set<string> {
  const railCardIds = new Set(
    deck.cards.filter((c) => isSidebarCard(c.componentId)).map((c) => c.id),
  );
  const ids = new Set<string>();
  if (railCardIds.size === 0) return ids;
  for (const pane of deck.panes) {
    if (pane.cardIds.some((id) => railCardIds.has(id))) ids.add(pane.id);
  }
  return ids;
}

/** `record` split into the entries `keep` admits and the rest; `undefined` for an empty half. */
function partition<T>(
  record: Readonly<Record<string, T>> | undefined,
  keep: (key: string) => boolean,
): [Record<string, T> | undefined, Record<string, T> | undefined] {
  if (record === undefined) return [undefined, undefined];
  const kept: Record<string, T> = {};
  const rest: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (keep(key)) kept[key] = value;
    else rest[key] = value;
  }
  return [
    Object.keys(kept).length > 0 ? kept : undefined,
    Object.keys(rest).length > 0 ? rest : undefined,
  ];
}

/**
 * Take the rail out of `deck`: the deck with no rail card, no rail pane and
 * no rail fields in its imposition, and the rail that was in it.
 *
 * Content panes keep their relative order. A session record keyed by a rail
 * member — a sheet floor, an opening bid, keyed by its componentId — leaves
 * with the rail, and so does an active pane that was a rail pane.
 */
export function splitRail(deck: DeckState): { deck: DeckState; rail: WindowRail } {
  const railPaneIds = railPaneIdsOf(deck);
  const railCardIds = new Set<string>();
  for (const pane of deck.panes) {
    if (railPaneIds.has(pane.id)) for (const id of pane.cardIds) railCardIds.add(id);
  }
  const railComponentIds = new Set(
    deck.cards.filter((c) => railCardIds.has(c.id)).map((c) => c.componentId),
  );
  const { sidebars, rails, ...imposition } = deck.imposition;
  const [railFloors, deckFloors] = partition(deck.sheetReservations, (k) => railComponentIds.has(k));
  const [railBids, deckBids] = partition(deck.openingBids, (k) => railComponentIds.has(k));
  const activeIsRail = deck.activePaneId !== undefined && railPaneIds.has(deck.activePaneId);

  const {
    railOffsets,
    sheetReservations: _floors,
    openingBids: _bids,
    activePaneId: _active,
    ...rest
  } = deck;
  const split: DeckState = {
    ...rest,
    cards: deck.cards.filter((c) => !railCardIds.has(c.id)),
    panes: deck.panes.filter((p) => !railPaneIds.has(p.id)),
    ...(deck.activePaneId !== undefined && !activeIsRail ? { activePaneId: deck.activePaneId } : {}),
    imposition: { ...imposition, sidebars: {} },
    ...(deckFloors !== undefined ? { sheetReservations: deckFloors } : {}),
    ...(deckBids !== undefined ? { openingBids: deckBids } : {}),
  };
  const rail: WindowRail = {
    cards: deck.cards.filter((c) => railCardIds.has(c.id)),
    panes: deck.panes.filter((p) => railPaneIds.has(p.id)),
    sidebars,
    ...(rails !== undefined ? { rails } : {}),
    ...(activeIsRail ? { activePaneId: deck.activePaneId } : {}),
    ...(railOffsets !== undefined ? { railOffsets } : {}),
    ...(railFloors !== undefined ? { sheetReservations: railFloors } : {}),
    ...(railBids !== undefined ? { openingBids: railBids } : {}),
  };
  return { deck: split, rail };
}

/**
 * Put `rail` into `deck`: the inverse of {@link splitRail}. The rail's panes
 * and cards follow the deck's own, and its imposition fields replace the
 * deck's. A rail pane that was the active pane is the active pane again only
 * where the deck names none of its own.
 */
export function joinRail(deck: DeckState, rail: WindowRail): DeckState {
  const { rails: _rails, sidebars: _sidebars, ...imposition } = deck.imposition;
  const sheetReservations = merged(deck.sheetReservations, rail.sheetReservations);
  const openingBids = merged(deck.openingBids, rail.openingBids);
  const { railOffsets: _offsets, ...rest } = deck;
  const activePaneId = deck.activePaneId ?? rail.activePaneId;
  return {
    ...rest,
    cards: [...deck.cards, ...rail.cards],
    panes: [...deck.panes, ...rail.panes],
    ...(activePaneId !== undefined ? { activePaneId } : {}),
    imposition: {
      ...imposition,
      sidebars: rail.sidebars,
      ...(rail.rails !== undefined ? { rails: rail.rails } : {}),
    },
    ...(rail.railOffsets !== undefined ? { railOffsets: rail.railOffsets } : {}),
    ...(sheetReservations !== undefined ? { sheetReservations } : {}),
    ...(openingBids !== undefined ? { openingBids } : {}),
  };
}

function merged<T>(
  a: Readonly<Record<string, T>> | undefined,
  b: Readonly<Record<string, T>> | undefined,
): Readonly<Record<string, T>> | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return { ...a, ...b };
}

/** The rail with its session-only fields dropped: what a save writes and a switch carries. */
export function lastingRail(rail: WindowRail): WindowRail {
  const {
    activePaneId: _a,
    railOffsets: _o,
    sheetReservations: _s,
    openingBids: _b,
    ...lasting
  } = rail;
  return lasting;
}

/** Whether `deck` holds any rail card. */
export function holdsRail(deck: DeckState): boolean {
  return deck.cards.some((c) => isSidebarCard(c.componentId));
}

/**
 * Bring a spaces state whose workspaces each kept their own rail onto one
 * window rail.
 *
 * The active workspace's rail becomes the window's; every other workspace's
 * rail cards and panes are removed, and with them their view state — the
 * orphan sweep forgets the state bags of cards no workspace holds. A
 * workspace whose active pane was a rail pane falls back to its frontmost
 * content pane, and one whose remembered focus named a removed card forgets
 * it, so its return falls back to its active pane's card. Every workspace's
 * deck is left holding no rail; the caller joins the window rail into the
 * active one.
 */
export function migrateToWindowRail(state: SpacesState): SpacesState {
  const active = state.spaces.find((s) => s.id === state.activeSpaceId) ?? state.spaces[0];
  const rail = active === undefined ? EMPTY_WINDOW_RAIL : lastingRail(splitRail(active.deck).rail);
  const spaces: SpaceState[] = state.spaces.map((space) => {
    const { deck: bare } = splitRail(space.deck);
    let deck: DeckState = bare;
    if (space.deck.activePaneId !== undefined && bare.activePaneId === undefined && bare.panes.length > 0) {
      deck = { ...bare, activePaneId: bare.panes[bare.panes.length - 1].id };
    }
    const keepsFocus =
      space.focusedCardId === undefined ||
      deck.cards.some((c) => c.id === space.focusedCardId) ||
      (space === active && rail.cards.some((c) => c.id === space.focusedCardId));
    const { focusedCardId: _focus, ...record } = space;
    return { ...(keepsFocus ? space : record), deck };
  });
  return { ...state, spaces, rail };
}
