/**
 * list-view-height-index — sparse measured-height store for `TugListView`.
 *
 * Internal building block — app code uses `TugListView` instead.
 *
 * Holds measured heights for cells the list view has actually
 * rendered and observed via `ResizeObserver`. Unmeasured indices fall
 * back to the consumer's `delegate.estimatedHeightForKind` value via
 * the accessor parameter on the read methods. The combination
 * (measured + estimate fallback) gives `computeWindow` a continuous
 * height function over the full item range, which it needs to walk
 * cumulative offsets without gaps.
 *
 * **Sparse by design.** The map is keyed on rendered-cell indices;
 * cells that scroll out of the rendered window have their entries
 * left in place (so a subsequent scroll-back returns the previously-
 * measured height before `ResizeObserver` re-fires). Stale entries
 * for indices that no longer exist (after a data-source shrink) are
 * harmless — `computeWindow` walks `[0, itemCount)` and ignores them.
 *
 * **Two-tier read implementation.** All read methods accept
 * `(itemCount, estimateFn)` (the original stateless API). When a
 * caller has called `prepare(itemCount, estimateFn)` first, reads use
 * an internal Fenwick (binary-indexed) tree of effective heights for
 * O(log n) `offsetForIndex` / `indexForOffset` and O(1) `totalHeight`.
 * When the cache is absent or stale (`prepare` never called, or the
 * args differ from what was prepared), reads fall back to a linear
 * walk — the legacy O(n) path remains correct but slower. `set`,
 * `delete`, and `clear` keep the cache up-to-date by patching the
 * Fenwick tree in place when the index is in range, or invalidating
 * the cache when it isn't.
 *
 * The fallback path means `prepare` is an opt-in performance hint, not
 * a correctness requirement — existing call sites that don't call
 * `prepare` continue to work; they just walk linearly. New callers
 * that want the binary-search behavior call `prepare` once per
 * `(itemCount, estimateFn)` change and read freely afterward.
 *
 * **A stale tier.** A width change that re-wraps text makes every
 * measured height suspect without making it useless: the row is still
 * there, and its old height is a far better stand-in than an estimate
 * or a mount of the whole list. `markAllStale` keeps every height and
 * flags it; `set` clears the flag for the row it measures. `has` keeps
 * its meaning (a height is present, fresh or stale), and the flag
 * travels with its entry through `shift`, `delete` and `clear`. The
 * Fenwick cache never sees the flag, because flipping it changes no
 * height.
 *
 * Laws: this module is non-React, non-DOM. No tuglaws apply directly
 * — the height index is consumed by `TugListView`, which carries the
 * relevant law citations.
 */

interface PreparedCache {
  itemCount: number;
  estimateFn: (index: number) => number;
  /** Effective height per index (measured if known, else estimate). */
  effective: Float64Array;
  /** 1-indexed Fenwick tree over `effective`; bit[0] is unused. */
  bit: Float64Array;
}

export class HeightIndex {
  private readonly heights = new Map<number, number>();

  /** Indices whose height predates the last `markAllStale`; always a subset of `heights`' keys. */
  private readonly stale = new Set<number>();

  private cache: PreparedCache | null = null;

  /** The held heights sorted ascending, for `median`; null until asked after a change. */
  private sorted: number[] | null = null;

  /**
   * Record a measured height for the cell at `index`. Negative,
   * non-finite, or NaN values are silently ignored — `ResizeObserver`
   * has been observed to deliver zero or sub-pixel values during
   * paint, but never negative or infinite, so dropping them is a
   * defensive guard rather than a normal path.
   *
   * If a Fenwick cache is active and `index` falls within its
   * `[0, itemCount)` range, the tree is patched in place with the
   * delta between the old effective height and the new measurement.
   * Out-of-range writes leave the cache intact and become visible the
   * next time `prepare` is called.
   *
   * A recorded measurement is fresh: the index leaves the stale tier.
   */
  set(index: number, height: number): void {
    if (!Number.isFinite(height) || height < 0) return;
    this.heights.set(index, height);
    this.stale.delete(index);
    this.sorted = null;
    if (this.cache !== null && index >= 0 && index < this.cache.itemCount) {
      const oldEffective = this.cache.effective[index];
      this.cache.effective[index] = height;
      this._bitUpdate(this.cache, index, height - oldEffective);
    }
  }

  /** Return the measured height at `index`, or `undefined` if unmeasured. */
  get(index: number): number | undefined {
    return this.heights.get(index);
  }

  /** Whether `index` has been measured. */
  has(index: number): boolean {
    return this.heights.has(index);
  }

  /**
   * Keep every measured height and mark it stale — the ledger's answer
   * to a width change that re-wraps text. The heights still stand in
   * the spacers, and each row is measured fresh as it mounts.
   */
  markAllStale(): void {
    for (const index of this.heights.keys()) this.stale.add(index);
  }

  /**
   * Mark one held height stale; a no-op for an index with no height. A
   * seeded height found to have been measured at another width is
   * marked this way, without touching heights measured live.
   */
  markStale(index: number): void {
    if (this.heights.has(index)) this.stale.add(index);
  }

  /** Whether `index` has a height measured since the last `markAllStale`. */
  isFresh(index: number): boolean {
    return this.heights.has(index) && !this.stale.has(index);
  }

  /** How many held heights are stale. */
  staleCount(): number {
    return this.stale.size;
  }

  /**
   * How many rows of `[0, itemCount)` are still to be measured: those with
   * no height and those whose height is stale. A drain is over when this
   * reaches 0.
   */
  pendingCount(itemCount: number): number {
    const n = Math.max(0, Math.floor(itemCount));
    let fresh = 0;
    for (const index of this.heights.keys()) {
      if (index >= 0 && index < n && !this.stale.has(index)) fresh += 1;
    }
    return n - fresh;
  }

  /**
   * The median held height, fresh or stale, or `null` with none held. An
   * even count takes the mean of the middle two. The sorted values are
   * cached until the next `set`, `delete`, `clear`, `shift` or `adjustAll`.
   */
  median(): number | null {
    if (this.heights.size === 0) return null;
    if (this.sorted === null) {
      this.sorted = Array.from(this.heights.values()).sort((a, b) => a - b);
    }
    const s = this.sorted;
    const mid = s.length >> 1;
    return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  }

  /**
   * Re-read the estimate for every unmeasured row of the prepared cache
   * from the cache's own `estimateFn`, and rebuild the tree in place — the
   * answer to an estimate whose value moved while its identity did not
   * (the list's median estimate, read through a ref). Measured rows are
   * untouched. A no-op with no cache.
   */
  reestimate(): void {
    const cache = this.cache;
    if (cache === null) return;
    for (let i = 0; i < cache.itemCount; i += 1) {
      if (!this.heights.has(i)) cache.effective[i] = Math.max(0, cache.estimateFn(i));
    }
    cache.bit.fill(0);
    this._bitBuild(cache);
  }

  /**
   * Add `delta` to EVERY stored measurement — the rebase for a change
   * in a per-row constant folded into the entries. The concrete case:
   * ledger entries are outer extents (measured height + the list's
   * flex `row-gap`), and when the live gap changes — a per-card
   * density setting landing after mount, a theme swap — every entry's
   * gap term is off by the same delta. Re-measuring is wrong (the
   * rows' own heights didn't change) and wiping is wasteful (it
   * forces a full remount to re-measure); adding the delta restores
   * exactness in O(n).
   *
   * Entries clamp at 0 (a negative extent is meaningless). Any
   * prepared Fenwick cache is patched in place — measured entries in
   * range copy their clamped values into `effective[]` and the tree
   * is rebuilt with the same O(n) linear sweep `prepare` uses.
   * Nulling the cache instead would silently demote every subsequent
   * read to the O(n) fallback for the rest of the session: nothing
   * re-runs `prepare` after a gap rebase, because its keying inputs
   * (`itemCount`, estimate identity) don't change.
   */
  adjustAll(delta: number): void {
    if (delta === 0) return;
    for (const [index, height] of this.heights) {
      this.heights.set(index, Math.max(0, height + delta));
    }
    this.sorted = null;
    const cache = this.cache;
    if (cache === null) return;
    for (let i = 0; i < cache.itemCount; i += 1) {
      const measured = this.heights.get(i);
      if (measured !== undefined) cache.effective[i] = measured;
    }
    cache.bit.fill(0);
    this._bitBuild(cache);
  }

  /**
   * Drop the measurement at `index`. Returns `true` if a value was
   * removed. If a Fenwick cache is active and `index` is in range,
   * the tree is patched back to the estimate value.
   */
  delete(index: number): boolean {
    const had = this.heights.delete(index);
    this.stale.delete(index);
    if (had) this.sorted = null;
    if (
      had
      && this.cache !== null
      && index >= 0
      && index < this.cache.itemCount
    ) {
      const oldEffective = this.cache.effective[index];
      const newEffective = Math.max(0, this.cache.estimateFn(index));
      this.cache.effective[index] = newEffective;
      this._bitUpdate(this.cache, index, newEffective - oldEffective);
    }
    return had;
  }

  /**
   * Drop every measurement. Invalidates any prepared cache; the next
   * `prepare` call rebuilds from estimates only.
   */
  clear(): void {
    this.heights.clear();
    this.stale.clear();
    this.cache = null;
    this.sorted = null;
  }

  /** Number of measured indices currently held. */
  get size(): number {
    return this.heights.size;
  }

  /**
   * Remap every measured height by `+by` indices — the transform a
   * front-insert (prepend) needs so each already-measured cell keeps its
   * height as its index shifts. After `M` rows are inserted at the front,
   * the cell formerly at index `i` is now at `i + M`; calling
   * `shift(M)` moves its measurement accordingly so the height index
   * stays aligned with the DOM without re-measuring the existing rows.
   * A stale entry stays stale at its new index.
   *
   * `by <= 0` is a no-op. Invalidates any prepared cache — the next
   * `prepare` rebuilds the Fenwick tree over the shifted indices.
   */
  shift(by: number): void {
    const delta = Math.floor(by);
    if (delta <= 0 || this.heights.size === 0) return;
    const shifted = new Map<number, number>();
    for (const [i, h] of this.heights) {
      shifted.set(i + delta, h);
    }
    this.heights.clear();
    for (const [i, h] of shifted) {
      this.heights.set(i, h);
    }
    if (this.stale.size > 0) {
      const moved = Array.from(this.stale, (i) => i + delta);
      this.stale.clear();
      for (const i of moved) this.stale.add(i);
    }
    this.cache = null;
    this.sorted = null;
  }

  /**
   * Build (or refresh) the internal Fenwick cache for the supplied
   * `(itemCount, estimateFn)` pair. After calling this, `totalHeight`,
   * `offsetForIndex`, and `indexForOffset` all run in O(log n) (or
   * O(1) for the constant-time root). The cache is automatically
   * patched on subsequent `set` / `delete` calls; it must be rebuilt
   * via another `prepare` call when `itemCount` grows or the estimate
   * function changes identity.
   *
   * Calling `prepare` is optional — read methods fall back to a
   * linear walk when the cache is absent or stale, so correctness
   * doesn't depend on it. Performance-sensitive callers (`TugListView`)
   * call it once per data-source / estimate change.
   *
   * Cost: O(itemCount) build (one pass to fill `effective`, one pass
   * to construct the Fenwick tree). Subsequent reads run in O(log n).
   */
  prepare(itemCount: number, estimateFn: (index: number) => number): void {
    const safeItemCount = Math.max(0, Math.floor(itemCount));
    if (
      this.cache !== null
      && this.cache.itemCount === safeItemCount
      && this.cache.estimateFn === estimateFn
    ) {
      return; // Already prepared with these inputs.
    }
    const effective = new Float64Array(safeItemCount);
    const bit = new Float64Array(safeItemCount + 1); // 1-indexed.
    for (let i = 0; i < safeItemCount; i += 1) {
      const measured = this.heights.get(i);
      effective[i] =
        measured !== undefined ? measured : Math.max(0, estimateFn(i));
    }
    this.cache = { itemCount: safeItemCount, estimateFn, effective, bit };
    this._bitBuild(this.cache);
  }

  /**
   * Sum of heights over `[0, itemCount)`, using measured heights when
   * known and the estimate accessor otherwise. Used by
   * `computeWindow` to populate spacer geometry and by the list view
   * to decide when a re-window is warranted.
   *
   * Fast path (O(1)): when a prepared cache matches `itemCount` and
   * `estimatedHeightForIndex` identity, reads the Fenwick tree's
   * total directly. Fallback path (O(n)): walks linearly.
   */
  totalHeight(
    itemCount: number,
    estimatedHeightForIndex: (index: number) => number,
  ): number {
    if (itemCount <= 0) return 0;
    const safeItemCount = Math.floor(itemCount);
    if (this._cacheMatches(safeItemCount, estimatedHeightForIndex)) {
      return this._bitPrefixSum(this.cache!, safeItemCount);
    }
    let total = 0;
    for (let i = 0; i < safeItemCount; i += 1) {
      const measured = this.heights.get(i);
      if (measured !== undefined) {
        total += measured;
      } else {
        total += Math.max(0, estimatedHeightForIndex(i));
      }
    }
    return total;
  }

  /**
   * Cumulative offset of cell `index` (sum of heights of cells
   * `[0, index)`). Used by `scrollToIndex` to compute the target
   * `scrollTop`. Out-of-range clamping matches `offsetForIndex` in
   * `list-view-window.ts`: negative → 0; index past end of the
   * prepared range → total height of the prepared range (with no
   * cache, walks until the heights map runs out and returns the
   * partial sum).
   *
   * Fast path (O(log n)): when a prepared cache covers `index` and
   * matches `estimatedHeightForIndex` identity, reads the Fenwick
   * tree's prefix sum. Fallback path (O(n)): walks linearly.
   */
  offsetForIndex(
    index: number,
    estimatedHeightForIndex: (index: number) => number,
  ): number {
    if (index <= 0) return 0;
    const target = Math.floor(index);
    if (
      this.cache !== null
      && this.cache.estimateFn === estimatedHeightForIndex
      && this.cache.itemCount >= target
    ) {
      return this._bitPrefixSum(this.cache, target);
    }
    let offset = 0;
    for (let i = 0; i < target; i += 1) {
      const measured = this.heights.get(i);
      if (measured !== undefined) {
        offset += measured;
      } else {
        offset += Math.max(0, estimatedHeightForIndex(i));
      }
    }
    return offset;
  }

  /**
   * Find the smallest index `i` in `[0, itemCount)` whose cumulative
   * `bottom` exceeds `offset` — i.e. the cell that contains the given
   * pixel position. Used by `scrollToIndex` for unrendered targets
   * and by future window-aware fast paths.
   *
   * Fast path (O(log n)): when a prepared cache matches `itemCount`
   * and `estimatedHeightForIndex` identity, walks the Fenwick tree
   * via standard binary lifting. Fallback path (O(n)): walks
   * linearly.
   */
  indexForOffset(
    offset: number,
    itemCount: number,
    estimatedHeightForIndex: (index: number) => number,
  ): number {
    if (itemCount <= 0) return 0;
    if (offset <= 0) return 0;
    const safeItemCount = Math.floor(itemCount);
    if (this._cacheMatches(safeItemCount, estimatedHeightForIndex)) {
      return this._bitBinarySearch(this.cache!, offset);
    }
    let cumulative = 0;
    for (let i = 0; i < safeItemCount; i += 1) {
      const measured = this.heights.get(i);
      const h =
        measured !== undefined
          ? measured
          : Math.max(0, estimatedHeightForIndex(i));
      const itemBottom = cumulative + h;
      if (itemBottom > offset) return i;
      cumulative = itemBottom;
    }
    return safeItemCount - 1;
  }

  // ---------------------------------------------------------------------
  // Fenwick internals
  // ---------------------------------------------------------------------

  private _cacheMatches(
    itemCount: number,
    estimateFn: (index: number) => number,
  ): boolean {
    return (
      this.cache !== null
      && this.cache.itemCount === itemCount
      && this.cache.estimateFn === estimateFn
    );
  }

  /**
   * Linear-time Fenwick construction over `cache.effective` into
   * `cache.bit` (which must be zeroed): each bit[i] is initially the
   * sum of its responsibility range (a lowbit-sized window ending at
   * i-1 in 0-indexed terms). Building incrementally via `_bitUpdate`
   * would be O(n log n); this in-place sweep is O(n). Shared by
   * `prepare` (fresh build) and `adjustAll` (in-place rebuild).
   */
  private _bitBuild(cache: PreparedCache): void {
    const n = cache.itemCount;
    for (let i = 1; i <= n; i += 1) {
      cache.bit[i] += cache.effective[i - 1];
      const j = i + (i & -i);
      if (j <= n) {
        cache.bit[j] += cache.bit[i];
      }
    }
  }

  /** Add `delta` to position `index0` (0-indexed) of the Fenwick tree. */
  private _bitUpdate(cache: PreparedCache, index0: number, delta: number): void {
    if (delta === 0) return;
    const n = cache.itemCount;
    let i = index0 + 1; // 1-indexed.
    while (i <= n) {
      cache.bit[i] += delta;
      i += i & -i;
    }
  }

  /** Sum of `effective[0..endExclusive)`. */
  private _bitPrefixSum(cache: PreparedCache, endExclusive: number): number {
    let sum = 0;
    let i = Math.min(endExclusive, cache.itemCount);
    while (i > 0) {
      sum += cache.bit[i];
      i -= i & -i;
    }
    return sum;
  }

  /**
   * Find the smallest 0-indexed `i` such that the cumulative bottom
   * after cell `i` strictly exceeds `offset` — i.e. the cell that
   * CONTAINS `offset`. Standard Fenwick binary-lifting walk.
   */
  private _bitBinarySearch(cache: PreparedCache, offset: number): number {
    const n = cache.itemCount;
    if (n === 0) return 0;
    let idx = 0; // running 1-indexed prefix end.
    let cumulative = 0;
    let mask = 1;
    while (mask * 2 <= n) mask *= 2;
    while (mask > 0) {
      const next = idx + mask;
      if (next <= n && cumulative + cache.bit[next] <= offset) {
        idx = next;
        cumulative += cache.bit[next];
      }
      mask >>= 1;
    }
    // After the walk: cumulative = prefix[idx] (1-indexed) ≤ offset,
    // and prefix[idx + 1] > offset (by the loop's maximality). The
    // 0-indexed cell containing `offset` is `idx` itself (since
    // 0-indexed cell `idx` spans `[prefix[idx], prefix[idx + 1])`).
    return Math.min(idx, n - 1);
  }
}
