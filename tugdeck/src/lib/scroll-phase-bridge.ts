/**
 * scroll-phase-bridge.ts — receives the macOS host's trackpad phase edges.
 *
 * A DOM `WheelEvent` carries deltas and nothing about whether the fingers are
 * on the glass, so a wheel gesture in the page can only end on a quiet. AppKit
 * knows: `MainWindow.bridgeScrollPhase` watches every `.scrollWheel` event and
 * calls `window.__tugBridge.onScrollPhase(edge)` on the three edges the deck
 * acts on (keep the callback name and the edge strings in lockstep):
 *
 * - `touched` — fingers down (`phase` `.began` or `.mayBegin`).
 * - `lifted` — fingers up (`phase` `.ended` or `.cancelled`).
 * - `momentum` — the first delta macOS sends on the hand's behalf after a
 *   lift (`momentumPhase` `.began`).
 *
 * Only the edges cross; the deltas themselves still arrive through the DOM. A
 * mouse wheel has no phases and sends nothing, and outside the host nothing
 * calls the receiver at all — a subscriber must treat "no edge seen" as the
 * ordinary case and keep its own fallback end.
 *
 * This module is only the wire: it validates the edge and fans it out to
 * subscribers. What a gesture does with an edge is the subscriber's.
 *
 * @module lib/scroll-phase-bridge
 */

/** One phase edge from the host. */
export type ScrollPhaseEdge = "touched" | "lifted" | "momentum";

/** The host→web bridge object; only the scroll-phase callback concerns us here. */
interface TugBridge {
  onScrollPhase?: (edge: unknown) => void;
}

interface WebkitHandles {
  __tugBridge?: TugBridge;
}

const EDGES: readonly string[] = ["touched", "lifted", "momentum"];

const listeners = new Set<(edge: ScrollPhaseEdge) => void>();

/**
 * Subscribe to phase edges. Returns the unsubscribe. Listeners run
 * synchronously, in subscription order, inside the host's call.
 */
export function subscribeScrollPhase(listener: (edge: ScrollPhaseEdge) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Install `__tugBridge.onScrollPhase`. Called once from deck boot; safe to
 * call again (the receiver is installed only when absent). An edge this build
 * does not know is dropped.
 */
export function installScrollPhaseBridge(): void {
  const w = globalThis as unknown as WebkitHandles;
  const bridge = (w.__tugBridge ??= {});
  if (bridge.onScrollPhase !== undefined) return;

  bridge.onScrollPhase = (edge) => {
    if (typeof edge !== "string" || !EDGES.includes(edge)) return;
    for (const listener of [...listeners]) listener(edge as ScrollPhaseEdge);
  };
}
