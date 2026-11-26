/**
 * CycleWaits — a short run of entry numbers behind a word, each number worn
 * as the chip its tile wears on the cycle map.
 *
 * An entry's row uses it for what the entry waits on ("Waits on 2 3"), and a
 * sketch's row for the entries that came from it ("Heads 1 4"). A number
 * that is met draws in the joined tone with a check. Presentational: the
 * host says which numbers and which are met. It renders nothing when there
 * are no numbers.
 *
 * Laws: [L06] met is a `data-*` the CSS paints, [L16] pairings declared,
 *       [L19] component authoring guide, [L20] owns `--tugx-cycle-waits-*`
 *
 * @module components/tugways/cycle-waits
 */

import "./cycle-waits.css";

import React from "react";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

/** One number in the run. */
export interface CycleWaitsItem {
  n: number;
  /**
   * The entry of this number has joined.
   * @selector .tug-cycle-waits-chip[data-met]
   */
  met?: boolean;
}

export interface CycleWaitsProps extends Omit<React.ComponentPropsWithoutRef<"span">, "children"> {
  /** The word before the numbers: "Waits on", "Heads". */
  label: string;
  items: readonly CycleWaitsItem[];
  /**
   * Draw a check in each met chip. A run whose every number is met by
   * definition, as a sketch's heads are, leaves it out.
   * @default true
   */
  checks?: boolean;
}

export const CycleWaits = React.forwardRef<HTMLSpanElement, CycleWaitsProps>(function CycleWaits(
  { label, items, checks = true, className, ...rest },
  ref,
) {
  if (items.length === 0) return null;
  return (
    <span ref={ref} data-slot="tug-cycle-waits" className={cn("tug-cycle-waits", className)} {...rest}>
      <span className="tug-cycle-waits-label">{label}</span>
      {items.map((item) => (
        <span key={item.n} className="tug-cycle-waits-chip" data-met={item.met ? "" : undefined}>
          {item.n}
          {item.met && checks ? <Check size={10} aria-hidden /> : null}
        </span>
      ))}
    </span>
  );
});
