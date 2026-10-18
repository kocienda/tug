/**
 * The shell's keyboard hold: a gesture of the shell's own, in flight, that
 * the keyboard has to stay with.
 *
 * Tug's pages share one window, and while a body card is the deck's first
 * responder the shell hands that body the keyboard. A gesture the shell
 * runs over a body card's chrome — a rail width drag on its edge — listens
 * for its Escape on the shell's own `window`, and a key sent to a body's page
 * never reaches it. So the gesture holds the keyboard for its length: the
 * shell names itself for the keyboard while any hold stands
 * (`body-shell.ts`, `keyboardBody`), and hands it back when the last one
 * goes.
 *
 * Counted, so two gestures that overlap release in either order. Each
 * release is good once.
 *
 * @module lib/shell-keyboard-hold
 */

let holds = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** Hold the keyboard in the shell until the returned release is called. */
export function holdShellKeyboard(): () => void {
  holds += 1;
  if (holds === 1) notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    if (holds === 0) notify();
  };
}

/** Whether a shell gesture holds the keyboard now. */
export function shellKeyboardHeld(): boolean {
  return holds > 0;
}

/** Hear the hold begin and end. Returns the unsubscribe. */
export function subscribeShellKeyboardHold(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
