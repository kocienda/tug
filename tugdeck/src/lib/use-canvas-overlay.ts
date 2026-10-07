/**
 * useCanvasOverlay — portal-target hook for canvas-level overlays.
 *
 * Returns the currently-registered `<CanvasOverlayRoot />` element so
 * a popup-class consumer can `createPortal(content, useCanvasOverlay())`.
 * When no root is registered (the brief window during initial deck
 * mount, or any host that mounts a substrate outside a `DeckCanvas` —
 * unit tests, future standalone harnesses), the hook falls back to
 * the deck root (`deckRootElement()` — `#deck-container`, or
 * `document.body` where there is none). Not `body` first: an overlay
 * outside the deck root draws at 100 % under View › Zoom. The fallback
 * path is invisible in production and
 * keeps standalone consumers working without forcing them to mount
 * the deck infrastructure just to use a substrate that opens an
 * overlay.
 *
 * ## Why lib, not chrome
 *
 * The hook is a service consumed by substrates (`tug-text-editor`'s
 * `CompletionOverlay`, eventually any popup-class primitive). Substrates
 * import from `lib/` by convention; importing from `chrome/` would
 * invert the layering. The root component itself stays in `chrome/`
 * because it is a deck-level chrome concern that gets composed into
 * `<DeckCanvas />`.
 *
 * ## Reactivity
 *
 * Subscribes via `useSyncExternalStore` against the registry, so a
 * consumer re-renders if the registered root changes. In practice
 * the root is registered once at deck mount and never replaced, but
 * during HMR or in tests that register multiple roots in sequence,
 * portals re-target on the next render.
 *
 * @module lib/use-canvas-overlay
 */

import { useCallback } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import * as canvasOverlayRegistry from "./canvas-overlay-registry";
import { deckRootElement } from "./page-zoom-store";

/**
 * Return the currently-registered canvas overlay root, or
 * the deck root as a fallback. Subscribes via
 * `useSyncExternalStore` to root-registration changes.
 */
export function useCanvasOverlay(): HTMLElement {
  // The hook returns `getRoot() ?? deckRootElement()`. We can't fall back
  // inside `getSnapshot` (would force the fallback to "win" the
  // useSyncExternalStore tear-check on every render) — instead we
  // return the nullable from getSnapshot and substitute the root at
  // return time.
  const subscribe = useCallback(
    (cb: () => void) => canvasOverlayRegistry.subscribe(cb),
    [],
  );
  const getSnapshot = useCallback(() => canvasOverlayRegistry.getRoot(), []);
  // Server-side rendering is not a concern for tugdeck (the deck only
  // runs in a browser); pass `getSnapshot` as the SSR snapshot too so
  // `useSyncExternalStore`'s 18+ signature is satisfied.
  const root = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return root ?? deckRootElement();
}
