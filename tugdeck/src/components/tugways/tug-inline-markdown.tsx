/**
 * `TugInlineMarkdown` — one line of model-written text with its inline marks
 * rendered rather than spelled.
 *
 * For a row that prints a sentence the model wrote — a task's subject, a
 * job's description, a goal's condition — where backticked paths, the odd
 * `**word**` and an entity carried from elsewhere would otherwise show as
 * their syntax. The grammar is inline only ({@link inlineMarkdownRuns}): code
 * spans, strong, emphasis, escapes and entities. Angle brackets, list markers
 * and headings are text, because these lines are often about code.
 *
 * The output is inline React nodes — text, `<code>`, `<strong>`, `<em>` — in
 * one inline `<span>` root, so it drops into a row's text slot and the slot's
 * own clipping and ellipsis keep working: an inline box is clipped and
 * ellipsized by its block container like the text it holds. No HTML string
 * is built, so there is nothing to sanitize.
 *
 * Laws: [L06] appearance is CSS (`tug-inline-markdown.css`); [L19] component
 * authoring guide.
 *
 * @module components/tugways/tug-inline-markdown
 */

import "./tug-inline-markdown.css";

import React from "react";

import { inlineMarkdownRuns, type InlineMarkdownRun } from "@/lib/inline-markdown-runs";
import { cn } from "@/lib/utils";

function renderRuns(runs: readonly InlineMarkdownRun[]): React.ReactNode[] {
  return runs.map((run, i) => {
    switch (run.kind) {
      case "text":
        return <React.Fragment key={i}>{run.text}</React.Fragment>;
      case "code":
        return (
          <code key={i} className="tug-inline-markdown-code">
            {run.text}
          </code>
        );
      case "strong":
        return (
          <strong key={i} className="tug-inline-markdown-strong">
            {renderRuns(run.children)}
          </strong>
        );
      case "em":
        return (
          <em key={i} className="tug-inline-markdown-em">
            {renderRuns(run.children)}
          </em>
        );
    }
  });
}

export interface TugInlineMarkdownProps extends Omit<React.ComponentPropsWithoutRef<"span">, "children"> {
  /** The line, in inline markdown. */
  text: string;
}

export const TugInlineMarkdown = React.forwardRef<HTMLSpanElement, TugInlineMarkdownProps>(
  function TugInlineMarkdown({ text, className, ...rest }, ref) {
    const nodes = React.useMemo(() => renderRuns(inlineMarkdownRuns(text)), [text]);
    return (
      <span {...rest} ref={ref} data-slot="tug-inline-markdown" className={cn("tug-inline-markdown", className)}>
        {nodes}
      </span>
    );
  },
);
