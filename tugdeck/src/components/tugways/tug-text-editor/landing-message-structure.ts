/**
 * tug-text-editor/landing-message-structure.ts — the landing message's
 * parts, marked in the editor that holds it.
 *
 * In landing mode the composer's field is the commit message, and a message
 * a skill wrote arrives as a subject, a summary paragraph, and the detail —
 * one document with three jobs. Painted as one undifferentiated block of
 * text, the reader has to find the joints; this extension marks them, so
 * the subject reads as a heading, the summary as the paragraph it is, and
 * the detail as what follows a rule.
 *
 * Mechanism ([L06] — appearance through the DOM, via decorations): a
 * `Decoration.line` puts `cm-landing-subject` on the subject line and
 * `cm-landing-summary` on each line of the summary paragraph; the
 * composer's stylesheet does the rest. Which lines those are is
 * {@link landingMessageLayout}'s reading — the same one the Changes shade
 * fronts the parts with, so the editor and the shade cannot disagree about
 * where the summary is. The whole document is walked, not the viewport: the
 * parts are at the top, and a message is a few hundred lines at the most.
 *
 * **The blank line between the subject and the summary is separator, not
 * text.** git's format puts it there and the subject's own rule already says
 * the same thing on screen, so painted at full height it read as a gap the
 * author had left. `cm-landing-gap` collapses it — except on the line the
 * caret is on, which is why this rebuilds on selection as well as on change:
 * a collapsed line is still an editable one, and a caret nobody can see
 * would be a worse lie than the gap. It is reached horizontally; CodeMirror's
 * vertical motion is geometric and steps over a line with no height, which is
 * the behaviour to want — the reader never arrows into a phantom.
 *
 * @module components/tugways/tug-text-editor/landing-message-structure
 */

import { RangeSetBuilder } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";

import { landingMessageLayout } from "@/lib/landing-message";

const SUBJECT = Decoration.line({ class: "cm-landing-subject" });
const SUMMARY = Decoration.line({ class: "cm-landing-summary" });
const GAP = Decoration.line({ class: "cm-landing-gap" });

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { doc } = view.state;
  if (doc.length === 0) return builder.finish();
  const layout = landingMessageLayout(doc.toString());
  const caretLine = doc.lineAt(view.state.selection.main.head).number;
  const subject = doc.line(Math.min(layout.subjectLine, doc.lines));
  builder.add(subject.from, subject.from, SUBJECT);
  if (layout.summaryLines !== null) {
    for (let n = layout.subjectLine + 1; n < layout.summaryLines.from; n += 1) {
      if (n > doc.lines || n === caretLine) continue;
      const line = doc.line(n);
      builder.add(line.from, line.from, GAP);
    }
    for (let n = layout.summaryLines.from; n < layout.summaryLines.to && n <= doc.lines; n += 1) {
      const line = doc.line(n);
      builder.add(line.from, line.from, SUMMARY);
    }
  }
  return builder.finish();
}

/** Marks the subject line and the summary paragraph; rebuilds on doc change. */
export const landingMessageStructure: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
