/**
 * Open-menu registry — whether a menu is on screen right now.
 *
 * A menu is a question the user has already asked and is in the middle of
 * answering. A tooltip is a question they have not asked yet. While a menu
 * stands, the second one has no business appearing: the two float over the
 * same region, the bubble often describes the very row the menu was raised
 * from, and it can cover the items the user is reading. So no tooltip opens
 * while any menu is open — the general rule, not a special case for one
 * surface.
 *
 * Dismissing on the gesture (`lib/tooltip-dismiss`) is only half of it. That
 * ends the bubble that was standing when the right-click landed. It says
 * nothing about the next hover: with the menu still up, moving the pointer
 * across the rows behind it would open a fresh bubble a moment later, which is
 * the pairing this registry exists to make impossible.
 *
 * ## Why a registry and not a DOM query
 *
 * Every menu shell in the suite paints `.tug-menu-content`, so `TugTooltip`
 * could ask the document whether such a node exists. That answer is markup
 * read as a proxy for state: it is true during a menu's exit animation, and
 * true for anything that borrows the class to look like a menu. A menu shell
 * already holds its own open state in React — this module lets it say so.
 * Registration is a `useLayoutEffect` keyed on that state, so the fact goes
 * up before the paint that shows the menu and comes down with the unmount.
 *
 * Counted rather than boolean: a sub-menu, or a dropdown raised over a
 * context menu, means two shells registered at once, and the second one
 * closing must not clear the first one's claim.
 *
 * Appearance-zone infrastructure outside the React tree [L22]; consumers read
 * it at an event edge or subscribe from an effect.
 *
 * @module lib/open-menu-registry
 */

import { createSubscribable } from "./subscribable";

type Listener = () => void;

const listeners = createSubscribable();

let openCount = 0;

function notify(): void {
  listeners.notify();
}

/**
 * Declare that a menu is open. Call from a `useLayoutEffect` keyed on the
 * shell's own open state and return the result as the cleanup, so the claim
 * is dropped on close and on unmount alike.
 */
export function registerOpenMenu(): () => void {
  openCount += 1;
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openCount -= 1;
    notify();
  };
}

/** Whether any menu is currently open. */
export function anyMenuOpen(): boolean {
  return openCount > 0;
}

/**
 * Subscribe to menu open/close. Fires on every registration and release,
 * synchronously; read {@link anyMenuOpen} for the current answer.
 */
export function observeOpenMenus(cb: Listener): () => void {
  return listeners.subscribe(cb);
}
