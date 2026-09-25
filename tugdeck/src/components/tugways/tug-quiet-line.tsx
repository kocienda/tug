/**
 * TugQuietLine — a single low-emphasis transcript "Voice-3" event row.
 *
 * The Code-route transcript narrates lifecycle and system events beside
 * the assistant's prose: task updates (Created / Started / Completed), a
 * background command finishing, a scheduled wake, an agent completing, a
 * plumbing tool running. This is the shared register for all of them: a
 * leading state icon, a label, a muted subject, and an optional trailing
 * meta on a second line (exit code, elapsed, tokens). One row per event,
 * sharing the tool-call header's line geometry so a run of notices reads
 * in the transcript's row rhythm without a card.
 *
 * Three tones. `primary` (task steps) — a semibold label in the normal
 * text tone over a muted glyph. `quiet` (background/system notices) — a
 * lighter label in the muted tone over a subtle glyph, one step quieter
 * than a task step. `danger` (the error row) — the one place danger
 * color is spent, tinting glyph + text the true red. Color comes from the
 * real muted / subtle / danger text tokens, never an `opacity` fade, so
 * the register is theme-correct.
 *
 * The component owns no outer margin — the consuming context (the
 * transcript stack, a gallery group) owns inter-item spacing.
 *
 * Laws: [L06] appearance via CSS, [L16] pairings declared, [L19] component
 *       authoring guide, [L20] token sovereignty (owns `--tugx-quiet-line-*`)
 */

import "./tug-quiet-line.css";

import React from "react";
import { cn } from "@/lib/utils";

export type TugQuietLineTone = "primary" | "quiet" | "danger";

export interface TugQuietLineProps
  extends React.ComponentPropsWithoutRef<"div"> {
  /** Leading state glyph — a 16px lucide icon. */
  icon: React.ReactNode;
  /**
   * The bold verb / notice ("Completed", "Background command completed").
   * Omit for a row whose whole message rides the subject slot (the error
   * row). `white-space: nowrap` — long text belongs in `subject`.
   */
  label?: React.ReactNode;
  /** The muted detail after the label. Wraps below row 1 when long. */
  subject?: React.ReactNode;
  /** Optional second line — exit code, elapsed time, token count. */
  meta?: React.ReactNode;
  /**
   * Emphasis register.
   * @selector [data-tone="primary"] | [data-tone="quiet"] | [data-tone="danger"]
   * @default "quiet"
   */
  tone?: TugQuietLineTone;
}

export const TugQuietLine = React.forwardRef<HTMLDivElement, TugQuietLineProps>(
  function TugQuietLine(
    { icon, label, subject, meta, tone = "quiet", className, ...rest },
    ref,
  ) {
    return (
      <div
        ref={ref}
        data-slot="tug-quiet-line"
        data-tone={tone}
        className={cn("tug-quiet-line", className)}
        {...rest}
      >
        <span className="tug-quiet-line-icon tug-line-box" aria-hidden="true">
          {icon}
        </span>
        <div className="tug-quiet-line-main">
          <div className="tug-quiet-line-head">
            {label !== undefined && label !== null ? (
              <span className="tug-quiet-line-label">{label}</span>
            ) : null}
            {subject !== undefined && subject !== null ? (
              <span className="tug-quiet-line-subject">{subject}</span>
            ) : null}
          </div>
          {meta !== undefined && meta !== null ? (
            <span className="tug-quiet-line-meta">{meta}</span>
          ) : null}
        </div>
      </div>
    );
  },
);
