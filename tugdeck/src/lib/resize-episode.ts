/**
 * resize-episode — hold a scroller's content still while its card changes width.
 *
 * A width change re-wraps content: the scroll element survives, `scrollTop`
 * survives with it, and the line it used to name is now somewhere else. WebKit
 * does not implement CSS scroll anchoring (`overflow-anchor`), so the anchoring
 * is ours.
 *
 * An *episode* brackets a width gesture. `beginResizeEpisode(frame)` walks the
 * pane frame for preservable scrollers and dispatches a cancelable
 * `tug-scroll-preserve-begin` on each; `handle.end()` dispatches
 * `tug-scroll-preserve-end`. A scroller that owns real anchor semantics — a
 * virtualized list keyed on cell index, a CodeMirror view keyed on line —
 * listens for begin, captures its own anchor, and calls `preventDefault()` to
 * claim itself. Everything else falls through to the generic element anchor
 * below, which is what CSS scroll anchoring would have done.
 *
 * This is the same shape as the `tug-region-scroll-set` protocol in
 * `card-host.tsx` — cancelable event first, framework fallback second — applied
 * to a second occasion. Discovery is the same selector, so a scroller that opted
 * into cross-mount region preservation is preserved across resize for free.
 *
 * Scroll position is DOM authority and is written directly, never through React
 * state ([L06]); the episode registry is module-level for the same reason. Every
 * observer and timer this module acquires is released by `end()` ([L27]).
 */

/** Detail carried by both episode events. */
export interface ResizeEpisodeEventDetail {
  /** Identifies the episode, so a late end cannot close a newer one. */
  readonly episodeId: number;
}

/** Dispatched on each scroller when a width gesture begins. Cancelable: `preventDefault()` claims the scroller. */
export const RESIZE_PRESERVE_BEGIN = "tug-scroll-preserve-begin";

/** Dispatched on each scroller when the gesture settles. Sent to claimed scrollers too. */
export const RESIZE_PRESERVE_END = "tug-scroll-preserve-end";

/**
 * Marks a scroller whose content does not re-wrap — an image, a scaled page.
 * Such a scroller holds its fractional position instead of an element anchor.
 */
export const PRESERVE_MODE_ATTR = "data-tug-preserve";

/**
 * Marks a scroller that participates in resize preservation but carries no
 * cross-mount region identity.
 *
 * The two are genuinely separate questions. `data-tug-scroll-key` names a
 * position in a saved bag, so only a scroller whose owner can supply a stable
 * key may have one; a CodeMirror view inside a Text card holds a place worth
 * keeping across a width change without any claim on the save bag at all.
 */
export const PRESERVE_SCROLLER_ATTR = "data-tug-preserve-scroll";

/** Stamped on the frame for the duration of an episode. Observable to tests; not React state ([L06]). */
export const RESIZE_EPISODE_ATTR = "data-resize-episode";

/**
 * How long past the animation's nominal duration the safety net waits before
 * closing an episode nobody closed. Background windows suspend rAF entirely, so
 * an episode whose end hangs off an animation callback can stall ([L27] — the
 * timer is released either way).
 */
export const RESIZE_EPISODE_SLACK_MS = 400;

/**
 * The safety net for an episode opened by a pointer gesture. The gesture's
 * own end — a release or a cancel — is the real close; this only covers a
 * gesture torn down mid-drag, so it is sized to be unreachable by any drag a
 * person actually performs rather than to approximate one.
 */
export const GESTURE_EPISODE_WINDOW_MS = 60_000;

/**
 * How long a scroller with a settle of its own should keep re-landing its
 * anchor after the episode ends.
 *
 * The gesture and the reflow do not end together. A virtualized list re-measures
 * rows for several frames past the last width tween — markdown re-layout,
 * per-cell observers landing — and every one of those moves the anchored content
 * again. A scroller that released at `end()` would land against half-measured
 * geometry and walk away from the rest.
 */
export const RESIZE_SETTLE_TAIL_MS = 600;

/** A scroller that has drifted this far from the anchor is mid-teleport, not mid-reflow; stop correcting. */
const MAX_ANCHOR_CORRECTION_PX = 100_000;

/** Within a pixel of the bottom counts as the bottom. */
const BOTTOM_EPSILON_PX = 1;

/** How far short of the full scroll extent a box must fall to count as content rather than wrapper. */
const ANCHOR_WRAPPER_SLACK_PX = 4;

// ---------------------------------------------------------------------------
// The arithmetic
//
// Pure functions over plain readings, so the math is exercised by unit tests
// without a DOM. Every DOM path below reads the element once, calls one of
// these, and writes the result back.

/** One scroller's geometry at a moment. */
export interface ScrollReading {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** What an unclaimed scroller remembers across a width change. */
export type GenericAnchor =
  /** Nothing to hold — leave the scroller exactly where it is. */
  | { readonly kind: "keep" }
  | { readonly kind: "top" }
  | { readonly kind: "bottom" }
  /** `delta` is the anchor element's top edge measured from the scroller's viewport top. */
  | { readonly kind: "element"; readonly delta: number }
  | { readonly kind: "fraction"; readonly fraction: number };

/** True when the scroller is resting at its bottom edge. */
export function isAtBottom(r: ScrollReading): boolean {
  return r.scrollTop + r.clientHeight >= r.scrollHeight - BOTTOM_EPSILON_PX;
}

/** The largest `scrollTop` a reading admits. */
export function maxScrollTop(r: ScrollReading): number {
  return Math.max(0, r.scrollHeight - r.clientHeight);
}

/**
 * Choose the anchor kind for a scroller at rest.
 *
 * A scroller at the top has nothing to hold — the top is already the anchor,
 * and computing an element anchor there only adds a chance to be wrong. One at
 * the bottom holds the bottom, which survives a content-height change exactly.
 * `fraction` is for content that scales rather than re-wraps; `elementDelta`
 * carries the measured anchor when the caller found one.
 *
 * Mid-content with no element to anchor on is `keep`, not `top`. The
 * difference is the whole reason the case is named: `top` is a position, and
 * writing it would answer "we could not find your place" by jumping the reader
 * to the beginning of the document — strictly worse than the drift the module
 * exists to prevent.
 */
export function chooseAnchor(
  r: ScrollReading,
  opts: { readonly elementDelta?: number; readonly fractionMode?: boolean },
): GenericAnchor {
  if (opts.fractionMode === true) {
    const max = maxScrollTop(r);
    return { kind: "fraction", fraction: max <= 0 ? 0 : r.scrollTop / max };
  }
  if (r.scrollTop <= 0) return { kind: "top" };
  if (isAtBottom(r)) return { kind: "bottom" };
  if (opts.elementDelta === undefined) return { kind: "keep" };
  return { kind: "element", delta: opts.elementDelta };
}

/**
 * Resolve the `scrollTop` that restores `anchor` against a fresh reading.
 *
 * `currentDelta` is the anchor element's top edge measured from the viewport
 * top *now*; the correction is the difference from where it sat at capture.
 * Returns `null` when there is nothing to write — a top anchor already at the
 * top, an element anchor whose node has gone (`currentDelta` undefined), or a
 * correction so large it can only be a teleport.
 */
export function resolveAnchoredScrollTop(
  anchor: GenericAnchor,
  r: ScrollReading,
  currentDelta?: number,
): number | null {
  const max = maxScrollTop(r);
  const clamp = (v: number): number => Math.max(0, Math.min(max, v));
  switch (anchor.kind) {
    case "keep":
      return null;
    case "top":
      return r.scrollTop === 0 ? null : 0;
    case "bottom":
      return isAtBottom(r) ? null : max;
    case "fraction":
      return clamp(anchor.fraction * max);
    case "element": {
      if (currentDelta === undefined) return null;
      const correction = currentDelta - anchor.delta;
      if (correction === 0) return null;
      if (Math.abs(correction) > MAX_ANCHOR_CORRECTION_PX) return null;
      return clamp(r.scrollTop + correction);
    }
  }
}

/**
 * Capture the reader's place in `el` as an element anchor, and return a
 * resolver for the `scrollTop` that restores it. `null` when there is nothing
 * under the top edge to hold.
 *
 * This is the same anchor an unclaimed scroller gets, offered to scrollers that
 * *do* claim the episode. A virtualized list resolves position by row, and that
 * is the right unit for a reload — but a transcript's row is a whole turn, often
 * several screens tall, and a pixel offset *into* a row is precisely what a
 * re-wrap invalidates. The element under the top edge is a finer unit than the
 * row and reads the same after the reflow.
 *
 * The resolver returns `null` once the anchored node leaves the document, which
 * is the caller's cue to fall back to whatever coarser anchor it holds.
 */
export function trackElementAnchor(el: HTMLElement): (() => number | null) | null {
  const anchorEl = findAnchorElement(el);
  if (anchorEl === null) return null;
  const delta = measureDelta(el, anchorEl);
  if (delta === undefined) return null;
  const anchor: GenericAnchor = { kind: "element", delta };
  return () => {
    const currentDelta = measureDelta(el, anchorEl);
    if (currentDelta === undefined) return null;
    // A resolved `null` here means "already there", not "not ready" — the
    // caller's fallback must not fire on it.
    return resolveAnchoredScrollTop(anchor, read(el), currentDelta) ?? el.scrollTop;
  };
}

// ---------------------------------------------------------------------------
// The episode

/** A live episode. `end()` is idempotent. */
export interface ResizeEpisodeHandle {
  readonly id: number;
  end(): void;
  /**
   * Put the episode's stamp on the frame.
   *
   * Called for you unless the caller asked to defer it, and idempotent either
   * way — a deferred caller that forgets loses only the stamp, never the
   * episode.
   */
  stamp(): void;
}

/** How `beginResizeEpisode` should place the stamp. */
export interface ResizeEpisodeOptions {
  /**
   * Leave `data-resize-episode` off the frame until the handle's `stamp()` is
   * called.
   *
   * `setAttribute` is a style-dirtying write, and the whole of `begin` around
   * it is geometry reads. A caller that begins ONE episode never notices;
   * a caller that begins one per pane frame in a loop pays a forced style
   * resolution per frame after the first, because each frame's stamp lands
   * between the frame before it reading and the frame after it reading. That
   * is what the geometry-chain probe attributes to `beginResizeEpisode` on a
   * session-card fold, nine chains deep.
   *
   * So a looping caller defers, reads every frame with nothing written in
   * between, and stamps them together in whatever pass it already reserves
   * for writes.
   */
  readonly deferStamp?: boolean;
}

/** Per-scroller state for a scroller the module is anchoring itself. */
interface GenericWatch {
  readonly el: HTMLElement;
  readonly anchor: GenericAnchor;
  /** The element whose top edge the anchor names. Absent for top/bottom/fraction anchors. */
  readonly anchorEl: HTMLElement | null;
  readonly observer: ResizeObserver;
}

interface Episode {
  readonly id: number;
  readonly frame: HTMLElement;
  readonly scrollers: readonly HTMLElement[];
  readonly watches: readonly GenericWatch[];
  timer: ReturnType<typeof setTimeout> | null;
  ended: boolean;
}

let nextEpisodeId = 1;

/** Open episodes, keyed by the frame they bracket. One per frame ([P03]). */
const openEpisodes = new WeakMap<HTMLElement, Episode>();

/**
 * Every scroller inside `frame` that participates in preservation.
 *
 * `[data-tug-scroll-key]` is the existing region-preservation seam and reaches
 * portaled card content, because the portal target lives inside the frame. The
 * pane's own content box is included when it is doing the scrolling — cards that
 * never took over their scrolling get their position held anyway.
 */
function discoverScrollers(frame: HTMLElement): HTMLElement[] {
  const found = new Set<HTMLElement>();
  const host = frame.querySelector<HTMLElement>(".tug-pane-content");
  if (host !== null && host.scrollHeight > host.clientHeight) found.add(host);
  const selector = `[data-tug-scroll-key],[${PRESERVE_SCROLLER_ATTR}]`;
  for (const el of frame.querySelectorAll<HTMLElement>(selector)) found.add(el);
  return [...found];
}

/** How deep into the content the anchor search will descend. */
const MAX_ANCHOR_DEPTH = 12;

/**
 * `node`'s first child box that reaches down to `line`, skipping the ones that
 * cannot carry a position.
 *
 * A sticky or fixed box is glued to the viewport edge, so its offset from that
 * edge is a constant — anchoring on one resolves every frame to "you are already
 * there" while the document moves underneath. A zero-height box has no top edge
 * worth the name.
 *
 * `aria-hidden` boxes are skipped for a related reason and a better one: they
 * are not content the reader is looking at. The case that matters is a
 * virtualized list's leading spacer, whose whole job is to be exactly as tall
 * as the rows it stands in for — its top edge is `-scrollTop` by construction
 * and its height changes as those rows are re-measured, which is the worst of
 * both.
 */
function firstBoxReaching(node: HTMLElement, line: number): HTMLElement | null {
  const view = node.ownerDocument.defaultView;
  for (const child of node.children) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.getAttribute("aria-hidden") === "true") continue;
    const position = view?.getComputedStyle(child).position;
    if (position === "sticky" || position === "fixed") continue;
    const rect = child.getBoundingClientRect();
    if (rect.height <= 0) continue;
    if (rect.bottom > line + 1) return child;
  }
  return null;
}

/**
 * The element whose top edge the anchor will name: the deepest box that meets
 * the scroller's top edge and is still *part* of the content.
 *
 * The search descends rather than hit-testing. `elementFromPoint` answers for
 * the whole document, so it returns any overlay standing over the card — during
 * a bullseye exit that is the recede scrim, which is not inside the scroller at
 * all, and the anchor silently comes back empty at the one moment it is needed.
 * Walking the scroller's own subtree cannot be fooled that way.
 *
 * It descends because depth is the point. A transcript row is a whole turn,
 * routinely several screens tall; its top edge is nowhere near the reader and
 * moves with every line that re-wraps inside it. The paragraph at the top edge
 * is the reader's place.
 *
 * The size ceiling stops the search from settling on a wrapper as tall as the
 * whole scroll extent, whose top edge is exactly `-scrollTop` by construction,
 * whatever the content inside it did. Most cards wrap their body in one such
 * div, so without it the fallback would degenerate into no fallback at all.
 */
function findAnchorElement(el: HTMLElement): HTMLElement | null {
  const line = el.getBoundingClientRect().top;
  const contentExtent = el.scrollHeight - ANCHOR_WRAPPER_SLACK_PX;
  let best: HTMLElement | null = null;
  let node: HTMLElement = el;
  for (let depth = 0; depth < MAX_ANCHOR_DEPTH; depth++) {
    const child = firstBoxReaching(node, line);
    if (child === null) break;
    const rect = child.getBoundingClientRect();
    if (rect.height < contentExtent) best = child;
    // A box that begins at or below the line is already the finest answer;
    // one that straddles it has the reader's place somewhere inside.
    if (rect.top >= line - 1) break;
    node = child;
  }
  return best;
}

/** Read `el`'s geometry as a plain reading. */
function read(el: HTMLElement): ScrollReading {
  return {
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  };
}

/** The anchor element's top edge, measured from the scroller's viewport top. */
function measureDelta(el: HTMLElement, anchorEl: HTMLElement | null): number | undefined {
  if (anchorEl === null || !el.contains(anchorEl)) return undefined;
  return anchorEl.getBoundingClientRect().top - el.getBoundingClientRect().top;
}

/** Re-apply one watch's anchor. Called per ResizeObserver delivery, and once more at end ([P02]). */
function reapply(watch: GenericWatch): void {
  const next = resolveAnchoredScrollTop(
    watch.anchor,
    read(watch.el),
    measureDelta(watch.el, watch.anchorEl),
  );
  if (next === null) return;
  watch.el.scrollTop = next;
}

/** Capture what an unclaimed scroller needs to hold its place, and watch it for the episode. */
function watchGeneric(el: HTMLElement): GenericWatch {
  const reading = read(el);
  const fractionMode = el.getAttribute(PRESERVE_MODE_ATTR) === "fraction";
  const anchorEl = fractionMode || reading.scrollTop <= 0 || isAtBottom(reading)
    ? null
    : findAnchorElement(el);
  const anchor = chooseAnchor(reading, {
    fractionMode,
    elementDelta: measureDelta(el, anchorEl),
  });
  const watch: GenericWatch = {
    el,
    anchor,
    anchorEl: anchor.kind === "element" ? anchorEl : null,
    observer: new ResizeObserver(() => {
      reapply(watch);
    }),
  };
  // Observing the scroller catches the frame's own width tween; observing the
  // content catches the re-wrap it causes, which is the delivery that actually
  // needs correcting.
  watch.observer.observe(el);
  const content = el.firstElementChild;
  if (content instanceof HTMLElement) watch.observer.observe(content);
  return watch;
}

/**
 * Bracket a width gesture on `frame`.
 *
 * Every preservable scroller inside the frame is offered the episode; the ones
 * that decline are anchored here. `durationMs` is the gesture's expected length
 * — the safety net fires that far past it, so an episode nobody closes still
 * closes ([P05]).
 *
 * Re-beginning on a frame that already has an open episode ends the old one
 * first, which re-captures every anchor at the position the user is looking at
 * now. That is the right reading for a gesture chain: the second gesture starts
 * from where the first one left them.
 */
export function beginResizeEpisode(
  frame: HTMLElement,
  durationMs: number,
  options?: ResizeEpisodeOptions,
): ResizeEpisodeHandle {
  const previous = openEpisodes.get(frame);
  if (previous !== undefined) closeEpisode(previous);

  const id = nextEpisodeId++;
  const scrollers = discoverScrollers(frame);
  const watches: GenericWatch[] = [];
  for (const el of scrollers) {
    const claimed = !el.dispatchEvent(
      new CustomEvent<ResizeEpisodeEventDetail>(RESIZE_PRESERVE_BEGIN, {
        detail: { episodeId: id },
        cancelable: true,
        bubbles: false,
      }),
    );
    if (!claimed) watches.push(watchGeneric(el));
  }

  const episode: Episode = {
    id,
    frame,
    scrollers,
    watches,
    timer: null,
    ended: false,
  };
  episode.timer = setTimeout(() => {
    episode.timer = null;
    closeEpisode(episode);
  }, durationMs + RESIZE_EPISODE_SLACK_MS);

  openEpisodes.set(frame, episode);

  // The stamp is the one WRITE in a function that is otherwise all reads, so
  // it is the last thing done and a looping caller can hold it back until its
  // own write pass (`deferStamp`). A frame the episode no longer owns is not
  // stamped: a late `stamp()` on a closed episode would leave an attribute
  // nothing takes off again.
  const stamp = (): void => {
    if (episode.ended) return;
    if (openEpisodes.get(frame) !== episode) return;
    frame.setAttribute(RESIZE_EPISODE_ATTR, String(id));
  };
  if (options?.deferStamp !== true) stamp();

  return {
    id,
    stamp,
    end: () => {
      closeEpisode(episode);
    },
  };
}

/** Land every anchor one final time, release every resource, and clear the stamp. */
function closeEpisode(episode: Episode): void {
  if (episode.ended) return;
  episode.ended = true;
  if (episode.timer !== null) {
    clearTimeout(episode.timer);
    episode.timer = null;
  }
  for (const watch of episode.watches) {
    reapply(watch);
    watch.observer.disconnect();
  }
  for (const el of episode.scrollers) {
    el.dispatchEvent(
      new CustomEvent<ResizeEpisodeEventDetail>(RESIZE_PRESERVE_END, {
        detail: { episodeId: episode.id },
        cancelable: false,
        bubbles: false,
      }),
    );
  }
  if (openEpisodes.get(episode.frame) === episode) {
    openEpisodes.delete(episode.frame);
    episode.frame.removeAttribute(RESIZE_EPISODE_ATTR);
  }
}
