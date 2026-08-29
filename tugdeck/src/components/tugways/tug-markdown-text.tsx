/**
 * `TugMarkdownText` — read-only markdown-styled text.
 *
 * A block of prose (a commit message body, a note) painted with the same
 * markdown styling the editing surfaces use — heading / strong / emphasis /
 * inline-code tones, and a hanging indent under wrapped list items — with
 * the raw syntax left in place. Read-only: no editor, no gestures, no
 * selection model of its own beyond the browser's.
 *
 * Styling is a synchronous filter ({@link applyMarkdownTextStyle}), so the first
 * paint is the styled paint. Text renders verbatim, whitespace preserved.
 *
 * `highlightQuery` paints a list filter's matches over the styled text — the
 * marks nest INSIDE the syntax runs (`renderFilterHighlightSpans`), so a match
 * inside inline code keeps the code tone and wears the highlight. Matching runs
 * per LINE, which is also the only correct grain: a query term cannot span a
 * newline.
 *
 * **Annotated.** This is prose, and prose in a transcript names things — a
 * commit message body is mostly backticked paths. So it opts into the content
 * annotator (`useAnnotatedElement`), which marks the entities in the text it
 * renders. Inert outside an {@link AnnotationScope}, so a consumer painting
 * this somewhere with no session behind it is unaffected.
 *
 * Laws: [L06] every tone comes from the shared highlight classes and the
 * component's own CSS; nothing here is React state. [L03] the annotation pass
 * runs in a layout effect, before any gesture can land on it.
 *
 * @module components/tugways/tug-markdown-text
 */

import "./tug-markdown-text.css";

import { useMemo, useSyncExternalStore } from "react";
import type React from "react";

import { renderFilterHighlightSpans } from "@/components/tugways/filter-highlight";
import { useAnnotatedElement } from "@/components/tugways/annotation-scope";
import {
  getMarkdownGrammarRevision,
  subscribeMarkdownGrammars,
} from "@/lib/markdown-text-style-grammar";
import { applyMarkdownTextStyle } from "@/lib/markdown-text-styling";

export interface TugMarkdownTextProps {
  /** The markdown to style. Rendered verbatim — nothing is hidden. */
  text: string;
  /**
   * A list filter's live query. Its matches are marked inside the styled runs.
   * Empty / absent ⇒ no marks and DOM identical to the unfiltered render.
   */
  highlightQuery?: string;
  className?: string;
  /** Test hook on the block element. */
  dataSlot?: string;
  /**
   * Stamps `data-tugx-findable` on the root, opting the rendered lines into
   * transcript Find. The painter walks the marked container and re-runs the
   * matcher over its live text, so whoever sets this owes the search index a
   * projection of the SAME text — for a receipt row that is its
   * registration's `findParts` ({@link session-command-block-registry}).
   */
  findable?: boolean;
}

/**
 * The text {@link TugMarkdownText} will put on screen for `text`, one entry
 * per rendered line — the projection half of its `findable` marker. It runs
 * the SAME styler the component does, so a surface that marks the block
 * findable and projects this into the transcript's search index cannot
 * count a line the painter will not see.
 */
export function markdownTextParts(text: string): string[] {
  return applyMarkdownTextStyle(text).map((line) => line.text);
}

export function TugMarkdownText({
  text,
  highlightQuery = "",
  className,
  dataSlot,
  findable = false,
}: TugMarkdownTextProps): React.ReactElement {
  // A fenced block's grammar loads lazily, and the filter is synchronous, so
  // its first pass over a ```ts fence returns a flat body. The revision
  // changes when a grammar arrives, which re-runs the filter — by then the
  // description has its support cached and the body tokenizes. [L02].
  const grammarRevision = useSyncExternalStore(
    subscribeMarkdownGrammars,
    getMarkdownGrammarRevision,
    getMarkdownGrammarRevision,
  );
  const lines = useMemo(
    () => applyMarkdownTextStyle(text),
    [text, grammarRevision],
  );
  // The rendered text is what the annotator scans, so the pass re-runs when
  // that text changes — including the filter query, which rewrites the spans
  // the marks are split out of.
  const annotatedRef = useAnnotatedElement<HTMLDivElement>([
    lines,
    highlightQuery,
  ]);
  return (
    <div
      ref={annotatedRef}
      className={
        className !== undefined ? `tug-markdown-text ${className}` : "tug-markdown-text"
      }
      data-slot={dataSlot}
      data-tugx-findable={findable ? "" : undefined}
    >
      {lines.map((line, i) => (
        <div
          key={i}
          className={
            line.code
              ? "tug-markdown-text-line tug-markdown-text-line-code"
              : "tug-markdown-text-line"
          }
          // The hanging indent: the block indents by the marker width so
          // wrapped lines start there, and the first visual line pulls back
          // by the same amount so the marker itself still reads flush.
          style={
            line.indent > 0
              ? {
                  paddingLeft: `${line.indent}ch`,
                  textIndent: `-${line.indent}ch`,
                }
              : undefined
          }
        >
          {renderFilterHighlightSpans(line.spans, line.text, highlightQuery)}
        </div>
      ))}
    </div>
  );
}
