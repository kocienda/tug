/**
 * TugProgressWave — Internal building block for the three-bar wave glyph.
 *
 * App code should use {@link TugProgressIndicator} instead.
 *
 * Three vertical bars rendered as a tight horizontal stack. When
 * `state === "running"`, the bars pulse in staggered sequence: each bar
 * runs a continuous `scaleY` @keyframes loop (`tugx-progress-wave-0/1/2`,
 * selected by sibling position) whose stops trace an ease-in-out pulse
 * from a rest pose to a peak pose. The three loops share one 960ms period
 * so the wave silhouette stays phase-locked.
 *
 * State semantics:
 *   running   — bars pulse in staggered cycles (CSS animation).
 *   paused    — bars hold at rest pose; no animation.
 *   stopped   — bars static at the short-long-short rest pose.
 *   completed — bars static at peak pose (all tall).
 *   aborted   — bars static at rest pose; danger tint from the parent.
 *
 * Laws: [L02] state arrives via props from the parent indicator;
 *       [L06] state drives `data-state` on the root; the running pulse is
 *       a CSS @keyframes loop gated on `[data-state="running"]`;
 *       [L13] a continuous animation lives in CSS `@keyframes`, not
 *       TugAnimator. Motion-off zeroes it via the global
 *       `body[data-tug-motion="off"]` duration rule, resting the bars at
 *       their seeded pose;
 *       [L19] component authoring guide.
 *
 * @module components/tugways/internal/tug-progress-wave
 */

import "./tug-progress-wave.css";

import React from "react";

import { cn } from "@/lib/utils";
import type { TugProgressIndicatorState } from "../tug-progress-indicator";

const BAR_COUNT = 3;
const SHRINK_TO = 0.5;
const SIDE_BAR_RATIO = 0.5;
const BAR_WIDTH_RATIO = 0.15;
const GAP_TO_WIDTH_RATIO = 0.8;

/** Gap (px) between bars given a bar width (px). Exported for tests. */
export function gapForBarWidth(barWidthPx: number): number {
  return barWidthPx * GAP_TO_WIDTH_RATIO;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Resolve the per-bar (rest, peak) scaleY pair. The middle bar (index 1)
 * sits at 1.0 and dips to `SHRINK_TO` at the pulse peak; the outer bars
 * (index 0, 2) sit at `SIDE_BAR_RATIO` and grow toward 1.0. The inverse
 * motion produces the "wave" silhouette. Exported for tests.
 */
export function barScales(index: number): { restScale: number; peakScale: number } {
  if (index === 1) return { restScale: 1, peakScale: clamp01(SHRINK_TO) };
  return { restScale: clamp01(SIDE_BAR_RATIO), peakScale: 1 };
}

/**
 * Per-bar pose for static states. Rest pose = short-long-short; peak
 * pose (`completed`) = all bars at 1.0. Exported for tests.
 */
export function staticScale(index: number, state: TugProgressIndicatorState): number {
  if (state === "completed") return 1;
  return barScales(index).restScale;
}

export interface TugProgressWaveProps extends Omit<React.ComponentPropsWithoutRef<"span">, "children"> {
  /** Bar height in CSS px. @default 16 */
  size?: number;
  /** Lifecycle state. @default "running" */
  state?: TugProgressIndicatorState;
  /** When true, opacity dims. */
  disabled?: boolean;
}

export const TugProgressWave = React.forwardRef<
  HTMLSpanElement,
  TugProgressWaveProps
>(function TugProgressWave(
  { size = 16, state = "running", disabled = false, className, style, ...rest },
  forwardedRef,
) {
  const barWidthPx = size * BAR_WIDTH_RATIO;
  const barGapPx = gapForBarWidth(barWidthPx);
  const rootStyle: React.CSSProperties = {
    ["--tugx-progress-wave-size" as string]: `${size}px`,
    ["--tugx-progress-wave-bar-width" as string]: `${barWidthPx}px`,
    ["--tugx-progress-wave-bar-gap" as string]: `${barGapPx}px`,
  };

  return (
    <span
      ref={forwardedRef}
      data-slot="tug-progress-wave"
      data-state={state}
      aria-hidden="true"
      {...rest}
      style={{ ...rootStyle, ...style }}
      className={cn(
        "tug-progress-wave",
        disabled && "tug-progress-wave-disabled",
        className,
      )}
    >
      {Array.from({ length: BAR_COUNT }).map((_, i) => {
        const restScale = staticScale(i, state);
        return (
          <span
            key={i}
            className="tug-progress-wave-bar"
            // Seed the bar's static pose. It renders on first paint, holds
            // for the non-running states, and equals the running loop's
            // 0% keyframe (rest) so the animation starts without a jump.
            style={{ transform: `scaleY(${restScale})` }}
          />
        );
      })}
    </span>
  );
});
