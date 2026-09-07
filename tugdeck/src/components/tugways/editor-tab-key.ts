/**
 * editor-tab-key.ts — the Tab binding both CM6 editing surfaces use.
 *
 * CM6 ships two Tab commands and neither is the one a text editor wants:
 *
 *   - `indentWithTab` runs `indentMore`, which inserts the indent unit at
 *     the **line's start** regardless of where the caret is. Press Tab
 *     after `abc` and the whole line jumps right — the indent never lands
 *     where you are typing. This is a block-indent command wearing Tab's
 *     name, and it is what made "Auto-expand tabs" look inert: the setting
 *     was live, but its only visible effect was at column zero.
 *   - `insertTab` inserts a literal `\t` at the caret, ignoring
 *     `indentUnit` entirely — so it cannot honour the setting at all.
 *
 * {@link tugInsertTab} is the union of what each gets right: a RANGED
 * selection indents its lines (`indentMore`, the one job that command is
 * for), and a plain caret inserts one indent unit **at the caret** — a
 * literal tab under hard tabs, or spaces to the next tab stop under soft
 * tabs. Advancing to the stop rather than always inserting `tabSize`
 * spaces is what makes a soft tab line up with a hard one: Tab at column 2
 * with a width of 4 inserts 2 spaces, not 4.
 *
 * Shift-Tab stays `indentLess` — dedent has no caret-local meaning.
 *
 * Both the prompt substrate (`tug-text-editor.tsx`) and the file editor
 * (`tug-text-card-editor.tsx`) bind this, so "Auto-expand tabs" and
 * "Spaces per tab" mean one thing across the app.
 *
 * @module components/tugways/editor-tab-key
 */

import { indentLess, indentMore } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { countColumn, EditorSelection } from "@codemirror/state";
import type { Command, KeyBinding } from "@codemirror/view";

/**
 * Tab: indent the selected lines, or insert one indent unit at the caret.
 *
 * The unit comes from the `indentUnit` facet, which the editors' tab
 * compartments set from the reader's `softTabs` / `tabSize` pair — so this
 * command reads the setting rather than knowing about it.
 */
export const tugInsertTab: Command = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  // A ranged selection is a block-indent gesture, not a text insertion —
  // that is exactly `indentMore`'s job, so hand it over unchanged.
  if (state.selection.ranges.some((r) => !r.empty)) {
    return indentMore({ state, dispatch });
  }
  const unit = state.facet(indentUnit);
  const hardTabs = unit.includes("\t");
  const width = unit.length > 0 ? unit.length : state.tabSize;
  dispatch(
    state.update(
      state.changeByRange((range) => {
        let insert: string;
        if (hardTabs) {
          insert = "\t";
        } else {
          // Distance to the next tab stop, measured in COLUMNS from the
          // line's start — a tab already sitting to the left of the caret
          // counts as its rendered width, not as one character.
          const line = state.doc.lineAt(range.from);
          const column = countColumn(
            state.doc.sliceString(line.from, range.from),
            state.tabSize,
          );
          insert = " ".repeat(width - (column % width));
        }
        return {
          changes: { from: range.from, insert },
          range: EditorSelection.cursor(range.from + insert.length),
        };
      }),
      { userEvent: "input", scrollIntoView: true },
    ),
  );
  return true;
};

/** The `Tab` / `Shift-Tab` pair. Replaces CM6's `indentWithTab`. */
export const tugTabKeyBinding: KeyBinding = {
  key: "Tab",
  run: tugInsertTab,
  shift: indentLess,
};
