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
 * pixel for pixel when the arriving card's box matches the departing one, at
 * the same offset in a card that moved or grew when it does not — a taller
 * card is given the room past the list's end that the offset needs, rather
 * than clamping the row lower ({@link slackForAnchor}) — and clamped "nearest"
 * so it stays in view when the arriving card is shorter.
 *
 * Beside the anchor stands the list's one cursor (`cards.listCursor`): the row
 * the keyboard is on, which a card coming on screen adopts as it places, so
 * that no card keeps a cursor of its own from the last time it was shown.
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

import {
  cardsListAnchor,
  cardsListCursor,
  type CardsListAnchorValue,
} from "@/bus/declarations/arrangement";
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
 * The `scrollTop` the anchor asks for before the scroller's range has a say:
 * the row at its offset, the offset clamped "nearest" so a row anchored near
 * the bottom of a tall card is still wholly in view in a shorter one.
 */
function wantedTop(anchor: ListAnchor, row: AnchorRow, viewport: AnchorViewport): number {
  const lowest = Math.max(0, viewport.clientHeight - row.height);
  const offset = Math.min(anchor.offset, lowest);
  return Math.max(0, row.top - offset);
}

/**
 * The `scrollTop` that puts the anchor's row at its offset, or `null` when the
 * row is not in this list (the caller leaves the scroller where it is).
 *
 * The result is clamped to the scroller's range. Near the top of the list
 * that leaves the row as close to its offset as the list can put it; near the
 * end a placement gives the scroller {@link slackForAnchor}'s room first, so
 * the clamp does not move the row there.
 */
export function scrollTopForAnchor(
  anchor: ListAnchor,
  row: AnchorRow | null,
  viewport: AnchorViewport,
): number | null {
  if (row === null || row.id !== anchor.rowId) return null;
  const max = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  return Math.min(max, wantedTop(anchor, row, viewport));
}

/**
 * How far past the list's end the scroller must reach to put the anchor's row
 * at its offset, px; 0 when its range already reaches.
 *
 * Each workspace sizes its own Workspaces card, so the card a switch arrives
 * in can be taller than the one the reader clicked in. A taller card has less
 * to scroll, and a row anchored low near the list's end asks for a
 * `scrollTop` the taller card cannot reach: clamped, every row lands lower by
 * the shortfall. That shortfall is the room this returns, measured against
 * the list's natural `scrollHeight` — the placement stands it below the list
 * so the row lands where it was clicked.
 */
export function slackForAnchor(
  anchor: ListAnchor,
  row: AnchorRow | null,
  viewport: AnchorViewport,
): number {
  if (row === null || row.id !== anchor.rowId) return 0;
  const max = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  return Math.max(0, wantedTop(anchor, row, viewport) - max);
}

/**
 * The room still wanted after a scroll: no more than keeps the scroller's
 * bottom edge where it is, so the room collapses as the reader scrolls back
 * up out of it and never lets them scroll further into it. `naturalHeight` is
 * the list's `scrollHeight` without the room.
 */
export function slackAfterScroll(
  slack: number,
  scrollTop: number,
  clientHeight: number,
  naturalHeight: number,
): number {
  return Math.max(0, Math.min(slack, scrollTop + clientHeight - naturalHeight));
}

/**
 * The shell's half: take each Workspaces card's proposed anchor, and its
 * proposed cursor, as the deck's. Called once, by the shell; a body proposes
 * through the stores and reads their replicas. Returns the release.
 */
export function shareCardsListAnchor(bus: PageBus = pageBus()): () => void {
  const store = cardsListAnchor.on(bus);
  const releaseAnchor = store.onProposal((anchor) => {
    store.set(anchor);
  });
  const cursor = cardsListCursor.on(bus);
  const releaseCursor = cursor.onProposal((rowId) => {
    cursor.set(rowId);
  });
  return () => {
    releaseAnchor();
    releaseCursor();
  };
}
