/**
 * ask-forwarder.ts — a question for a Session card, in whichever page holds it.
 *
 * `pendingAskStore` parks a question on the target session's
 * `CodeSessionStore`, and the card renders its dialog from that store. Each
 * page has its own: a Session card that is a body holds its store in its own
 * page, and the shell holds no services for it at all, so a question the
 * shell parked would find no card and be answered with its fallback, nobody
 * asked. The body shell installs a forwarder that shows the question in the
 * card's body instead; the shell's store still owns it, and the answer comes
 * back as `ask-response` advice.
 *
 * @module lib/ask-forwarder
 */

import type { PendingAsk } from "./code-session-store/types";

/** Shows questions in body cards. */
export interface AskForwarder {
  /** Whether `cardId` is a body card that can show a question now. */
  holds: (cardId: string) => boolean;
  /** Show `ask` in `cardId`'s body, or take its dialog down (`null`). */
  show: (cardId: string, ask: PendingAsk | null) => void;
}

let forwarder: AskForwarder | null = null;

/** Install the forwarder for questions. Returns the uninstall. */
export function setAskForwarder(fn: AskForwarder): () => void {
  forwarder = fn;
  return () => {
    if (forwarder === fn) forwarder = null;
  };
}

/** The installed forwarder, if `cardId` is a card it holds; `null` otherwise. */
export function askForwarderFor(cardId: string): AskForwarder | null {
  return forwarder !== null && forwarder.holds(cardId) ? forwarder : null;
}
