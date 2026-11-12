/**
 * TugProgressPie — Internal building block for the filled pie wedge glyph.
 *
 * App code should use {@link TugProgressIndicator} instead.
 *
 * Renders a circular div with conic-gradient that fills clockwise from
 * 12 o'clock.
 *
 * State semantics:
 *   running   — value undefined: 25% wedge rotates continuously.
 *               value set: wedge drawn at fraction (no rotation).
 *   paused    — animation paused at current pose.
 *   stopped   — wedge hidden (angle = 0).
 *   completed — full circle (angle = 360).
 *   aborted   — wedge drawn at value (if any) or hidden; danger tint comes
 *               from the parent via `--tugx-progress-indicator-fill`.
 *
 * Color is inherited from the parent's `--tugx-progress-indicator-fill`.
 * Track uses `--tug7-surface-slider-primary-normal-track-rest`.
 *
 * Laws: [L06] angle via inline CSS variable, [L13] CSS keyframes only,
 *       [L16] pairings declared, [L19] component authoring guide
 */

import React, { useRef, useLayoutEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import "./tug-progress-pie.css";
import type { TugProgressIndicatorState } from "../tug-progress-indicator";

export interface TugProgressPieProps extends Omit<React.ComponentPropsWithoutRef<"span">, "children"> {
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
}

export const TugProgressPie = React.forwardRef<HTMLSpanElement, TugProgressPieProps>(
  function TugProgressPie(
    { value, max = 1, size = 16, state = "running", disabled = false, className, style, ...rest },
    ref,
  ) {
    const isDeterminate = value !== undefined;
    const fraction = isDeterminate
      ? Math.min(Math.max(value / max, 0), 1)
      : 0;

    let angle: number | undefined;
    if (state === "completed") {
      angle = 360;
    } else if (state === "stopped") {
      angle = 0;
    } else if (isDeterminate) {
      angle = fraction * 360;
    } else if (state === "aborted") {
      angle = 0;
    }

    const isIndeterminate =
      !isDeterminate && (state === "running" || state === "paused");

    const prevDeterminateRef = useRef(isDeterminate);
    const pieRef = useRef<HTMLSpanElement>(null);

    useLayoutEffect(() => {
      const wasDeterminate = prevDeterminateRef.current;
      prevDeterminateRef.current = isDeterminate;

      if (!wasDeterminate && isDeterminate && pieRef.current) {
        pieRef.current.style.transition = "none";
        requestAnimationFrame(() => {
          if (pieRef.current) {
            pieRef.current.style.transition = "";
          }
        });
      }
    }, [isDeterminate]);

    const setRef = useCallback(
      (el: HTMLSpanElement | null) => {
        (pieRef as React.MutableRefObject<HTMLSpanElement | null>).current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) (ref as React.MutableRefObject<HTMLSpanElement | null>).current = el;
      },
      [ref],
    );

    const styleObj: React.CSSProperties = {
      width: `${size}px`,
      height: `${size}px`,
    };
    if (angle !== undefined) {
      (styleObj as Record<string, string>)["--tug-progress-pie-angle"] = `${angle}deg`;
    }

    return (
      <span
        ref={setRef}
        data-slot="tug-progress-pie"
        data-state={state}
        aria-hidden="true"
        {...rest}
        className={cn(
          "tug-progress-pie",
          isIndeterminate && state === "running" && "tug-progress-pie-indeterminate",
          state === "paused" && "tug-progress-pie-paused",
          disabled && "tug-progress-pie-disabled",
          className,
        )}
        style={{ ...styleObj, ...style }}
      />
    );
  },
);
