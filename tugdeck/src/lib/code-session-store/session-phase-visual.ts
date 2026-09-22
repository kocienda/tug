/**
 * session-phase-visual.ts — Map a CodeSession's (phase, transport,
 * interrupt, running-jobs) state onto the {@link TugProgressIndicator}
 * `phase` / `phaseLabels` / `phaseVisual` API.
 *
 * The session-phase model has several orthogonal axes — `phase`,
 * `transportState`, `interruptInFlight`, and the background-jobs
 * ledger — but a UI indicator only needs one identifier per render.
 * {@link sessionSessionPhaseKey} flattens them into a stable string
 * key; {@link SESSION_PHASE_LABELS} maps every key to its
 * human-readable title (used for the indicator's visible label and
 * tooltip); and {@link sessionSessionPhaseVisual} maps every key to a
 * partial `{ role, state }` for the indicator's visual treatment.
 *
 * Transport health dominates phase: an offline wire reads as
 * `aborted/danger` regardless of the reducer's phase; a restoring
 * wire reads as `running/caution`. An in-flight interrupt promotes
 * the indicator to `running/caution` so the user sees that the stop
 * request has not been lost between request and ack. Otherwise the
 * phase enum drives the visual.
 *
 * The reducer's `phase` is a *turn* lifecycle: it answers whether the
 * conversational turn is in flight and whether the composer may
 * submit. `idle` therefore means "no turn in flight" — which is not
 * the same as "this session is done". A backgrounded agent runs after
 * its launching turn commits, so a session can sit at `idle` with
 * agents still working. The `background` key exists so the indicator
 * does not report that session as quiet; it is a presentation key
 * only, and the reducer's phase enum is untouched by it.
 *
 * `pendingAsk` rides the same "presentation key only" seam, for the
 * mirror-image reason. A session is Awaiting whenever a dialog is
 * holding the user's answer, and there are three such dialogs:
 * `PermissionDialog` and `QuestionWizard` reach this function through
 * the reducer, which really does set `phase: "awaiting_approval"` when
 * their `control_request_forward` lands. `AppTestAskDialog` cannot —
 * it arrives over `/api/ask`, belongs to no turn, and usually finds the
 * session idle, so writing that phase would make `canSubmit` false and
 * `canInterrupt` true: a dead composer and a live Stop button with
 * nothing to stop. Flattening it here instead reports Awaiting off the
 * one axis the indicator actually reads, and leaves the turn machine
 * alone. All three dialogs therefore read Awaiting; only two of them
 * are turn phases.
 *
 * `ready` is the third key on that seam, and the most patient fact of
 * the three: an arc seated on this session has finished and a join
 * offer stands for it, unspent by a land, a discard or a reopen. No
 * turn is in flight — the wheel handed the card back — so the reducer
 * says `idle`, which is true about the turn and wrong about the
 * session: the work is done and it is waiting on a person. Flattening
 * it here keeps `canSubmit` true, which is the point. Ready is a state
 * you can keep working under, not a block; writing a turn phase for it
 * would kill the composer and light a Stop button with nothing to
 * stop.
 *
 * Migrated from the legacy `TugStateIndicator` — the visual
 * vocabulary is preserved; the API shape is reshaped to the unified
 * indicator's phase axis.
 */

import type {
  TugProgressIndicatorPhaseVisual,
} from "@/components/tugways/tug-progress-indicator";
import type { CodeSessionPhase, TransportState } from "./types";

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/**
 * The CodeSession indicator state. Same shape as the legacy
 * `TugStateIndicatorState`; renamed here to avoid implying any
 * coupling to a particular indicator component.
 *
 * `runningJobCount` is optional because not every consumer knows it: a
 * persisted state-change row replays a historical `(phase, transport,
 * interrupt)` triple and has no ledger to consult, and absent
 * correctly reads as "makes no claim about background work". Every
 * *live* surface passes it — omitting it there is what would put the
 * `Idle` lie back.
 */
export interface SessionPhaseInput {
  readonly phase: CodeSessionPhase;
  readonly transportState: TransportState;
  readonly interruptInFlight: boolean;
  /**
   * Whether a stop on this session went unanswered past its deadline.
   * Optional for the same reason as `runningJobCount`: a replayed
   * historical state-change row has no live flag to consult, and absent
   * correctly reads as "makes no claim". Every live surface passes it.
   */
  readonly stopStalled?: boolean;
  readonly runningJobCount?: number;
  /**
   * Whether a question from outside the turn stream (`/api/ask`) is on
   * screen waiting to be answered. Optional for the same reason as
   * `runningJobCount`: a replayed historical state-change row has no
   * live dialog to consult, and absent correctly reads as "makes no
   * claim". Every live surface passes it.
   */
  readonly pendingAsk?: boolean;
  /**
   * Whether a join offer stands for the arc seated on this session and
   * nothing has spent it. Optional for the same reason as
   * `runningJobCount` and `pendingAsk`: a replayed historical
   * state-change row has no live register to consult, and absent
   * correctly reads as "makes no claim". Every live surface passes it.
   */
  readonly joinReady?: boolean;
}

// ---------------------------------------------------------------------------
// Phase key
// ---------------------------------------------------------------------------

export type SessionPhaseKey =
  | "offline"
  | "restoring"
  | "interrupting"
  | "stop_stalled"
  | "ready"
  | "background"
  | CodeSessionPhase;

/**
 * Flatten the session's state into a single stable string. Transport
 * degradations and the interrupt flag take precedence over the
 * reducer's phase; otherwise the phase enum is the key.
 *
 * `background` promotes from `idle` alone. Every other phase already
 * describes something more specific about the session and keeps its
 * key — including `errored`, where the failure is the more important
 * reading and danger continues to dominate, exactly as transport does.
 *
 * A pending ask outranks the phase, because a dialog holding the user's
 * answer is the more important reading of the session whatever its turn
 * is doing — and the common case is an agent's own Bash call raising the
 * dialog mid-`tool_work`, where reporting "Working" would describe the
 * one participant who is not the bottleneck. It stays *below* transport
 * and interrupt: a dead wire means the answer cannot be delivered, and a
 * stop in flight is the thing the user most recently asked for.
 *
 * `stop_stalled` sits directly below `interrupting`, and the ordering is
 * the whole of its meaning: it is what the card reads *after* an
 * interrupt stopped being in flight without anything having answered it.
 * The two are never both true — the deadline's tick clears the flag it
 * raises this one beside — so the order is documentation rather than
 * arbitration. It stays above the phase for the same reason
 * `interrupting` does: an unanswered stop is the most recent thing the
 * user asked for and has not got.
 *
 * The lifecycle matrix's `stalled` overlay — a live turn gone quiet, or
 * claude reporting a connection retry — is deliberately **not** a key
 * here. It was once, wearing caution and the word "Waiting", and that
 * put the summons colour on every long tool call and every long think:
 * a `cargo build` produces no stream event for minutes, and nothing
 * about that wait is the user's to end. Caution on the dot means the
 * turn is parked on a person. The stall still reaches the card as a
 * banner, which is where a fact about the wire belongs.
 *
 * `ready` promotes from `idle` alone, on the same terms as
 * `background` and for the same reason: every other phase is a turn
 * saying something more specific about the session right now, and a
 * standing join offer is patient. It sits below `pendingAsk` too — a
 * dialog holding an answer blocks the turn, and a join offer blocks
 * nothing.
 */
export function sessionSessionPhaseKey(input: SessionPhaseInput): SessionPhaseKey {
  if (input.transportState === "offline") return "offline";
  if (input.transportState === "restoring") return "restoring";
  if (input.interruptInFlight) return "interrupting";
  if (input.stopStalled === true) return "stop_stalled";
  if (input.pendingAsk === true) return "awaiting_approval";
  if (input.phase === "idle" && input.joinReady === true) return "ready";
  if (input.phase === "idle" && (input.runningJobCount ?? 0) > 0) {
    return "background";
  }
  return input.phase;
}

// ---------------------------------------------------------------------------
// Human-readable labels
// ---------------------------------------------------------------------------

/**
 * Phase key → visible label. Drives both the indicator's inline label
 * (when shown) and its tooltip body. The full map is also the
 * width-stabilize set for indicators that opt into
 * `labelAlign="center"`.
 *
 * `waking` shares "Streaming" with `streaming` — the wake path is
 * indistinguishable to the user from a normal stream; the distinction
 * is internal lifecycle bookkeeping.
 *
 * `background` reads "Running", deliberately neither "Idle" nor
 * "Working": no turn is in flight and the composer is open, but the
 * session still has work of its own outstanding. It claims execution,
 * which is what a backgrounded agent is doing, and it sits beside
 * "Working" — a turn in flight — as the between-turns counterpart of
 * it. It replaced "Active", a word that made no claim a live turn does
 * not also make.
 */
export const SESSION_PHASE_LABELS: Record<SessionPhaseKey, string> = {
  offline: "Disconnected",
  restoring: "Reconnecting",
  interrupting: "Interrupting",
  stop_stalled: "Unanswered",
  idle: "Idle",
  ready: "Ready",
  background: "Running",
  submitting: "Sending",
  awaiting_first_token: "Waiting",
  streaming: "Streaming",
  tool_work: "Working",
  awaiting_approval: "Awaiting",
  replaying: "Restoring",
  waking: "Streaming",
  errored: "Error",
};

// ---------------------------------------------------------------------------
// Visual mapping
// ---------------------------------------------------------------------------

/**
 * Map a phase key onto the indicator's `{ role, state }`. The
 * caller passes this as `phaseVisual` to TugProgressIndicator.
 * Mapping:
 *
 *  - `offline`, `errored`        → `{ role: danger,  state: aborted }`
 *  - `restoring`, `interrupting` → `{ role: caution, state: running }`
 *  - `awaiting_approval`         → `{ role: caution, state: running }`
 *  - `ready`                     → `{ role: success, state: running }`
 *  - active stream phases        → `{ role: action,  state: running }`
 *  - `background`                → `{ role: action,  state: running, shape: diamond }`
 *  - `idle`                      → `{ role: inherit, state: stopped }`
 *
 * `action` (Key) is the canonical "work in flight" tone across the
 * design system. `success` is reserved for the "done" reading
 * (`state: completed`) — paired together they give a clear
 * key-while-running → green-when-finished story. `ready` is the one
 * place that pairing is deliberately crossed: green while running, for
 * a session whose work is finished and whose next move is a person's.
 * Nothing else on the session dot has ever worn `success`, so
 * green-and-breathing means exactly one thing across the room, and the
 * pulse is truthful on Awaiting's own argument — what is depicted is a
 * live wait on the user, not a settled session.
 *
 * `background` breathes: agents launched by a committed turn are
 * executing this instant, which is exactly what `running` claims, so
 * the liveness rule is satisfied rather than bent. It takes the
 * working tone too, because the tone is the truthful one — the
 * session IS working — and it separates from a live turn on **shape**
 * instead: the same cobalt mark, turned 45°, shedding a pulse turned
 * with it. The quiet `inherit` tone this used to wear made the dot
 * read as Idle-with-a-twitch, which is the one thing it is not. Idle
 * owns `inherit`; nothing that is working may borrow it.
 */
export function sessionSessionPhaseVisual(phaseKey: string): TugProgressIndicatorPhaseVisual {
  switch (phaseKey as SessionPhaseKey) {
    case "offline":
    case "errored":
      return { role: "danger", state: "aborted" };
    case "restoring":
    case "interrupting":
      return { role: "caution", state: "running" };
    case "stop_stalled":
      // Still breathing, and still caution: the turn is not over, the
      // card is not wedged, and the one thing that changed is that the
      // stop the user asked for has not been answered. A still glyph
      // here would read as a settled session, which is the lie.
      return { role: "caution", state: "running" };
    case "awaiting_approval":
      // The turn is IN FLIGHT — opened, parked on the user, and resuming the
      // instant they answer — so the session's dot pulses, in caution rather
      // than the working tone. This is the state most in need of being seen
      // from across the room, and a still glyph is the one thing that cannot
      // be. See `indicator-liveness`.
      return { role: "caution", state: "running" };
    case "ready":
      return { role: "success", state: "running" };
    case "background":
      return { role: "action", state: "running", shape: "diamond" };
    case "submitting":
    case "awaiting_first_token":
    case "streaming":
    case "tool_work":
    case "replaying":
    case "waking":
      return { role: "action", state: "running" };
    case "idle":
    default:
      return { role: "inherit", state: "stopped" };
  }
}
