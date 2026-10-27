/**
 * fold-receipt-keep-store.ts — which fold receipts the reader has kept.
 *
 * A fold receipt reports a commit made on the base out of uncommitted work,
 * and it is answered: Undo takes the commit back, Keep accepts it. Keep is the
 * reader's acknowledgement, and the receipt hides once it is given.
 *
 * Deck-local and page-lived on purpose. The receipt already retires itself on
 * the server's side when the fold stops being the arc's newest op — a join
 * lands, or an undo runs — so a kept receipt that reappears after a reload is
 * one whose fold still stands, which is a true thing to show again. A key is
 * `<owner_id>|<seq>`, so a later fold on the same arc is a new receipt.
 *
 * [L02]: read through {@link useFoldReceiptKept}, a `useSyncExternalStore`.
 *
 * @module lib/fold-receipt-keep-store
 */

import { useSyncExternalStore } from "@/lib/gesture-scope";
import { Subscribable } from "@/lib/subscribable";

export class FoldReceiptKeepStore extends Subscribable {
  private kept = new Set<string>();

  /** Keep the receipt under `key`. Keeping one already kept changes nothing. */
  keep(key: string): void {
    if (this.kept.has(key)) return;
    this.kept = new Set(this.kept).add(key);
    this.notify();
  }

  /** Whether the receipt under `key` has been kept. */
  isKept(key: string): boolean {
    return this.kept.has(key);
  }

  /** Forget every kept receipt — tests only. */
  reset(): void {
    if (this.kept.size === 0) return;
    this.kept = new Set();
    this.notify();
  }
}

/** The deck's one store. */
export const foldReceiptKeepStore = new FoldReceiptKeepStore();

/** Whether the receipt under `key` has been kept, as a subscription. */
export function useFoldReceiptKept(key: string): boolean {
  return useSyncExternalStore(foldReceiptKeepStore.subscribe, () =>
    foldReceiptKeepStore.isKept(key),
  );
}

export function _resetFoldReceiptKeepStoreForTest(): void {
  foldReceiptKeepStore.reset();
}
