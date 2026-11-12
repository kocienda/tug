/**
 * workspace-name-zoom.ts — where the naming modal's zoom rectangles run
 * from, carried from the control that raised it to the shell that asks.
 *
 * A door with a place on screen — the Workspaces card's `+`, a header row's
 * `···` menu — measures itself in its own page and sends that rect with its
 * card id as `from` on the verb's payload ({@link zoomSourceOf}). The shell
 * reads it back ({@link readZoomSource}) and converts it to window points
 * ({@link zoomSourceInWindow}): a body card's page is drawn at its card's
 * content box, the `[data-body-placeholder]` the shell lays out for it, so
 * the rect is offset by that box's origin; a card the shell draws itself
 * shares the shell's viewport, and its rect stands as it is. A body card
 * with no placeholder is not on screen, and gives no rect: no run.
 *
 * Where the named workspace lands is the same trip the other way. The shell
 * asks the Workspaces card on screen to `locate` the workspace's header row
 * (`cards-space-verb-request.ts`); the card measures the row in its page and
 * answers through {@link reportSpaceRow} — over `cards.spaceRow` from a body
 * page, directly in a page with no body pages — and the shell converts the
 * rect the same way and sets it as the question's destination
 * ({@link answerSpaceRow}). A card with no row on screen answers `null`.
 *
 * @module lib/workspace-name-zoom
 */

import { cardsSpaceRow } from "../bus/declarations/arrangement";
import { page } from "../bus/page";
import { bodyCardsStore } from "./body-cards-store";
import { CARDS_CARD_ID } from "./cards-card-id";
import { cardsSpaceVerbRequest } from "./cards-space-verb-request";
import { setWorkspaceNameDestination, windowRectOf, type WorkspaceNameRect } from "./workspace-name-request";

/** A rect a card measured in its own page, and the card it measured it in. */
export interface ZoomSource {
  readonly cardId: string;
  readonly rect: WorkspaceNameRect;
}

/** The `from` a door sends on its verb's payload: `el`'s rect, in card `cardId`'s page. */
export function zoomSourceOf(el: Element, cardId: string): ZoomSource {
  const box = el.getBoundingClientRect();
  return { cardId, rect: { top: box.top, left: box.left, width: box.width, height: box.height } };
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The `from` on a verb's payload, or `null` when it carries none — a door
 * with no place on screen (the Window menu, a chord) — or one that is not a
 * rect with a card id. An empty rect is none: there is nothing to run from.
 */
export function readZoomSource(payload: unknown): ZoomSource | null {
  if (typeof payload !== "object" || payload === null) return null;
  const from = (payload as { from?: unknown }).from;
  if (typeof from !== "object" || from === null) return null;
  const { cardId, rect } = from as { cardId?: unknown; rect?: unknown };
  if (typeof cardId !== "string" || typeof rect !== "object" || rect === null) return null;
  const { top, left, width, height } = rect as Record<string, unknown>;
  if (!finite(top) || !finite(left) || !finite(width) || !finite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { cardId, rect: { top, left, width, height } };
}

/**
 * `source`'s rect in window points, in the shell: offset by its card's
 * content box when the card is a body card, as it stands when the shell
 * draws the card, and `null` when a body card has no box on screen.
 */
export function zoomSourceInWindow(source: ZoomSource | null): WorkspaceNameRect | null {
  if (source === null) return null;
  if (!bodyCardsStore.has(source.cardId)) return windowRectOf(source.rect, null);
  const placeholder = document.querySelector<HTMLElement>(
    `[data-body-placeholder][data-card-id="${CSS.escape(source.cardId)}"]`,
  );
  if (placeholder === null) return null;
  const box = placeholder.getBoundingClientRect();
  return windowRectOf(source.rect, { x: box.x, y: box.y });
}

/**
 * In the shell: card `cardId`'s answer to `locate`, a header row's rect in
 * its page or `null` for none on screen, set as the open question's
 * destination in window points.
 */
export function answerSpaceRow(cardId: string, rect: WorkspaceNameRect | null): void {
  setWorkspaceNameDestination(rect === null ? null : zoomSourceInWindow({ cardId, rect }));
}

/**
 * In the Workspaces card: answer `locate` with the header row `row`, or
 * `null` when the row is not on screen. `row`'s rect is taken now.
 */
export function reportSpaceRow(cardId: string, row: Element | null): void {
  const rect = row === null ? null : zoomSourceOf(row, cardId).rect;
  const shown = rect !== null && rect.width > 0 && rect.height > 0 ? rect : null;
  if (page.isBody) cardsSpaceRow.dispatch({ rect: shown });
  else answerSpaceRow(cardId, shown);
}

/**
 * Ask where workspace `spaceId`'s header row lands, for the open question's
 * order-out: the Workspaces card on screen answers `locate`. A deck with no
 * Workspaces card has no row to land on, and the question is answered so
 * at once — the card is not revealed to give the zoom a destination. It reads
 * only the shown deck's cards, and is typed so: a Workspaces card's page loads
 * this module too, and a page holds no shell deck.
 */
export function locateSpaceRow(
  store: { getSnapshot(): { readonly cards: readonly { readonly componentId: string }[] } },
  spaceId: string,
): void {
  const holdsCards = store.getSnapshot().cards.some((card) => card.componentId === CARDS_CARD_ID);
  if (holdsCards) cardsSpaceVerbRequest.request("locate", spaceId);
  else setWorkspaceNameDestination(null);
}
