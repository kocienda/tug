/**
 * SessionStepRing — a session's step ring, as a leaf subscription.
 *
 * The ring is one system with the phase dot it wraps: its tone comes from the
 * same phase→visual mapping the dot reads, so a session waiting on the user's
 * answer wears a caution ring around a caution dot, and a working one wears
 * the same fixed cobalt the working dot fills with. `complete` overrides to
 * the success tone — every step landed is the one reading that outranks what
 * the session is doing this second.
 *
 * A LEAF for the same reason `SessionPhaseDot` is one: liveness is not
 * identity, and a phase subscription up in the row would wake the whole
 * identity tier on every phase transition. Here the wake repaints one glyph.
 *
 * With `dot` the ring wraps a live {@link SessionPhaseDot} at the ring form's
 * one dot size; without it, it is the inline miniature for rows whose lead is
 * something else — still phase-toned, because the ring reports the session
 * doing the steps wherever it paints.
 *
 * @module components/tugways/session-step-ring
 */

import React from "react";

import { SessionPhaseDot } from "./session-phase-dot";
import {
  TugStepRing,
  TUG_STEP_RING_DOT_SIZE,
} from "./tug-step-ring";
import { sessionSessionPhaseVisual } from "@/lib/code-session-store/session-phase-visual";
import { useSessionPhase } from "@/lib/code-session-store/use-session-phase";

export interface SessionStepRingProps {
  /** The session whose phase tones the ring (and fills the dot inside it). */
  sessionId: string;
  /** The step being worked, 1-based. */
  current: number;
  /** How many steps the plan holds. */
  total: number;
  /** Every step landed — the ring reads success whatever the phase. */
  complete?: boolean;
  /**
   * Wrap a live phase dot at the ring form's one dot size. Omitted, the ring
   * is the inline miniature.
   * @default false
   */
  dot?: boolean;
  /** The dot's period jitter, forwarded to {@link SessionPhaseDot}. */
  drift?: boolean;
}

export function SessionStepRing({
  sessionId,
  current,
  total,
  complete = false,
  dot = false,
  drift = false,
}: SessionStepRingProps): React.ReactElement {
  const phase = useSessionPhase(sessionId);
  const role = sessionSessionPhaseVisual(phase).role ?? "inherit";
  return (
    <TugStepRing
      current={current}
      total={total}
      complete={complete}
      role={role}
      dot={
        dot ? (
          <SessionPhaseDot
            sessionId={sessionId}
            size={TUG_STEP_RING_DOT_SIZE}
            drift={drift}
          />
        ) : undefined
      }
    />
  );
}
