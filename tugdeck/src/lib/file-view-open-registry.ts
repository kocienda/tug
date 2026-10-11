/**
 * file-view-open-registry.ts — live index of mounted viewer cards, keyed by
 * card id, exposing each card's bound path.
 *
 * The read-only twin of `text-card-open-registry.ts`. The `open-file` action
 * uses it for the same path-keyed reuse: opening an image already on screen
 * raises that card instead of mounting a second copy of the same bytes.
 *
 * The entry interface is deliberately narrower than the Text card's. A viewer
 * is never dirty, has no unsaved mark, and has no lines to reveal, so those
 * members would be dead weight (or nullable holes on the text side) in a
 * shared registry.
 *
 * Entries are registered by `FileViewCardContent` in a layout effect and
 * removed on unmount. Callbacks read live state at call time ([L07]).
 *
 * @module lib/file-view-open-registry
 */

import { createSubscribable } from "./subscribable";

export interface FileViewOpenEntry {
  /** The card's bound path, or null before the seed restores. */
  getPath(): string | null;
  /**
   * Rebind this card to a different file (the "reuse frontmost card" open
   * target). The new path is written through to the card's persisted state,
   * so a reload re-resumes on the file the card is actually showing.
   */
  openFile(path: string): void;
}

const entries = new Map<string, FileViewOpenEntry>();

/** Observers notified when a viewer card mounts, unmounts, or rebinds. */
const listeners = createSubscribable();
let version = 0;

/** Subscribe to registry changes (register / unregister / path rebind). */
export function subscribeOpenFileViewCards(listener: () => void): () => void {
  return listeners.subscribe(listener);
}

/** A monotonic token that bumps on every registry change — a
 *  `useSyncExternalStore` snapshot paired with {@link subscribeOpenFileViewCards}. */
export function getOpenFileViewCardsVersion(): number {
  return version;
}

/** Notify observers that a card's binding changed even though the entry
 *  object is the same. Called by a viewer card when its path rebinds. */
export function notifyOpenFileViewCardsChanged(): void {
  version += 1;
  listeners.notify();
}

export function registerOpenFileViewCard(
  cardId: string,
  entry: FileViewOpenEntry,
): void {
  entries.set(cardId, entry);
  notifyOpenFileViewCardsChanged();
}

export function unregisterOpenFileViewCard(cardId: string): void {
  if (entries.delete(cardId)) notifyOpenFileViewCardsChanged();
}

/** The open entry for `cardId`, or null when not a mounted viewer card. */
export function getOpenFileViewCard(cardId: string): FileViewOpenEntry | null {
  return entries.get(cardId) ?? null;
}

/** Find the viewer card currently bound to `path` (exact string match). */
export function findFileViewCardByPath(
  path: string,
): { cardId: string; entry: FileViewOpenEntry } | null {
  for (const [cardId, entry] of entries) {
    if (entry.getPath() === path) return { cardId, entry };
  }
  return null;
}
