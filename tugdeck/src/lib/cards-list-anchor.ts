/**
 * cards-list-anchor.ts — where the reader is in the Workspaces list, as one
 * fact for the deck.
 *
 * Every mounted workspace holds its own Workspaces card, and they show one
 * list. So "where I was in it" is not a card's: it is a row and that row's
 * offset from the top of the card that showed it, held by the shell as the
 * `cards.listAnchor` store and proposed by whichever card the reader is
 * scrolling or clicking in. A card that comes on screen places its scroller
 * from the anchor, so the row the reader last touched is where they left it —
 * pixel for pixel when the arriving card's box matches the departing one,
 * at the same offset in a card that moved when it does not, and clamped
 * "nearest" so it stays in view when the arriving card is shorter.
 *
 * A workspace with no Workspaces card reads nothing, and the anchor stands for
 * the next card that shows.
 *
 * The arithmetic is three pure functions that know nothing of pages or
 * stores, so a single Workspaces card standing outside the layers would hold
 * an anchor of the same shape as its own state and use them unchanged; only
 * {@link shareCardsListAnchor}, the shell's half of the store, is about pages.
 *
 * @module lib/cards-list-anchor
 */

import { cardsListAnchor, type CardsListAnchorValue } from "@/bus/declarations/arrangement";
import { pageBus, type PageBus } from "@/bus/page-bus";

/** A row and its offset from the top of the card's scroller, px. */
export type ListAnchor = CardsListAnchorValue;

/** One row's box, in the scroller's content coordinates. */
export interface AnchorRow {
  readonly id: string;
  /** Distance from the top of the scroll content, px. */
  readonly top: number;
  readonly height: number;
}

/** The scroller's own extent. */
export interface AnchorViewport {
  readonly clientHeight: number;
  readonly scrollHeight: number;
}

/** The anchor that holds `row` where it stands at `scrollTop`. */
export function anchorForRow(row: AnchorRow, scrollTop: number): ListAnchor {
  return { rowId: row.id, offset: row.top - scrollTop };
}

/**
 * The anchor after a scroll. A row the anchor already names keeps it while any
 * of that row is still in view — so a row the reader clicked stays the anchor
 * as they nudge the list — and otherwise the anchor is the first row in view.
 * `rows` are in list order; `null` when no row is in view at all.
 */
export function anchorAfterScroll(
  rows: readonly AnchorRow[],
  scrollTop: number,
  clientHeight: number,
  current: ListAnchor | null,
): ListAnchor | null {
  const bottom = scrollTop + clientHeight;
  const inView = (r: AnchorRow): boolean => r.top + r.height > scrollTop && r.top < bottom;
  if (current !== null) {
    const held = rows.find((r) => r.id === current.rowId);
    if (held !== undefined && inView(held)) return anchorForRow(held, scrollTop);
  }
  const first = rows.find(inView);
  return first === undefined ? null : anchorForRow(first, scrollTop);
}

/**
 * The `scrollTop` that puts the anchor's row at its offset, or `null` when the
 * row is not in this list (the caller leaves the scroller where it is).
 *
 * The offset is clamped "nearest" first, so a row anchored near the bottom of
 * a tall card is still wholly in view in a shorter one; the result is then
 * clamped to the scroller's range, which near either end of the list leaves
 * the row as close to its offset as the list can put it.
 */
export function scrollTopForAnchor(
  anchor: ListAnchor,
  row: AnchorRow | null,
  viewport: AnchorViewport,
): number | null {
  if (row === null || row.id !== anchor.rowId) return null;
  const lowest = Math.max(0, viewport.clientHeight - row.height);
  const offset = Math.min(anchor.offset, lowest);
  const max = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  return Math.min(max, Math.max(0, row.top - offset));
}

/**
 * The shell's half: take each Workspaces card's proposed anchor as the deck's.
 * Called once, by the shell; a body proposes through the store and reads its
 * replica. Returns the release.
 */
export function shareCardsListAnchor(bus: PageBus = pageBus()): () => void {
  const store = cardsListAnchor.on(bus);
  return store.onProposal((anchor) => {
    store.set(anchor);
  });
}
