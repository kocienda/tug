/**
 * session-card-z1c.tsx — `SessionZ1C` per-row in-flight indicator zone.
 *
 * Per [D19] / `#spec-z1c`, SessionZ1C is the in-flight indicator chrome
 * for the assistant row. It attaches via `TugTranscriptEntry`'s
 * `inflightFooter` slot — every row carries the slot uniformly and
 * the slot collapses to zero height when its rendered output is
 * empty (see `.tug-transcript-entry__inflight-footer:empty` in
 * `tug-transcript-entry.css`).
 *
 * **Per-row mount discipline.** Only the **in-flight-tip row** mounts
 * `SessionZ1C`; every other row passes `null` to `inflightFooter` and
 * stays subscription-free. In Step 5.8 the in-flight tip is the
 * in-flight code row (`!isCommitted`); in Step 5.9 it is the row
 * carrying the Message flagged `isLastInflightMessage`. The
 * subscription discipline matters at scale — every row that
 * subscribes wakes on every snapshot dispatch.
 *
 * **Memoized snapshot selector.** Z1C subscribes to the snapshot via
 * one `useSyncExternalStore` call whose selector returns a stable
 * `{phase, interruptInFlight}` object across dispatches that don't
 * change either field. Required for `useSyncExternalStore`'s
 * `Object.is` guard — text-delta dispatches build a fresh snapshot
 * reference (per [D07] copy-on-write) but don't change phase /
 * interruptInFlight; without the memoization the component would
 * re-render on every delta.
 *
 * **Visible appearance.** The visible glyph is the bare three-bar
 * {@link TugProgressIndicator} `variant="wave"` (no inline label) —
 * identical to the pre-Step-5.8 in-row indicator. The phase
 * label rides on `aria-label` for screen readers; the visible
 * surface stays the same three bars regardless of phase. Per
 * [D19], `awaiting_approval` and `interruptInFlight === true` both
 * resolve to `null` — Z1C renders nothing and the slot collapses.
 *
 * Tuglaws cross-check:
 *  - [L02] external state arrives via `useSyncExternalStore` only.
 *  - [L06] visibility / vertical-space collapse flows through CSS
 *    (`:empty` on the wrapper), not React state.
 *  - [L19] file pair with `session-card-z1c.css`; the pure-logic
 *    helper `sessionZ1CContent` is the testable surface (exported
 *    from this same file).
 *  - [L26] mount identity: the row's `inflightFooter` prop carries
 *    the same component reference across snapshot dispatches; React
 *    keeps the same mounted instance across content swaps.
 *
 * @module components/tugways/cards/session-card-z1c
 */

import "./session-card-z1c.css";

import React, { useCallback, useRef } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import type { CodeSessionStore } from "@/lib/code-session-store";
import type { CodeSessionPhase } from "@/lib/code-session-store/types";

// ---------------------------------------------------------------------------
// Pure-logic helper — phase → indicator content
// ---------------------------------------------------------------------------

/**
 * What SessionZ1C should render. `null` means the slot collapses (no
 * indicator) — used for `awaiting_approval` (pending dialog is the
 * affordance), `interruptInFlight === true` (interrupt is instant
 * from the user's POV; Z1B paints the end-state once the turn
 * commits), and `idle` / `replaying` / `errored`.
 */
export interface SessionZ1CContent {
  label: string;
}

/**
 * Resolve the indicator content for a given snapshot phase +
 * `interruptInFlight` flag per the [D19] table.
 *
 * Precedence: `interruptInFlight === true` overrides every phase
 * and returns `null` (slot collapses) so the stop gesture feels
 * instant. `awaiting_approval` also returns `null` — the pending
 * permission / question dialog is the affordance, the indicator
 * would be redundant.
 */
export function sessionZ1CContent(
  phase: CodeSessionPhase,
  interruptInFlight: boolean,
): SessionZ1CContent | null {
  if (interruptInFlight) return null;
  switch (phase) {
    case "submitting":
      return { label: "Submitting…" };
    case "awaiting_first_token":
      return { label: "Thinking…" };
    case "streaming":
      return { label: "Streaming…" };
    case "tool_work":
      return { label: "Tool work…" };
    case "waking":
      return { label: "Waking…" };
    case "awaiting_approval":
    case "idle":
    case "replaying":
    case "errored":
      return null;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface SessionZ1CProps {
  /**
   * The per-card `CodeSessionStore` whose snapshot drives the
   * indicator's content. The component reads `phase` and
   * `interruptInFlight` via `useSyncExternalStore`.
   */
  codeSessionStore: CodeSessionStore;
}

interface SessionZ1CSelection {
  phase: CodeSessionPhase;
  interruptInFlight: boolean;
}

export const SessionZ1C: React.FC<SessionZ1CProps> = ({ codeSessionStore }) => {
  // Memoized narrowed selector — returns the SAME object reference
  // across snapshot dispatches that don't change `phase` or
  // `interruptInFlight`. See module docstring for rationale.
  const lastSelectionRef = useRef<SessionZ1CSelection | null>(null);
  const getSelection = useCallback((): SessionZ1CSelection => {
    const snap = codeSessionStore.getSnapshot();
    const prev = lastSelectionRef.current;
    if (
      prev !== null &&
      prev.phase === snap.phase &&
      prev.interruptInFlight === snap.interruptInFlight
    ) {
      return prev;
    }
    const next: SessionZ1CSelection = {
      phase: snap.phase,
      interruptInFlight: snap.interruptInFlight,
    };
    lastSelectionRef.current = next;
    return next;
  }, [codeSessionStore]);

  const selection = useSyncExternalStore(
    codeSessionStore.subscribe,
    getSelection,
  );

  const content = sessionZ1CContent(selection.phase, selection.interruptInFlight);
  if (content === null) return null;

  return (
    <TugProgressIndicator
      data-slot="session-z1c"
      variant="wave"
      state="running"
      role="inherit"
      aria-label={content.label}
      aria-live="polite"
    />
  );
};
