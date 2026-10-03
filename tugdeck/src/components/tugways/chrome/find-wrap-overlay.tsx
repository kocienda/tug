/**
 * find-wrap-overlay — the transient "search wrapped around" indicator for the
 * Session card's Find route.
 *
 * When Find navigation crosses an end (Next from the last match back to the
 * first, or Previous from the first to the last), `FindSession` raises its
 * `wrapped` flag. This component watches that flag ([L02] via
 * `useSyncExternalStore`) and, on its rising edge, paints a brief BBEdit-style
 * circular-arrow panel centred over the canvas — imperative appearance ([L06],
 * Web Animations), never React state, so it composes with the highlighter's
 * flash without a render.
 *
 * The panel mounts into `CanvasOverlayRoot` (via {@link useCanvasOverlay}) so it
 * floats above every pane's clip, and auto-removes when its animation finishes.
 *
 * @module components/tugways/chrome/find-wrap-overlay
 */

import { useEffect, useRef, type RefObject } from "react";

import { useCanvasOverlay } from "@/lib/use-canvas-overlay";
import { animate } from "@/components/tugways/tug-animator";
import type { FindSession } from "@/lib/find-session";
import "./find-wrap-overlay.css";

const SVG_OPEN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
  'aria-hidden="true">';

/** lucide `rotate-cw` — shown when Next wraps bottom → top. */
const WRAP_CW_SVG =
  SVG_OPEN +
  '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/>' +
  '<path d="M21 3v5h-5"/></svg>';

/** lucide `rotate-ccw` — shown when Previous wraps top → bottom. */
const WRAP_CCW_SVG =
  SVG_OPEN +
  '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>' +
  '<path d="M3 3v5h5"/></svg>';

const SHOW_MS = 720;

function showWrapGraphic(
  root: HTMLElement,
  cardEl: HTMLElement | null,
  direction: 1 | -1 | 0,
): void {
  // Only ever one panel — a rapid re-wrap replaces the in-flight one.
  root.querySelector(".tugx-find-wrap")?.remove();
  const panel = document.createElement("div");
  panel.className = "tugx-find-wrap";
  // Previous wrapping top → bottom turns counter-clockwise; Next wrapping
  // bottom → top turns clockwise.
  panel.innerHTML = direction === -1 ? WRAP_CCW_SVG : WRAP_CW_SVG;
  // Centre on the CARD, not the deck: place the panel at the card's viewport
  // centre (it lives in the fixed CanvasOverlayRoot, so viewport coords). The
  // CSS `translate(-50%, -50%)` recentres it on that point. Falls back to the
  // deck centre (the CSS 50%/50%) only if the card element is unavailable.
  if (cardEl !== null) {
    const rect = cardEl.getBoundingClientRect();
    panel.style.left = `${rect.left + rect.width / 2}px`;
    panel.style.top = `${rect.top + rect.height / 2}px`;
  }
  root.appendChild(panel);

  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) {
    // No scale/fade choreography — a plain brief presence honours [L14].
    window.setTimeout(() => panel.remove(), SHOW_MS);
    return;
  }
  const animation = animate(
    panel,
    [
      { opacity: 0, transform: "translate(-50%, -50%) scale(0.8)" },
      { opacity: 1, transform: "translate(-50%, -50%) scale(1)", offset: 0.18 },
      { opacity: 1, transform: "translate(-50%, -50%) scale(1)", offset: 0.66 },
      { opacity: 0, transform: "translate(-50%, -50%) scale(1)" },
    ],
    { duration: SHOW_MS, easing: "ease-out" },
  );
  const remove = (): void => panel.remove();
  void animation.finished.then(remove, remove);
}

export function FindWrapOverlay({
  findSession,
  cardRef,
}: {
  findSession: FindSession;
  /** The card root — the wrap panel centres on this, not the deck. */
  cardRef: RefObject<HTMLElement | null>;
}): null {
  const overlayRoot = useCanvasOverlay();
  // Read the live overlay root at fire time (it can change identity as the
  // registry updates) without re-subscribing.
  const overlayRootRef = useRef(overlayRoot);
  overlayRootRef.current = overlayRoot;

  // Subscribe DIRECTLY to the session and detect the wrap event in the callback
  // — the graphic is pure imperative appearance, so it does not go through a
  // React render ([L06]). Firing on the monotonic `wrapSeq` increment means
  // every wrap shows, including consecutive ones (bouncing first ↔ last of two
  // matches). `prevWrapSeq` lives in the subscription closure, so it survives
  // every navigation and never resets mid-session.
  useEffect(() => {
    let prevWrapSeq = findSession.getSnapshot().wrapSeq;
    return findSession.subscribe(() => {
      const snap = findSession.getSnapshot();
      if (snap.wrapSeq > prevWrapSeq) {
        showWrapGraphic(overlayRootRef.current, cardRef.current, snap.wrapDirection);
      }
      prevWrapSeq = snap.wrapSeq;
    });
  }, [findSession, cardRef]);
  return null;
}
