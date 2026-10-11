/**
 * open-quickly-store.ts — the open/closed state of the Open Quickly
 * popup (File ▸ Open Quickly, ⇧⌘O).
 *
 * A minimal module-singleton subscribable store ([L02]): the deck-global
 * overlay reads it through `useSyncExternalStore`; the `open-quickly`
 * action opens it; the popup closes it on commit / dismiss. Kept separate
 * from the deck store because the popup is chrome, not deck structure.
 *
 * @module lib/open-quickly-store
 */

import { createSubscribable } from "./subscribable";

let open = false;
const listeners = createSubscribable();

function emit(): void {
  listeners.notify();
}

/** Subscribe to open/close changes. Returns an unsubscribe function. */
export function subscribeOpenQuickly(listener: () => void): () => void {
  return listeners.subscribe(listener);
}

/** Current open state (the `useSyncExternalStore` snapshot). */
export function getOpenQuicklyOpen(): boolean {
  return open;
}

/** Open the popup (re-opening while open is a no-op). */
export function openOpenQuickly(): void {
  if (open) return;
  open = true;
  emit();
}

/** Close the popup (closing while closed is a no-op). */
export function closeOpenQuickly(): void {
  if (!open) return;
  open = false;
  emit();
}
