/**
 * The editor atom bake's font family, and the editor line-height derived from
 * the atom register — alone in a leaf module.
 *
 * `tug-atom-img` reads the family for every measure and paint and re-exports
 * both setters; `editor-settings-store` writes the family and publishes the
 * line-height. Both import from here, so the settings store does not import
 * the bake — which reads live session and arc state and so sits on the
 * action-dispatch hub that `card-services-store` (and through it the settings
 * store) also hangs from.
 *
 * @module lib/atom-font
 */

import { atomEditorLineBoxFloorPx } from "./atom-register";

/** Font family stack for Canvas measurement AND Canvas label painting —
 *  the same string drives both, so measured bounds always fit the
 *  painted glyphs. Custom faces resolve from the parent document's
 *  own @font-face rules (the Canvas shares the document's font set). */
let _measureFamily = "system-ui, sans-serif";

/** The family {@link setAtomFont} last set, read by the bake. */
export function atomMeasureFamily(): string {
  return _measureFamily;
}

/**
 * The editor's line-height, as a multiple of its own font size.
 *
 * Derived rather than pinned, and that is the point: an editor line has to be
 * able to seat an atom, and an atom's height is its register's rather than a
 * function of the type the line happens to be set in. So the leading is
 * whatever seats a `prose` atom over the editor's current font size, floored at
 * the leading a line of code wants when no atom is on it. Before this the
 * editor pinned 1.5 and the bake sized its chips to fit *that*, which is how
 * one atom came to be 18px in the composer and 20px in the transcript it was
 * sent to.
 *
 * Lives beside {@link setAtomFont} rather than in `editor-settings-store` so
 * the bake and the store cannot disagree about it; the store publishes it as
 * `--tug-line-height-editor`.
 */
export function editorLineHeightFor(fontSizePx: number): number {
  const seated = atomEditorLineBoxFloorPx() / Math.max(1, fontSizePx);
  return Math.max(EDITOR_MIN_LINE_HEIGHT, Math.ceil(seated * 100) / 100);
}

/** The leading a line of editor text wants with no atom on it. */
const EDITOR_MIN_LINE_HEIGHT = 1.5;

/**
 * Set the font FAMILY used for the editor's atom-chip rendering AND
 * measurement. `family` is the full CSS font-family stack
 * (e.g. `"IBM Plex Mono", monospace`). The editor settings store calls this
 * when the user's font preference changes (and at cold-boot
 * construction time).
 *
 * The family only. An atom's type size is its register's, not its host's:
 * chips that grew and shrank with the editor's font size surprised users, and
 * the same coupling is what made an atom change size the moment it was sent.
 *
 * This drives the *editor*'s data-URI chip path only. React-side
 * surfaces (`TugAtomChip`) intentionally do NOT track this — they
 * use the surrounding transcript font instead, so chips read as
 * part of the prose rather than as borrowed editor-surface text.
 * The editor still calls `regenerateAtoms()` separately to bust
 * CM6's widget cache.
 */
export function setAtomFont(family: string): void {
  _measureFamily = family;
}
