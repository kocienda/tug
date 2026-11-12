/**
 * TugProgressSpinner — Internal building block for the classic 12-spoke spinner.
 *
 * App code should use {@link TugProgressIndicator} instead.
 *
 * Renders twelve radial capsule spokes around an empty center — the
 * familiar macOS-style indeterminate spinner. Each spoke fades from
 * full opacity to a quiet rest opacity over one cycle, staggered by
 * `(i / 12) * duration` so the "leading" (full-opacity) spoke walks
 * around the ring.
 *
 * State semantics:
 *   running   — staggered opacity walks around the ring.
 *   paused    — animation frozen mid-cycle.
 *   stopped   — every spoke at rest opacity (quiescent visible ring).
 *   completed — every spoke at full opacity.
 *   aborted   — same pose as stopped; the danger tint comes from the
 *               parent via `--tugx-progress-indicator-fill`.
 *
 * Geometry: each spoke is a capsule positioned vertically above the
 * center, from inner radius 24 to outer radius 48 on a 100-unit
 * square, emitted as percentages of the root box so the glyph scales
 * with `size`. Width 9. The inner radius leaves a small empty center;
 * spokes occupy most of the host radius so the glyph reads at parity
 * with the ring / pie variants at the same `size`.
 *
 * The spokes are HTML spans rather than SVG rects, and that is a
 * residency requirement, not a preference: an SVG interior element
 * never gets a compositing layer, so twelve SVG spokes meant twelve
 * perpetual main-thread opacity animations per visible spinner. A
 * capsule is exactly what a span with a full border-radius is. Each
 * spoke's placement rotation is a STATIC transform, which acceleration
 * does not object to — only the animated property set matters. Enforced
 * by `animationCensus()` in tugdeck/src/lib/perf-monitor.ts.
 *
 * Color is inherited from the parent's `--tugx-progress-indicator-fill`.
 *
 * Laws: [L06] appearance via CSS, [L13] CSS keyframes only,
 *       [L16] pairings declared, [L19] component authoring guide
 */

import React from "react";
import { cn } from "@/lib/utils";
import "./tug-progress-spinner.css";
import type { TugProgressIndicatorState } from "../tug-progress-indicator";

export interface TugProgressSpinnerProps extends Omit<React.ComponentPropsWithoutRef<"span">, "children"> {
  /** Diameter in CSS px. @default 16 */
  size?: number;
  /** Lifecycle state. @default "running" */
  state?: TugProgressIndicatorState;
  /** When true, opacity dims and animation freezes. */
  disabled?: boolean;
}

const SPOKE_COUNT = 12;
const SPOKES = Array.from({ length: SPOKE_COUNT }, (_, i) => i);

// Geometry on a 100-unit square, which is also percent of the root box.
// A spoke is a vertical capsule above the center, running from the inner
// radius (24) out to the outer radius (48). Width 9.
const INNER = 24;
const OUTER = 48;
const SPOKE_WIDTH = 9;
const SPOKE_HEIGHT = OUTER - INNER;
const SPOKE_LEFT = 50 - SPOKE_WIDTH / 2;
const SPOKE_TOP = 50 - OUTER;
// Rotation happens about the BOX center, which sits `OUTER` units below the
// spoke's own top edge — expressed, as transform-origin requires, in units of
// the spoke's own height.
const SPOKE_ORIGIN_Y = (OUTER / SPOKE_HEIGHT) * 100;

export const TugProgressSpinner = React.forwardRef<HTMLSpanElement, TugProgressSpinnerProps>(
  function TugProgressSpinner(
    { size = 16, state = "running", disabled = false, className, style, ...rest },
    ref,
  ) {
    return (
      <span
        ref={ref}
        data-slot="tug-progress-spinner"
        data-state={state}
        aria-hidden="true"
        {...rest}
        style={{ width: `${size}px`, height: `${size}px`, ...style }}
        className={cn(
          "tug-progress-spinner",
          state === "running" && "tug-progress-spinner-running",
          state === "paused" && "tug-progress-spinner-paused",
          state === "completed" && "tug-progress-spinner-completed",
          disabled && "tug-progress-spinner-disabled",
          className,
        )}
      >
        {SPOKES.map((i) => (
          <span
            key={i}
            className="tug-progress-spinner-spoke"
            style={{
              left: `${SPOKE_LEFT}%`,
              top: `${SPOKE_TOP}%`,
              width: `${SPOKE_WIDTH}%`,
              height: `${SPOKE_HEIGHT}%`,
              transformOrigin: `50% ${SPOKE_ORIGIN_Y}%`,
              transform: `rotate(${i * (360 / SPOKE_COUNT)}deg)`,
              animationDelay: `calc(${-(SPOKE_COUNT - i) / SPOKE_COUNT} * var(--tugx-progress-spinner-cycle))`,
            }}
          />
        ))}
      </span>
    );
  },
);
