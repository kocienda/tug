/**
 * TugStepRing — step progress as a segmented ring, in a role's tone.
 *
 * The ring answers "how far through its plan" at zero pixel cost: it wraps a
 * mark a row already has (the session's phase dot) or stands alone as a 14px
 * inline miniature, so no surface changes height to carry it. Done segments
 * fill in the ring's tone, the current segment breathes, and the unfilled
 * steps are a toned-back whisper the fill contrasts against — the count is
 * read off that contrast.
 *
 * The tone is a semantic ROLE, never a theme accent: the caller passes the
 * same role its dot resolved from the phase mapping, so one glyph answers
 * "what is this session doing" and "how far through its plan" in one tint.
 * `success` is the completion reading — every step landed outranks what the
 * work is doing this second. The wired-up session form is
 * `SessionStepRing` (`session-step-ring.tsx`); this component is the shape.
 *
 * ONE geometry. With a dot the ring wraps it at the dot's own box plus a
 * fixed margin, and the dot's pulse ends AT the ring, never inside it — which
 * is why the ring form always takes the dense {@link TUG_STEP_RING_DOT_SIZE}
 * dot rather than the Lens monitor's 28.
 *
 * Laws: [L06] segment states are `data-*` the CSS paints from; [L13] the
 * breathing segment's motion is CSS animation; [L19] `.tsx`/`.css` pair,
 * `data-slot`; [L20] owns `--tugx-step-ring-*`.
 *
 * @module components/tugways/tug-step-ring
 */

import "./tug-step-ring.css";

import React from "react";

import type { TugProgressIndicatorRole } from "./tug-progress-indicator";
import { TUG_SESSION_ROW_STACK_DOT_SIZE } from "./tug-session-row";

/** Past this many steps the ring stops drawing per-step gaps: a 24-way split
 *  ring is texture, not a count, so it becomes one continuous arc. */
export const TUG_STEP_RING_SEGMENT_MAX = 16;

/** THE dot box for the ring form. One geometry, every surface: the dense
 *  session-row dot, whose pulse ends at the ring rather than inside it. */
export const TUG_STEP_RING_DOT_SIZE = TUG_SESSION_ROW_STACK_DOT_SIZE;

/** The ring's margin past the dot box it wraps, in px. */
const RING_DOT_MARGIN = 10;

/** The inline miniature's whole box, in px — for rows with no dot of
 *  their own. */
const RING_MINI_BOX = 14;

/** One ring segment's arc path, angles in radians. */
function arcPath(
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
): string {
  const x0 = cx + r * Math.cos(a0);
  const y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1);
  const y1 = cy + r * Math.sin(a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export interface TugStepRingProps {
  /** The step being worked, 1-based. */
  current: number;
  /** How many steps the plan holds. */
  total: number;
  /**
   * Every step landed. Overrides the ring to the success tone and fills every
   * segment — the completion reading outranks the role the caller resolved.
   * @default false
   */
  complete?: boolean;
  /**
   * The ring's tone — the same role the dot inside it resolved from the phase
   * mapping, so the two marks cannot disagree about what the work is doing.
   * @default "inherit"
   */
  role?: TugProgressIndicatorRole;
  /**
   * The phase dot the ring wraps. Omitted, the ring is the inline miniature
   * for rows with no dot of their own.
   */
  dot?: React.ReactNode;
  /**
   * The miniature's box, in px. Ignored when `dot` sets the geometry — the
   * ring form has one size. A surface set at a reading scale (the Changes
   * shade) takes the miniature a step larger than the rail default.
   * @default 14
   */
  size?: number;
}

export function TugStepRing({
  current,
  total,
  complete = false,
  role = "inherit",
  dot,
  size = RING_MINI_BOX,
}: TugStepRingProps): React.ReactElement {
  const stroke = 2;
  const box =
    dot !== undefined && dot !== null
      ? TUG_STEP_RING_DOT_SIZE + RING_DOT_MARGIN
      : size;
  const c = box / 2;
  const r = c - stroke / 2 - 0.5;
  const segmented = total <= TUG_STEP_RING_SEGMENT_MAX;
  const gap = segmented ? 0.3 : 0;
  const span = (Math.PI * 2) / total;
  const top = -Math.PI / 2;
  const shown = complete ? total + 1 : current;
  const label = complete
    ? `all ${total} steps done`
    : `step ${current} of ${total}`;
  return (
    <span
      className="tug-step-ring"
      data-slot="tug-step-ring"
      data-role={complete ? "success" : role}
      style={{ width: box, height: box }}
      role="img"
      aria-label={label}
    >
      <svg
        className="tug-step-ring-svg"
        width={box}
        height={box}
        viewBox={`0 0 ${box} ${box}`}
        aria-hidden
      >
        {Array.from({ length: total }, (_, i) => {
          const step = i + 1;
          const a0 = top + i * span + gap / 2;
          const a1 = top + (i + 1) * span - gap / 2;
          const state =
            step < shown ? "done" : step === shown ? "current" : "todo";
          return (
            <path
              key={step}
              className="tug-step-ring-seg"
              data-state={state}
              d={arcPath(c, c, r, a0, a1)}
              fill="none"
              strokeWidth={stroke}
              strokeLinecap="round"
            />
          );
        })}
      </svg>
      {dot !== undefined && dot !== null ? (
        <span className="tug-step-ring-dot">{dot}</span>
      ) : null}
    </span>
  );
}

/**
 * The counters at caption weight — the ring's numerate companion where a row
 * has the width for six characters. Mono, so a column of them aligns.
 */
export function TugStepFraction({
  current,
  total,
}: {
  current: number;
  total: number;
}): React.ReactElement {
  return (
    <span
      className="tug-step-fraction"
      data-slot="tug-step-fraction"
      aria-label={`step ${current} of ${total}`}
    >
      <span className="tug-step-fraction-i">{current}</span>
      <span className="tug-step-fraction-slash">/</span>
      <span className="tug-step-fraction-n">{total}</span>
    </span>
  );
}
