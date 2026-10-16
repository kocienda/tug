/**
 * selectors.ts — shared selectors for strings and marks the app-tests mirror
 * from product source.
 *
 * A test that spells a product string inline goes stale silently when the
 * product renames it: the selector still parses, `querySelector` still returns
 * `null`, and the failure reads as a behavior regression instead of a rename.
 * Renaming `aria-label="Route this input"` once broke seven files that way.
 *
 * Every constant here names the product file it mirrors. When that source
 * changes, this module is the one place to update — and because it lives in
 * `_harness/`, `app-test-changed` prints a SWEEP ADVISED advisory for the edit,
 * which is the correct scope for a selector rename.
 *
 * Engine marks are grouped separately: they are written by the focus engine's
 * projection, not by a component, and they are the vocabulary [P07] assertions
 * speak in ("the keyboard is here" is `[data-key-view]`, not
 * `contains(document.activeElement)`).
 */

/**
 * The Z4A route control: a `TugChoiceGroup` of Prompt | Changes. Mirrors the
 * `aria-label` in `tugdeck/src/components/tugways/tug-prompt-entry.tsx` and the
 * root `data-slot` in `tug-choice-group.tsx`. It was a single
 * `button[aria-label="Route this input"]` until the bang layer was retired.
 */
export const ROUTE_CHOICE = '[data-slot="tug-choice-group"][aria-label="Route"]';

/** Mirrors the dialog island class names in `tugdeck/src/components/chrome/`. */
export const QUESTION_DIALOG = ".session-question-dialog";
export const PERMISSION_DIALOG = ".session-permission-dialog";

/**
 * Engine marks, written by `FocusManager`/`FocusContext` projection in
 * `tugdeck/src/components/tugways/focus-manager.ts`.
 */
export const KEY_VIEW = "[data-key-view]";
export const KEY_VIEW_KBD = "[data-key-view-kbd]";
export const KEY_WITHIN = "[data-key-within]";
export const KEY_CURSOR = "[data-key-cursor]";
export const DEFAULT_RING = "[data-default-ring]";
export const FIRST_RESPONDER = "[data-first-responder]";
export const FOCUSABLE = "[data-tug-focusable]";

/**
 * The keyboard sink: where the engine parks `document.activeElement` on the
 * `engine-routed` route. It lives OUTSIDE every card host, which is exactly why
 * card-containment of `document.activeElement` is not a test for "the keyboard
 * is in this card."
 */
export const KEY_SINK = "[data-tug-key-sink]";

/**
 * The card host wrapper for a given card id. A card that is a body holds its
 * host in its own page, so this selector is evaluated in the card's body —
 * `app.body(cardId)` — and finds nothing in the shell's document there.
 */
export function cardHost(cardId: string): string {
  return `[data-card-host][data-card-id=${JSON.stringify(cardId)}]`;
}

/**
 * A page-side expression, evaluated in the page that holds `cardId`'s host,
 * that is true when that page's keyboard marks are inside the host: the key
 * view, the first responder, or real DOM focus.
 *
 * Under the focus engine there are two legal shapes: the engine parks the sink
 * outside the card and marks the card's key view (`engine-routed`), or it
 * grants a text surface real DOM focus inside the card (`dom-granted`). Either
 * satisfies "the keyboard is here"; only the second one puts
 * `document.activeElement` inside the card host.
 *
 * This is the card's half of `keyboardIsInCard` in `card-reach.ts`, which
 * adds the deck's half and picks the page.
 */
export function keyboardInCardHost(cardId: string): string {
  const host = JSON.stringify(cardHost(cardId));
  return `(function(){
  var host = document.querySelector(${host});
  if (host === null) return false;
  var keyView = host.querySelector(${JSON.stringify(KEY_VIEW)});
  var fr = document.querySelector(${JSON.stringify(FIRST_RESPONDER)});
  var frInCard = fr !== null && host.contains(fr);
  var domGranted = document.activeElement !== null && host.contains(document.activeElement);
  return keyView !== null || frInCard || domGranted;
})()`;
}

/**
 * A page-side expression that is true when the app reads as foreground — the
 * gate any assertion about a painted focus mark has to pass.
 *
 * `focus-ring.css` suppresses the whole focus language (ring, cursor, within,
 * and the container wash) under `html[data-app-active="false"]`, so a suite that
 * probes an outline or a background layer before this is true reads a
 * legitimately-blank style and fails with a mysterious zero rather than a clear
 * cause. `DeckManager.setHasFocus` projects the bit onto `<html>`, and
 * `seedDeckState({ state: { hasFocus: true } })` seeds it, so it is available in
 * both harness event modes.
 *
 * **Use this, not `document.hasFocus()`.** The two are not interchangeable, and
 * the difference decides whether a suite can run in the background event mode
 * that is now the default. A pid-mode harness window deliberately never
 * activates — it sits one window level below normal and takes keys by
 * `postToPid` — so `document.hasFocus()` is false for the entire run and any
 * suite gating on it hangs until timeout. Only a suite whose *subject* is real
 * app activation (`@foreground`, e.g. at0004 / at0295) should read
 * `document.hasFocus()`, and those declare the foreground tier to earn it.
 */
export function appIsActive(): string {
  return `document.documentElement.getAttribute("data-app-active") === "true"`;
}
