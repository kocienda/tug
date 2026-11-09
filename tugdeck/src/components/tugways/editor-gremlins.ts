/**
 * editor-gremlins.ts — Zap Gremlins, which both CM6 editing surfaces bind.
 *
 * A gremlin is a character that is in the text and not on the screen, or
 * that looks like a space and is not one — the debris of a paste from a
 * web page, a PDF or a chat client. Zap Gremlins clears a fixed set of them:
 *
 *   - **Deleted:** control characters (C0 and C1, and DEL) other than tab
 *     and newline, and the zero-width characters U+200B–U+200D, U+2060 and
 *     U+FEFF.
 *   - **Made a plain space:** the no-break space U+00A0, and the other
 *     Unicode spaces — U+1680, U+2000–U+200A, U+202F, U+205F and U+3000.
 *
 * It acts on the selected text, or on the whole document when every range
 * is empty. It runs without a dialog; BBEdit's options can come later if a
 * fixed set turns out to be wrong. Each press is one transaction, so ⌘Z
 * reverts it whole.
 *
 * The classes below are written as escapes, never as the characters
 * themselves: a literal gremlin in the source is invisible to a reader and
 * is exactly what a paste, an editor or this command would silently drop.
 *
 * @module components/tugways/editor-gremlins
 */

import type { ChangeSpec, EditorState, TransactionSpec } from "@codemirror/state";

import { lineEditSpec } from "./editor-quote-lines";

/** Characters Zap Gremlins deletes. */
// oxlint-disable-next-line no-control-regex -- matching control characters is the command's whole job
const DELETED = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‍⁠﻿]/g;

/** Characters Zap Gremlins replaces with a plain space. */
const SPACES = /[   -   　]/g;

/**
 * The Zap Gremlins transaction for `state`: every gremlin in the selected
 * text, or in the whole document when nothing is selected, deleted or made a
 * plain space. Null on a read-only document, or when there is none.
 */
export function zapGremlinsSpec(state: EditorState): TransactionSpec | null {
  if (state.readOnly) return null;
  const ranges = state.selection.ranges.filter((r) => !r.empty);
  const scope = ranges.length === 0 ? [{ from: 0, to: state.doc.length }] : ranges;
  const changes: ChangeSpec[] = [];
  for (const { from, to } of scope) {
    const text = state.doc.sliceString(from, to);
    for (const [pattern, insert] of [[DELETED, ""], [SPACES, " "]] as const) {
      for (const hit of text.matchAll(pattern)) {
        const at = from + (hit.index ?? 0);
        changes.push({ from: at, to: at + hit[0].length, insert });
      }
    }
  }
  if (changes.length === 0) return null;
  return lineEditSpec(state, changes);
}
