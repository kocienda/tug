/**
 * `TugMetaRun` — the small facts that follow a row's name.
 *
 * A row names one thing and then says a few short things about it: a file's
 * `edit · exact`, a dash's `main · 4 rounds · uncommitted · implementing`. The
 * grammar is one rule dividing the name from its facts, the facts separated
 * from each other, and small proportional type throughout — proportional
 * because these are read as a sentence about the row rather than as
 * identifiers to be typed back. The name ahead of the rule is the run somebody
 * copies, and it keeps its own family.
 *
 * **Parts are atomic.** A run lives on a line that is allowed to get narrow,
 * and a fact that shrinks below its own text wraps mid-phrase — "4 / rounds",
 * "step / 2/5". A fact is legible whole or it should not be on the line, so
 * every child holds its width. A host with one run of prose in the mix (a step
 * title, a commit subject) opts that one child back into giving way; nothing
 * else does.
 *
 * **Two ways to separate the facts, and the run has to be told which.** Some
 * hosts hand over parts that already carry their own separator inside a string
 * ({@link TugMetaRun} cannot style what it cannot see); others emit
 * {@link TugMetaBullet} between parts. The bullets take space on both sides
 * from the flex gap, so the two need different gaps to land on the same
 * rhythm. That is what `separator` says — not what the run should draw, but
 * what the caller has already drawn.
 *
 * Laws: [L19] file pair, docblock, `data-slot`; [L20] owns `--tugx-meta-run-*`
 * and composes no other component's tokens.
 *
 * @module components/tugways/tug-meta-run
 */

import "./tug-meta-run.css";

import type React from "react";

export function TugMetaRun({
  children,
  separator = "gap",
  slot = "tug-meta-run",
  className,
}: {
  children: React.ReactNode;
  /**
   * How the caller has already separated the parts: `"gap"` for parts that
   * stand apart on space alone (or carry a separator inside their own text),
   * `"bullet"` for a caller emitting {@link TugMetaBullet} between them.
   */
  separator?: "gap" | "bullet";
  slot?: string;
  className?: string;
}): React.ReactElement {
  return (
    <span
      className={
        className !== undefined ? `tug-meta-run ${className}` : "tug-meta-run"
      }
      data-slot={slot}
      data-separator={separator}
    >
      {children}
    </span>
  );
}

/** The interpunct between two facts. Decorative: it separates, it says nothing. */
export function TugMetaBullet(): React.ReactElement {
  return (
    <span className="tug-meta-run-bullet" aria-hidden="true">
      ·
    </span>
  );
}
