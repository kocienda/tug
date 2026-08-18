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
 * **A run never paints outside its own box.** The parts are atomic, so a run
 * that will not fit cannot shrink — and on a row whose leading and trailing
 * slots are fixed, the overflow lands on top of the trailing controls. `fit`
 * says what a run does when the line runs out: `"natural"` takes the width its
 * parts need (correct where the run is sized by its content — a right-aligned
 * tail in the Lens), `"clip"` bounds it to the box and fades the last visible
 * fact out. The fade is self-gating: it covers the trailing edge of the BOX, so
 * a run that fits is fading empty space and nothing shows.
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
  fit = "natural",
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
  /**
   * What the run does when its parts need more room than the line has.
   * `"natural"` takes the width they need; `"clip"` bounds the run to its box
   * and fades out at the trailing edge. Use `"clip"` on any row where the run
   * shares a line with slotted controls — there is nothing else stopping it
   * painting over them.
   */
  fit?: "natural" | "clip";
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
      data-fit={fit}
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
