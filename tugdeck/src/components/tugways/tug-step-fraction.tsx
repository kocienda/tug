/**
 * TugStepFraction — step progress as counters, at caption weight.
 *
 * The ring's numerate companion where a row has the width for six characters.
 * Mono, so a column of them aligns.
 *
 * Laws: [L19] `.tsx`/`.css` pair, `data-slot`; [L20] owns
 * `--tugx-step-fraction-*`, whose default sits at its point of use so a host
 * line set at a reading scale can raise it.
 *
 * @module components/tugways/tug-step-fraction
 */

import "./tug-step-fraction.css";

import React from "react";

export function TugStepFraction({
  current,
  total,
}: {
  current: number;
  total: number;
}): React.ReactElement {
  return (
    <span
      className="tug-step-fraction"
      data-slot="tug-step-fraction"
      aria-label={`step ${current} of ${total}`}
    >
      <span className="tug-step-fraction-i">{current}</span>
      <span className="tug-step-fraction-slash">/</span>
      <span className="tug-step-fraction-n">{total}</span>
    </span>
  );
}
