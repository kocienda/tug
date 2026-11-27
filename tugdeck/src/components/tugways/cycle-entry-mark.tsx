/**
 * CycleEntryMark — how a cycle's entry stands, at the trailing edge of its
 * row: a Joined badge, the running arc's lifecycle mark, a Ready badge, or a
 * Dropped badge in whatever ink its row gives it.
 *
 * A waiting entry has no mark; what it waits on says it. A running entry
 * draws the arc's own lifecycle mark from the model the host hands it, so
 * the row and the arc's other faces read one phase; with no model it says
 * Running in a badge. The mark is a reading and holds no control: nothing
 * here starts an entry.
 *
 * Composes `TugBadge` and `ArcLifecycleMark`, which keep their own tokens;
 * the mark's CSS is its box alone.
 *
 * Laws: [L06] state is a `data-*`, [L16] no pairings of its own,
 *       [L19] component authoring guide, [L20] composed children keep theirs
 *
 * @module components/tugways/cycle-entry-mark
 */

import "./cycle-entry-mark.css";

import React from "react";

import { cn } from "@/lib/utils";

import { ArcLifecycleMark } from "./arc-lifecycle-mark";
import type { CycleMapTileState } from "./cycle-map";
import type { ArcTrackModel } from "./tug-arc-track";
import { TugBadge } from "./tug-badge";

export interface CycleEntryMarkProps extends Omit<React.ComponentPropsWithoutRef<"span">, "children"> {
  /**
   * How the entry stands.
   * @selector .tug-cycle-entry-mark[data-state="joined" | "running" | "dropped" | "ready"]
   */
  state: CycleMapTileState;
  /** The running arc's track model. Read only while `state` is `running`. */
  model?: ArcTrackModel | null;
  /** The arc's name, for the lifecycle mark's accessible sentence. */
  name?: string;
}

export const CycleEntryMark = React.forwardRef<HTMLSpanElement, CycleEntryMarkProps>(function CycleEntryMark(
  { state, model, name, className, ...rest },
  ref,
) {
  if (state === "waiting") return null;
  return (
    <span
      ref={ref}
      data-slot="tug-cycle-entry-mark"
      className={cn("tug-cycle-entry-mark", className)}
      {...rest}
      data-state={state}
    >
      {state === "joined" ? (
        <TugBadge size="xs" emphasis="ghost" role="success">
          Joined
        </TugBadge>
      ) : state === "ready" ? (
        <TugBadge size="xs" emphasis="tinted" role="action">
          Ready
        </TugBadge>
      ) : state === "dropped" ? (
        <TugBadge size="xs" emphasis="ghost" role="inherit">
          Dropped
        </TugBadge>
      ) : model != null ? (
        <ArcLifecycleMark model={model} name={name} size="rail" showWord />
      ) : (
        <TugBadge size="xs" emphasis="ghost" role="accent">
          Running
        </TugBadge>
      )}
    </span>
  );
});
