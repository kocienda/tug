/**
 * tug-text-editor/atom-type-over.ts — type-over-selected-atom input.
 *
 * An atom chip is a CM6 replaced widget over a U+FFFC placeholder, and
 * CM stamps the widget's DOM node `contentEditable="false"`. When the
 * selection covers only (or partly) such a node, WebKit will not let a
 * typed character replace it — the keystroke is dropped or inserted
 * adjacent, so the chip survives. That breaks the universal editing
 * contract that typing over a selection replaces it.
 *
 * This handler restores it: on a printable keystroke whose selection
 * spans an atom, it dispatches the replacement itself (the selected
 * range → the typed character) and preventDefault's the browser's
 * broken default. Plain-text selections are left to the native DOM path,
 * which already replaces correctly; IME composition and modified chords
 * (Cmd/Ctrl) are yielded untouched.
 *
 * Selection membership is read straight from the document: every atom
 * carries a backing U+FFFC, so a selection whose sliced text contains
 * {@link TUG_ATOM_CHAR} covers at least one atom.
 *
 * Laws: [L06] appearance/DOM handled outside React state, [L11] the edit
 *        rides the transaction stream, [L19] file structure.
 */

import { EditorSelection, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { EditorState, Extension, TransactionSpec } from "@codemirror/state";

import { TUG_ATOM_CHAR } from "@/lib/tug-atom-img";

/** The `KeyboardEvent` fields the type-over decision reads. */
type TypeOverKey = Pick<
  KeyboardEvent,
  "key" | "isComposing" | "metaKey" | "ctrlKey" | "defaultPrevented"
>;

/**
 * Whether `event` is a single literal character being typed — the case
 * the native DOM path drops when the selection covers a non-editable
 * atom widget. Excludes IME composition, the Cmd/Ctrl chords (shortcuts,
 * never text), and any non-printable key (`event.key` longer than one
 * code unit: `Enter`, `Backspace`, `ArrowLeft`, `Dead`, …). Shift and
 * Alt are allowed — on macOS Option produces literal characters.
 */
function isLiteralType(event: TypeOverKey): boolean {
  if (event.isComposing) return false;
  if (event.metaKey || event.ctrlKey) return false;
  return event.key.length === 1;
}

/**
 * The transaction that types `event.key` over the current selection when
 * that selection spans an atom, or `null` when this keystroke is not a
 * type-over-atom (not a literal char, empty selection, or a selection
 * that touches no atom — the native path handles those). Pure: no view,
 * no DOM, so the replace behavior is exercisable headlessly.
 *
 * The covered atoms leave with their U+FFFCs: the field drops an atom
 * whose character a change takes, and records it for undo.
 */
export function typeOverAtomChange(
  state: EditorState,
  event: TypeOverKey,
): TransactionSpec | null {
  if (event.defaultPrevented) return null;
  if (!isLiteralType(event)) return null;
  const sel = state.selection.main;
  if (sel.empty) return null;
  if (!state.sliceDoc(sel.from, sel.to).includes(TUG_ATOM_CHAR)) return null;

  const changes = { from: sel.from, to: sel.to, insert: event.key };
  return {
    changes,
    selection: EditorSelection.cursor(sel.from + event.key.length),
    userEvent: "input.type",
    scrollIntoView: true,
  };
}

export const atomTypeOverExt: Extension = Prec.highest(
  EditorView.domEventHandlers({
    keydown(event, view) {
      const spec = typeOverAtomChange(view.state, event);
      if (spec === null) return false;
      view.dispatch(spec);
      event.preventDefault();
      return true;
    },
  }),
);
