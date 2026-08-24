/**
 * tool-call-phase-visual.ts — Map a single tool call's lifecycle onto
 * the {@link TugProgressIndicator} `phase` / `phaseLabels` /
 * `phaseVisual` API, so a tool-block header can paint one leftmost
 * `pulsing-dot` that fully tracks the call.
 *
 * This is the tool-call-level analogue of `session-phase-visual.ts`:
 * the session module flattens (phase, transport, interrupt) for the
 * status-bar indicator; this module flattens (status, awaiting,
 * interrupted) for the per-row indicator. One mental model, one tested
 * mapping shape, one level down.
 *
 * The store models a tool call's `status` as `pending | done | error`
 * — which cannot express *awaiting approval*, *success*, or
 * *interrupted* as distinct readings. {@link deriveToolCallPhase}
 * folds the raw status together with two orthogonal signals (is this
 * the call a permission/question dialog is blocked on; was the call
 * interrupted) into a single {@link ToolCallPhase}; {@link
 * toolCallPhaseVisual} maps that phase onto the indicator's
 * `{ role, state }`.
 *
 * Mapping ([D03] of dash/block-header.md):
 *
 *   - `in_flight`   → `{ state: running,   role: action }`  (blue — work in flight)
 *   - `awaiting`    → `{ state: running,   role: caution }` (yellow — held on a dialog, and pulsing to say so)
 *   - `success`     → `{ state: completed, role: success }` (green — finished)
 *   - `error`       → `{ state: aborted,   role: danger }`  (red — failed)
 *   - `interrupted` → `{ state: aborted,   role: danger }`  (red — canceled)
 *   - `idle`        → `{ state: stopped,   role: inherit }` (muted — quiescent)
 *
 * `error` and `interrupted` share the danger/aborted visual; they are
 * distinguished by label/tooltip, not color (a canceled call and a
 * failed call both read "this did not succeed").
 */

import type { TugProgressIndicatorPhaseVisual } from "@/components/tugways/tug-progress-indicator";

// ---------------------------------------------------------------------------
// Phase identifier
// ---------------------------------------------------------------------------

/**
 * A tool call's lifecycle as the header indicator reads it. Richer than
 * the store's `pending | done | error`: it splits `pending` into
 * `in_flight` vs `awaiting`, splits `done` into `success` vs
 * `interrupted`, and keeps an `idle` resting pose for completeness
 * (a row that has no call in flight — rare, but the indicator needs a
 * quiescent default).
 */
export type ToolCallPhase =
  | "idle"
  | "in_flight"
  | "awaiting"
  | "success"
  | "error"
  | "interrupted";

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * The raw signals {@link deriveToolCallPhase} folds into a phase. Kept
 * structurally minimal so callers (the dispatch, tests) can assemble it
 * from a `ToolUseMessage` plus the snapshot's pending-dialog join
 * without importing the full store types here.
 */
export interface ToolCallPhaseInput {
  /** The store's tool-call status. */
  readonly status: "pending" | "done" | "error";
  /**
   * True when *this* call is the one a permission or question dialog is
   * currently blocked on — resolved by id-joining the snapshot's
   * `pendingApproval` / `pendingQuestion` `tool_use_id` against the
   * call's `toolUseId` ([Q01]).
   */
  readonly awaiting?: boolean;
  /**
   * True when the call was interrupted (the turn was stopped mid-run,
   * or the tool's structured result carries an `interrupted` flag).
   */
  readonly interrupted?: boolean;
}

/**
 * Fold the raw (status, awaiting, interrupted) triple into a single
 * {@link ToolCallPhase}. Pure; the single source of truth for the
 * header dot's lifecycle reading.
 *
 * Precedence (highest first):
 *  1. `error`       — the result is an error; nothing overrides a failure.
 *  2. `interrupted` — the call was canceled (even a `done` call can carry
 *     an `interrupted` flag, e.g. a bash command killed mid-run; the
 *     canceled reading wins over a nominal "done").
 *  3. `awaiting`    — a `pending` call blocked on a permission/question
 *     dialog. Held, not actively working.
 *  4. `in_flight`   — a `pending` call doing work.
 *  5. `success`     — a `done` call that neither errored nor was canceled.
 */
export function deriveToolCallPhase(input: ToolCallPhaseInput): ToolCallPhase {
  if (input.status === "error") return "error";
  if (input.interrupted === true) return "interrupted";
  if (input.awaiting === true) return "awaiting";
  if (input.status === "pending") return "in_flight";
  return "success";
}

// ---------------------------------------------------------------------------
// Human-readable labels
// ---------------------------------------------------------------------------

/**
 * Phase → visible label. Drives the indicator's tooltip / aria text and
 * the width-stabilize set for any header that opts into a labeled dot.
 * `error` and `interrupted` share the danger visual but keep distinct
 * labels — the color says "did not succeed," the label says which way.
 */
export const TOOL_CALL_PHASE_LABELS: Record<ToolCallPhase, string> = {
  idle: "Idle",
  in_flight: "Running",
  awaiting: "Awaiting approval",
  success: "Done",
  error: "Error",
  interrupted: "Interrupted",
};

// ---------------------------------------------------------------------------
// Visual mapping
// ---------------------------------------------------------------------------

/**
 * Map a phase onto the indicator's `{ role, state }`. Pass this as
 * `phaseVisual` to {@link TugProgressIndicator} (with `phase` set to
 * the `ToolCallPhase`). See the module docstring for the table.
 *
 * Accepts a bare `string` (the indicator's `phaseVisual` signature) and
 * narrows internally so an unrecognized phase falls back to the quiet
 * `idle` pose rather than throwing.
 */
export function toolCallPhaseVisual(
  phase: string,
): TugProgressIndicatorPhaseVisual {
  switch (phase as ToolCallPhase) {
    case "in_flight":
      return { role: "action", state: "running" };
    case "awaiting":
      // A permission/question dialog is blocked on this call, so the dot
      // pulses in the caution tint: it is the call the user has to answer
      // before anything moves, and every yellow dot in the app says that
      // the same way. Mirrors `sessionSessionPhaseVisual`'s
      // `awaiting_approval` mapping, which is the same wait seen from the
      // session's end.
      return { role: "caution", state: "running" };
    case "success":
      return { role: "success", state: "completed" };
    case "error":
    case "interrupted":
      return { role: "danger", state: "aborted" };
    case "idle":
    default:
      return { role: "inherit", state: "stopped" };
  }
}
