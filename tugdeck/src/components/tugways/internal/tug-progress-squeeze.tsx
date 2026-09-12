/**
 * TugProgressSqueeze — Internal building block for the squeeze glyph.
 *
 * App code should use {@link TugProgressIndicator} instead.
 *
 * A full-width track with one centred band inside it. When
 * `state === "running"` the band breathes: it fills the track, presses in to
 * about 40 percent of it, and opens back out, on a continuous 2000ms loop —
 * the pulsing dot's period, so the two indeterminate marks in the app beat
 * together.
 *
 * What it is FOR is compaction. Every other indeterminate glyph in the set
 * says "something is running" and nothing more: a barber pole travels, a wave
 * pulses, a spinner turns. A `/compact` is a particular something — context
 * being pressed smaller — and the band pressing in from both sides is that
 * operation drawn rather than named. It reads at two sizes without changing
 * shape, which is what lets a compaction hand itself between a cover panel's
 * bar and a folded card's 20px mark: the band shrinks into the mark and grows
 * back out of it.
 *
 * State semantics:
 *   running   — the band breathes (CSS animation).
 *   paused    — frozen mid-pose (`animation-play-state`).
 *   stopped   — band at rest, filling the track; no animation.
 *   completed — band at its pressed extent, which is what the operation
 *               leaves behind.
 *   aborted   — band at rest; danger tint from the parent.
 *
 * Laws: [L02] state arrives via props from the parent indicator;
 *       [L06] state drives `data-state` on the root; the running breath is a
 *       CSS @keyframes loop gated on `[data-state="running"]`;
 *       [L13] a continuous animation lives in CSS `@keyframes`, not
 *       TugAnimator. Motion-off zeroes it via the global
 *       `body[data-tug-motion="off"]` duration rule, resting the band at its
 *       seeded pose.
 *
 * @module components/tugways/internal/tug-progress-squeeze
 */

import "./tug-progress-squeeze.css";

import React from "react";

import { cn } from "@/lib/utils";
import type { TugProgressIndicatorState } from "../tug-progress-indicator";

/** How far in the band presses at the breath's tightest. Exported for tests. */
export const SQUEEZE_TO = 0.4;

/**
 * The band's `scaleX` for a static state. Rest is the open pose, and it equals
 * the running loop's 0% keyframe so the animation starts without a jump;
 * `completed` is the pressed pose, because that is what a finished compaction
 * left behind. Exported for tests.
 */
export function staticScale(state: TugProgressIndicatorState): number {
  return state === "completed" ? SQUEEZE_TO : 1;
}

export interface TugProgressSqueezeProps {
  /** Track height in CSS px. @default 6 */
  size?: number;
  /** Lifecycle state. @default "running" */
  state?: TugProgressIndicatorState;
  /** When true, opacity dims and the breath freezes. */
  disabled?: boolean;
  /** Additional CSS class names. */
  className?: string;
}

export const TugProgressSqueeze = React.forwardRef<
  HTMLSpanElement,
  TugProgressSqueezeProps
>(function TugProgressSqueeze(
  { size = 6, state = "running", disabled = false, className },
  forwardedRef,
) {
  return (
    <span
      ref={forwardedRef}
      data-slot="tug-progress-squeeze"
      data-state={state}
      aria-hidden="true"
      style={{ height: `${size}px` }}
      className={cn(
        "tug-progress-squeeze",
        disabled && "tug-progress-squeeze-disabled",
        className,
      )}
    >
      <span
        className="tug-progress-squeeze-band"
        // Seed the band's static pose, for the same reason the wave seeds its
        // bars: it renders on first paint, holds for every non-running state,
        // and matches the loop's 0% keyframe so running does not jump.
        style={{ transform: `scaleX(${staticScale(state)})` }}
      />
    </span>
  );
});
