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

import { installHostChannel, onHostMessage } from "@/host/channel";
import { scrollPhaseToPage } from "@/host/declarations/services";

/** One phase edge from the host. */
export type ScrollPhaseEdge = "touched" | "lifted" | "momentum";

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

let installed = false;

/**
 * Take `__tugBridge.onScrollPhase` in this page. Called once from deck boot;
 * safe to call again. An edge this build does not know is refused by the
 * declaration and never arrives.
 */
export function installScrollPhaseBridge(): void {
  installHostChannel();
  if (installed) return;
  installed = true;
  onHostMessage(scrollPhaseToPage, (edge) => {
    for (const listener of [...listeners]) listener(edge);
  });
}
