/**
 * editor-font-options.ts — the Font / Size popup items shared by every
 * settings panel that lets a reader choose an editor face.
 *
 * One list, two panels: the Settings card's "Sessions" tab (the prompt
 * editor) and its "Text Files" tab / the File card's gear popover (the
 * file editor). The faces themselves are `FONT_STACKS` in
 * `lib/editor-settings-store.ts` — these are the labels over that map, so
 * a face added there gains a row here and nowhere else.
 *
 * @module components/tugways/cards/editor-font-options
 */

import { TUG_ACTIONS } from "../action-vocabulary";
import type { TugPopupButtonItem } from "../tug-popup-button";

/** The editor faces, keyed by the `FONT_STACKS` id they name. */
export const EDITOR_FONT_OPTIONS: TugPopupButtonItem<string>[] = [
  { action: TUG_ACTIONS.SET_VALUE, value: "plex-mono", label: "IBM Plex Mono" },
  { action: TUG_ACTIONS.SET_VALUE, value: "plex-sans", label: "IBM Plex Sans" },
];

/** The offered point sizes. */
export const FONT_SIZE_OPTIONS: TugPopupButtonItem<number>[] = [
  { action: TUG_ACTIONS.SET_VALUE, value: 11, label: "11 px" },
  { action: TUG_ACTIONS.SET_VALUE, value: 12, label: "12 px" },
  { action: TUG_ACTIONS.SET_VALUE, value: 13, label: "13 px" },
  { action: TUG_ACTIONS.SET_VALUE, value: 14, label: "14 px" },
  { action: TUG_ACTIONS.SET_VALUE, value: 15, label: "15 px" },
  { action: TUG_ACTIONS.SET_VALUE, value: 16, label: "16 px" },
];
