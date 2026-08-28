/**
 * Tooltip dismissal broadcaster — the input gestures that end a hover.
 *
 * A tooltip is an answer to "what is this thing the pointer is resting on".
 * The moment the user does something — presses a button, opens a context
 * menu, scrolls the view out from under the pointer — the question is no
 * longer being asked, and the bubble is in the way of the answer to the new
 * one. A context menu and a tooltip on screen together is the worst of these:
 * two floating surfaces describing the same target, one of them stale.
 *
 * `TugTooltip` already dismisses on any action flowing through the responder
 * chain (`manager.observeDispatch`). That covers the deliberate act that
 * *reaches* the chain. It does not cover the gestures that never dispatch:
 * a right-click that only opens a native/portal menu, a press on a surface
 * that handles its own pointer events, a wheel or trackpad scroll. Those are
 * raw input, so they are observed as raw input — at the document, in the
 * capture phase, before any handler can stop them.
 *
 * ## Why one module-level emitter
 *
 * Every open tooltip wants the same four listeners. Installing them per
 * tooltip would mean four `addEventListener` calls per bubble and four more
 * per nested trigger. Instead the listeners are installed once, lazily, when
 * the first subscriber arrives, and removed when the last one leaves — so an
 * app with no tooltip showing carries no document-level input listeners at
 * all. This is appearance-zone infrastructure outside the React tree [L22];
 * components subscribe from an effect.
 *
 * ## Capture phase, and `scroll` in particular
 *
 * All four listeners are capture-phase. `pointerdown` and `contextmenu` in
 * capture means the tooltip is gone before the surface that owns the gesture
 * gets to run — a menu can never paint alongside a bubble that outlived it,
 * even if the surface calls `stopPropagation`. `scroll` does not bubble at
 * all, so capture at the document is the only way to hear a scroll inside an
 * arbitrary scroller; the same is true of any scroller the transcript or a
 * sheet mounts later. `wheel` is listened to separately from `scroll` because
 * a wheel over a non-scrollable region produces no scroll event, and the
 * user's intent to move on is identical.
 *
 * ## The event travels with the notification
 *
 * Three of the four are acts: the user pressed, right-clicked, or wheeled, and
 * the bubble goes wherever the act landed. `scroll` is not an act — it is a
 * consequence, and most of them are nobody's gesture at all. A transcript
 * following its bottom as a session streams emits one every time a row is
 * appended, and a bubble the reader is looking at across the window died to a
 * scroller they were not touching, several times a second, while the pointer
 * never moved.
 *
 * So the event rides along to the subscriber, which is the only party that
 * knows what it is describing. The reason a scroll ends a hover is that the
 * scroll moved the target out from under the pointer — a claim only a scroller
 * that CONTAINS the trigger can make. `dismissTooltips` passes `null`, meaning
 * unconditional.
 *
 * Listeners are passive: this module only observes.
 *
 * @module lib/tooltip-dismiss
 */

type Listener = (ev: Event | null) => void;

const listeners = new Set<Listener>();

/** The gestures that end a hover. All observed in the capture phase. */
const DISMISS_EVENTS = ["pointerdown", "contextmenu", "wheel", "scroll"] as const;

let installed = false;

function notify(ev: Event | null): void {
  // Copy before iterating: a listener dismisses its own tooltip, which
  // unmounts an effect and calls `unsubscribe` — mutating the set mid-loop.
  for (const cb of [...listeners]) cb(ev);
}

function install(): void {
  if (installed || typeof document === "undefined") return;
  for (const type of DISMISS_EVENTS) {
    document.addEventListener(type, notify, { capture: true, passive: true });
  }
  installed = true;
}

function uninstall(): void {
  if (!installed || typeof document === "undefined") return;
  for (const type of DISMISS_EVENTS) {
    document.removeEventListener(type, notify, { capture: true });
  }
  installed = false;
}

/**
 * Subscribe to tooltip-dismissing input. The callback runs synchronously in
 * the capture phase of the gesture, so a tooltip closed from it is closed
 * before the gesture reaches whatever surface handles it. The event is handed
 * over so the subscriber can scope its own dismissal — see the note above on
 * `scroll`, which is the one of the four that is not a gesture.
 *
 * Returns an unsubscribe function. The document listeners exist only while
 * at least one subscriber is registered.
 */
export function observeTooltipDismiss(cb: Listener): () => void {
  listeners.add(cb);
  install();
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) uninstall();
  };
}

/**
 * Dismiss every open tooltip now, without an input gesture. For surfaces
 * that open a floating panel programmatically (a menu raised from a
 * keyboard command, say) and need the hover bubble gone with it.
 */
export function dismissTooltips(): void {
  notify(null);
}
