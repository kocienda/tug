/**
 * editor-line-breaks.ts — Add Line Breaks and Remove Line Breaks, the pair
 * both CM6 editing surfaces bind.
 *
 *   - **Add Line Breaks** turns the soft wraps in the touched lines into real
 *     newlines, at the points where the editor is wrapping them now — what
 *     the user sees becomes what is stored. The whitespace a wrap hangs at
 *     the end of a visual line is dropped, so no line ends in a space.
 *   - **Remove Line Breaks** joins the lines of each touched paragraph with
 *     one space, and keeps blank lines as the paragraph breaks they are. The
 *     whitespace on either side of each join folds into that one space.
 *
 * "Touched" is the quote pair's reading (`touchedLines`): every line a
 * selection touches, a ranged selection ending at column 0 not catching the
 * line below. Remove widens a bare caret to its whole paragraph, since a
 * single line has no breaks of its own to remove.
 *
 * Where the view wraps is layout, which an `EditorState` cannot see. So Add
 * is split in two: `softWrapBreaks` reads the break points off a live
 * `EditorView`, and `addLineBreaksSpec` is the pure transform over a state
 * and those points, which is what a unit test can hold. The view can only
 * report wraps for lines it has drawn, so a touched line scrolled out of the
 * viewport reads as unwrapped and is left alone.
 *
 * Each press is one transaction, so ⌘Z reverts it whole.
 *
 * @module components/tugways/editor-line-breaks
 */

import { EditorSelection } from "@codemirror/state";
import type { ChangeSpec, EditorState, Line, TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import { lineEditSpec, touchedLines } from "./editor-quote-lines";

const isBlank = (line: Line): boolean => line.text.trim() === "";

/**
 * The positions in the touched lines where `view` soft-wraps them now, each
 * the start of a continuation visual line, ascending.
 */
export function softWrapBreaks(view: EditorView): number[] {
  const { state } = view;
  const breaks: number[] = [];
  for (const n of touchedLines(state)) {
    const line = state.doc.line(n);
    let pos = line.from;
    for (;;) {
      const end = view.moveToLineBoundary(EditorSelection.cursor(pos, 1), true, true).head;
      if (end <= pos || end >= line.to) break;
      breaks.push(end);
      pos = end;
    }
  }
  return breaks;
}

/**
 * The Add Line Breaks transaction for `state`: a newline at each of
 * `breaks`, replacing the whitespace around it. Null on a read-only
 * document, or when there is no break to add.
 */
export function addLineBreaksSpec(
  state: EditorState,
  breaks: readonly number[],
): TransactionSpec | null {
  if (state.readOnly) return null;
  const changes: ChangeSpec[] = [];
  for (const at of breaks) {
    const line = state.doc.lineAt(at);
    if (at <= line.from || at >= line.to) continue;
    let from = at;
    while (from > line.from && /[ \t]/.test(state.doc.sliceString(from - 1, from))) from--;
    let to = at;
    while (to < line.to && /[ \t]/.test(state.doc.sliceString(to, to + 1))) to++;
    if (from === line.from || to === line.to) continue;
    changes.push({ from, to, insert: "\n" });
  }
  if (changes.length === 0) return null;
  return lineEditSpec(state, changes);
}

/** The touched lines, with a bare caret widened to its whole paragraph. */
function removeScope(state: EditorState): number[] {
  const lines = new Set(touchedLines(state));
  for (const range of state.selection.ranges) {
    if (!range.empty) continue;
    const here = state.doc.lineAt(range.head);
    if (isBlank(here)) continue;
    let first = here.number;
    while (first > 1 && !isBlank(state.doc.line(first - 1))) first--;
    let last = here.number;
    while (last < state.doc.lines && !isBlank(state.doc.line(last + 1))) last++;
    for (let n = first; n <= last; n++) lines.add(n);
  }
  return [...lines].sort((a, b) => a - b);
}

/**
 * The Remove Line Breaks transaction for `state`: each run of consecutive,
 * non-blank touched lines joined into one line with single spaces. Null on a
 * read-only document, or when no touched paragraph has more than one line.
 */
export function removeLineBreaksSpec(state: EditorState): TransactionSpec | null {
  if (state.readOnly) return null;
  const scope = removeScope(state);
  const changes: ChangeSpec[] = [];
  for (let i = 0; i + 1 < scope.length; i++) {
    if (scope[i + 1] !== scope[i] + 1) continue;
    const upper = state.doc.line(scope[i]);
    const lower = state.doc.line(scope[i + 1]);
    if (isBlank(upper) || isBlank(lower)) continue;
    const from = upper.from + upper.text.trimEnd().length;
    const to = lower.from + (lower.text.length - lower.text.trimStart().length);
    changes.push({ from, to, insert: " " });
  }
  if (changes.length === 0) return null;
  return lineEditSpec(state, changes);
}
