/**
 * list-view-keyed-ledger — a measured-height store keyed by row key.
 *
 * Internal building block. `HeightIndex` is the list view's ledger, keyed
 * by index, which a prepend moves with a positive `shift`. A column that
 * also trims rows from its front — the Overview's, at its row cap — cannot
 * follow that with index keys, so it keeps its heights by the row's own key,
 * where a prepend and a trim move nothing.
 *
 * The tiers are `HeightIndex`'s: a key has a height or not, and a height is
 * fresh or stale. `markAllStale` keeps every height and flags it, `set`
 * clears the flag for the key it measures, and a stale height is still a
 * far better stand-in than an estimate.
 *
 * Entries are **outer extents** — a row's measured height plus the row gap
 * after it — the list view's convention, so a run of rows sums to its share
 * of the column with no per-row arithmetic. A change of the live gap is
 * `adjustAll(delta)`, never a re-measure.
 *
 * What a window reads is index-shaped, so `viewFor(keys)` answers the
 * window's `MeasureLedger` questions over one render's key order.
 *
 * Laws: this module is non-React, non-DOM. The consumer carries the law
 * citations.
 */

import type { MeasureLedger } from "./list-view-window";

export class KeyedHeightLedger {
  private readonly extents = new Map<string, number>();
  private readonly stale = new Set<string>();

  /** Record `key`'s measured extent, fresh. */
  set(key: string, extent: number): void {
    this.extents.set(key, extent);
    this.stale.delete(key);
  }

  get(key: string): number | undefined {
    return this.extents.get(key);
  }

  /** Whether `key` has a height, fresh or stale. */
  has(key: string): boolean {
    return this.extents.has(key);
  }

  /** Whether `key` has a height measured since the last `markAllStale`. */
  isFresh(key: string): boolean {
    return this.extents.has(key) && !this.stale.has(key);
  }

  /** Flag every held height stale, keeping it. */
  markAllStale(): void {
    for (const key of this.extents.keys()) this.stale.add(key);
  }

  /** Mark one held extent stale; a no-op for a key with no extent. */
  markStale(key: string): void {
    if (this.extents.has(key)) this.stale.add(key);
  }

  /** How many of `keys` have no height or a stale one. */
  pendingCount(keys: readonly string[]): number {
    let n = 0;
    for (const key of keys) if (!this.isFresh(key)) n += 1;
    return n;
  }

  /**
   * The median held extent, or `null` with none held. An even count takes
   * the mean of the middle two.
   */
  median(): number | null {
    const n = this.extents.size;
    if (n === 0) return null;
    const sorted = [...this.extents.values()].sort((a, b) => a - b);
    const mid = n >> 1;
    return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  }

  /** Drop every key not in `liveKeys`. */
  prune(liveKeys: Iterable<string>): void {
    const live = new Set(liveKeys);
    for (const key of this.extents.keys()) {
      if (live.has(key)) continue;
      this.extents.delete(key);
      this.stale.delete(key);
    }
  }

  /**
   * Add `delta` to every held extent — the rebase for a change in the row
   * gap folded into each entry. Freshness is untouched: the rows' own
   * heights did not change.
   */
  adjustAll(delta: number): void {
    if (delta === 0) return;
    for (const [key, extent] of this.extents) this.extents.set(key, extent + delta);
  }

  get size(): number {
    return this.extents.size;
  }

  /** The ledger as a window reads it, by index into `keys`. */
  viewFor(keys: readonly string[]): MeasureLedger {
    return {
      has: (i) => {
        const key = keys[i];
        return key !== undefined && this.has(key);
      },
      isFresh: (i) => {
        const key = keys[i];
        return key !== undefined && this.isFresh(key);
      },
    };
  }
}
