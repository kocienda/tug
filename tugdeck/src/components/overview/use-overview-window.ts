/**
 * useOverviewWindow — the Overview column's window, on the list view's
 * helpers.
 *
 * The column mounts the posts within a viewport of the scrollport (and keeps
 * them until they are two away), plus at most one measure segment, and
 * stands spacers in for the rest — `computeWindow` and
 * `resolveEvictSegments` over a ledger of measured extents, the same window
 * math `TugListView` runs. The spacers keep `scrollHeight` and `scrollTop`
 * exact, which is all the card's follow, prepend and paging models read, so
 * those stay with the card.
 *
 * The ledger is a `KeyedHeightLedger`, keyed by post rather than by index,
 * so a prepend and the front trim at the row cap move indices without
 * touching it. A width change re-wraps every post, so every height goes
 * stale and drains through measure segments, as the list view's do.
 *
 * Laws: [L02] the posts arrive as props from the card's store subscription;
 * [L03] the observers and the pin tracker register in `useLayoutEffect`,
 * live before the first post can settle or the first gesture land; [L06]
 * spacer heights are inline style on elements this hook renders, and every
 * scroll write stays the card's; [L24] the window and its bookkeeping are
 * derived in render from refs written in layout effects; [D9] the observer
 * is a `heldResizeObserver` and a commit under a closed motion gate renders
 * what the last unheld commit rendered.
 *
 * The ledger persists with the card's state ([A9] `bag.components`, under
 * `"overview-heights"`), by post key, so a reopened or relaunched column
 * windows against real heights from its first commit. A transient `t:` key
 * names no post a relaunch will see again, so it is never recorded.
 *
 * A drain above a reader who is not following holds them ([P08] of
 * population-ceiling-cold-paths): WebKit has no scroll anchoring, so every
 * stale or estimated height that resolves above the reader would move their
 * line. A width change, or a prepend that leaves posts to measure above,
 * takes the top post the card's pinned-header pass last sampled — its key and
 * how far into it the reader was — and re-lands it on every commit and every
 * observer delivery until the drain ends and `RESIZE_SETTLE_TAIL_MS` has
 * passed. A wheel, a press or a key on the scroller supersedes it.
 */

import React, { useCallback, useLayoutEffect, useReducer, useRef } from "react";

import { afterGesture, gestureScope, heldResizeObserver } from "@/lib/gesture-scope";
import { layoutRectOf, pageZoomStore } from "@/lib/page-zoom-store";
import { RESIZE_SETTLE_TAIL_MS } from "@/lib/resize-episode";
import {
  capturePersistedHeights,
  carryPersistedHeights,
  coercePersistedHeights,
  heightSamplesMatch,
  seedPersistedHeights,
  type HeightSample,
  type PersistedHeightLedger,
} from "@/components/tugways/internal/list-view-height-persist";
import {
  useComponentStatePreservation,
  useSavedComponentState,
} from "@/components/tugways/use-component-state-preservation";
import { KeyedHeightLedger } from "@/components/tugways/internal/list-view-keyed-ledger";
import {
  resolveRowAnchorScrollTop,
  type RowRun,
} from "@/components/tugways/internal/list-view-window";
import {
  computeOverviewWindow,
  overviewColumnSpacers,
  overviewEstimatedExtent,
  pinnedRangeFor,
  type OverviewSpacers,
  type PostKeyRange,
} from "./overview-window";

/** The column's flex `gap` and its first child's top margin. */
export interface OverviewColumnMetrics {
  gap: number;
  firstMargin: number;
}

/** The `bag.components` key the column's measured heights persist under. */
export const OVERVIEW_HEIGHTS_KEY = "overview-heights";

/** A post key a relaunch will see again; transient `t:` keys are not. */
function persistentPostKey(key: string | undefined): string | null {
  return key === undefined || key.startsWith("t:") ? null : key;
}

export interface UseOverviewWindowOptions {
  /** Whether the reader is following the live edge, as of now. Stable. */
  isFollowing: () => boolean;
  /**
   * Called from every observer delivery, after the ledger has taken the
   * delivery's heights and before the re-window it may ask for: the card's
   * follow pin and its re-engage read, on the real geometry. Stable.
   */
  onGeometry: (el: HTMLDivElement) => void;
}

export interface OverviewWindowResult<P> {
  /** The first and last post this commit renders; null with no posts. */
  column: { firstKey: string | null; lastKey: string | null };
  /** The column's children: the window's posts and the segment's, with spacers. */
  renderColumn: (row: (post: P) => React.ReactElement) => React.ReactNode[];
  ledger: KeyedHeightLedger;
  /** Null until the first commit has laid the column out. */
  metrics: React.RefObject<OverviewColumnMetrics | null>;
  /** The extent a post with no measured height stands in at, as of now. */
  estimateExtent: () => number;
  /** Re-window, or once the gate opens when a settle's motion gate is closed. */
  scrollTick: () => void;
  /**
   * The pinned-header pass's reading of the top post: its key (null with no
   * post at the top) and how far the scrollport top sits below the post's
   * top. The drain hold re-lands this post. A reading taken at a width the
   * observer has not yet seen is the re-wrapped column rather than the
   * reader's, and leaves the earlier reading in place. Stable.
   */
  noteTopPost: (key: string | null, offset: number) => void;
  /** Whether a drain hold owns the reader's position right now. Stable. */
  holding: () => boolean;
  /** Let go of the drain hold: the reader or the card moved the column. Stable. */
  releaseHold: () => void;
}

export function useOverviewWindow<P extends { key: string }>(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  posts: readonly P[],
  { isFollowing, onGeometry }: UseOverviewWindowOptions,
): OverviewWindowResult<P> {
  const ledgerRef = useRef<KeyedHeightLedger | null>(null);
  if (ledgerRef.current === null) ledgerRef.current = new KeyedHeightLedger();
  const ledger = ledgerRef.current;
  // Read once per width change. Null until the first commit has laid the
  // column out; the window stays fully mounted until then.
  const metricsRef = useRef<OverviewColumnMetrics | null>(null);
  // The previous commit's window and segment, by post key so a prepend or a
  // trim cannot shift them.
  const prevWindowRef = useRef<PostKeyRange | null>(null);
  const prevSegmentRef = useRef<PostKeyRange | null>(null);
  // The whole column the previous unheld commit rendered — its first and
  // last post, spacers included — and the spacer heights it rendered, for a
  // commit under a closed motion gate to render again verbatim.
  const prevColumnSpanRef = useRef<PostKeyRange | null>(null);
  const prevSpacersRef = useRef<OverviewSpacers | null>(null);
  // The posts holding the selection's endpoints and keyboard focus ([L23]):
  // the window clamps outward to keep them mounted.
  const pinKeysRef = useRef<{
    anchor: string | null;
    focus: string | null;
    focused: string | null;
  }>({ anchor: null, focus: null, focused: null });
  // Re-window. While a settle's motion gate is closed the re-window waits
  // for it to open, coalesced to one, exactly as the list view's does.
  const [, renderTick] = useReducer((x: number) => x + 1, 0);
  const tickHeldRef = useRef(false);
  const scrollTick = useCallback((): void => {
    if (!gestureScope.isMotionHeld()) {
      renderTick();
      return;
    }
    if (tickHeldRef.current) return;
    tickHeldRef.current = true;
    afterGesture(() => {
      tickHeldRef.current = false;
      renderTick();
    });
  }, []);

  const postKeys = posts.map((p) => p.key);

  // Persisted heights. The mount render seeds the empty ledger before the
  // first window; posts that arrive later are seeded by the layout effect
  // below. A seed taken with no width to check it against (the mount, or a
  // column that has never had a box) takes the record's samples as live and
  // is checked by the observer effect once a width exists.
  //
  // The record is read once, at mount: a capture rewrites the bag, and a
  // column captured before its posts arrive would otherwise read back its
  // own empty ledger. Each capture carries the record forward for posts it
  // has not been given.
  const savedHeights = useSavedComponentState<unknown>(OVERVIEW_HEIGHTS_KEY);
  const [persistedHeights] = React.useState(() => coercePersistedHeights(savedHeights));
  // The width the ledger's heights were measured at; 0 until the column has
  // had a box. Compared against rather than reading `clientWidth` in render.
  const ledgerWidthRef = useRef(0);
  const uncheckedSeedsRef = useRef<{ sample: HeightSample; keys: string[] }[]>([]);
  const postKeysRef = useRef(postKeys);
  postKeysRef.current = postKeys;
  const seedFromRecord = (record: PersistedHeightLedger, keys: readonly string[]): boolean => {
    const gap = metricsRef.current?.gap;
    const live: HeightSample | null =
      ledgerWidthRef.current > 0 && gap !== undefined
        ? { width: ledgerWidthRef.current, zoomFactor: pageZoomStore.getFactor(), rowGap: gap }
        : null;
    const { seeded } = seedPersistedHeights(
      {
        has: (i) => ledger.has(keys[i]!),
        set: (i, h) => ledger.set(keys[i]!, h),
        markStale: (i) => ledger.markStale(keys[i]!),
      },
      record,
      keys.length,
      (i) => persistentPostKey(keys[i]),
      live ?? record,
    );
    if (live === null && seeded.length > 0) {
      uncheckedSeedsRef.current.push({ sample: record, keys: seeded.map((i) => keys[i]!) });
    }
    return seeded.length > 0;
  };
  const mountSeededRef = useRef(false);
  if (!mountSeededRef.current) {
    mountSeededRef.current = true;
    if (persistedHeights !== undefined && ledger.size === 0) seedFromRecord(persistedHeights, postKeys);
  }
  useComponentStatePreservation<PersistedHeightLedger | undefined>({
    componentStatePreservationKey: OVERVIEW_HEIGHTS_KEY,
    captureState: () => {
      const gap = metricsRef.current?.gap;
      if (ledgerWidthRef.current === 0 || gap === undefined) return persistedHeights;
      const keys = postKeysRef.current;
      return carryPersistedHeights(
        capturePersistedHeights(
          (i) => (ledger.isFresh(keys[i]!) ? ledger.get(keys[i]!) : undefined),
          keys.length,
          (i) => persistentPostKey(keys[i]),
          { width: ledgerWidthRef.current, zoomFactor: pageZoomStore.getFactor(), rowGap: gap },
        ),
        persistedHeights,
      );
    },
  });

  const estimateExtent = useCallback(
    (): number => overviewEstimatedExtent(ledger.median(), metricsRef.current?.gap ?? 0),
    [ledger],
  );

  // ---- The drain hold ([P08]) ----
  //
  // The top post as the pinned-header pass last read it at the width the
  // observer has seen — so a width change still finds the reader's post from
  // before the re-wrap; the post a hold re-lands and how far into it the
  // reader was; and the release tail, armed once the drain has ended.
  const topSampleRef = useRef<{ key: string; offset: number } | null>(null);
  const holdRef = useRef<{ key: string; offset: number } | null>(null);
  const holdTailRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteTopPost = useCallback(
    (key: string | null, offset: number): void => {
      const el = scrollRef.current;
      if (el === null || Math.abs(el.clientWidth - ledgerWidthRef.current) >= 0.5) return;
      topSampleRef.current = key === null ? null : { key, offset };
    },
    [scrollRef],
  );
  const holding = useCallback((): boolean => holdRef.current !== null, []);
  const clearHoldTail = (): void => {
    if (holdTailRef.current === null) return;
    clearTimeout(holdTailRef.current);
    holdTailRef.current = null;
  };
  const releaseHold = useCallback((): void => {
    holdRef.current = null;
    clearHoldTail();
  }, []);
  // Hold the reader on the post they were last read at. A hold already in
  // place keeps its target, which is still where the reader is, and a tail
  // it was riding waits for the new drain to end instead.
  const installHold = useCallback((): void => {
    if (holdRef.current !== null) {
      clearHoldTail();
      return;
    }
    if (isFollowing()) return;
    holdRef.current = topSampleRef.current;
  }, [isFollowing]);
  // Re-land the target: the post's mounted rect where it has one, otherwise
  // the first margin plus the extents above it (Spec S05). With nothing left
  // to measure, the target rides `RESIZE_SETTLE_TAIL_MS` and lets go, so it
  // never fights the next thing to move the column. Under a closed motion
  // gate nothing lands — the held commit asks for the re-window that will.
  const landHold = useCallback((): void => {
    const target = holdRef.current;
    const el = scrollRef.current;
    if (target === null || el === null) return;
    const keys = postKeysRef.current;
    const index = keys.indexOf(target.key);
    if (index < 0 || isFollowing()) {
      releaseHold();
      return;
    }
    if (gestureScope.isMotionHeld() || el.clientHeight === 0) return;
    let rowTop: number | null = null;
    for (const cell of el.querySelectorAll<HTMLElement>(":scope > .overview-cell")) {
      if (cell.dataset.postKey !== target.key) continue;
      rowTop = el.scrollTop + layoutRectOf(cell).top - layoutRectOf(el).top;
      break;
    }
    if (rowTop === null) {
      const estimate = estimateExtent();
      rowTop = metricsRef.current?.firstMargin ?? 0;
      for (let j = 0; j < index; j++) rowTop += ledger.get(keys[j]!) ?? estimate;
    }
    const top = resolveRowAnchorScrollTop(rowTop, target.offset, el.scrollHeight - el.clientHeight);
    if (Math.abs(el.scrollTop - top) >= 0.5) el.scrollTop = top;
    if (ledger.pendingCount(keys) > 0) {
      clearHoldTail();
      return;
    }
    if (holdTailRef.current !== null) return;
    holdTailRef.current = setTimeout(() => {
      holdTailRef.current = null;
      holdRef.current = null;
    }, RESIZE_SETTLE_TAIL_MS);
  }, [scrollRef, isFollowing, releaseHold, estimateExtent, ledger]);
  const extentFor = (i: number): number | undefined => {
    const key = postKeys[i];
    return key === undefined ? undefined : ledger.get(key);
  };
  const scrollEl = scrollRef.current;
  const metrics = metricsRef.current;
  // A post with no height stands in at the median extent.
  const estimate = estimateExtent();
  const resolved = computeOverviewWindow({
    keys: postKeys,
    geometry:
      scrollEl === null || metrics === null
        ? null
        : {
            scrollTop: scrollEl.scrollTop,
            viewportHeight: scrollEl.clientHeight,
            gap: metrics.gap,
            firstMargin: metrics.firstMargin,
          },
    ledger: ledger.viewFor(postKeys),
    extentFor,
    estimate,
    motionHeld: gestureScope.isMotionHeld(),
    prevWindow: prevWindowRef.current,
    prevSegment: prevSegmentRef.current,
    prevSpan: prevColumnSpanRef.current,
    prevSpacers: prevSpacersRef.current,
    pinnedRange: pinnedRangeFor(
      postKeys,
      pinKeysRef.current.anchor,
      pinKeysRef.current.focus,
      pinKeysRef.current.focused,
    ),
  });
  // The posts this commit renders: all of them, or under a held commit the
  // span the last unheld commit rendered.
  const held = resolved?.held ?? null;
  const front = held?.first ?? 0;
  const end = held?.last ?? posts.length;
  const firstKey = posts.length === 0 ? null : posts[front]!.key;
  const lastKey = posts.length === 0 ? null : posts[end - 1]!.key;
  // The spacer heights this commit renders, by slot: the held commit's
  // verbatim, otherwise summed from the ledger over the runs they stand for.
  const spacers: OverviewSpacers | null =
    resolved === null
      ? null
      : (held?.spacers ??
        overviewColumnSpacers(resolved, posts.length, extentFor, metrics?.gap ?? 0, estimate));

  // The most posts any commit has mounted (window plus segment), published
  // as `data-window-peak`; and while a drain runs, how many posts are still
  // to be measured, as `data-window-stale`, removed at zero. Instrumentation
  // for the eviction lab and app-tests, never a styling hook.
  const peakRef = useRef(0);
  // Remember what this commit mounted, by key, once it has committed. A held
  // commit remembers nothing — the next commit works from the last unheld
  // one — and always re-windows once the gate opens: it stood in for a
  // commit that would have windowed against the column as it is now, and the
  // request that asked for that commit has been spent on it.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const mounted =
      resolved === null
        ? posts.length
        : resolved.window.lastIndex -
          resolved.window.firstIndex +
          (resolved.segment === null
            ? 0
            : resolved.segment.lastIndex - resolved.segment.firstIndex);
    if (mounted > peakRef.current) peakRef.current = mounted;
    const peak = String(peakRef.current);
    const pending = ledger.pendingCount(postKeys);
    if (el !== null) {
      queueMicrotask(() => {
        el.setAttribute("data-window-peak", peak);
        if (pending > 0) el.setAttribute("data-window-stale", String(pending));
        else el.removeAttribute("data-window-stale");
      });
    }
    if (resolved === null) {
      prevWindowRef.current = null;
      prevSegmentRef.current = null;
      prevColumnSpanRef.current = null;
      prevSpacersRef.current = null;
      return;
    }
    if (resolved.held !== null) {
      scrollTick();
      return;
    }
    // The first post the last unheld commit had, for the prepend read below.
    const prevFirstKey = prevColumnSpanRef.current?.firstKey ?? null;
    const keyRange = (run: RowRun | null): PostKeyRange | null =>
      run === null || run.lastIndex <= run.firstIndex
        ? null
        : { firstKey: postKeys[run.firstIndex]!, lastKey: postKeys[run.lastIndex - 1]! };
    prevWindowRef.current = keyRange(resolved.window);
    prevSegmentRef.current = keyRange(resolved.segment);
    prevColumnSpanRef.current = keyRange({ firstIndex: 0, lastIndex: postKeys.length });
    prevSpacersRef.current = spacers;
    // Older posts prepended with heights still to measure: the drain above
    // would walk the reader's line down, so hold it. The card's own prepend
    // compensation stands aside while a hold owns the position.
    if (prevFirstKey !== null && postKeys[0] !== prevFirstKey) {
      const at = postKeys.indexOf(prevFirstKey);
      if (at > 0 && ledger.pendingCount(postKeys.slice(0, at)) > 0) installHold();
    }
    landHold();
  });
  // A post that left the column (the front trim at the row cap) leaves the
  // ledger with it.
  useLayoutEffect(() => {
    ledger.prune(postKeys);
    // Posts that arrived after the mount take their persisted heights, and
    // the window re-cuts against them.
    if (persistedHeights !== undefined && seedFromRecord(persistedHeights, postKeys)) scrollTick();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `postKeys` is derived from `posts`
  }, [posts, ledger, persistedHeights]);

  // The observer: the scroller for its own box (the viewport) and every
  // cell for theirs (the content), which together are every way the
  // column's scroll height can change.
  //
  // Every connected post cell writes its extent, fresh, on every delivery —
  // an unchanged height included, or a post whose height survived a width
  // change would stay stale and stall the drain. A width change on the
  // scroller marks every height stale and re-reads the column's gap and
  // first margin, rebasing every extent if the gap moved, so the cells
  // delivered beside it land fresh. A change in the scroller's height
  // re-windows too: the window's reach is measured in viewports, so a taller
  // column, or a hidden one shown again, can need posts the last window
  // never mounted, with no scroll and no cell resize to say so.
  //
  // Held by the gate ([D9]): a delivery under a closed motion gate waits for
  // it to open, so the follow pin, the ledger write and the re-window all
  // land after the settle rather than inside it.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const readMetrics = (): void => {
      const gapPx = Number.parseFloat(getComputedStyle(el).rowGap);
      const first = el.firstElementChild;
      const margin =
        first === null ? 0 : Number.parseFloat(getComputedStyle(first).marginBlockStart);
      const next = {
        gap: Number.isFinite(gapPx) ? gapPx : 0,
        firstMargin: Number.isFinite(margin) ? margin : 0,
      };
      const prev = metricsRef.current;
      if (prev !== null) ledger.adjustAll(next.gap - prev.gap);
      metricsRef.current = next;
    };
    readMetrics();
    let lastWidth = el.clientWidth;
    let lastHeight = el.clientHeight;
    // Heights seeded with no width to check them against are checked the
    // first time there is one: here for a column that has a box, or at the
    // first box of one that mounted hidden. A sample that does not match
    // marks exactly those posts stale, and they drain.
    const checkSeededHeights = (width: number): void => {
      ledgerWidthRef.current = width;
      const groups = uncheckedSeedsRef.current;
      if (groups.length === 0) return;
      uncheckedSeedsRef.current = [];
      const live: HeightSample = {
        width,
        zoomFactor: pageZoomStore.getFactor(),
        rowGap: metricsRef.current?.gap ?? 0,
      };
      let marked = false;
      for (const { sample, keys } of groups) {
        if (heightSamplesMatch(sample, live)) continue;
        for (const key of keys) ledger.markStale(key);
        marked = true;
      }
      if (marked) scrollTick();
    };
    if (lastWidth > 0) checkSeededHeights(lastWidth);
    const observer = heldResizeObserver((entries) => {
      let windowMoved = false;
      if (Math.abs(el.clientHeight - lastHeight) >= 0.5) {
        lastHeight = el.clientHeight;
        windowMoved = true;
      }
      // A hidden column reports every cell at 0; nothing it says is a height.
      if (el.clientWidth > 0) {
        if (Math.abs(el.clientWidth - lastWidth) >= 0.5) {
          if (lastWidth > 0) {
            // Every post re-wraps and drains: hold a reader who is not
            // following on the post they were reading before it.
            installHold();
            ledger.markAllStale();
          }
          lastWidth = el.clientWidth;
          readMetrics();
          checkSeededHeights(lastWidth);
          windowMoved = true;
        }
        const gap = metricsRef.current?.gap ?? 0;
        for (const entry of entries) {
          const cell = entry.target as HTMLElement;
          const key = cell.dataset.postKey;
          if (key === undefined || !cell.isConnected) continue;
          const extent = (entry.borderBoxSize[0]?.blockSize ?? cell.offsetHeight) + gap;
          const prev = ledger.get(key);
          if (prev === undefined || !ledger.isFresh(key) || Math.abs(prev - extent) >= 0.5) {
            windowMoved = true;
          }
          ledger.set(key, extent);
        }
      }
      landHold();
      onGeometry(el);
      if (windowMoved) scrollTick();
    });
    observer.observe(el);
    // The cells are re-observed as the column changes, from the same effect
    // that owns the observer — one place that decides what is watched. A
    // cell the window released is let go of too.
    const sync = (records?: MutationRecord[]): void => {
      for (const record of records ?? []) {
        for (const node of record.removedNodes) {
          if (node instanceof HTMLElement && node.classList.contains("overview-cell")) {
            observer.unobserve(node);
          }
        }
      }
      for (const cell of el.querySelectorAll<HTMLElement>(":scope > .overview-cell")) {
        observer.observe(cell);
      }
    };
    sync();
    const mutations = new MutationObserver(sync);
    mutations.observe(el, { childList: true });
    return () => {
      mutations.disconnect();
      observer.disconnect();
    };
  }, [scrollRef, ledger, onGeometry, scrollTick, installHold, landHold]);

  // The reader's own gesture on the column supersedes the hold, and the hold
  // goes with the column. [L03] — live before the first gesture.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const supersede = (): void => releaseHold();
    const types = ["wheel", "pointerdown", "keydown"] as const;
    for (const type of types) el.addEventListener(type, supersede, { passive: true });
    return () => {
      for (const type of types) el.removeEventListener(type, supersede);
      releaseHold();
    };
  }, [scrollRef, releaseHold]);

  // Selection and focus pins ([L23] under windowing): a post holding an
  // endpoint of the user's selection, or keyboard focus, must not unmount
  // when the window moves elsewhere. Tracked by direct DOM observation into
  // a ref, and a change re-windows. [L03] — live before the first gesture.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const keyOf = (node: Node | null): string | null => {
      if (node === null) return null;
      const host = node instanceof Element ? node : node.parentElement;
      if (host === null || !el.contains(host)) return null;
      return host.closest<HTMLElement>(".overview-cell")?.dataset.postKey ?? null;
    };
    const recompute = (): void => {
      const sel = document.getSelection();
      const selecting = sel !== null && sel.rangeCount > 0 && !sel.isCollapsed;
      const next = {
        anchor: selecting ? keyOf(sel.anchorNode) : null,
        focus: selecting ? keyOf(sel.focusNode) : null,
        focused: keyOf(document.activeElement),
      };
      const prev = pinKeysRef.current;
      if (
        next.anchor === prev.anchor &&
        next.focus === prev.focus &&
        next.focused === prev.focused
      ) {
        return;
      }
      pinKeysRef.current = next;
      scrollTick();
    };
    document.addEventListener("selectionchange", recompute);
    el.addEventListener("focusin", recompute);
    el.addEventListener("focusout", recompute);
    return () => {
      document.removeEventListener("selectionchange", recompute);
      el.removeEventListener("focusin", recompute);
      el.removeEventListener("focusout", recompute);
    };
  }, [scrollRef, scrollTick]);

  /**
   * The column's children for this render: the window's posts and the
   * segment's, in post order, with a spacer for every run between them.
   * Spacers carry `overview-spacer`, never `overview-cell`, so every
   * `:scope > .overview-cell` reader sees posts only.
   */
  const renderColumn = (row: (post: P) => React.ReactElement): React.ReactNode[] => {
    if (resolved === null || spacers === null) return posts.map(row);
    const rows = (run: RowRun): React.ReactElement[] =>
      posts.slice(run.firstIndex, run.lastIndex).map(row);
    // A spacer renders when it stands for any post: its run is non-empty, or,
    // under a held commit, its verbatim height is.
    const spacer = (
      key: string,
      first: number,
      last: number,
      px: number,
    ): React.ReactElement | null =>
      last <= first && px <= 0
        ? null
        : React.createElement("div", {
            key,
            className: "overview-spacer",
            "aria-hidden": "true",
            style: { blockSize: `${px}px` },
          });
    const { window: win, segment: seg } = resolved;
    if (seg !== null && seg.lastIndex <= win.firstIndex) {
      return [
        spacer("overview-spacer:top", front, seg.firstIndex, spacers.top),
        ...rows(seg),
        spacer("overview-spacer:middle", seg.lastIndex, win.firstIndex, spacers.middle),
        ...rows(win),
        spacer("overview-spacer:bottom", win.lastIndex, end, spacers.bottom),
      ];
    }
    if (seg !== null) {
      return [
        spacer("overview-spacer:top", front, win.firstIndex, spacers.top),
        ...rows(win),
        spacer("overview-spacer:middle", win.lastIndex, seg.firstIndex, spacers.middle),
        ...rows(seg),
        spacer("overview-spacer:bottom", seg.lastIndex, end, spacers.bottom),
      ];
    }
    return [
      spacer("overview-spacer:top", front, win.firstIndex, spacers.top),
      ...rows(win),
      spacer("overview-spacer:bottom", win.lastIndex, end, spacers.bottom),
    ];
  };

  return {
    column: { firstKey, lastKey },
    renderColumn,
    ledger,
    metrics: metricsRef,
    estimateExtent,
    scrollTick,
    noteTopPost,
    holding,
    releaseHold,
  };
}
