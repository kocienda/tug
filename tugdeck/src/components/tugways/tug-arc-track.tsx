/**
 * TugArcTrack — an arc's whole life as one cap-height strip.
 *
 * Five cells in lifecycle order — brief · devise · review · implement · join —
 * with implement subdivided into one tick per plan step. That is a planned arc.
 * A plain arc — the short one — is brief · implement · join: the two cells a
 * settling would have filled are the ones it never had. Each cell wears one of
 * four states the CSS paints ([L06]): `pending`, `active`, `done`, `stopped`.
 * A stop is the one fact that outranks the rest: the cell it stopped in paints
 * danger and its tooltip says why, in the arc receipt's own words.
 *
 * The strip is the height of the line's cap, so it rides any line box an atom
 * already sits on — the masthead's title line, the rail's meta line, the
 * transcript footer's status cell — without growing it. The ring beside it
 * stays the session's own indicator; this is the arc's.
 *
 * The model is derived, never sent: {@link arcTrackModel} reads the fields
 * the changeset feed already carries — `documents`, `arc`, `steps`, `stage` —
 * and {@link arcTrackModelFromEntry} adapts a wire entry to it. Both are pure
 * and live in `lib/arc-track-model.ts`, which this module re-exports, so the
 * derivation is a table test rather than a DOM one.
 *
 * Laws: [L06] state is `data-state`; [L19] `.tsx`/`.css` pair, `data-slot`;
 * [L20] composes `TugTooltip`, owns `--tugx-arc-track-*`.
 *
 * @module components/tugways/tug-arc-track
 */

import "./tug-arc-track.css";

import React from "react";

import { TugTooltip } from "./tug-tooltip";
import { useMotionHold, useOffscreenPause } from "@/lib/motion-guard";
import {
  ARC_PHASES,
  DIRECT_PHASES,
  arcCellState,
  arcCellTip,
  tickState,
  type ArcPhase,
  type ArcTrackModel,
} from "@/lib/arc-track-model";

export {
  ARC_CELL_WIDEST_FRACTION,
  ARC_CELL_WIDEST_WORD,
  ARC_PHASES,
  arcCellRestClause,
  arcCellState,
  arcCellTip,
  arcCellWord,
  arcReading,
  arcSessionPurpose,
  arcTrackModel,
  arcTrackModelFromEntry,
  arcTrackSteps,
  tickState,
} from "@/lib/arc-track-model";
export type {
  ArcCellState,
  ArcPhase,
  ArcReading,
  ArcTickState,
  ArcTrackInput,
  ArcTrackModel,
  ArcTrackSteps,
} from "@/lib/arc-track-model";

export interface TugArcTrackProps {
  model: ArcTrackModel;
  "aria-label"?: string;
}

export function TugArcTrack({
  model,
  "aria-label": ariaLabel,
}: TugArcTrackProps): React.ReactElement {
  // The track draws the phases the arc has, never the six with two struck
  // out: a plain arc did not skip devise and review, it never had them. It
  // did have a brief, so it draws one.
  const phases: readonly ArcPhase[] = model.planned ? ARC_PHASES : DIRECT_PHASES;
  // A track that is not stopped always has one cell or tick breathing — the
  // phase in hand, or the step in hand (`tug-arc-track.css`) — and the
  // motion registry hears it ([D7]).
  useMotionHold(model.stopped === null);
  // And it is stilled while it is out of its scroller's view
  // (`lib/motion-guard/offscreen.ts`).
  const rootRef = React.useRef<HTMLSpanElement | null>(null);
  useOffscreenPause(rootRef, model.stopped === null);
  return (
    <span
      ref={rootRef}
      className="tug-arc-track"
      data-slot="tug-arc-track"
      data-phase={model.phase}
      data-direct={model.direct ? "true" : undefined}
      data-stopped={model.stopped !== null ? "true" : undefined}
      aria-label={ariaLabel ?? arcCellTip(model, model.phase, arcCellState(model, model.phase))}
    >
      {phases.map((phase) => {
        const state = arcCellState(model, phase);
        const ticks =
          phase === "implement" && model.steps !== null
            ? Array.from({ length: model.steps.total }, (_, i) => i + 1)
            : null;
        return (
          <TugTooltip key={phase} content={arcCellTip(model, phase, state)}>
            <span
              className="tug-arc-track-cell"
              data-slot="tug-arc-track-cell"
              data-phase={phase}
              data-state={state}
              data-steps={ticks !== null ? "true" : undefined}
            >
              {ticks !== null
                ? ticks.map((n) => (
                    <span key={n} className="tug-arc-track-tick" data-state={tickState(model, n)} />
                  ))
                : null}
            </span>
          </TugTooltip>
        );
      })}
    </span>
  );
}
