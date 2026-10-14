/**
 * The keyboard yield: whether this page has given the keyboard to another.
 *
 * Tug's pages share one window, and in WebKit a page that focuses a DOM
 * element asks the window to make its web view the first responder. So a page
 * that does not hold the keyboard — the shell while a body card is the deck's
 * first responder, a body whose card is not the key card — must write no DOM
 * focus at all, or it takes the keys from the page that has them. The focus
 * engine (`components/tugways/focus-manager.ts`) consults this before every
 * DOM focus write it makes; `onYield` is called when a key-sink park was
 * declined, so the page can hand the keyboard on (the shell posts `bodyFocus`).
 * With none installed a page never yields.
 *
 * @module lib/keyboard-yield
 */

let keyboardYield: (() => boolean) | null = null;
let onKeyboardYield: (() => void) | null = null;

/** Install the page's keyboard yield. Returns the uninstall. */
export function setKeyboardYield(predicate: () => boolean, onYield?: () => void): () => void {
  keyboardYield = predicate;
  onKeyboardYield = onYield ?? null;
  return () => {
    if (keyboardYield === predicate) {
      keyboardYield = null;
      onKeyboardYield = null;
    }
  };
}

/** Whether this page has yielded the keyboard to another page. */
export function keyboardYielded(): boolean {
  return keyboardYield !== null && keyboardYield();
}

/** Tell the page a park was declined because it has yielded. */
export function noteKeyboardYield(): void {
  onKeyboardYield?.();
}
