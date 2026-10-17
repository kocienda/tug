/**
 * body-chord-capture-store.ts — which body cards have a chord capture armed.
 *
 * A chord capture in a body page arms that page's `chordCaptureState`, which
 * the shell cannot read: the body says so over the bus (the `capture-armed`
 * advice), and this store is where the shell keeps the answer. The host-menu
 * publisher reads it beside the shell's own flag, so a capture armed in a
 * body parks the menu bar's key equivalents exactly as one armed in the shell
 * does. A body that terminates while armed is cleared here, since its disarm
 * can never arrive.
 *
 * @module lib/body-chord-capture-store
 */

import { createSubscribable } from "@/lib/subscribable";

const armed = new Set<string>();
const subscribers = createSubscribable();

export const bodyChordCaptureStore = {
  /** Record what `cardId`'s body said. Notifies only on a change. */
  set(cardId: string, isArmed: boolean): void {
    if (isArmed === armed.has(cardId)) return;
    if (isArmed) armed.add(cardId);
    else armed.delete(cardId);
    subscribers.notify();
  },

  /** Forget `cardId`: its body is gone, so nothing of its capture survives. */
  clear(cardId: string): void {
    if (!armed.delete(cardId)) return;
    subscribers.notify();
  },

  /** Whether any body's capture is armed. */
  isArmed(): boolean {
    return armed.size > 0;
  },

  subscribe(subscriber: () => void): () => void {
    return subscribers.subscribe(subscriber);
  },
};
