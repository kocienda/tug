/**
 * deck-store-selectors.ts — derived predicates over `DeckState`.
 *
 * A selector here is a pure function of `DeckState` plus its inputs
 * (typically a `cardId`). No side effects, no memoization, no imports
 * from React. Consumers pick the subscription shape that fits:
 *
 *   - React components subscribe through `useSyncExternalStore` — see
 *     `deck-store-hooks.ts` for the `use*` wrappers built on these
 *     selectors (upholds [L02]).
 *   - Non-React singletons (e.g. the `selectionGuard`, app-lifecycle
 *     plumbing) subscribe to the deck store directly and re-run the
 *     selector inside their subscription callback:
 *
 *     ```ts
 *     const unsubscribe = deckStore.subscribe(() => {
 *       if (isFocusDestination(cardId, deckStore.getSnapshot())) {
 *         // react to the current card being the focus destination
 *       }
 *     });
 *     ```
 *
 * Keeping these derivations pure means the same predicate is reused
 * from both pathways without forking the logic per consumer — the
 * foundation [A1] establishes for [A3] / [A4] in later steps.
 */

import type { DeckState, TugPaneState } from "./layout-tree";
import { LENS_CARD_ID } from "./lib/lens-card-id";
import { getStackSizePolicy, isSidebarCard } from "./card-registry";
import {
  clampSlot,
  columnModeOf,
  effectiveColumnOrder,
  flowStripPositions,
  impositionLayout,
  railSeamFractions,
  type ColumnMode,
  type FlowSlotExtent,
  type FlowStrip,
} from "./lib/layout-imposer";

/**
 * `isFocusDestination(cardId, state)` — returns true iff `cardId`
 * identifies the card that currently deserves the OS keyboard caret
 * ([A1]). Three conditions, all of which must hold:
 *
 *   1. The app is foreground (`state.hasFocus === true`). When the
 *      tugdeck window is blurred, no card is the focus destination —
 *      restoring focus into the DOM while another app owns the caret
 *      would steal focus back (the [R07] class of bugs).
 *   2. The card's host pane is the active pane
 *      (`state.activePaneId === card.paneId`).
 *   3. The card is the active card of that pane
 *      (`pane.activeCardId === cardId`).
 *
 * Returns `false` for unknown `cardId` (card not in the deck, card
 * with no containing pane, pane missing) — the selector degrades
 * quietly in transient states that show up during deck mutations.
 *
 * Pure: the same inputs always produce the same output. Safe to call
 * from any context — React render, effect, non-React subscribe
 * callback.
 */
export function isFocusDestination(
  cardId: string,
  state: DeckState,
): boolean {
  if (!state.hasFocus) return false;
  const pane = state.panes.find((p) => p.cardIds.includes(cardId));
  if (!pane) return false;
  if (state.activePaneId !== pane.id) return false;
  return pane.activeCardId === cardId;
}

/**
 * `findSidebarPane(state, componentId)` — the pane hosting a sidebar card, or
 * `undefined` when that card is closed.
 *
 * A sidebar pane carries no marker of its own: it is the pane holding the card
 * registered under `componentId`. A sidebar card is a singleton and its pane
 * hosts nothing else (`acceptsFamilies: []` and an un-mergeable family), so the
 * derivation is single-valued. This is the one predicate every consumer that
 * needs "which pane is the Lens / the Jots card" goes through.
 */
export function findSidebarPane(
  state: DeckState,
  componentId: string,
): TugPaneState | undefined {
  const cardIds = new Set(
    state.cards.filter((c) => c.componentId === componentId).map((c) => c.id),
  );
  if (cardIds.size === 0) return undefined;
  return state.panes.find((p) => p.cardIds.some((cid) => cardIds.has(cid)));
}

/**
 * Every pane hosting a sidebar-role card, paired with the componentId it hosts.
 * The order is the panes array's own (z-order); callers that need a spatial
 * order sort by the side each card holds.
 */
export function findSidebarPanes(
  state: DeckState,
): readonly { componentId: string; pane: TugPaneState }[] {
  const byCardId = new Map<string, string>();
  for (const card of state.cards) {
    if (isSidebarCard(card.componentId)) byCardId.set(card.id, card.componentId);
  }
  if (byCardId.size === 0) return [];
  const out: { componentId: string; pane: TugPaneState }[] = [];
  for (const pane of state.panes) {
    for (const cid of pane.cardIds) {
      const componentId = byCardId.get(cid);
      if (componentId !== undefined) {
        out.push({ componentId, pane });
        break;
      }
    }
  }
  return out;
}

/** `findLensPane(state)` — the pane hosting the Lens, or `undefined` when the
 *  Lens is closed. The Lens-shaped reading of {@link findSidebarPane}, kept
 *  because most call sites want exactly this one. */
export function findLensPane(state: DeckState): TugPaneState | undefined {
  return findSidebarPane(state, LENS_CARD_ID);
}

/**
 * `slotStackOf(state, slot)` — every pane holding `slot`, in z-order
 * (last = topmost, the order `DeckState.panes` itself carries). Empty when
 * the slot is unoccupied.
 *
 * `undefined` never matches: a free pane and the Lens hold no slot, so they
 * stand in no stack. The membership and the order are both fully determined
 * by state the deck already owns, which is why nothing here is stored — a
 * stored copy could only ever disagree with the array it was copied from.
 */
export function slotStackOf(
  state: DeckState,
  slot: number | undefined,
): readonly TugPaneState[] {
  if (slot === undefined) return [];
  return state.panes.filter((p) => p.slot === slot);
}

// A pane's display name is NOT derived here. It is the string that pane's own
// title bar renders — registry title, multi-tab group prefix, and the live
// `cardTitleStore` override composed together — and it lives in exactly one
// place, `lib/pane-title.ts`. A simpler rule used to live here (the
// `CardState.title` fallback chain) and it disagreed with the title bar for
// every card whose identity is dynamic: a Session card bound to a project read
// `test-repo/petit-thaw` on its title bar and `Untitled` in every list.

/**
 * One row of a stack's picker, already resolved for display.
 *
 * A slot's stack and a stacked rail are ordered topmost-first, matching the
 * host menu-state convention. A SPLIT rail is ordered top to bottom instead —
 * nothing is occluded there, so depth is not what the rows are about.
 *
 * The title bar renders its picker from these and never reaches for the deck
 * store: it has no access to one, and chrome driven entirely by props is what
 * keeps chrome and content in their lanes ([L10]).
 */
export interface SlotStackEntry {
  /** The pane this row raises. */
  paneId: string;
  /**
   * The card id to activate — the pane's `activeCardId`, resolved at
   * projection time so the raise needs no second store read.
   */
  cardId: string;
  /** Display title, from {@link paneDisplayTitle}. */
  title: string;
  /**
   * The pane's icon, as a `lucide-react` name — the same `CardMeta.icon` its
   * own title bar draws, resolved here so a picker row reads as a miniature of
   * the title bar it stands for rather than as a bare list of strings.
   * Absent when the card's registration declares no icon.
   */
  icon?: string;
  /**
   * True for the row the picker checks — which is a different pane by
   * arrangement, and that is why the field is not named for either one. In a
   * stack it is the pane at the front, the only one you can see. In a split
   * every member is visible, so it is the FOCUSED member instead, and no row
   * is checked when focus rests outside the rail.
   */
  selected: boolean;
}

/**
 * `bullseyePaneIdOf(state)` — the pane standing in bullseye, or `null`.
 *
 * The stored `state.bullseyePaneId` is an input to this derivation, not its
 * answer. The id is honored only when a pane with that id still exists AND
 * that pane hosts the current first responder — the same rule
 * `DeckManager.getFirstResponderCardId()` states (`activePaneId` names the
 * pane; that pane's `activeCardId` is the responder), reproduced here rather
 * than imported so the selector stays a pure function of a snapshot.
 *
 * Deriving is what makes the focus-shaped exits hold by construction: raising
 * another pane, the depth and lateral rings, a sidebar chord, and the
 * canvas-background deselect all move the first responder, and every one of
 * them stops this from matching without any of them knowing bullseye exists.
 * A raw id may therefore linger after focus moves; it is unreadable through
 * here and is overwritten by the next toggle.
 *
 * Note the pane, not the card, is the subject: switching tabs within a
 * multi-card bullseyed pane keeps the posture, because the user is still
 * working in the card they bullseyed.
 */
export function bullseyePaneIdOf(state: DeckState): string | null {
  const paneId = state.bullseyePaneId;
  if (paneId === undefined) return null;
  if (state.activePaneId !== paneId) return null;
  const pane = state.panes.find((p) => p.id === paneId);
  if (pane === undefined) return null;
  return pane.cardIds.includes(pane.activeCardId) ? paneId : null;
}

/**
 * `paneRenderWidthOf(state, pane)` — the width a pane PAINTS at: its stored
 * width raised to its stack's size floor.
 *
 * A stored width below the floor is a number the frame never shows, so any
 * geometry packed on it — a band inset from a rail, a strip of slots — would
 * run under an edge the deck actually draws.
 */
export function paneRenderWidthOf(
  state: DeckState,
  pane: TugPaneState,
): number {
  return Math.max(
    pane.size.width,
    getStackSizePolicy(
      state.cards
        .filter((card) => pane.cardIds.includes(card.id))
        .map((card) => card.componentId),
    ).min.width,
  );
}

/**
 * `deckFlowStrip(state)` — where the occupied slots stand when the deck is in
 * flow, or `null` when it is not.
 *
 * **This is the deck's one strip.** Flow spends the placement invariant that
 * makes a slot resolvable from its own pane (see `ImposedPlacement`), so the
 * resolution has to be paid in a single place or the frames and the reveal
 * would be reading two strips that agree only by luck. Both callers come here:
 * `deck-canvas.tsx` to place the frames, and `DeckManager` to compute what the
 * next activation reveals.
 *
 * A slot's extent is its WIDEST member's render width — panes sharing a slot
 * share its place, exactly as they do in fit.
 */
export function deckFlowStrip(state: DeckState): FlowStrip | null {
  if (state.imposition.kind === undefined) return null;
  if (impositionLayout(state.imposition) !== "flow") return null;
  const occupied: FlowSlotExtent[] = [];
  for (const pane of state.panes) {
    if (pane.slot === undefined) continue;
    // Clamped to the kind, exactly as `resolvePlacement` clamps it, so the
    // strip is keyed by the slot a pane actually stands in. A stored slot past
    // the kind's last one pulls in rather than opening a place of its own —
    // and two panes pulled onto the same slot share it, widest extent winning.
    occupied.push({
      slot: clampSlot(state.imposition.kind, pane.slot),
      width: paneRenderWidthOf(state, pane),
    });
  }
  return flowStripPositions(occupied);
}

/**
 * One slot's column: the panes standing in it, how they stand against one
 * another, and — when they divide the run — where the seams fall.
 *
 * The content-side twin of `deck-canvas.tsx`'s `SidebarRail`, and deliberately
 * the same shape: both are a place several panes either take turns in or
 * divide.
 */
export interface DeckColumn {
  slot: number;
  mode: ColumnMode;
  /** The members' pane ids, top to bottom when split. */
  members: readonly string[];
  /** Where the gaps fall, as fractions of the run: `members.length - 1` values
   *  in split mode, empty in a stack (a stack has no gaps to place). */
  seams: readonly number[];
}

/**
 * `deckColumnsOf(state)` — the occupied slots of the imposed chain, in slot
 * order, each with the arrangement its panes stand under.
 *
 * **This is the deck's one reading of its columns**, for the reason
 * {@link deckFlowStrip} is the deck's one strip: the frames' member pins, the
 * seam handles, the arrangement signature, and the seam-property writer all
 * have to agree about which member is at which index, and four independent
 * derivations would agree only by luck.
 *
 * Empty when nothing is imposed: a slot is a place in an arrangement, and a
 * free deck has none.
 *
 * The fallback order — what a column with no stored `order` gets — is the
 * slot's panes **sorted by pane id**, NOT their order in `state.panes`. That
 * array is z-order, and `activateCard` rewrites it: taking it here would make
 * two unarranged members of a split column trade places when the user clicked
 * the lower one. Sorting by id is arbitrary between two panes that arrived
 * together and, far more importantly, is fixed under a raise. It is the same
 * hazard `sidebarRailsOf` avoids by sorting into registration order; a pane has
 * no registration to sort into, and its id is what it has instead.
 *
 * A split column normally never reaches that fallback anyway:
 * `DeckManager.setColumnMode` materializes the order in the same commit that
 * writes the split, so the members land in the front-to-back order they stood
 * in at the moment of the split, and the stored order governs from there.
 */
export function deckColumnsOf(state: DeckState): readonly DeckColumn[] {
  const kind = state.imposition.kind;
  if (kind === undefined) return [];
  const bySlot = new Map<number, string[]>();
  for (const pane of state.panes) {
    if (pane.slot === undefined) continue;
    // Clamped exactly as the strip and `resolvePlacement` clamp it, so a
    // column is keyed by the slot its panes actually stand in.
    const slot = clampSlot(kind, pane.slot);
    const members = bySlot.get(slot);
    if (members) members.push(pane.id);
    else bySlot.set(slot, [pane.id]);
  }
  const columns: DeckColumn[] = [];
  for (const slot of [...bySlot.keys()].sort((a, b) => a - b)) {
    const standing = [...(bySlot.get(slot) ?? [])].sort();
    const members = effectiveColumnOrder(state.imposition, slot, standing);
    const mode = columnModeOf(state.imposition, slot);
    columns.push({
      slot,
      mode,
      members,
      seams:
        mode === "split"
          ? railSeamFractions(members, state.imposition.columns?.[slot]?.shares)
          : [],
    });
  }
  return columns;
}

/**
 * `columnMoveOrder(state, paneId)` — the sequence a move-in-column verb walks
 * for the pane, or empty when the pane stands in no column.
 *
 * Split, that is the column's member order, top to bottom. Stacked, nothing is
 * above anything — every member draws the same rect — so the only ordering the
 * user can see is z, reversed so index 0 is the front and "up" is one index
 * earlier in both arrangements.
 *
 * One reading, because two callers ask: `DeckManager.moveInColumn` performs the
 * move, and the menu's `column` fact says whether the move would be refused. A
 * fact derived from a second walk would disagree with the verb exactly at the
 * ends, which is the only place either answer is interesting.
 */
export function columnMoveOrder(
  state: DeckState,
  paneId: string,
): readonly string[] {
  const kind = state.imposition.kind;
  if (kind === undefined) return [];
  const pane = state.panes.find((p) => p.id === paneId);
  if (pane?.slot === undefined) return [];
  const slot = clampSlot(kind, pane.slot);
  if (columnModeOf(state.imposition, slot) === "split") {
    return deckColumnsOf(state).find((column) => column.slot === slot)?.members ?? [];
  }
  return state.panes
    .filter((p) => p.slot !== undefined && clampSlot(kind, p.slot) === slot)
    .map((p) => p.id)
    .reverse();
}

/**
 * `countWorkCards(state)` — how many cards the user is working in, i.e. every
 * card but the Lens. The Lens is app furniture (it opens by factory default),
 * so anything asking "does this deck hold work yet" — the setup wizard's
 * "start a session" step, the copy that reads a deck as busy — counts through
 * here rather than off `state.cards.length`.
 */
export function countWorkCards(state: DeckState): number {
  return state.cards.filter((c) => c.componentId !== LENS_CARD_ID).length;
}
