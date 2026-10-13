/**
 * overview-window — the Overview column's window arithmetic. Pure, no DOM.
 *
 * The column is a flex column with a `gap` between its children, a top
 * margin on its first child and a bottom margin on its last. A spacer that
 * stands in for a run of posts is one more child, so the gap sits between it
 * and its neighbours exactly as it sat between the first and last post of
 * the run, and the first- and last-child margins land on whichever element
 * is first or last. That is what makes a spacer of `Σh + (n−1)·gap` leave the
 * column the height it had fully mounted.
 *
 * Heights are kept as the list view keeps them, as outer extents — a post's
 * border-box height plus the gap after it — so a run of `n` posts is
 * `Σextent − gap`, the same column height.
 */

import {
  coldWindow,
  computeWindow,
  EVICT_MOUNT_MARGIN_VIEWPORTS,
  EVICT_RETAIN_MARGIN_VIEWPORTS,
  resolveEvictSegments,
  type MeasureLedger,
  type RowRun,
} from "@/components/tugways/internal/list-view-window";

/** The height of a spacer standing in for posts of the given extents. */
export function overviewSpacerHeight(extents: readonly number[], gap: number): number {
  if (extents.length === 0) return 0;
  let sum = 0;
  for (const e of extents) sum += e;
  return sum - gap;
}

/**
 * Every post's top relative to the scrollport, from the measured extents:
 * `firstMargin + Σ_{j<i} extent_j − scrollTop`. Used where a post may not be
 * mounted, so its rect cannot be read.
 */
export function overviewCellTops(
  extents: readonly number[],
  firstMargin: number,
  scrollTop: number,
): number[] {
  const tops: number[] = [];
  let offset = firstMargin;
  for (const e of extents) {
    tops.push(offset - scrollTop);
    offset += e;
  }
  return tops;
}

/**
 * What a post's height is taken to be before the column has measured any
 * post. Once it has, a post with no height stands in at the median extent
 * ({@link overviewEstimatedExtent}).
 */
export const OVERVIEW_ESTIMATED_POST_PX = 160;

/**
 * The extent a post with no measured height stands in at, in its spacer and
 * in the window's arithmetic: the median measured extent, or the fixed
 * estimate plus the gap before any post has been measured.
 */
export function overviewEstimatedExtent(median: number | null, gap: number): number {
  return median ?? OVERVIEW_ESTIMATED_POST_PX + gap;
}

/** A run of posts named by its first and last keys. */
export interface PostKeyRange {
  firstKey: string;
  lastKey: string;
}

/** The spacer heights a commit rendered, by slot, kept for a held commit. */
export interface OverviewSpacers {
  top: number;
  middle: number;
  bottom: number;
}

/**
 * What a commit under a closed motion gate renders: the posts `[first, last)`
 * of the live column — the span the last unheld commit rendered, spacers
 * included — with that commit's spacer heights verbatim.
 */
export interface OverviewHeldColumn {
  first: number;
  last: number;
  spacers: OverviewSpacers;
}

/** The column's window and measure segment for one render. */
export interface OverviewWindow {
  window: RowRun;
  segment: RowRun | null;
  held: OverviewHeldColumn | null;
}

/** The scroller's geometry as the window reads it. */
export interface OverviewGeometry {
  scrollTop: number;
  /** The scroller's `clientHeight`; 0 for a hidden column. */
  viewportHeight: number;
  /** The column's flex `row-gap`. */
  gap: number;
  /** The first child's top margin. */
  firstMargin: number;
}

/**
 * The Overview column's window and measure segment for this render, or
 * `null` with no posts. No render mounts every post: before the column has
 * been laid out, or while it is hidden with no window to hold, the commit
 * renders a cold window of the newest posts — the column opens following —
 * and a post with no height stands in its spacer at `estimate` and drains
 * through measure segments, as a stale one does.
 *
 * The list view's window math, fed the column's own geometry: every extent
 * carries the flex gap after it and the window is computed from the first
 * post's top, `scrollTop − firstMargin` — fed bare heights, the window would
 * drift a gap per post.
 *
 * While a settle's motion gate is closed ([D9]) the commit holds what the
 * last unheld commit rendered: the same window and segment, and the same
 * spacers, verbatim, standing for the same span of posts. A post that
 * arrived under the hold — with a height or without one — is neither mounted
 * nor in a spacer until the re-window after the gate opens. A post the row
 * cap trimmed from the front under the hold leaves the data, and the verbatim
 * top spacer still stands for it. A span or window that no longer resolves
 * renders unheld.
 */
export function computeOverviewWindow({
  keys,
  geometry,
  ledger,
  extentFor,
  estimate,
  motionHeld,
  prevWindow,
  prevSegment,
  prevSpan,
  prevSpacers,
  pinnedRange,
}: {
  keys: readonly string[];
  /** Null before the column has been laid out. */
  geometry: OverviewGeometry | null;
  /** The ledger by index into `keys`. */
  ledger: MeasureLedger;
  /** The measured extent of the post at an index, if it has one. */
  extentFor: (index: number) => number | undefined;
  /** The extent a post with no measured height stands in at. */
  estimate: number;
  motionHeld: boolean;
  prevWindow: PostKeyRange | null;
  prevSegment: PostKeyRange | null;
  prevSpan: PostKeyRange | null;
  prevSpacers: OverviewSpacers | null;
  pinnedRange: { first: number; last: number } | null;
}): OverviewWindow | null {
  const n = keys.length;
  if (n === 0) return null;
  const cold = (): OverviewWindow => ({
    window: coldWindow(n, { kind: "tail" }),
    segment: null,
    held: null,
  });
  if (geometry === null) return cold();
  const runOf = (range: PostKeyRange | null): RowRun | null => {
    if (range === null) return null;
    const a = keys.indexOf(range.firstKey);
    const b = keys.indexOf(range.lastKey);
    return a === -1 || b < a ? null : { firstIndex: a, lastIndex: b + 1 };
  };
  const prev = runOf(prevWindow);
  if (prev !== null && prevSpan !== null && prevSpacers !== null && motionHeld) {
    const heldSegment = runOf(prevSegment);
    const spanLast = keys.indexOf(prevSpan.lastKey);
    // A first key the row cap trimmed under the hold: the span starts at
    // the column's front, and the top spacer still stands for the trimmed.
    const spanFirst = Math.max(0, keys.indexOf(prevSpan.firstKey));
    if (
      spanLast !== -1 &&
      (prevSegment === null || heldSegment !== null) &&
      spanFirst <= Math.min(prev.firstIndex, heldSegment?.firstIndex ?? prev.firstIndex) &&
      spanLast + 1 >= Math.max(prev.lastIndex, heldSegment?.lastIndex ?? prev.lastIndex)
    ) {
      return {
        window: prev,
        segment: heldSegment,
        held: { first: spanFirst, last: spanLast + 1, spacers: prevSpacers },
      };
    }
  }
  const { viewportHeight: viewport, firstMargin } = geometry;
  if (viewport === 0) {
    // A hidden column (a parked twin, a folded rail) has no geometry to
    // window against. Hold what was mounted rather than mounting everything
    // on every post that arrives while nobody can see it.
    return prev === null ? cold() : { window: prev, segment: null, held: null };
  }
  const candidate = computeWindow({
    itemCount: n,
    scrollTop: Math.max(0, geometry.scrollTop - firstMargin),
    viewportHeight: viewport,
    overscanCount: 1,
    estimatedHeightForIndex: (i) => extentFor(i) ?? estimate,
    pinnedRange,
    mountMarginPx: viewport * EVICT_MOUNT_MARGIN_VIEWPORTS,
    retainMarginPx: viewport * EVICT_RETAIN_MARGIN_VIEWPORTS,
    prevRange: prev === null ? null : { first: prev.firstIndex, last: prev.lastIndex },
  });
  const resolution = resolveEvictSegments(
    candidate,
    ledger,
    n,
    viewport,
    (i) => extentFor(i) ?? estimate,
  );
  return {
    window: { firstIndex: resolution.firstIndex, lastIndex: resolution.lastIndex },
    segment: resolution.segment,
    held: null,
  };
}

/**
 * The spacer heights an unheld commit renders, by slot, summed from the
 * ledger over the runs of posts each stands for, a post with no height at
 * `estimate`.
 */
export function overviewColumnSpacers(
  column: { window: RowRun; segment: RowRun | null },
  itemCount: number,
  extentFor: (index: number) => number | undefined,
  gap: number,
  estimate: number,
): OverviewSpacers {
  const px = (first: number, last: number): number => {
    if (last <= first) return 0;
    const extents: number[] = [];
    for (let i = first; i < last; i += 1) extents.push(extentFor(i) ?? estimate);
    return overviewSpacerHeight(extents, gap);
  };
  const { window: win, segment: seg } = column;
  if (seg !== null && seg.lastIndex <= win.firstIndex) {
    return {
      top: px(0, seg.firstIndex),
      middle: px(seg.lastIndex, win.firstIndex),
      bottom: px(win.lastIndex, itemCount),
    };
  }
  if (seg !== null) {
    return {
      top: px(0, win.firstIndex),
      middle: px(win.lastIndex, seg.firstIndex),
      bottom: px(seg.lastIndex, itemCount),
    };
  }
  return { top: px(0, win.firstIndex), middle: 0, bottom: px(win.lastIndex, itemCount) };
}

/**
 * The inclusive range of posts that must stay mounted because they hold the
 * selection's endpoints or the focused element, or `null` when none does.
 * Each key may be `null` (that endpoint is not inside a post) or a key no
 * longer in `keys` (ignored).
 */
export function pinnedRangeFor(
  keys: readonly string[],
  anchorKey: string | null,
  focusKey: string | null,
  focusedKey: string | null,
): { first: number; last: number } | null {
  let first = Infinity;
  let last = -Infinity;
  for (const key of [anchorKey, focusKey, focusedKey]) {
    if (key === null) continue;
    const i = keys.indexOf(key);
    if (i === -1) continue;
    if (i < first) first = i;
    if (i > last) last = i;
  }
  return first <= last ? { first, last } : null;
}

/** The key of the in-flight answer's placeholder row, which has no post key. */
export const PENDING_TOP_POST = "pending";

/**
 * Which post sits at the top of the column, for the one pinned header that
 * draws its attribution: a post key, {@link PENDING_TOP_POST}, or `null` when
 * no post is under the scrollport top.
 */
export interface TopPostStore {
  get(): string | null;
  /** Set the key; listeners hear only a change. */
  set(key: string | null): void;
  subscribe(listener: () => void): () => void;
}

export function createTopPostStore(): TopPostStore {
  let key: string | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => key,
    set(next) {
      if (next === key) return;
      key = next;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
