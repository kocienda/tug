/**
 * Whose keyboard-focus paint the shell wears while it has yielded the
 * keyboard to a body.
 *
 * KBF mode's paint (`data-kbf` on the root) stands down while a caret is
 * live: a ring beside a caret is two claims on one keyboard. The answer is
 * the focus engine's (`FocusManager.kbfPainting`), and it reads the route of
 * the page it runs in. With bodies the keyboard can be in a card's own page
 * while the shell's deck says the mode is on — the Overview engages it at
 * rest and seeds its composer's caret — and the shell, which parks nothing
 * while it has yielded the keyboard (`keyboard-yield.ts`), reads its own route
 * as engine-routed and paints. So the shell's root wore the mode beside the
 * Overview body's caret.
 *
 * The body says its own paint answer (`kbf-paint` advice), and while the
 * shell has yielded the keyboard to that body this module answers the shell
 * engine's paint question with it. With no source installed, or no word from
 * the body holding the keyboard, the engine reads its own route as before.
 *
 * @module lib/yielded-kbf-paint
 */

let source: (() => boolean | null) | null = null;

/** Install the shell's source of the keyboard body's paint. Returns the uninstall. */
export function setYieldedKbfPaintSource(next: () => boolean | null): () => void {
  source = next;
  return () => {
    if (source === next) source = null;
  };
}

/**
 * The paint the page holding the keyboard reports, or null when there is no
 * such word — no source, or a body that has not said.
 */
export function yieldedKbfPaint(): boolean | null {
  return source === null ? null : source();
}
