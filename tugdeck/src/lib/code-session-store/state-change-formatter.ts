/**
 * Pure-logic row formatter for the persisted `session_state_changes`
 * ledger.
 *
 * Decodes a single ledger row into the four display fields the popover
 * renders: timestamp, phase, transport state, and interrupt flag.
 * Mirrors the indicator's three-axis view from
 * [`TugStateIndicator`](#step-20-4-2), not the full 12-state lifecycle
 * matrix from [Step 20.5.A](#step-20-5-a) — the ledger and the
 * indicator agree on `(phase, transportState, interruptInFlight)`, and
 * this formatter mirrors that surface verbatim. Signals the matrix
 * tracks but neither the ledger nor the indicator render (transcript
 * length, `pendingApproval` vs `pendingQuestion` distinction,
 * `queuedSends`, `turnEndReason`, DRILLDOWN_OPEN) intentionally do not
 * surface here.
 *
 * Time is rendered in local time as `HH:MM:SS.mmm` — same density the
 * the DevTools card Log section uses for log entries. Local time
 * matches the dev-panel convention and the wall-clock most consumers
 * recognize ("this transition happened at 14:23"); UTC would force
 * mental arithmetic for every row read.
 *
 * Pure: takes only the row + an optional renderer for `Date` (test
 * seam — production calls `new Date(ms)`). Returns a frozen plain
 * object; no DOM, no side effects.
 */

import type {
  CodeSessionPhase,
  TransportState,
} from "@/lib/code-session-store/types";

/**
 * Source row shape — matches `SessionStateChangeRow` from the reader
 * module. Re-stated here so this module compiles without importing the
 * reader (which carries a `TugConnection` dependency this pure helper
 * has no business knowing about).
 */
export interface FormatterStateChangeRow {
  atMs: number;
  phase: CodeSessionPhase;
  transportState: TransportState;
  interruptInFlight: boolean;
}

/**
 * Formatted view ready for rendering — four discrete cells the
 * popover's row layout binds to. Frozen so callers cannot
 * accidentally mutate the per-row record between renders.
 */
export interface FormattedStateChangeRow {
  /** Local-time wall-clock timestamp as `HH:MM:SS.mmm`. */
  atText: string;
  /** The reducer's phase label, verbatim (e.g. `"submitting"`). */
  phase: CodeSessionPhase;
  /** The transport-state label, verbatim (e.g. `"online"`). */
  transportState: TransportState;
  /**
   * Interrupt-in-flight rendered as `"yes"` or `"no"` so the popover's
   * row aligns vertically with adjacent rows where the boolean might
   * differ — readable scan column.
   */
  interrupt: "yes" | "no";
}

/**
 * Format one ledger row into the popover's display shape. Pure
 * function; safe to call from `useMemo` / render bodies.
 *
 * `now` is an optional injection point for tests so the wall-clock
 * formatting is deterministic without a real `Date` constructor.
 * Production callers omit it and the formatter falls back to
 * `new Date(row.atMs)`.
 */
export function formatStateChangeRow(
  row: FormatterStateChangeRow,
  now: (ms: number) => Date = (ms) => new Date(ms),
): FormattedStateChangeRow {
  return Object.freeze({
    atText: formatAtMs(row.atMs, now),
    phase: row.phase,
    transportState: row.transportState,
    interrupt: row.interruptInFlight ? "yes" : "no",
  });
}

/**
 * Format a wall-clock millisecond timestamp as `HH:MM:SS.mmm` in the
 * local time zone. Pads each part to its fixed width so successive
 * rows scan vertically.
 *
 * Exported so the popover can render an "elapsed since the previous
 * row" annotation in a future iteration without re-deriving the
 * underlying clock parts.
 */
export function formatAtMs(
  atMs: number,
  now: (ms: number) => Date = (ms) => new Date(ms),
): string {
  const d = now(atMs);
  const hh = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  const mmm = pad3(d.getMilliseconds());
  return `${hh}:${mm}:${ss}.${mmm}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function pad3(n: number): string {
  if (n < 10) return `00${n}`;
  if (n < 100) return `0${n}`;
  return String(n);
}
