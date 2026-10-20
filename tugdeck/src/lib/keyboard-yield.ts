/**
 * The keyboard yield: whether this page has given the keyboard to another.
 *
 * Tug's pages share one window, and in WebKit a page that focuses a DOM
 * element asks the window to make its web view the first responder. So a page
 * that does not hold the keyboard — the shell while a body card is the deck's
 * first responder, a body whose card is not the key card — must write no DOM
 * focus at all, or it takes the keys from the page that has them. The focus
 * engine (`components/tugways/focus-manager.ts`) consults this before every
 * DOM focus write it makes.
 *
 * A body reads its page: it holds the keyboard exactly while its card is the
 * deck's first responder, as its deck store publishes it, and yields it
 * otherwise — always, until it is bound. The shell's half is host plumbing,
 * installed once by `installBodyShell` ({@link setKeyboardYield}): its
 * predicate says whether a body card holds the keyboard now, `onYield` is
 * called when a key-sink park was declined, so the shell can hand the
 * keyboard on (it posts `bodyFocus`), and `to` names the body card holding
 * the keyboard, whose keyboard-focus paint the shell then wears. With none
 * installed the shell never yields.
 *
 * The overlay page installs one too, and an installed predicate answers for
 * its page whatever the page's role: the overlay is a body page with no card
 * of its own in the deck, and it holds the keyboard exactly while it claims
 * the whole window — the span the host makes its view the key one
 * (`overlay/overlay-claim.ts`).
 *
 * @module lib/keyboard-yield
 */

import { page } from "../bus/page";
import { getCardDeck } from "./deck-store-registry";

let keyboardYield: (() => boolean) | null = null;
let onKeyboardYield: (() => void) | null = null;
let yieldedTo: (() => string | null) | null = null;

/** Install the shell's keyboard yield. Returns the uninstall. */
export function setKeyboardYield(
  predicate: () => boolean,
  onYield?: () => void,
  to?: () => string | null,
): () => void {
  keyboardYield = predicate;
  onKeyboardYield = onYield ?? null;
  yieldedTo = to ?? null;
  return () => {
    if (keyboardYield === predicate) {
      keyboardYield = null;
      onKeyboardYield = null;
      yieldedTo = null;
    }
  };
}

/** The body card holding the keyboard this page yielded, or null when it names none. */
export function keyboardYieldedTo(): string | null {
  return yieldedTo === null ? null : yieldedTo();
}

/** Whether this page has yielded the keyboard to another page. */
export function keyboardYielded(): boolean {
  if (keyboardYield !== null) return keyboardYield();
  if (page.isBody) return page.cardId === null || getCardDeck()?.getFirstResponderCardId() !== page.cardId;
  return false;
}

/** Tell the page a park was declined because it has yielded. */
export function noteKeyboardYield(): void {
  onKeyboardYield?.();
}
