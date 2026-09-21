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

import { classifyApiRetry } from "@/components/tugways/cards/api-retry";

import type { ApiRetryState, CodeSessionPhase, TransportState } from "./types";

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
 *
 * `stop_stalled` is the second member, and it earns its place on exactly the
 * rule above: `deriveSubmitButtonMode(state, overlays)` never sees the
 * snapshot, so `stopStalled` cannot reach it as a raw read, and widening that
 * signature would give the Z5 column a second dependency surface the matrix
 * does not otherwise have. An overlay is this file's declared mechanism for a
 * state orthogonal to the base lifecycle, and an unanswered stop is exactly
 * that: the turn is wherever it was, and what changed is what the stop
 * control means.
 *
 * `stalled` is the third, and it says the one thing neither of the others
 * can: the wire is up, the stop is deliverable, and *the network claude
 * needs* is not answering. It has two arms and they are one condition —
 * claude's own SDK reporting a connection-level retry, and a live turn that
 * has produced nothing for `STREAM_SILENCE_STALL_MS` — because a user on a
 * plane gets whichever of the two their failure happens to produce, and the
 * card should read the same either way.
 */
export type SessionLifecycleOverlay =
  | "transport_down"
  | "stop_stalled"
  | "stalled";

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
  | { kind: "force_stop" }
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
   * A stop on this session went unanswered past its deadline. Raises the
   * `stop_stalled` overlay, which is the only thing that produces the
   * `force_stop` submit-button mode ([P02]) — there is no way to reach Force
   * Stop without having pressed Stop and had it answered by nothing.
   */
  stopStalled: boolean;
  /**
   * A live turn has gone `STREAM_SILENCE_STALL_MS` without a stream event.
   * One of the two arms of the `stalled` overlay.
   */
  streamStalled: boolean;
  /**
   * Claude's own retry announcement, or `null`. The other arm of `stalled`:
   * an announcement whose {@link classifyApiRetry} `category` is
   * `"connection"` is claude telling the deck the network is the problem,
   * which is better evidence than any timer.
   */
  apiRetry: ApiRetryState | null;
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

/**
 * The `stalled` condition, exported because two surfaces read it and they
 * must not each derive their own: the lifecycle overlay below, and the
 * flattened phase key in `session-phase-visual.ts` that the STATE cell and
 * every list row paint from. Two copies of this rule would be two cards
 * disagreeing about the same session.
 *
 * The `category` read is deliberate and load-bearing: `label` is display
 * copy and the tokens behind the connection reading are private to
 * `api-retry.ts`, so keying off anything but the discriminator would let a
 * copy edit silently retire the whole state.
 *
 * Neither arm needs a clear anywhere. `foldStreamEvent` nulls `apiRetry` and
 * `streamStalled` on every live stream event, so recovery drops both arms
 * through the one mechanism they already run on — read that function's
 * docstring before adding a second.
 */
export function isNetworkStalled(s: {
  streamStalled: boolean;
  apiRetry: ApiRetryState | null;
}): boolean {
  if (s.streamStalled) return true;
  if (s.apiRetry === null) return false;
  return (
    classifyApiRetry(s.apiRetry.error, s.apiRetry.errorStatus).category ===
    "connection"
  );
}

/** The active overlay set — the matrix's overlay row. */
function deriveOverlays(
  s: LifecycleStoreSignals,
): ReadonlySet<SessionLifecycleOverlay> {
  const overlays = new Set<SessionLifecycleOverlay>();
  // TRANSPORT_DOWN covers both `offline` (no wire) and `restoring`
  // (wire back, binding not re-ack'd) — anything but `online`.
  if (s.transportState !== "online") overlays.add("transport_down");
  // An unanswered stop. Deliberately independent of `transport_down`: the
  // two can both be up, and each says something the other does not.
  if (s.stopStalled) overlays.add("stop_stalled");
  // A network stall, from either of its two arms.
  if (isNetworkStalled(s)) overlays.add("stalled");
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
  // An unanswered stop outranks a down transport, which is the one place in
  // this function where something beats the wire. The argument is that the
  // card has something to force-stop whatever the wire is doing, and
  // `stop_all_work` is deliverable the instant the wire returns — whereas an
  // inert "Reconnecting…" here would put the user back where this whole arc
  // started: a dead stop button over work that will not end.
  if (overlays.has("stop_stalled")) return { kind: "force_stop" };
  // `stalled` deliberately does NOT appear in this function, and the absence
  // is the decision. Unlike `transport_down`, a network stall leaves
  // loopback healthy: the frame Stop sends reaches tugcode the instant it is
  // pressed, and the turn it stops is one claude is failing to advance. A
  // disabled stop button over work that will not end is the exact defect
  // this arc began from, and it is not to be reintroduced for the one state
  // that most looks like it deserves one.
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
