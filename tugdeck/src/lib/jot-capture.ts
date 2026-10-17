/**
 * jot-capture.ts — ⌘J's capture, in whichever page holds the Jots card.
 *
 * `NEW_JOT` reveals the Jots card, then creates an empty jot and opens its
 * editor. The open row is the jots store's `editingId`, and each page has its
 * own store: a Jots card that is a body mounts its editor from its body's
 * store, so a create in the shell's store writes the jot and opens nothing.
 * The body shell installs a forwarder that takes the capture for a card that
 * is a body; any other card captures in this page's store.
 *
 * @module lib/jot-capture
 */

import { getJotsStore } from "./jots-store";

/** Takes the capture for `cardId` and says so, or declines it. */
export type JotCaptureForwarder = (cardId: string) => boolean;

let forwarder: JotCaptureForwarder | null = null;

/** Install the forwarder for jot captures. Returns the uninstall. */
export function setJotCaptureForwarder(fn: JotCaptureForwarder): () => void {
  forwarder = fn;
  return () => {
    if (forwarder === fn) forwarder = null;
  };
}

/** Create an empty jot in `cardId`, the Jots card, and open its editor. */
export function captureJot(cardId: string): void {
  if (forwarder !== null && forwarder(cardId)) return;
  getJotsStore().createJot(null);
}
