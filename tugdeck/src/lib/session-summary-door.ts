/**
 * session-summary-door.ts — a way into a card's Session Summary from outside
 * the masthead that draws it.
 *
 * The Summary is the masthead's popover, opened by its own trigger. A
 * command that wants to show it — a bare `/remove-dir`, whose list of
 * removable folders is the Summary's DIRECTORIES row — reaches it through the
 * opener the masthead registers here under its card's id. The masthead
 * registers in a layout effect ([L03]), so the opener is in place before any
 * command can ask for it.
 *
 * @module lib/session-summary-door
 */

/** Opens a card's Summary; `false` when there is nothing on screen to open. */
export type SessionSummaryOpener = () => boolean;

const openers = new Map<string, SessionSummaryOpener>();

/**
 * Register `cardId`'s Summary opener. The returned function withdraws it,
 * and leaves a newer registration for the same card in place.
 */
export function registerSessionSummaryOpener(
  cardId: string,
  opener: SessionSummaryOpener,
): () => void {
  openers.set(cardId, opener);
  return () => {
    if (openers.get(cardId) === opener) openers.delete(cardId);
  };
}

/** Open `cardId`'s Summary. `false` when no masthead offers one. */
export function openSessionSummary(cardId: string): boolean {
  return openers.get(cardId)?.() ?? false;
}
