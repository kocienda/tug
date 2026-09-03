/**
 * `lifecycle-state` — the Session card lifecycle state machine.
 *
 * `deriveLifecycleSnapshot` encodes the session-card lifecycle
 * state-to-zone coordination matrix as one pure projection: it reads the
 * matrix-relevant signals off the `CodeSessionStore` snapshot and
 * returns the matrix row — the `SessionLifecycleState`, the active
 * `SessionLifecycleOverlay`s, and the derived Z5 `submitButtonMode`.
 * Every zone that coordinates on lifecycle reads this one snapshot
 * (via `useLifecycleState`), so the matrix has exactly one executable
 * source of truth and a regression against any matrix cell is a
 * single-file diff.
 *
 * Pure module — no DOM, no React, no time source. The
 * `useSyncExternalStore` subscription lives in
 * `hooks/use-lifecycle-state.ts`.
 *
 * Conformance:
 *   - [DT09] — reference-stable: pass the previous result as the
 *     second argument and the function hands it straight back when no
 *     matrix-relevant signal moved, so a stream of `assistant_delta`s
 *     (content churn, not lifecycle) does not re-render the hook's
 *     consumers.
 *
 * @module lib/code-session-store/lifecycle-state
 */

import type { CodeSessionPhase, TransportState } from "./types";

// ---------------------------------------------------------------------------
// Matrix vocabulary
// ---------------------------------------------------------------------------

/**
 * The ten lifecycle states of the session-card lifecycle matrix. Eight map 1:1
 * onto a `CodeSessionPhase`; two are projections with no raw phase of
 * their own — INTERRUPTING (an interrupt round-trip is in flight) and
 * COMPLETE (`idle` once at least one turn has committed).
 */
export type SessionLifecycleState =
  | "idle"
  | "submitting"
  | "awaiting_first_token"
  | "streaming"
  | "tool_work"
  | "awaiting_user"
  | "interrupting"
  | "replaying"
  | "errored"
  | "complete";

/**
 * The matrix's overlay row — an orthogonal condition that can apply on top of
 * any base state, derived from the store snapshot. An overlay says something is
 * true about the session; the state says where its turn is, and the two are
 * independent. The matrix's QUEUED_NEXT_TURN condition needs no derived value
 * here — it surfaces directly as transcript ghost rows off the snapshot's
 * `queuedSends`.
 *
 * An overlay earns its place by *deriving* something for a delegate that reads
 * it: `transport_down` collapses a three-valued `transportState` into the one
 * question consumers ask, and `deriveSubmitButtonMode` right below reads it.
 *
 * A `pending_ask` overlay was added here once and removed, and the removal is
 * worth recording because the reasoning that produced it was half right. It was
 * a synonym — `pendingAsk` rides the same snapshot, so a consumer could read it
 * directly — but the reason nothing consumed the overlay was that the *consumer
 * was never wired*, not that no consumer was wanted. The Awaiting reading it was
 * meant to produce is a real requirement, and it does not live here: the STATE
 * cell and the Cards card row both flatten their indicator through
 * `sessionSessionPhaseKey` (`session-phase-visual.ts`), which is where
 * `pendingAsk` now surfaces as Awaiting. Deleting an unread overlay was right;
 * concluding from its silence that the feature was unwanted was not.
 */
export type SessionLifecycleOverlay = "transport_down";

/**
 * The Z5 submit-button mode — the matrix's Z5 column. The `submit`
 * kind carries `disabled` (the lifecycle never sets it `true`; the
 * Z5 consumer ANDs in editor-draft emptiness — see
 * {@link deriveSubmitButtonMode}). A turn in flight is always `stop`:
 * a mid-turn submit queues rather than overriding the primary button,
 * so QUEUED_NEXT_TURN no longer bears on this mode (the `+` queue
 * button is a separate control, and the queue surfaces as transcript
 * ghost rows). The remaining kinds are all disabled buttons:
 * `awaiting_user` / `stopping` / `reconnecting` / `restoring`.
 */
export type SessionSubmitButtonMode =
  | { kind: "submit"; disabled: boolean }
  | { kind: "stop" }
  | { kind: "awaiting_user" }
  | { kind: "stopping" }
  | { kind: "reconnecting" }
  | { kind: "restoring" };

/** One row of the matrix — what `deriveLifecycleSnapshot` projects. */
export interface SessionLifecycleSnapshot {
  state: SessionLifecycleState;
  overlays: ReadonlySet<SessionLifecycleOverlay>;
  submitButtonMode: SessionSubmitButtonMode;
}

/**
 * The `CodeSessionSnapshot` fields `deriveLifecycleSnapshot` reads.
 * The full `CodeSessionSnapshot` structurally satisfies this — the
 * function declares the narrow shape so its dependency surface is
 * explicit and a pure-logic test supplies a literal without
 * fabricating the snapshot's ~30 unrelated fields.
 */
export interface LifecycleStoreSignals {
  phase: CodeSessionPhase;
  transportState: TransportState;
  interruptInFlight: boolean;
  /**
   * Only `.length` is read — it splits the `idle` phase into COMPLETE
   * (a turn has committed) vs a never-used IDLE.
   */
  transcript: ReadonlyArray<unknown>;
}

// ---------------------------------------------------------------------------
// Derivation — the matrix encoded as one switch
// ---------------------------------------------------------------------------

/**
 * The base lifecycle state. Precedence: a sticky session error and the
 * replay window dominate; an in-flight interrupt overrides whichever
 * in-flight phase it landed on; the remaining phases map 1:1; `idle`
 * splits into COMPLETE / IDLE on whether any turn has committed.
 *
 * `waking` maps to `streaming` for Slice 1: the wake turn renders as
 * an active streaming turn (status indicator success+pulse, submit
 * button is Stop). Slice 2 may introduce a `waking` matrix state
 * with trigger-aware chrome (see [Q02] in
 * `arc/tugplan-session-wake.md`); until then, sharing the
 * streaming row gives wakes the right visual treatment without a
 * matrix-wide audit.
 */
function deriveLifecycleState(s: LifecycleStoreSignals): SessionLifecycleState {
  if (s.phase === "errored") return "errored";
  if (s.phase === "replaying") return "replaying";
  if (s.interruptInFlight) return "interrupting";
  switch (s.phase) {
    case "submitting":
      return "submitting";
    case "awaiting_first_token":
      return "awaiting_first_token";
    case "streaming":
      return "streaming";
    case "tool_work":
      return "tool_work";
    case "awaiting_approval":
      // The matrix collapses permission and question prompts into one
      // AWAITING_USER state; `phase === "awaiting_approval"` is the
      // canonical signal (equivalently `pendingApproval !== null ||
      // pendingQuestion !== null`).
      return "awaiting_user";
    case "waking":
      return "streaming";
    case "idle":
      return s.transcript.length > 0 ? "complete" : "idle";
    default: {
      const exhaustive: never = s.phase;
      return exhaustive;
    }
  }
}

/** The active overlay set — the matrix's overlay row. */
function deriveOverlays(
  s: LifecycleStoreSignals,
): ReadonlySet<SessionLifecycleOverlay> {
  const overlays = new Set<SessionLifecycleOverlay>();
  // TRANSPORT_DOWN covers both `offline` (no wire) and `restoring`
  // (wire back, binding not re-ack'd) — anything but `online`.
  if (s.transportState !== "online") overlays.add("transport_down");
  // A question from outside the turn stream (`/api/ask`) deliberately touches
  // nothing here. It says nothing about the turn — the session is usually idle
  // when one arrives — and routing it through `awaiting_approval` would make
  // `canSubmit` false and `canInterrupt` true on a session with no turn: a dead
  // composer and a live Stop button with nothing to stop. Its two readings live
  // where their consumers do: modality is `inlineDialogPending` in
  // `session-card.tsx`, and the Awaiting state is `sessionSessionPhaseKey` in
  // `session-phase-visual.ts`.
  return overlays;
}

/** The Z5 submit-button mode — the matrix's Z5 column. */
function deriveSubmitButtonMode(
  state: SessionLifecycleState,
  overlays: ReadonlySet<SessionLifecycleOverlay>,
): SessionSubmitButtonMode {
  // Transport down trumps everything — neither submit nor stop can
  // reach the wire, so the button is an inert "Reconnecting…".
  if (overlays.has("transport_down")) return { kind: "reconnecting" };

  switch (state) {
    case "replaying":
      return { kind: "restoring" };
    case "interrupting":
      return { kind: "stopping" };
    case "awaiting_user":
      return { kind: "awaiting_user" };
    case "submitting":
    case "awaiting_first_token":
    case "streaming":
    case "tool_work":
      // A turn is in flight → Stop, unconditionally. A mid-turn submit
      // queues (the reducer's `queuedSends` FIFO) rather than changing
      // the primary button; the queue is reached through the separate
      // `+` button and surfaces as transcript ghost rows, so it does
      // not bear on Z5.
      return { kind: "stop" };
    case "idle":
    case "complete":
    case "errored":
      // The lifecycle never disables a submit-mode button. The
      // matrix's "disabled if prompt empty" (IDLE) is editor-draft
      // emptiness — not a lifecycle signal — which the Z5
      // submit-button consumer ANDs in locally.
      return { kind: "submit", disabled: false };
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Structural equality — the [DT09] reference-stability primitive
// ---------------------------------------------------------------------------

function overlaySetsEqual(
  a: ReadonlySet<SessionLifecycleOverlay>,
  b: ReadonlySet<SessionLifecycleOverlay>,
): boolean {
  if (a.size !== b.size) return false;
  for (const overlay of a) {
    if (!b.has(overlay)) return false;
  }
  return true;
}

function submitButtonModesEqual(
  a: SessionSubmitButtonMode,
  b: SessionSubmitButtonMode,
): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "submit" && b.kind === "submit") {
    return a.disabled === b.disabled;
  }
  // Every other kind is a nullary tag — same `kind` is full equality.
  return true;
}

/**
 * Structural equality of two lifecycle snapshots — the matrix row is
 * unchanged iff `state`, the overlay set, and `submitButtonMode` all
 * match. The [DT09] reference-stability check in
 * {@link deriveLifecycleSnapshot} is built on this.
 */
export function lifecycleSnapshotsEqual(
  a: SessionLifecycleSnapshot,
  b: SessionLifecycleSnapshot,
): boolean {
  if (a === b) return true;
  return (
    a.state === b.state &&
    overlaySetsEqual(a.overlays, b.overlays) &&
    submitButtonModesEqual(a.submitButtonMode, b.submitButtonMode)
  );
}

// ---------------------------------------------------------------------------
// The public projection
// ---------------------------------------------------------------------------

/**
 * Project the store snapshot onto the lifecycle matrix row. Pure: a
 * deterministic function of its arguments.
 *
 * `previous` is the [DT09] reference-stability hook — pass the caller's
 * last result and the function returns it unchanged when no
 * matrix-relevant signal moved (so a content-only `assistant_delta`
 * does not produce a fresh object and re-render every zone). Omit it
 * and every call returns a fresh snapshot. The `useLifecycleState`
 * hook threads it from a per-card `useRef`, so the stability is
 * per-card — a module-level cache would thrash when two cards stream
 * at once.
 */
export function deriveLifecycleSnapshot(
  storeSnapshot: LifecycleStoreSignals,
  previous?: SessionLifecycleSnapshot,
): SessionLifecycleSnapshot {
  const state = deriveLifecycleState(storeSnapshot);
  const overlays = deriveOverlays(storeSnapshot);
  const submitButtonMode = deriveSubmitButtonMode(state, overlays);
  const next: SessionLifecycleSnapshot = { state, overlays, submitButtonMode };
  if (previous !== undefined && lifecycleSnapshotsEqual(previous, next)) {
    return previous;
  }
  return next;
}
