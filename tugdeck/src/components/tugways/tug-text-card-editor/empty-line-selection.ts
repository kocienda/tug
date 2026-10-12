/**
 * empty-line-selection — paint the selection across blank lines.
 *
 * The File card's selection is native `::selection` (see `theme.ts`), and
 * WebKit paints `::selection` only over text. CM6 renders a blank line as a
 * `.cm-line` holding nothing but a `<br>`, so a selection spanning paragraphs
 * shows a gap at every blank line between them, which reads as two selections
 * instead of one.
 *
 * This extension marks each blank line whose line break lies inside a ranged
 * selection with `cm-tug-selectedEmptyLine`; the theme paints a one-character
 * swatch of the selection color at the line's content edge — the newline the
 * selection covers. The swatch is a background image, so the line's layout,
 * the caret, and the active-line wash beneath it are untouched.
 *
 * Appearance-only via a CM6 line decoration + CSS ([L06]).
 *
 * @module components/tugways/tug-text-card-editor/empty-line-selection
 */

import { RangeSetBuilder } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";

const selectedEmptyLine = Decoration.line({ class: "cm-tug-selectedEmptyLine" });

/**
 * Line starts of every blank line whose break is selected, ascending. A blank
 * line is selected when a ranged selection starts at or before it and ends
 * past it; a range that ends exactly at the line's start selects none of it.
 * Exported for tests.
 */
export function selectedEmptyLineStarts(
  state: EditorState,
  visible: readonly { from: number; to: number }[],
): number[] {
  const starts: number[] = [];
  for (const range of state.selection.ranges) {
    if (range.empty) continue;
    for (const vis of visible) {
      const from = Math.max(range.from, vis.from);
      const to = Math.min(range.to, vis.to);
      if (from > to) continue;
      let pos = from;
      while (pos <= to) {
        const line = state.doc.lineAt(pos);
        if (line.length === 0 && line.from >= range.from && line.from < range.to) {
          starts.push(line.from);
        }
        pos = line.to + 1;
      }
    }
  }
  return [...new Set(starts)].sort((a, b) => a - b);
}

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const start of selectedEmptyLineStarts(view.state, view.visibleRanges)) {
    builder.add(start, start, selectedEmptyLine);
  }
  return builder.finish();
}

export const emptyLineSelection: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
