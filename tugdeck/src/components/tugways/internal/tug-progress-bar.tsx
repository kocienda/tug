/**
 * TugProgressBar — Internal building block for the horizontal progress bar.
 *
 * App code should use {@link TugProgressIndicator} instead.
 *
 * Renders a track with a fill region.
 *
 * State semantics:
 *   running   — value undefined: barber-pole indeterminate fill animation.
 *               value set: fill drawn at fraction.
 *   paused    — animation paused at current pose.
 *   stopped   — fill hidden (zero width); only the track is visible.
 *   completed — fill at 100%.
 *   aborted   — fill drawn at value (if any) or hidden; danger tint comes
 *               from the parent via `--tugx-progress-indicator-fill`.
 *
 * Track height: `--tugx-progress-indicator-size` (parent-set). Width fills
 * the parent container.
 *
 * Color is inherited from the parent's `--tugx-progress-indicator-fill`.
 * Track uses `--tug7-surface-progress-primary-normal-default-rest`.
 *
 * # The painted seam
 *
 * The fill's width is a CSS `calc` over a custom property rather than an
 * inline `width`, which is what lets a value that moves a hundred times a
 * download be drawn without a render ([B07]). A caller that passes `value`
 * gets `--tugx-progress-bar-prop-value` written inline here and notices
 * nothing. A caller that owns a fast-moving value instead writes
 * `--tugx-progress-indicator-value` (0…1) on the indicator root from its own
 * store subscription, plus `data-painted` to take the barber pole off — the
 * two never both apply, because a caller either passes the value or paints
 * it. See `tug-progress-bar.css`.
 *
 * Laws: [L06] fill width via inline style, [L13] CSS keyframes only,
 *       [L16] pairings declared, [L19] component authoring guide
 */

import React, { useRef, useLayoutEffect } from "react";
import { cn } from "@/lib/utils";
import "./tug-progress-bar.css";
import type { TugProgressIndicatorState } from "../tug-progress-indicator";

export interface TugProgressBarProps {
  /** Determinate progress value, 0 to max. Undefined = indeterminate. */
  value?: number;
  /** Maximum value. @default 1 */
  max?: number;
  /** Track height in CSS px. @default 6 */
  size?: number;
  /** Lifecycle state. @default "running" */
  state?: TugProgressIndicatorState;
  /** When true, opacity dims and animation freezes. */
  disabled?: boolean;
  /** Additional CSS class names. */
  className?: string;
}

export const TugProgressBar = React.forwardRef<HTMLDivElement, TugProgressBarProps>(
  function TugProgressBar(
    { value, max = 1, size = 6, state = "running", disabled = false, className },
    ref,
  ) {
    const isDeterminate = value !== undefined;
    const fraction = isDeterminate
      ? Math.min(Math.max(value / max, 0), 1)
      : 0;

    let widthFraction: number | undefined;
    if (state === "completed") {
      widthFraction = 1;
    } else if (state === "stopped") {
      widthFraction = 0;
    } else if (isDeterminate) {
      widthFraction = fraction;
    } else if (state === "aborted") {
      widthFraction = 0;
    }

    const isIndeterminate =
      !isDeterminate && (state === "running" || state === "paused");

    // Suppress the width transition whenever the fill would otherwise animate
    // BACKWARD: the indeterminate → determinate switch, or any *decrease* in
    // width — a reset to 0 for a new operation, or a completed → running
    // restart. Progress should snap to its new (lower) value, never slide
    // down: a slide-down reads as "un-progressing," and (for a reused bar
    // that retains its last full fill) as the new operation starting full and
    // emptying. Forward growth keeps the smooth 300ms transition. [L06]
    const prevDeterminateRef = useRef(isDeterminate);
    const prevWidthRef = useRef(widthFraction);
    const fillRef = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
      const wasDeterminate = prevDeterminateRef.current;
      const prevWidth = prevWidthRef.current;
      prevDeterminateRef.current = isDeterminate;
      prevWidthRef.current = widthFraction;

      const switchedToDeterminate = !wasDeterminate && isDeterminate;
      const decreased =
        prevWidth !== undefined &&
        widthFraction !== undefined &&
        widthFraction < prevWidth;
      if ((switchedToDeterminate || decreased) && fillRef.current) {
        fillRef.current.style.transition = "none";
        requestAnimationFrame(() => {
          if (fillRef.current) {
            fillRef.current.style.transition = "";
          }
        });
      }
    }, [isDeterminate, widthFraction]);

    const sizeStyle: React.CSSProperties = {
      height: `${size}px`,
    };

    return (
      <div
        ref={ref}
        data-slot="tug-progress-bar"
        data-state={state}
        aria-hidden="true"
        style={sizeStyle}
        className={cn(
          "tug-progress-bar-track",
          state === "paused" && "tug-progress-bar-paused",
          disabled && "tug-progress-bar-disabled",
          className,
        )}
      >
        <div
          ref={fillRef}
          className={cn(
            "tug-progress-bar-fill",
            isIndeterminate && state === "running" && "tug-progress-bar-indeterminate",
          )}
          style={
            widthFraction !== undefined
              ? ({
                  ["--tugx-progress-bar-prop-value" as string]: String(widthFraction),
                } as React.CSSProperties)
              : undefined
          }
        />
      </div>
    );
  },
);
