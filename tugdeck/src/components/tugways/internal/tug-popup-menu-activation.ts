/**
 * tug-popup-menu-activation — when a picked menu item's `onSelect` runs,
 * relative to the confirmation blink that plays on it.
 *
 * A TugPopupMenu item pick plays a double-blink on the item and closes the
 * menu when the blink ends. By default the caller's `onSelect` runs at that
 * end too, just before the close. A menu whose pick has a visible effect the
 * user is waiting on — the workspace row's theme menu — opts into running
 * `onSelect` as the blink starts instead, so the effect does not wait out the
 * blink. The close stays at the blink's end in both timings: the blink is the
 * confirmation that the pick landed, and the user still sees it.
 *
 * The caller raises its re-entry/dismiss guard before calling this and lowers
 * it in `finish`, so the guard spans the whole blink in either timing — a
 * chain dispatch issued by `onSelect` cannot dismiss the menu early.
 *
 * Pure sequencing over a promise, so it is unit-tested with no DOM.
 */

export interface PopupMenuActivation {
  /** Run `select` as the blink starts rather than when it ends. */
  selectAtBlinkStart: boolean;
  /** The caller's `onSelect`, bound to the picked id. */
  select: () => void;
  /** Lower the guard and close the menu. Always runs, once, after `select`. */
  finish: () => void;
}

/**
 * Sequence an item activation against `blink` (the blink's `finished`).
 *
 * `select` runs exactly once — synchronously here when `selectAtBlinkStart`,
 * otherwise when `blink` settles. A rejected blink (the element detached, the
 * animation interrupted) still selects, so a pick is never lost. `finish`
 * runs once, when `blink` settles, after `select` — even when `select`
 * throws, so a failing handler cannot leave the caller's guard raised and
 * its menu open.
 */
export function sequencePopupMenuActivation(
  blink: Promise<unknown>,
  { selectAtBlinkStart, select, finish }: PopupMenuActivation,
): Promise<void> {
  const settle = (): void => {
    try {
      if (!selectAtBlinkStart) select();
    } finally {
      finish();
    }
  };
  // Attached before an at-start `select` runs, so its throw cannot skip it.
  const done = blink.then(settle, settle);
  if (selectAtBlinkStart) select();
  return done;
}
