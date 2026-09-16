/**
 * Spaces: the level above the deck.
 *
 * A SPACE is a named deck ([B01]). One Tug instance holds an ordered list of
 * them and renders exactly one — the active space — so a person can keep one
 * arrangement per project or purpose and move between them without closing
 * anything. The user-facing noun is **Workspace**; the code identifier is
 * `space`, kept distinct so `workspace_key` in `protocol.ts` keeps its one
 * meaning (a session's project directory) ([P01], [B03]).
 *
 * This module holds the record types and the pure helpers over them. It knows
 * nothing about the manager that hosts the spaces, nothing about rendering,
 * and nothing about persistence beyond the shape `serialization.ts` writes.
 */

import type { CardState, DeckState, TugPaneState } from "./layout-tree";
import { isSidebarCard } from "./card-registry";
import { columnMembersOf } from "./deck-store-selectors";
import {
  clampSlot,
  slotCount,
  withMemberSeated,
  type ColumnArrangement,
  type DeckImposition,
} from "./lib/layout-imposer";

/** The user-facing name a migrated pre-v5 deck comes back under ([B09]). */
export const MAIN_SPACE_NAME = "Main";

/** One named deck. */
export interface SpaceState {
  id: string;
  name: string;
  deck: DeckState;
  /**
   * The card that held first responder when this space was last left. Read on
   * activation to put focus back where the user had it. Absent on a space
   * nobody has left yet, and on a space migrated from a pre-v5 blob — whose
   * pointer arrives instead through `DeckManager`'s legacy
   * `initialFocusedCardId` argument (Spec S02).
   */
  focusedCardId?: string;
}

/** Every space, and which one is rendered. */
export interface SpacesState {
  spaces: readonly SpaceState[];
  activeSpaceId: string;
}

/**
 * What React readers see: the list's identities and order, which workspaces
 * are mounted, and the parked decks of the mounted ones.
 *
 * The ACTIVE workspace's deck is deliberately absent, and that is the whole
 * of the old "no decks here" rule that survives: the live deck is the deck
 * store's, it changes on every mutation inside it, and a copy cached here
 * would go stale the moment a pane moved. A subscriber that wants the active
 * deck reads `getSnapshot`.
 *
 * What IS here is every MOUNTED workspace's parked deck ([B06]). The canvas
 * renders one wrapper per mounted workspace, and the inactive ones' panes
 * have to come from somewhere a render body may read — [L02] is exact, and a
 * `getSpaceDeck(id)` call in render is an external read outside a store hook.
 * A parked deck is rewritten only by a park or a cross-workspace move, and
 * both invalidate this snapshot, so the identities here are as stable as the
 * names beside them.
 */
export interface SpacesSnapshot {
  spaces: readonly { id: string; name: string }[];
  activeSpaceId: string;
  /**
   * The workspaces React is holding mounted — the active one and every one
   * the user has visited this run ([P01]). In the list's order.
   */
  mountedSpaceIds: readonly string[];
  /**
   * The parked deck of every mounted workspace EXCEPT the active one, whose
   * deck is the live one. A mounted id with no entry here is the active one.
   */
  mountedDecks: ReadonlyMap<string, DeckState>;
}

/**
 * Strip the session-only fields from a deck about to be parked (List L01).
 *
 * These are exactly the fields `serialize` already omits, and for the same
 * reasons stated one by one on {@link DeckState}: a bullseye posture, a strip
 * offset, a sheet's floor claim, an arrival mark are all things derived from
 * what is on screen, and nothing of a parked space is on screen. `parkedDeck`
 * is the in-memory twin of that omission — a space returns the way a relaunch
 * returns, which is the only way a switch and a restart can be made to agree.
 *
 * `hasFocus` is not stripped but re-seeded to `true`, as `deserialize` seeds
 * it: the live deck's own value is re-applied at the moment of return, so what
 * is parked is a placeholder rather than a stale reading of window focus.
 *
 * Returns the deck itself when there is nothing to strip, so a park that
 * changes nothing does not mint a new object.
 */
export function parkedDeck(deck: DeckState): DeckState {
  const {
    bullseyePaneId: _bullseyePaneId,
    flowOffset: _flowOffset,
    columnOffsets: _columnOffsets,
    railOffsets: _railOffsets,
    sheetReservations: _sheetReservations,
    openingBids: _openingBids,
    arriving: _arriving,
    ...rest
  } = deck;

  const parked: DeckState = { ...rest, hasFocus: true };
  return sameParkedDeck(deck, parked) ? deck : parked;
}

/** True when `parkedDeck` would have changed nothing about `deck`. */
function sameParkedDeck(deck: DeckState, parked: DeckState): boolean {
  return (
    deck.hasFocus === parked.hasFocus &&
    Object.keys(deck).length === Object.keys(parked).length
  );
}

/**
 * Wrap one deck as the sole space of a fresh {@link SpacesState}, named
 * {@link MAIN_SPACE_NAME}.
 *
 * This is the migration of every pre-v5 blob (Spec S02) and the shape a
 * factory-fresh boot starts in.
 */
export function wrapAsMainSpace(deck: DeckState): SpacesState {
  const id = crypto.randomUUID();
  return { spaces: [{ id, name: MAIN_SPACE_NAME, deck }], activeSpaceId: id };
}

/**
 * The name a new workspace takes: `Workspace N` for the first N not already
 * taken, counting from 1 — so creating, deleting the middle one, and creating
 * again does not mint a duplicate name ([P05]).
 */
export function nextSpaceName(existing: readonly string[]): string {
  const taken = new Set(existing);
  for (let n = 1; ; n += 1) {
    const candidate = `Workspace ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The deck a duplicated workspace opens on: the source's layout and its
 * sidebars, and none of its content ([P06]).
 *
 * **A session cannot be in two places**, which is the whole of why this copies
 * so little. A fresh-id copy of a Session card is a card with no binding and
 * no ledger row, so it would mount on the project picker — a workspace full of
 * pickers is not a copy of anything. The sidebar cards have no such identity
 * to divide: a Cards card is the same Cards card wherever it stands, and a
 * fresh id for it is a fresh instance rather than a claim on somebody's
 * session.
 *
 * What a pane counts as a sidebar pane is read from `imposition.sidebars`,
 * which is keyed by `componentId` precisely because a sidebar card is a
 * singleton of its type. That keeps this helper pure: it needs no registry,
 * and the deck it is handed already carries the fact.
 *
 * `imposition.columns` is dropped rather than copied — its members are named
 * by PANE id, and every pane id here is freshly minted, so a copied record
 * would name nothing that exists. `rails` and `sidebars` survive, being keyed
 * by side and by componentId.
 *
 * `mintId` is the caller's id source, so a test can hand it a counter and read
 * the result.
 */
export function duplicatedDeck(
  source: DeckState,
  mintId: () => string,
): DeckState {
  const { columns: _columns, ...imposition } = source.imposition;
  const sidebars = imposition.sidebars ?? {};

  const cards: CardState[] = [];
  const panes: TugPaneState[] = [];
  let activePaneId: string | undefined;

  for (const pane of source.panes) {
    const seats = pane.cardIds
      .map((id) => source.cards.find((c) => c.id === id))
      .filter(
        (card): card is CardState =>
          card !== undefined && sidebars[card.componentId] !== undefined,
      );
    if (seats.length === 0) continue;

    const copies = seats.map((card) => ({ ...card, id: mintId() }));
    cards.push(...copies);

    // A sidebar pane is pinned from `imposition.sidebars` at render, never
    // slotted — `validateDeckState` rejects a rail pane carrying a slot — so
    // the source's `slot` does not come along even when it had one.
    const { slot: _slot, ...rest } = pane;
    const activeIndex = seats.findIndex((c) => c.id === pane.activeCardId);
    const copiedPane: TugPaneState = {
      ...rest,
      id: mintId(),
      cardIds: copies.map((c) => c.id),
      activeCardId: copies[activeIndex === -1 ? 0 : activeIndex].id,
    };
    panes.push(copiedPane);
    if (pane.id === source.activePaneId) activePaneId = copiedPane.id;
  }

  // The source's active pane may have been a content pane, which is not here.
  // Fall back to the frontmost copied pane rather than leaving the deck with
  // no active pane at all.
  if (activePaneId === undefined && panes.length > 0) {
    activePaneId = panes[panes.length - 1].id;
  }

  return {
    cards,
    panes,
    ...(activePaneId !== undefined ? { activePaneId } : {}),
    imposition,
    hasFocus: true,
  };
}

/**
 * Move `cardId`'s whole pane from one deck to another, ids unchanged ([B07]).
 *
 * **The pane travels, not the card.** A card is never alone in the record —
 * it sits in a pane that owns its geometry ([L09]) — and a move that took the
 * card alone would have to invent a pane on the far side, which is a new
 * frame at a position nobody chose. Moving the pane whole carries the
 * geometry, the tab stack, and the title across in one piece, and a tab stack
 * that arrives split between two workspaces is a stack nobody asked to break.
 *
 * **Refused (`null`) when the pane holds a sidebar card.** A sidebar card is a
 * singleton of its type, pinned from `imposition.sidebars` rather than placed;
 * moving its pane would leave the source's rail naming a componentId with no
 * pane and hand the destination a second one. The answer for a rail is to open
 * the card there, not to move this one.
 *
 * Also `null` when no pane holds the card — the caller's invariant, reported
 * rather than assumed.
 *
 * What leaves the source is the pane, its cards, its place in
 * `imposition.columns`, and every session-only record that named it:
 * `activePaneId`, `bullseyePaneId`, a sheet floor claim, an opening bid, an
 * arrival mark. All of those name a pane that is no longer there, and a record
 * naming a pane in another workspace is worse than an absent one.
 *
 * What arrives at the destination is the pane at **slot 0**, seated at the
 * BOTTOM of that column ([D194]) when the destination imposes more than one
 * slot — the same seat every other newcomer takes, so a moved card is not a
 * special case the column has to explain. A one-up destination imposes a
 * single place and the pane keeps its stored position and size instead, with
 * its old slot dropped.
 *
 * Neither deck's `hasFocus` is touched: that is the window's fact and belongs
 * to whichever deck is on screen.
 */
export function moveCardBetweenDecks(
  source: DeckState,
  dest: DeckState,
  cardId: string,
): { source: DeckState; dest: DeckState } | null {
  const pane = source.panes.find((p) => p.cardIds.includes(cardId));
  if (pane === undefined) return null;
  const movingIds = new Set(pane.cardIds);
  const movingCards = source.cards.filter((c) => movingIds.has(c.id));
  if (movingCards.length === 0) return null;
  if (movingCards.some((c) => isSidebarCard(c.componentId))) return null;

  const nextSource = strippedOfPane(
    {
      ...source,
      cards: source.cards.filter((c) => !movingIds.has(c.id)),
      panes: source.panes.filter((p) => p.id !== pane.id),
      imposition: withoutColumnMember(source.imposition, pane.id),
    },
    pane.id,
  );

  const kind = dest.imposition.kind;
  const seatSlot =
    kind !== undefined && slotCount(kind) > 1 ? clampSlot(kind, 0) : undefined;
  const { slot: _oldSlot, ...paneWithoutSlot } = pane;
  const arrived: TugPaneState =
    seatSlot === undefined
      ? paneWithoutSlot
      : { ...paneWithoutSlot, slot: seatSlot };

  const projected: DeckState = {
    ...dest,
    cards: [...dest.cards, ...movingCards],
    panes: [...dest.panes, arrived],
  };
  const nextDest: DeckState =
    seatSlot === undefined
      ? projected
      : {
          ...projected,
          imposition: withMemberSeated(
            projected.imposition,
            seatSlot,
            // Read over the deck as it will be committed, including the
            // arriving pane, which is what `withMemberSeated` expects.
            columnMembersOf(projected, seatSlot),
            arrived.id,
          ),
        };

  return { source: nextSource, dest: nextDest };
}

/** `deck` with every session-only record that named `paneId` dropped. */
function strippedOfPane(deck: DeckState, paneId: string): DeckState {
  const next: DeckState = { ...deck };
  if (next.activePaneId === paneId) delete next.activePaneId;
  if (next.bullseyePaneId === paneId) delete next.bullseyePaneId;

  const reservations = withoutRecordKey(next.sheetReservations, paneId);
  if (reservations === undefined) delete next.sheetReservations;
  else next.sheetReservations = reservations;

  const bids = withoutRecordKey(next.openingBids, paneId);
  if (bids === undefined) delete next.openingBids;
  else next.openingBids = bids;

  const arriving = withoutRecordKey(next.arriving, paneId);
  if (arriving === undefined) delete next.arriving;
  else next.arriving = arriving;

  return next;
}

/**
 * `record` without `key`, or `undefined` when that empties it — these records
 * are absent rather than empty when nothing is claiming, so absence stays the
 * one reading of "nothing here".
 */
function withoutRecordKey<T>(
  record: Readonly<Record<string, T>> | undefined,
  key: string,
): Readonly<Record<string, T>> | undefined {
  if (record === undefined) return undefined;
  if (!(key in record)) return record;
  const { [key]: _gone, ...rest } = record;
  return Object.keys(rest).length === 0 ? undefined : rest;
}

/**
 * `imposition` with `paneId` dropped from every column's order and shares.
 *
 * Not {@link sweptColumnOrders}, which deliberately keeps an id whose pane has
 * gone entirely — inert residue a reopened pane could never reclaim. Here the
 * pane has not gone: it is standing in ANOTHER deck, and a share held for it in
 * this one would divide a run among a member that will never draw.
 */
function withoutColumnMember(
  imposition: DeckImposition,
  paneId: string,
): DeckImposition {
  const columns = imposition.columns;
  if (columns === undefined) return imposition;
  let changed = false;
  const next: Record<number, ColumnArrangement> = {};
  for (const [key, arrangement] of Object.entries(columns)) {
    let entry = arrangement;
    if (entry.order !== undefined && entry.order.includes(paneId)) {
      entry = { ...entry, order: entry.order.filter((id) => id !== paneId) };
      changed = true;
    }
    if (entry.shares !== undefined && paneId in entry.shares) {
      const { [paneId]: _gone, ...rest } = entry.shares;
      entry = { ...entry, shares: rest };
      changed = true;
    }
    next[Number(key)] = entry;
  }
  return changed ? { ...imposition, columns: next } : imposition;
}
