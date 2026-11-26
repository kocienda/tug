/**
 * CycleSeal — a sketch's letter in a small ring: the cycle map's seal, at the
 * size that leads a row.
 *
 * Presentational and not pressable. The row it leads is the control; the
 * seal only says which sketch the row is.
 *
 * Laws: [L06] no state of its own, [L16] pairings declared,
 *       [L19] component authoring guide, [L20] owns `--tugx-cycle-seal-*`
 *
 * @module components/tugways/cycle-seal
 */

import "./cycle-seal.css";

import React from "react";

import { cn } from "@/lib/utils";

export interface CycleSealProps extends Omit<React.ComponentPropsWithoutRef<"span">, "children"> {
  /** The sketch's letter on its cycle. */
  letter: string;
}

export const CycleSeal = React.forwardRef<HTMLSpanElement, CycleSealProps>(function CycleSeal(
  { letter, className, ...rest },
  ref,
) {
  return (
    <span ref={ref} data-slot="tug-cycle-seal" className={cn("tug-cycle-seal", className)} {...rest}>
      {letter}
    </span>
  );
});
