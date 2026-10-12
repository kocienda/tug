/**
 * list-view-window — pure windowing math for `TugListView`.
 *
 * Internal building block — app code uses `TugListView` instead.
 *
 * Given a viewport, a scroll offset, an item count, and a per-index
 * height accessor, computes which contiguous slice of indices should
 * be in the rendered window plus the spacer heights that fake the
 * scroll height for the unrendered cells. Pure: no React, no DOM, no
 * mutable state — drop-in testable.
 *
 * Step 3 ships the cumulative-walk variant, which is O(n) per call.
 * Step 4's height-index version will memoize prefix sums and use a
 * binary search; the public input/output shape stays the same so the
 * caller (`TugListView`) doesn't change.
 *
 * Semantics:
 * - The `firstIndex` / `lastIndex` slice is half-open `[firstIndex,
 *   lastIndex)` — `lastIndex` is the exclusive end. This matches
 *   typical JS slice idioms; `Array.slice(firstIndex, lastIndex)`
 *   gives the rendered range.
 * - `topSpacerHeight` is the total height of cells `[0, firstIndex)`
 *   so the rendered cells appear at the right scroll offset.
 * - `bottomSpacerHeight` is the total height of cells `[lastIndex,
 *   itemCount)` so the scroll height matches the document model.
 * - `totalHeight` is the sum of all item heights — convenient for
 *   spacer correctness checks and external scroll math.
 * - Two window shapes share this function. The cell-count shape
 *   (`overscanCount` alone) is the original. The pixel-margin shape
 *   (`mountMarginPx` / `retainMarginPx` / `prevRange`) adds mount and
 *   retain bands around the viewport: a cell enters the window when
 *   it reaches the mount band and leaves only when it clears the
 *   wider retain band, so a cell straddling the boundary cannot
 *   oscillate between mounted and unmounted as the scroll jitters.
 *
 * Edge cases (each pinned by its own test in Step 3):
 * - `itemCount === 0`: empty window, both spacers zero.
 * - `itemCount === 1`: a single rendered cell when in viewport,
 *   spacers reflect either side; no overscan into negative indices.
 * - `scrollTop > totalHeight`: window clamps to last item, top spacer
 *   covers everything before, bottom spacer is zero.
 * - `viewportHeight === 0`: window degenerates to overscan-only at
 *   the current scroll offset.
 * - `overscanCount` larger than itemCount: clamps; never produces
 *   indices outside `[0, itemCount)`.
 */

export interface ComputeWindowInput {
  /** Total number of items per `dataSource.numberOfItems()`. */
  itemCount: number;
  /** Current `scrollContainer.scrollTop` value. */
  scrollTop: number;
  /** Current `scrollContainer.clientHeight`. */
  viewportHeight: number;
  /**
   * Number of cells to render above and below the visible viewport
   * for smooth scrolling. The list view will render up to
   * `overscanCount` extra cells on each side of the visible range.
   */
  overscanCount: number;
  /**
   * Per-index height in CSS pixels. Step 3 calls this with a fixed
   * value derived from `delegate.estimatedHeightForKind`; Step 4
   * substitutes a `HeightIndex`-backed accessor that returns measured
   * heights when known and estimates otherwise.
   */
  estimatedHeightForIndex: (index: number) => number;
  /**
   * Inclusive index range that MUST be inside the rendered window
   * regardless of the scroll position — the pin that keeps rows
   * holding the user's selection or focus mounted while the visible
   * window moves elsewhere (the [L23] obligation under windowed
   * mounting). The window stays one contiguous range: it CLAMPS
   * outward to cover the pinned range, so a selection far from the
   * viewport widens the window rather than splitting it. The
   * degenerate cost (a selection spanning the whole document mounts
   * everything) exists only while such a selection exists and is
   * strictly bounded by user action. Out-of-range bounds clamp;
   * `null`/omitted means no pin.
   */
  pinnedRange?: { first: number; last: number } | null;
  /**
   * Pixel margin above and below the visible viewport within which a
   * cell enters the window. Supplying it (or `retainMarginPx`)
   * switches the window from cell-count overscan to pixel margins:
   * `overscanCount` still applies on top as a cell-count floor.
   *
   * Pixel margins exist because cell-count overscan is meaningless
   * when row heights vary by two orders of magnitude — three overscan
   * cells is either a screenful or a pixel depending on where the
   * scroll happens to be.
   */
  mountMarginPx?: number;
  /**
   * Pixel margin within which an ALREADY-WINDOWED cell (one named by
   * `prevRange`) is retained. Must be ≥ `mountMarginPx` to have any
   * effect; the gap between the two is the hysteresis band that keeps
   * a cell hovering at the boundary from mounting and unmounting on
   * alternating scroll ticks. Defaults to `mountMarginPx`.
   */
  retainMarginPx?: number;
  /**
   * The previous call's rendered range, half-open `[first, last)` —
   * feed it the prior result's `{firstIndex, lastIndex}` verbatim.
   * Cells in this range that still intersect the retain band stay in
   * the window even when they have left the mount band. Omitted or
   * `null` means no retention (a fresh window).
   */
  prevRange?: { first: number; last: number } | null;
}

export interface ComputeWindowResult {
  /** First rendered index (inclusive). */
  firstIndex: number;
  /** End of rendered range (exclusive). */
  lastIndex: number;
  /** Pixel height of the top spacer ([0, firstIndex)). */
  topSpacerHeight: number;
  /** Pixel height of the bottom spacer ([lastIndex, itemCount)). */
  bottomSpacerHeight: number;
  /** Sum of all item heights — total scroll height of the document. */
  totalHeight: number;
}

const EMPTY_RESULT: Readonly<ComputeWindowResult> = Object.freeze({
  firstIndex: 0,
  lastIndex: 0,
  topSpacerHeight: 0,
  bottomSpacerHeight: 0,
  totalHeight: 0,
});

export function computeWindow(input: ComputeWindowInput): ComputeWindowResult {
  const { itemCount, scrollTop, viewportHeight, overscanCount, estimatedHeightForIndex } = input;

  if (itemCount <= 0) {
    return EMPTY_RESULT;
  }

  const safeScrollTop = scrollTop < 0 ? 0 : scrollTop;
  const safeViewport = viewportHeight < 0 ? 0 : viewportHeight;
  const safeOverscan = overscanCount < 0 ? 0 : Math.floor(overscanCount);
  const viewportEnd = safeScrollTop + safeViewport;

  // Pixel-margin mode engages as soon as either margin is supplied;
  // otherwise the bands collapse onto the visible range and the
  // function behaves exactly as the cell-count version always has.
  const useMargins =
    input.mountMarginPx !== undefined || input.retainMarginPx !== undefined;
  const mountMargin = Math.max(0, input.mountMarginPx ?? 0);
  const retainMargin = Math.max(mountMargin, input.retainMarginPx ?? mountMargin);
  const mountBandTop = safeScrollTop - mountMargin;
  const mountBandBottom = viewportEnd + mountMargin;
  const retainBandTop = safeScrollTop - retainMargin;
  const retainBandBottom = viewportEnd + retainMargin;

  // First pass: walk indices, accumulate height, find the visible
  // window's edges (and the margin bands' edges when they apply).
  // Single-pass O(n); Step 4 swaps this for a binary-search-friendly
  // height index.
  let firstVisibleIndex = -1;
  let lastVisibleIndex = -1;
  let firstMountIndex = -1;
  let lastMountIndex = -1;
  let firstRetainIndex = -1;
  let lastRetainIndex = -1;
  let cumulative = 0;

  for (let i = 0; i < itemCount; i += 1) {
    const h = Math.max(0, estimatedHeightForIndex(i));
    const itemTop = cumulative;
    const itemBottom = cumulative + h;

    if (firstVisibleIndex === -1 && itemBottom > safeScrollTop) {
      firstVisibleIndex = i;
      // Seed `lastVisibleIndex` to the first match so a zero-height
      // viewport (`viewportHeight === 0`) still produces a non-empty
      // window. Without this seed, the second predicate below would
      // never fire when `itemTop === viewportEnd`.
      lastVisibleIndex = i;
    }
    if (firstVisibleIndex !== -1 && itemTop < viewportEnd) {
      lastVisibleIndex = i;
    }

    if (useMargins) {
      if (firstMountIndex === -1 && itemBottom > mountBandTop) {
        firstMountIndex = i;
        lastMountIndex = i;
      }
      if (firstMountIndex !== -1 && itemTop < mountBandBottom) {
        lastMountIndex = i;
      }
      if (firstRetainIndex === -1 && itemBottom > retainBandTop) {
        firstRetainIndex = i;
        lastRetainIndex = i;
      }
      if (firstRetainIndex !== -1 && itemTop < retainBandBottom) {
        lastRetainIndex = i;
      }
    }

    cumulative = itemBottom;
  }

  const totalHeight = cumulative;

  // No visible item — distinguish two cases:
  //   1. All items have zero total height (every cell is zero-tall).
  //      The list has no scrollable extent; render everything in
  //      document order so any zero-height content (focus rings,
  //      outlines, etc.) still paints.
  //   2. Scroll position is past the end of a non-zero document.
  //      Clamp the window to the last item so the user still sees
  //      content rather than an empty viewport.
  if (firstVisibleIndex === -1) {
    if (totalHeight === 0) {
      return {
        firstIndex: 0,
        lastIndex: itemCount,
        topSpacerHeight: 0,
        bottomSpacerHeight: 0,
        totalHeight: 0,
      };
    }
    firstVisibleIndex = itemCount - 1;
    lastVisibleIndex = itemCount - 1;
  }

  // The window's base is the mount band when pixel margins apply,
  // the visible range otherwise. A scroll position past the end can
  // leave the band empty (`-1`); the visible fallback above has
  // already clamped to the last item, so reuse it.
  const baseFirst =
    useMargins && firstMountIndex !== -1 ? firstMountIndex : firstVisibleIndex;
  const baseLast =
    useMargins && firstMountIndex !== -1 ? lastMountIndex : lastVisibleIndex;

  // Apply overscan symmetrically. Clamp to [0, itemCount).
  let firstIndex = Math.max(0, baseFirst - safeOverscan);
  let lastIndexInclusive = Math.min(itemCount - 1, baseLast + safeOverscan);

  // Retention (hysteresis): a cell the previous window rendered stays
  // rendered while it still intersects the retain band, even once it
  // has left the mount band. Both ranges are contiguous, so their
  // union is taken by clamping outward — the window never splits.
  const prev = useMargins ? (input.prevRange ?? null) : null;
  if (prev !== null && firstRetainIndex !== -1) {
    const prevFirst = Math.floor(prev.first);
    const prevLastInclusive = Math.floor(prev.last) - 1;
    const retainedFirst = Math.max(prevFirst, firstRetainIndex);
    const retainedLast = Math.min(prevLastInclusive, lastRetainIndex);
    if (retainedFirst <= retainedLast) {
      firstIndex = Math.max(0, Math.min(firstIndex, retainedFirst));
      lastIndexInclusive = Math.min(
        itemCount - 1,
        Math.max(lastIndexInclusive, retainedLast),
      );
    }
  }

  // Pinned-range clamp: widen the window outward until it covers the
  // pinned (selection/focus) rows. One contiguous range, so spacer
  // math below is untouched.
  const pinned = input.pinnedRange ?? null;
  if (pinned !== null) {
    const pinFirst = Math.max(0, Math.min(itemCount - 1, Math.floor(pinned.first)));
    const pinLast = Math.max(0, Math.min(itemCount - 1, Math.floor(pinned.last)));
    firstIndex = Math.min(firstIndex, Math.min(pinFirst, pinLast));
    lastIndexInclusive = Math.max(lastIndexInclusive, Math.max(pinFirst, pinLast));
  }
  const lastIndex = lastIndexInclusive + 1;

  // Compute spacer heights. Two more single-pass walks; total
  // complexity remains O(n) for Step 3.
  let topSpacerHeight = 0;
  for (let i = 0; i < firstIndex; i += 1) {
    topSpacerHeight += Math.max(0, estimatedHeightForIndex(i));
  }
  let bottomSpacerHeight = 0;
  for (let i = lastIndex; i < itemCount; i += 1) {
    bottomSpacerHeight += Math.max(0, estimatedHeightForIndex(i));
  }

  return {
    firstIndex,
    lastIndex,
    topSpacerHeight,
    bottomSpacerHeight,
    totalHeight,
  };
}

/**
 * Compute the cumulative offset (in CSS pixels) of the cell at
 * `index`. Used by `scrollToIndex` to compute the target `scrollTop`
 * for an unrendered row. Pure single-pass O(n); Step 4 swaps for a
 * height-index prefix-sum lookup.
 *
 * Out-of-range indices clamp: negative → 0; index >= itemCount →
 * `totalHeight` (the document end). Matches the [D03] tolerance for
 * stale index paths.
 */
export function offsetForIndex(
  index: number,
  itemCount: number,
  estimatedHeightForIndex: (index: number) => number,
): number {
  if (itemCount <= 0 || index <= 0) {
    return 0;
  }
  const stop = Math.min(index, itemCount);
  let offset = 0;
  for (let i = 0; i < stop; i += 1) {
    offset += Math.max(0, estimatedHeightForIndex(i));
  }
  return offset;
}

/**
 * What a settled change in a list's scroller width means for the
 * measured-height ledger.
 *
 * - `unchanged` — the width moved less than half a pixel: nothing to do.
 * - `reflowed` — the content box changed at a fixed View › Zoom factor:
 *   a pane drag, a card resize. Text re-wraps, every measured height is
 *   suspect, and the ledger is wiped so the next commit re-measures it.
 * - `rescaled` — the width moved together with the zoom factor. The deck
 *   root is scaled by a transform and sized to the window ÷ the factor,
 *   so a card sized from the viewport changes its layout width by the
 *   factor's ratio (less its fixed chrome), and a card of fixed size moves
 *   only by rounding. Measured heights stay as they are: wiping them
 *   suspends eviction and mounts every row of every transcript on the
 *   deck in one commit, which is the multi-second freeze a zoom step used
 *   to cost. Mounted rows re-measure through their own observer
 *   deliveries, and an offscreen row's height is refreshed when it next
 *   mounts, with the browser's scroll anchoring holding the reader's place
 *   if it moved.
 *
 * The factor, not the width, is what tells the two apart, because a zoom
 * on a layout whose cards are sized from the viewport changes the width
 * by as much as a resize does. Not `devicePixelRatio`: under a transform
 * it is the display's backing scale alone and never moves on a zoom step.
 */
export type WidthSettleKind = "unchanged" | "reflowed" | "rescaled";

export interface WidthSample {
  /** The scroller's `clientWidth`, layout px. */
  width: number;
  /** The View › Zoom factor (`pageZoomStore.getFactor()`) when the width was read. */
  zoomFactor: number;
}

export function classifyWidthSettle(
  prev: WidthSample,
  next: WidthSample,
): WidthSettleKind {
  if (Math.abs(next.width - prev.width) < 0.5) return "unchanged";
  if (Math.abs(next.zoomFactor - prev.zoomFactor) > 1e-6) return "rescaled";
  return "reflowed";
}

/** The ledger questions eviction asks; `HeightIndex` answers both. */
export interface EvictionLedger {
  has(index: number): boolean;
  coversRange(first: number, last: number): boolean;
}

/**
 * Eviction margins, in viewport heights (see `TugListView`'s
 * `evictOffscreen` prop). A row mounts once it is within one viewport of
 * the scrollport and is not released until it is two viewports away — the
 * gap is the hysteresis band, and it is also the budget for a fast flick:
 * at a viewport of scroll per frame, a row is already mounted a frame
 * before it could be seen.
 *
 * Cell counts cannot express this: transcript rows range from one line
 * to thousands, so "three cells" is a screenful in one place and a
 * sliver in another.
 */
export const EVICT_MOUNT_MARGIN_VIEWPORTS = 1;
export const EVICT_RETAIN_MARGIN_VIEWPORTS = 2;

/**
 * The most rows one measure segment mounts for a stale drain. A segment
 * is also capped at a viewport of stale height, so a drain costs about a
 * screenful of layout per commit whatever the rows' sizes.
 */
export const MEASURE_SEGMENT_MAX_ROWS = 8;

/** What a measure segment asks of the ledger beyond eviction's questions. */
export interface MeasureLedger extends EvictionLedger {
  isFresh(index: number): boolean;
}

/** A half-open run of rows `[firstIndex, lastIndex)`. */
export interface RowRun {
  firstIndex: number;
  lastIndex: number;
}

/**
 * How an eviction-mode commit renders: the window, plus at most one
 * *measure segment* — a separate run of rows outside the window, mounted
 * only so it can be measured, then released.
 *
 * - `evict` — render the window and the segment (or none), with spacers
 *   standing in for every other row. Every spacer row has a height.
 * - `suspended` — no row outside the window has a height at all (a cold
 *   ledger): render every row.
 */
export type EvictSegmentsResolution =
  | { kind: "evict"; firstIndex: number; lastIndex: number; segment: RowRun | null }
  | { kind: "suspended" };

/**
 * Resolve the window and its measure segment from the candidate window
 * and the ledger. The rules, in order:
 *
 * 1. **Cold.** No row outside the window has a height, and there is at
 *    least one → `suspended`.
 * 2. **Missing heights.** A row with no height mounts in the commit it
 *    appears, or a spacer would estimate it, so a missing run is never
 *    capped. Missing rows on one side only make the segment the run
 *    covering them all. On both sides, the window clamps outward over
 *    the nearer side's run and the farther side's run is the segment
 *    (ties count the side below as nearer).
 * 3. **Stale heights.** Otherwise the segment is the stale run nearest
 *    the window (below wins a tie), taken from its window end and capped
 *    at {@link MEASURE_SEGMENT_MAX_ROWS} rows and at the rows whose
 *    heights sum to `budgetPx`, minimum one row.
 * 4. **Fresh.** Otherwise no segment.
 *
 * A segment never touches the window: one that would is merged into it.
 */
export function resolveEvictSegments(
  candidate: RowRun,
  ledger: MeasureLedger,
  itemCount: number,
  budgetPx: number,
  heightFor: (index: number) => number,
): EvictSegmentsResolution {
  let firstIndex = Math.max(0, Math.min(candidate.firstIndex, itemCount));
  let lastIndex = Math.max(firstIndex, Math.min(candidate.lastIndex, itemCount));
  const outside = firstIndex + (itemCount - lastIndex);

  // One pass over the rows outside the window: what is missing on each
  // side, whether anything has a height, and the nearest stale row.
  let anyHeight = false;
  let missAboveFirst = -1;
  let missAboveLast = -1;
  let missBelowFirst = -1;
  let missBelowLast = -1;
  let staleAbove = -1; // the largest stale index above the window
  let staleBelow = -1; // the smallest stale index below it
  for (let i = 0; i < firstIndex; i += 1) {
    if (!ledger.has(i)) {
      if (missAboveFirst === -1) missAboveFirst = i;
      missAboveLast = i;
    } else {
      anyHeight = true;
      if (!ledger.isFresh(i)) staleAbove = i;
    }
  }
  for (let i = lastIndex; i < itemCount; i += 1) {
    if (!ledger.has(i)) {
      if (missBelowFirst === -1) missBelowFirst = i;
      missBelowLast = i;
    } else {
      anyHeight = true;
      if (staleBelow === -1 && !ledger.isFresh(i)) staleBelow = i;
    }
  }

  if (outside > 0 && !anyHeight) return { kind: "suspended" };

  let segment: RowRun | null = null;
  const missAbove: RowRun | null =
    missAboveFirst === -1 ? null : { firstIndex: missAboveFirst, lastIndex: missAboveLast + 1 };
  const missBelow: RowRun | null =
    missBelowFirst === -1 ? null : { firstIndex: missBelowFirst, lastIndex: missBelowLast + 1 };

  if (missAbove !== null && missBelow !== null) {
    const gapAbove = firstIndex - missAbove.lastIndex;
    const gapBelow = missBelow.firstIndex - lastIndex;
    if (gapBelow <= gapAbove) {
      lastIndex = missBelow.lastIndex;
      segment = missAbove;
    } else {
      firstIndex = missAbove.firstIndex;
      segment = missBelow;
    }
  } else if (missAbove !== null || missBelow !== null) {
    segment = missAbove ?? missBelow;
  } else if (staleAbove !== -1 || staleBelow !== -1) {
    const below =
      staleBelow !== -1 && (staleAbove === -1 || staleBelow - lastIndex <= firstIndex - 1 - staleAbove);
    const step = below ? 1 : -1;
    const start = below ? staleBelow : staleAbove;
    let end = start; // the last row taken, inclusive
    let rows = 1;
    let height = Math.max(0, heightFor(start));
    for (let i = start + step; i >= 0 && i < itemCount; i += step) {
      if (!ledger.has(i) || ledger.isFresh(i)) break;
      if (rows >= MEASURE_SEGMENT_MAX_ROWS) break;
      const h = Math.max(0, heightFor(i));
      if (height + h > budgetPx) break;
      height += h;
      rows += 1;
      end = i;
    }
    segment = below
      ? { firstIndex: start, lastIndex: end + 1 }
      : { firstIndex: end, lastIndex: start + 1 };
  }

  // A segment that touches the window is part of it.
  if (segment !== null) {
    if (segment.lastIndex === firstIndex) {
      firstIndex = segment.firstIndex;
      segment = null;
    } else if (segment.firstIndex === lastIndex) {
      lastIndex = segment.lastIndex;
      segment = null;
    }
  }
  return { kind: "evict", firstIndex, lastIndex, segment };
}
