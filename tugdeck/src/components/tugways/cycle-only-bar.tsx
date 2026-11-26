/**
 * CycleOnlyBar — the way back, under a cycle map whose list is narrowed to
 * the assets selected on it.
 *
 * It says how many assets are showing and how to change that, and holds one
 * Back button. Selection is the host's, as it is for `CycleMap`: the bar
 * reports the press and the host clears its set. A host shows the bar only
 * while two or more assets are selected.
 *
 * Composes `TugPushButton` and `TugLabel`, which keep their own tokens. The
 * bar paints no ground, border or padding of its own; those are the host's,
 * through the host's own class.
 *
 * Laws: [L06] no appearance state, [L11] the bar reports a press and the
 *       host owns the selection it clears, [L16] no pairings of its own,
 *       [L19] component authoring guide, [L20] composed children keep theirs
 *
 * @module components/tugways/cycle-only-bar
 */

import "./cycle-only-bar.css";

import React from "react";

import { cn } from "@/lib/utils";

import { TugLabel } from "./tug-label";
import { TugPushButton } from "./tug-push-button";

export interface CycleOnlyBarProps extends Omit<React.ComponentPropsWithoutRef<"div">, "children"> {
  /** How many assets are selected, and so showing. */
  count: number;
  /** A press on Back: the host clears its selection. */
  onBack: () => void;
}

export const CycleOnlyBar = React.forwardRef<HTMLDivElement, CycleOnlyBarProps>(function CycleOnlyBar(
  { count, onBack, className, ...rest },
  ref,
) {
  return (
    <div ref={ref} data-slot="tug-cycle-only-bar" className={cn("tug-cycle-only-bar", className)} {...rest}>
      <TugPushButton size="2xs" subtype="text" emphasis="outlined" onClick={onBack}>
        Back
      </TugPushButton>
      <TugLabel size="2xs" emphasis="calm">
        {`Showing ${count} · Shift-click to add or remove, click the map's ground to clear`}
      </TugLabel>
    </div>
  );
});
