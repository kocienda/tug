/**
 * editor-quote-lines.ts — Quote and Unquote, the Markdown quote-level pair
 * both CM6 editing surfaces bind.
 *
 * The pair acts on **lines**, not on the selected text: every line a
 * selection touches gains or loses one level of `>`, and a bare caret acts
 * on its own line. That is Mail's Increase / Decrease Quote Level, and it
 * is why the commands are not `transformSelectionCase`-shaped — a quote
 * that started mid-line would not be a quote.
 *
 *   - **Quote** prefixes `> ` to every touched line, and a bare `>` to an
 *     empty one, so the block stays one blockquote across its blank lines —
 *     the same output `quoteMarkdown` gives Paste as Quote. Applied again it
 *     nests: `> a` becomes `> > a`.
 *   - **Unquote** removes one level from every touched line that has one —
 *     up to three spaces of indent, the `>`, and one space after it, which
 *     is everything CommonMark reads as the marker. A line with no marker is
 *     left alone, and a selection with none anywhere is a no-op.
 *
 * A ranged selection that ends at column 0 does not touch that last line —
 * the convention `indentMore` keeps, so a selection made by dragging whole
 * lines does not catch the line below. A ranged selection grows to cover
 * the prefixes, so a second press acts on the same lines and the selection
 * reads as the block it is; a caret keeps its place in its text.
 *
 * Each press is one transaction, so ⌘Z reverts it whole.
 *
 * Both the prompt substrate (`tug-text-editor.tsx`) and the file editor
 * (`tug-text-card-editor.tsx`) dispatch these from their responder handlers
 * for `quote-lines` / `unquote-lines`.
 *
 * @module components/tugways/editor-quote-lines
 */

import { EditorSelection } from "@codemirror/state";
import type { ChangeSpec, EditorState, TransactionSpec } from "@codemirror/state";

/** CommonMark's blockquote marker: ≤3 spaces of indent, `>`, one optional space. */
const QUOTE_MARKER = /^ {0,3}> ?/;

/** The numbers of every line the selection touches, ascending, each once. */
function touchedLines(state: EditorState): number[] {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from);
    let last = state.doc.lineAt(range.to);
    if (!range.empty && range.to === last.from && last.number > first.number) {
      last = state.doc.line(last.number - 1);
    }
    for (let n = first.number; n <= last.number; n++) lines.add(n);
  }
  return [...lines].sort((a, b) => a - b);
}

/** The transaction that applies `changes`, mapping the selection through it. */
function lineEditSpec(state: EditorState, changes: ChangeSpec[]): TransactionSpec {
  const set = state.changes(changes);
  const selection = EditorSelection.create(
    state.selection.ranges.map((range) => {
      if (range.empty) return EditorSelection.cursor(set.mapPos(range.head, 1));
      // The start sticks to the line's start and the end to its text, so the
      // range grows over an inserted prefix rather than stopping short of it.
      const from = set.mapPos(range.from, -1);
      const to = set.mapPos(range.to, 1);
      return range.anchor <= range.head
        ? EditorSelection.range(from, to)
        : EditorSelection.range(to, from);
    }),
    state.selection.mainIndex,
  );
  return { changes: set, selection, userEvent: "input", scrollIntoView: true };
}

/**
 * The Quote transaction for `state`: one more quote level on every touched
 * line. Null on a read-only document.
 */
export function quoteLinesSpec(state: EditorState): TransactionSpec | null {
  if (state.readOnly) return null;
  const changes: ChangeSpec[] = touchedLines(state).map((n) => {
    const line = state.doc.line(n);
    return { from: line.from, insert: line.length === 0 ? ">" : "> " };
  });
  return lineEditSpec(state, changes);
}

/**
 * The Unquote transaction for `state`: one less quote level on every touched
 * line that has one. Null on a read-only document, or when no touched line
 * is quoted.
 */
export function unquoteLinesSpec(state: EditorState): TransactionSpec | null {
  if (state.readOnly) return null;
  const changes: ChangeSpec[] = [];
  for (const n of touchedLines(state)) {
    const line = state.doc.line(n);
    const marker = QUOTE_MARKER.exec(line.text);
    if (marker !== null) {
      changes.push({ from: line.from, to: line.from + marker[0].length });
    }
  }
  if (changes.length === 0) return null;
  return lineEditSpec(state, changes);
}
