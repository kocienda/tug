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

import React from "react";

export function TugMetaRun({
  children,
  parts,
  separator = "gap",
  slot = "tug-meta-run",
  className,
}: {
  children?: React.ReactNode;
  /**
   * A fixed list of facts, some of which may be absent. Nulls are dropped and
   * a {@link TugMetaBullet} goes between whatever survives — so a run whose
   * middle fact is missing does not show two bullets in a row, and a caller
   * never writes `a !== null && b !== null ? bullet : null`. That expression
   * is correct exactly until someone adds a fourth fact.
   *
   * Use `children` instead when the facts are not a list: the dash lane
   * interleaves conditional fragments, some of which carry their own bullets
   * and one of which (a step's title) deliberately has none.
   *
   * Each surviving part must be an **element**, not a bare string. A string
   * lands as an anonymous flex item, which no selector can reach — so the rule
   * that keeps facts atomic would silently skip it and that one fact would wrap
   * mid-phrase while its neighbours held.
   */
  parts?: ReadonlyArray<React.ReactNode>;
  /**
   * How the caller has already separated the parts: `"gap"` for parts that
   * stand apart on space alone (or carry a separator inside their own text),
   * `"bullet"` for a caller emitting {@link TugMetaBullet} between them.
   */
  separator?: "gap" | "bullet";
  slot?: string;
  className?: string;
}): React.ReactElement {
  const present =
    parts === undefined
      ? null
      : parts.filter((part) => part !== null && part !== undefined && part !== false);
  return (
    <span
      className={
        className !== undefined ? `tug-meta-run ${className}` : "tug-meta-run"
      }
      data-slot={slot}
      data-separator={present !== null ? "bullet" : separator}
    >
      {present !== null
        ? present.map((part, index) => (
            // Index keys: the list is positional and fixed per render — there
            // is no identity here to key on and nothing reorders.
            <React.Fragment key={index}>
              {index > 0 ? <TugMetaBullet /> : null}
              {part}
            </React.Fragment>
          ))
        : children}
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
