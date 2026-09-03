/**
 * TugProgressRing — Internal building block for the circular arc progress glyph.
 *
 * App code should use {@link TugProgressIndicator} instead.
 *
 * Renders an SVG ring with a background track and a foreground arc. The arc
 * starts at 12 o'clock via a -90deg rotation on the SVG.
 *
 * State semantics:
 *   running   — value undefined: indeterminate rotating partial arc.
 *               value set: arc drawn at fraction, no rotation.
 *   paused    — animation-play-state paused; current pose held.
 *   stopped   — arc hidden; only the track outline is visible (quiescent).
 *   completed — closed circle drawn in the indicator fill color (no break).
 *   aborted   — arc drawn at value (if any) or hidden; the danger tint comes
 *               from the parent via `--tugx-progress-indicator-fill`.
 *
 * Color is inherited from the parent's `--tugx-progress-indicator-fill`.
 * Track uses `--tug7-surface-progress-primary-normal-default-rest`.
 *
 * Laws: [L06] arc offset via inline style, [L13] CSS keyframes only,
 *       [L16] pairings declared, [L19] component authoring guide
 */

import React, { useRef, useLayoutEffect } from "react";
import { cn } from "@/lib/utils";
import "./tug-progress-ring.css";
import type { TugProgressIndicatorState } from "../tug-progress-indicator";

export interface TugProgressRingProps {
  /** Determinate progress value, 0 to max. Undefined = indeterminate. */
  value?: number;
  /** Maximum value. @default 1 */
  max?: number;
  /** Diameter in CSS px. @default 16 */
  size?: number;
  /** Lifecycle state. @default "running" */
  state?: TugProgressIndicatorState;
  /** When true, opacity dims and animation freezes. */
  disabled?: boolean;
  /** Additional CSS class names. */
  className?: string;
}

const STROKE_WIDTH = 3;
const RADIUS = 16 - STROKE_WIDTH / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const INDETERMINATE_VISIBLE_OFFSET = CIRCUMFERENCE * 0.75;

export const TugProgressRing = React.forwardRef<HTMLSpanElement, TugProgressRingProps>(
  function TugProgressRing(
    { value, max = 1, size = 16, state = "running", disabled = false, className },
    ref,
  ) {
    const isDeterminate = value !== undefined;
    const fraction = isDeterminate
      ? Math.min(Math.max(value / max, 0), 1)
      : 0;

    // State decides the arc length:
    //   completed → full closed circle (offset 0)
    //   stopped / aborted (with no value) → hidden arc (offset = circumference)
    //   determinate → fraction
    //   running indeterminate → handled by .indeterminate animation
    let arcOffset: number | undefined;
    if (state === "completed") {
      arcOffset = 0;
    } else if (state === "stopped") {
      arcOffset = CIRCUMFERENCE;
    } else if (isDeterminate) {
      arcOffset = CIRCUMFERENCE * (1 - fraction);
    } else if (state === "aborted") {
      arcOffset = CIRCUMFERENCE;
    }

    const isIndeterminate =
      !isDeterminate && (state === "running" || state === "paused");

    // Suppress the dashoffset transition when switching modes [L06].
    const prevDeterminateRef = useRef(isDeterminate);
    const arcRef = useRef<SVGCircleElement>(null);

    useLayoutEffect(() => {
      const wasDeterminate = prevDeterminateRef.current;
      prevDeterminateRef.current = isDeterminate;

      if (!wasDeterminate && isDeterminate && arcRef.current) {
        arcRef.current.style.transition = "none";
        requestAnimationFrame(() => {
          if (arcRef.current) {
            arcRef.current.style.transition = "";
          }
        });
      }
    }, [isDeterminate]);

    const sizeStyle: React.CSSProperties = {
      width: `${size}px`,
      height: `${size}px`,
    };

    return (
      <span
        ref={ref}
        data-slot="tug-progress-ring"
        data-state={state}
        aria-hidden="true"
        style={sizeStyle}
        className={cn(
          "tug-progress-ring",
          isIndeterminate && state === "running" && "tug-progress-ring-indeterminate",
          state === "paused" && "tug-progress-ring-paused",
          disabled && "tug-progress-ring-disabled",
          className,
        )}
      >
        <svg className="tug-progress-ring-svg" viewBox="0 0 32 32">
          <circle
            className="tug-progress-ring-track"
            cx="16"
            cy="16"
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE_WIDTH}
          />
          <circle
            ref={arcRef}
            className="tug-progress-ring-arc"
            cx="16"
            cy="16"
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE_WIDTH}
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={
              isIndeterminate && !isDeterminate
                ? INDETERMINATE_VISIBLE_OFFSET
                : arcOffset
            }
            strokeLinecap="round"
          />
        </svg>
      </span>
    );
  },
);
