/**
 * Off-screen content costs zero — the rule, and the one observer that keeps it.
 *
 * A long-running loop on an element scrolled out of its scroller's view is not
 * compositor-resident on this WebKit: it dirties style on the main thread
 * every frame, at about 0.05 ms a figure, for as long as it runs. Two hundred
 * of them under the Overview card's fold read as a deck ticking sixty times a
 * second at rest with nothing on screen moving. The doctrine's answer is a
 * rule for every loop rather than a patch for one card: **no animation runs on
 * a figure whose box is outside the visible area of its scroller or the
 * viewport.**
 *
 * ## The mechanism
 *
 * One `IntersectionObserver`, rooted on the viewport, watching every figure
 * that registered. The viewport root is the whole point: an intersection is
 * computed through every clipping ancestor on the way up, so a figure inside a
 * `tug-list-view` scroller inside a pane inside a workspace layer needs no
 * knowledge of any of them, and a figure that mounts in a plain `overflow`
 * column gets the same answer as one in the list primitive.
 *
 * A figure the observer finds out of view is marked `data-tug-offscreen`, and
 * the stylesheet resolves `--tug-loop-iterations: 0` under that mark — the
 * same knob the motion circuit breaker turns, honoured by every loop the audit
 * lets ship (`scripts/audit-motion.ts` rule 3). Zero iterations means the
 * engine holds no animation for the figure at all: nothing is blended, nothing
 * is relevant to the timeline, and `getAnimations()` on the figure is empty.
 * That is stronger than `animation-play-state: paused`, which keeps every
 * paused loop resident in the timeline's list, and it is the demotion the
 * breaker already relies on, so a figure paused here and a figure demoted
 * there are one state rather than two.
 *
 * Scrolling the figure back in removes the mark; the loops are created afresh
 * in the next style update. A figure with more than one loop resumes through
 * its own weld — the pulsing dot re-welds its three loops to one start time
 * the moment it hears it is visible — so a figure never returns out of phase
 * with itself.
 *
 * ## Why not `content-visibility: auto`
 *
 * The declarative answer was benched against this one, on the same three
 * hundred dots in the same scroller (`at0629`, and the arc's record): the list
 * primitive's own `offscreenSkip` (`tug-list-view.tsx`), which is
 * `content-visibility: auto` on rows at their exact measured height. With 287
 * of 300 rows skipped every one of the 900 loops was still resident and
 * running, and the main thread was still held about 15 ms of every second
 * against 33 untreated — the skipped subtree's animations are still resolved
 * on this WebKit, the same finding as the workspace layer's
 * `content-visibility: hidden` keeping its loops running
 * (`space-layer-loops.ts`). The observer read zero: 36 loops resident for the
 * 12 figures in view, and 0 to 3 ms of a second on the main thread.
 *
 * ## What it costs
 *
 * An observer delivery per figure per crossing of the viewport edge, batched
 * by the engine after layout, and nothing per frame. Nothing here polls, and
 * nothing measures: the engine reports the crossing.
 *
 * Nothing here is React state ([L06]). The mark is an attribute the observer
 * writes, the pause is a stylesheet rule that reads it, and the hook below is
 * a registration in a layout effect ([L03]).
 *
 * @module lib/motion-guard/offscreen
 */

import * as React from "react";

/** The mark a figure wears while its box is out of view. */
export const OFFSCREEN_ATTRIBUTE = "data-tug-offscreen";

type VisibilityListener = (visible: boolean) => void;

const listeners = new WeakMap<Element, VisibilityListener | undefined>();
const observed = new Set<Element>();
let paused = 0;
let observer: IntersectionObserver | null = null;
let enabled = true;

function mark(target: Element, visible: boolean): void {
  const wasOffscreen = target.hasAttribute(OFFSCREEN_ATTRIBUTE);
  if (visible === !wasOffscreen) return;
  if (visible) {
    target.removeAttribute(OFFSCREEN_ATTRIBUTE);
    paused -= 1;
  } else {
    target.setAttribute(OFFSCREEN_ATTRIBUTE, "");
    paused += 1;
  }
  // The listener runs AFTER the mark moves, so a figure that re-welds on
  // return finds its loops already declared by the stylesheet: the
  // `getAnimations()` inside the weld resolves style, which creates them.
  listeners.get(target)?.(visible);
}

function onIntersection(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) {
    if (!observed.has(entry.target)) continue;
    mark(entry.target, entry.isIntersecting);
  }
}

function ensureObserver(): IntersectionObserver | null {
  if (observer !== null) return observer;
  if (typeof IntersectionObserver === "undefined") return null;
  observer = new IntersectionObserver(onIntersection, { threshold: 0 });
  return observer;
}

/**
 * Watch `target` and still its loops while it is out of view.
 *
 * Returns the release. Releasing clears the mark, so a figure that unmounts
 * or stops being a loop owner leaves nothing behind. `onChange` is told each
 * crossing, after the mark has moved.
 */
export function observeOffscreen(
  target: Element,
  onChange?: VisibilityListener,
): () => void {
  listeners.set(target, onChange);
  observed.add(target);
  if (enabled) ensureObserver()?.observe(target);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    observed.delete(target);
    observer?.unobserve(target);
    mark(target, true);
    listeners.delete(target);
  };
}

/**
 * Turn the rule off, or back on. Diagnostics only: the bench reads the same
 * population with and without it, which is the reading that says the rule is
 * what made the difference. Off, every mark is cleared and nothing is watched;
 * on, every registered figure is watched again and marked on the observer's
 * first delivery.
 */
export function setOffscreenPause(on: boolean): void {
  if (on === enabled) return;
  enabled = on;
  if (on) {
    const io = ensureObserver();
    if (io === null) return;
    for (const target of observed) io.observe(target);
    return;
  }
  observer?.disconnect();
  for (const target of observed) mark(target, true);
}

/** Whether the rule is in force. */
export function offscreenPauseEnabled(): boolean {
  return enabled;
}

/** How many watched figures are out of view right now. Diagnostics and tests. */
export function offscreenPaused(): number {
  return paused;
}

/** How many figures are watched. Diagnostics and tests. */
export function offscreenWatched(): number {
  return observed.size;
}

/**
 * Still the loops under `ref` while the element is out of view, for as long
 * as `active` is true. The hook form of {@link observeOffscreen}, for a loop
 * owner that is a component — the same shape as `useMotionHold`, and taken
 * in the same commit ([L03]).
 */
export function useOffscreenPause(
  ref: React.RefObject<Element | null>,
  active: boolean = true,
): void {
  React.useLayoutEffect(() => {
    const target = ref.current;
    if (!active || target === null) return;
    return observeOffscreen(target);
  }, [ref, active]);
}
