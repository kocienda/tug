/**
 * The custom MIME type a Tug clipboard carries its atom sidecar under, alone
 * in a leaf module.
 *
 * The editor's clipboard filters define the sidecar and re-export this
 * constant; `copy-clipboard` writes it, so it lives in `lib` where that write
 * can name it without importing the editor.
 *
 * @module lib/tug-atoms-mime
 */

/** Custom MIME type carrying the atom-sidecar JSON inside a tug clipboard. */
export const TUG_ATOMS_MIME = "application/x-tug-atoms";
