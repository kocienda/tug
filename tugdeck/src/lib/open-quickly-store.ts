/**
 * open-quickly-store.ts — the open/closed state of the Open Quickly
 * popup (File ▸ Open Quickly, ⇧⌘O).
 *
 * A minimal module-singleton subscribable store ([L02]): the deck-global
 * overlay reads it through `useSyncExternalStore`; the `open-quickly`
 * action opens it; the popup closes it on commit / dismiss. Kept separate
 * from the deck store because the popup is chrome, not deck structure.
 *
 * Where the host keeps an overlay the popup is drawn there ([B08]): the
 * shell's store is the truth, relayed as `overlay.openQuickly`, and the
 * overlay's copy adopts it and sends its own close and its chosen file back
 * through the sinks below.
 *
 * Every open request is numbered ({@link getOpenQuicklySeq}), a request made
 * while the shell holds the popup open included, and a close names the open
 * it closed. The overlay's close reaches the shell a bus hop after the
 * overlay took the popup down, so a ⇧⌘O pressed inside that hop finds the
 * shell still open: the request re-raises it under a new number, and the
 * close that arrives after is for the old one and is dropped.
 *
 * @module lib/open-quickly-store
 */

import { createSubscribable } from "./subscribable";

let open = false;
const listeners = createSubscribable();
let seq = 0;
const requests = createSubscribable();

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

/** The number of the latest open request. */
export function getOpenQuicklySeq(): number {
  return seq;
}

/** Subscribe to every open request, a re-raise while open included. Returns an unsubscribe function. */
export function subscribeOpenQuicklyRequests(listener: () => void): () => void {
  return requests.subscribe(listener);
}

/** Open the popup. A request while open notifies no open/close subscriber; it is numbered all the same. */
export function openOpenQuickly(): void {
  seq += 1;
  requests.notify();
  if (open) return;
  open = true;
  emit();
}

/** Close the popup (closing while closed is a no-op). */
export function closeOpenQuickly(): void {
  if (!open) return;
  open = false;
  emit();
  closeSink?.(seq);
}

let closeSink: ((seq: number) => void) | null = null;
let fileSink: ((path: string, line: number | undefined) => void) | null = null;

/** Take the shell's open state and request number, in the page that draws the popup for it. */
export function adoptOpenQuicklyOpen(next: boolean, nextSeq: number): void {
  seq = nextSeq;
  if (open === next) return;
  open = next;
  emit();
}

/** Where a close in the page that draws the popup goes, naming the open it closed: the shell, which holds the truth. */
export function setOpenQuicklyCloseSink(sink: ((seq: number) => void) | null): void {
  closeSink = sink;
}

/** Where the popup's chosen file goes when the page drawing it holds no deck to open it in. */
export function setOpenQuicklyFileSink(sink: ((path: string, line: number | undefined) => void) | null): void {
  fileSink = sink;
}

/** The file sink, or null where the popup opens files in its own page's deck. */
export function openQuicklyFileSink(): ((path: string, line: number | undefined) => void) | null {
  return fileSink;
}
