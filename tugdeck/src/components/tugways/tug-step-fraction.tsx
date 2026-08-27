/**
 * TugStepFraction — step progress as counters, at caption weight.
 *
 * The ring's numerate companion where a row has the width for six characters.
 * Mono, so a column of them aligns.
 *
 * It forwards its ref so a host can hang a tooltip on it: the lifecycle line
 * names the step in hand there rather than setting the title as a run ([D168]),
 * and Radix's `asChild` trigger needs the element the ref resolves to.
 *
 * Laws: [L19] `.tsx`/`.css` pair, `data-slot`; [L20] owns
 * `--tugx-step-fraction-*`, whose default sits at its point of use so a host
 * line set at a reading scale can raise it.
 *
 * @module components/tugways/tug-step-fraction
 */

import "./tug-step-fraction.css";

import React from "react";

export const TugStepFraction = React.forwardRef<
  HTMLSpanElement,
  { current: number; total: number }
>(function TugStepFraction({ current, total }, ref) {
  return (
    <span
      ref={ref}
      className="tug-step-fraction"
      data-slot="tug-step-fraction"
      aria-label={`step ${current} of ${total}`}
    >
      <span className="tug-step-fraction-i">{current}</span>
      <span className="tug-step-fraction-slash">/</span>
      <span className="tug-step-fraction-n">{total}</span>
    </span>
  );
});
