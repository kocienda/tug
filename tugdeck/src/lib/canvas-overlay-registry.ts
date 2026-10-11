/**
 * Canvas overlay registry — maps the (single) canvas-level overlay root
 * to the `HTMLElement` mounted by `<CanvasOverlayRoot />`. The portal
 * target hook (`use-canvas-overlay.ts`) reads from this registry; the
 * root component registers and unregisters itself in a `useLayoutEffect`.
 *
 * The registry is module-level (not React state). It is appearance-zone
 * infrastructure that lives outside the React render tree (L22): React
 * components opt in via `useSyncExternalStore` against `subscribe`.
 *
 * ## Single-root invariant
 *
 * Today there is exactly one `<DeckCanvas />` per tab and therefore
 * exactly one overlay root. The registry stores a single element,
 * not a keyed map. A second `register()` call replaces the previous
 * registration and emits a dev-mode warning — useful for catching
 * "two `<CanvasOverlayRoot />` components mounted accidentally" but
 * also benign during HMR (Vite may briefly mount a replacement before
 * unmounting the old one). Production code never observes the warning.
 *
 * ## Multi-deck promotion path
 *
 * When a future multi-deck UI lands, this module promotes from a single
 * root to a `Map<deckId, HTMLElement>` keyed by deck id. Consumers who
 * subscribe through `useCanvasOverlay` already pass through a hook that
 * can grow a `deckId` parameter — the migration is local. Today's
 * single-root API is the right shape until that day; speculative
 * generalization is its own bug.
 *
 * ## Notify contract
 *
 * `register` and `unregister` both call `notify()` synchronously in
 * the same tick as the mutation. Every listener runs before control
 * returns to the caller. `useSyncExternalStore` consumers therefore
 * observe the new root inside the same commit cycle that registered
 * it — no microtask deferral, no batched callback. This mirrors
 * `pane-content-registry`'s contract for the same reason: a delayed
 * notify would open a window where a portal could attach to a stale
 * (or null) root.
 *
 * @module lib/canvas-overlay-registry
 */

import { createSubscribable } from "./subscribable";

type Listener = () => void;

let currentRoot: HTMLElement | null = null;
const listeners = createSubscribable();

function notify(): void {
  listeners.notify();
}

/**
 * Register the canvas overlay root. Idempotent: registering the same
 * element a second time is a no-op (no notify). Registering a
 * different element replaces the previous registration, notifies all
 * subscribers, and (in dev mode) warns about the second registration
 * — production should only ever register one root.
 */
export function register(el: HTMLElement): void {
  if (currentRoot === el) return;
  if (currentRoot !== null && import.meta.env?.DEV) {
    console.warn(
      "[canvas-overlay-registry] Multiple roots registered. The most recent " +
        "registration wins. If this fires outside of HMR, a second " +
        "<CanvasOverlayRoot /> is mounted somewhere it should not be.",
    );
  }
  currentRoot = el;
  notify();
}

/**
 * Unregister the canvas overlay root. Idempotent: calling with an
 * element other than the currently-registered one is a no-op (this
 * matters during HMR or rapid mount/unmount — a stale cleanup must
 * not clear a fresh registration). Calling with the matching element
 * (or never having registered) clears state and notifies subscribers.
 */
export function unregister(el: HTMLElement): void {
  if (currentRoot !== el) return;
  currentRoot = null;
  notify();
}

/** Read the currently-registered overlay root, or `null` if none. */
export function getRoot(): HTMLElement | null {
  return currentRoot;
}

/**
 * Subscribe to root-registration changes. Returns an unsubscribe
 * function. The callback fires on every `register` or `unregister`
 * call (including idempotent no-ops? no — only on actual changes,
 * mirroring `pane-content-registry`). It does NOT fire on initial
 * subscription.
 */
export function subscribe(callback: Listener): () => void {
  return listeners.subscribe(callback);
}

/**
 * Test-only: clear the registered root and all listeners. Tests that
 * mount and unmount overlay roots across describe blocks call this in
 * `beforeEach` to prevent state from leaking between tests.
 */
export function _resetForTests(): void {
  currentRoot = null;
  listeners.clearListeners();
}
