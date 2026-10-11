/**
 * chord-capture-state.ts — whether a chord-capture surface is armed.
 *
 * While the Keyboard pane records a chord, every key the user presses is an
 * answer, not a command. The capture surface owns the keyboard for that span,
 * and two layers have to yield for the ownership to be real: the key
 * pipeline's stage-1 listener (which would otherwise match the chord and
 * dispatch its old command) and the native menu bar (which would otherwise
 * resolve a key equivalent before the web view sees a keydown at all). Both
 * read this flag — stage 1 directly, the menu bar via the `captureArmed`
 * field on the menuState push, which the host answers by parking every key
 * equivalent until the capture disarms.
 *
 * One armed capture at a time: arming is exclusive by construction, because
 * the pane renders one capture surface and unmounts it before another can
 * mount. The flag is a count anyway, so an overlap is merely harmless
 * rather than corrupting.
 *
 * @module lib/chord-capture-state
 */

import { createSubscribable } from "@/lib/subscribable";

let armedCount = 0;
const subscribers = createSubscribable();

function notify(): void {
  subscribers.notify();
}

export const chordCaptureState = {
  /** Arm the capture. Returns the release; call it on teardown ([L27]). */
  arm(): () => void {
    armedCount += 1;
    if (armedCount === 1) notify();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      armedCount -= 1;
      if (armedCount === 0) notify();
    };
  },

  isArmed(): boolean {
    return armedCount > 0;
  },

  subscribe(subscriber: () => void): () => void {
    return subscribers.subscribe(subscriber);
  },
};
