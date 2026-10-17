/**
 * The cycle forwarder: who takes the ⌥⇥ toggle when this page's key card
 * lives in another page.
 *
 * A card whose content is in a body holds its cycle scope and its stops
 * there, so the toggle is the body's to run. Pressed inside the body, ⌥⇥ is
 * answered there; dispatched in the shell — the View menu's Keyboard Focus
 * item, the palette, ⌥⇥ while the shell holds the keyboard — the shell's key
 * card is only the body's placeholder, and toggling the shell's own cycle
 * would leave the card's untouched. `cycleFocusMode` (`action-dispatch.ts`)
 * consults this at the base mode; an installed forwarder that answers `true`
 * has handed the toggle on. With none installed a page toggles in place.
 *
 * @module lib/cycle-focus-forwarder
 */

/** Hands the toggle to the page that holds the key card; returns whether it did. */
export type CycleFocusForwarder = () => boolean;

let forwarder: CycleFocusForwarder | null = null;

/** Install the page's forwarder. Returns the uninstall. */
export function setCycleFocusForwarder(next: CycleFocusForwarder): () => void {
  forwarder = next;
  return () => {
    if (forwarder === next) forwarder = null;
  };
}

/** Offer the toggle to the page that holds the key card; whether it was taken. */
export function forwardCycleFocus(): boolean {
  return forwarder !== null && forwarder();
}
