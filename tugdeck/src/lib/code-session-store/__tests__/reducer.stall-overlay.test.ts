/**
 * reducer — the stream-stall timer and the `streamStalled` flag behind the
 * `stalled` overlay.
 *
 * The claim, in one sentence: a live turn that goes quiet says so, and
 * nothing else about the card changes.
 *
 * **There is no fake `TimerSource` here, and that is deliberate.** The
 * reducer is pure: it never holds a clock. What it does is *emit* the
 * `schedule_timer` / `cancel_timer` effects the impure store wrapper hands
 * to `setTimeout`, and consume the `tick_stream_stall` that wrapper
 * dispatches back. So the honest test of the arming rule is the effect the
 * reducer returns, and the honest test of the tick is the tick dispatched
 * directly — a fake clock in between would only be testing `setTimeout`.
 *
 * The one half that does not live in the reducer is the cancel: it is a
 * phase transition, so `streamStallCancelEffect` is exercised here as the
 * pure function the wrapper calls, with the phase pair it would see.
 *
 * Pins:
 *   - an `api_retry` carrying `ECONNRESET` raises the overlay; one carrying
 *     `rate_limit` does not (through `deriveLifecycleSnapshot`, which is
 *     where the two arms meet),
 *   - a live turn silent past the deadline raises `streamStalled`; a stream
 *     event clears it and re-arms the timer,
 *   - the timer is not armed outside a live turn, so an idle card never
 *     reads stalled,
 *   - `enterErrored` clears `streamStalled` and the wrapper's rule cancels
 *     the timer behind it.
 */

import { describe, it, expect } from "bun:test";

import {
  reduce,
  createInitialState,
  streamStallEffect,
  streamStallCancelEffect,
  STREAM_SILENCE_STALL_MS,
  type CodeSessionState,
} from "@/lib/code-session-store/reducer";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";
import type { Effect } from "@/lib/code-session-store/effects";
import { deriveLifecycleSnapshot } from "@/lib/code-session-store/lifecycle-state";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";

function fresh(): CodeSessionState {
  return createInitialState(FIXTURE_IDS.TUG_SESSION_ID, "test", "new");
}

function send(turnKey = "k1"): CodeSessionEvent {
  return {
    type: "send",
    text: "hi",
    atoms: [],
    content: [{ type: "text" as const, text: "hi" }],
    turnKey,
  } as CodeSessionEvent;
}

function assistantText(msgId = "m1", text = "ok"): CodeSessionEvent {
  return {
    type: "assistant_text",
    msg_id: msgId,
    block_index: 0,
    text,
    is_partial: false,
  } as CodeSessionEvent;
}

function apiRetry(error: string, errorStatus: number | null): CodeSessionEvent {
  return {
    type: "api_retry",
    attempt: 3,
    maxRetries: 10,
    deadline: 1_700_000_010_000,
    error,
    errorStatus,
  } as CodeSessionEvent;
}

const TICK: CodeSessionEvent = { type: "tick_stream_stall" };

function applyAll(
  state: CodeSessionState,
  events: ReadonlyArray<CodeSessionEvent>,
): CodeSessionState {
  let current = state;
  for (const ev of events) current = reduce(current, ev).state;
  return current;
}

/** The overlay set the card actually paints, for a reducer state. */
function overlays(state: CodeSessionState): ReadonlySet<string> {
  return deriveLifecycleSnapshot({
    phase: state.phase,
    transportState: state.transportState,
    interruptInFlight: state.interruptInFlight,
    stopStalled: state.stopStalled,
    streamStalled: state.streamStalled,
    apiRetry: state.apiRetry,
    transcript: [],
  }).overlays;
}

function schedules(effects: ReadonlyArray<Effect>): Effect[] {
  return effects.filter(
    (e) =>
      (e.kind === "schedule_timer" || e.kind === "cancel_timer") &&
      e.name === "stream_stall",
  );
}

// ---------------------------------------------------------------------------
// Arm (a): claude's own connection report
// ---------------------------------------------------------------------------

describe("stall overlay — claude's retry announcement", () => {
  it("an ECONNRESET retry raises the overlay", () => {
    const state = applyAll(fresh(), [send(), apiRetry("ECONNRESET", null)]);
    expect(overlays(state).has("stalled")).toBe(true);
  });

  it("a rate_limit retry does not", () => {
    // The category discriminator doing its job: claude being throttled is
    // not the network failing, and the card should not say it is.
    const state = applyAll(fresh(), [send(), apiRetry("rate_limit", 429)]);
    expect(overlays(state).has("stalled")).toBe(false);
  });

  it("a stream event drops it, with no clear of its own", () => {
    // The interaction `foldStreamEvent` already had: it nulls `apiRetry` on
    // every live stream event, because claude's SDK only resumes streaming
    // once a retried request succeeds. So recovery self-clears.
    const stalled = applyAll(fresh(), [send(), apiRetry("ECONNRESET", null)]);
    expect(overlays(stalled).has("stalled")).toBe(true);

    const recovered = reduce(stalled, assistantText()).state;
    expect(recovered.apiRetry).toBeNull();
    expect(overlays(recovered).has("stalled")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Arm (b): a turn that simply goes quiet
// ---------------------------------------------------------------------------

describe("stall overlay — a live turn that goes silent", () => {
  it("the tick raises streamStalled and nothing else", () => {
    const live = applyAll(fresh(), [send(), assistantText()]);
    const after = reduce(live, TICK).state;

    expect(after.streamStalled).toBe(true);
    expect(overlays(after).has("stalled")).toBe(true);
    // The whole of what it does NOT do: no turn committed, no error
    // stamped, no interrupt implied.
    expect(after.pendingTurn).toBe(live.pendingTurn);
    expect(after.lastError).toBeNull();
    expect(after.phase).toBe(live.phase);
    expect(after.interruptInFlight).toBe(false);
  });

  it("Stop stays Stop while stalled", () => {
    // Said against the projection the button actually reads, because this
    // is the sentence the state exists for.
    const stalled = reduce(
      applyAll(fresh(), [send(), assistantText()]),
      TICK,
    ).state;
    expect(
      deriveLifecycleSnapshot({
        phase: stalled.phase,
        transportState: stalled.transportState,
        interruptInFlight: stalled.interruptInFlight,
        stopStalled: stalled.stopStalled,
        streamStalled: stalled.streamStalled,
        apiRetry: stalled.apiRetry,
        transcript: [],
      }).submitButtonMode,
    ).toEqual({ kind: "stop" });
  });

  it("a stream event clears it and re-arms the timer", () => {
    const stalled = reduce(
      applyAll(fresh(), [send(), assistantText()]),
      TICK,
    ).state;
    expect(stalled.streamStalled).toBe(true);

    const { state: recovered, effects } = reduce(stalled, assistantText("m2"));
    expect(recovered.streamStalled).toBe(false);
    expect(schedules(effects)).toEqual([
      {
        kind: "schedule_timer",
        name: "stream_stall",
        ms: STREAM_SILENCE_STALL_MS,
        fire: { type: "tick_stream_stall" },
      },
    ]);
  });

  it("every stream event re-arms, so the timer measures the last gap", () => {
    // The re-arm is what makes the deadline mean "since the last event"
    // rather than "since the turn opened". A `schedule_timer` with a live
    // name cancels the prior one at the wrapper.
    let state = applyAll(fresh(), [send()]);
    for (const ev of [
      assistantText("m1"),
      assistantText("m1", "more"),
      assistantText("m1", "more still"),
    ]) {
      const step = reduce(state, ev);
      state = step.state;
      expect(schedules(step.effects)).toHaveLength(1);
      expect(schedules(step.effects)[0]?.kind).toBe("schedule_timer");
    }
  });
});

// ---------------------------------------------------------------------------
// The timer's life — armed only where a stall means something
// ---------------------------------------------------------------------------

describe("stall timer — armed only inside a live turn", () => {
  it("arms in every phase where the far end owes content", () => {
    for (const phase of [
      "submitting",
      "awaiting_first_token",
      "streaming",
      "tool_work",
      "waking",
    ] as const) {
      expect(streamStallEffect(phase)).toEqual({
        kind: "schedule_timer",
        name: "stream_stall",
        ms: STREAM_SILENCE_STALL_MS,
        fire: { type: "tick_stream_stall" },
      });
    }
  });

  it("cancels rather than arms everywhere else", () => {
    // `awaiting_approval` is the one worth naming: a turn parked on a
    // dialog is silent because the user has not answered, and calling that
    // a network stall would blame the wire for the user's own wait.
    for (const phase of [
      "idle",
      "errored",
      "replaying",
      "awaiting_approval",
    ] as const) {
      expect(streamStallEffect(phase)).toEqual({
        kind: "cancel_timer",
        name: "stream_stall",
      });
    }
  });

  it("an idle card never reads stalled, however the tick arrives", () => {
    const idle = fresh();
    expect(idle.phase).toBe("idle");
    const after = reduce(idle, TICK).state;
    expect(after.streamStalled).toBe(false);
    // Same state reference: a dropped tick costs nothing.
    expect(after).toBe(idle);
  });

  it("a tick that races a turn's end is dropped", () => {
    const ended = applyAll(fresh(), [
      send(),
      assistantText(),
      { type: "turn_complete", msg_id: "m1", result: "success" } as CodeSessionEvent,
    ]);
    expect(reduce(ended, TICK).state.streamStalled).toBe(false);
  });

  it("the tick is idempotent on an already-raised flag", () => {
    const stalled = reduce(
      applyAll(fresh(), [send(), assistantText()]),
      TICK,
    ).state;
    const again = reduce(stalled, TICK).state;
    expect(again).toBe(stalled);
  });
});

// ---------------------------------------------------------------------------
// The cancel rule — the half the wrapper owns
// ---------------------------------------------------------------------------

describe("streamStallCancelEffect — leaving a live turn cancels", () => {
  it("cancels on every exit from a watched phase", () => {
    for (const next of ["idle", "errored", "replaying", "awaiting_approval"] as const) {
      expect(streamStallCancelEffect("streaming", next)).toEqual({
        kind: "cancel_timer",
        name: "stream_stall",
      });
    }
  });

  it("says nothing about a move between two watched phases", () => {
    // The arm rides the stream event, so a `streaming → tool_work` step
    // must not cancel the timer the event just set.
    expect(streamStallCancelEffect("streaming", "tool_work")).toBeNull();
    expect(streamStallCancelEffect("submitting", "awaiting_first_token")).toBeNull();
  });

  it("says nothing when no turn was open to begin with", () => {
    expect(streamStallCancelEffect("idle", "replaying")).toBeNull();
    expect(streamStallCancelEffect("errored", "idle")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The endings that clear the flag
// ---------------------------------------------------------------------------

describe("stall flag — every ending clears it", () => {
  it("a terminal clears it through enterErrored", () => {
    const stalled = reduce(
      applyAll(fresh(), [send(), assistantText()]),
      TICK,
    ).state;
    expect(stalled.streamStalled).toBe(true);

    const errored = reduce(stalled, {
      type: "session_unknown",
      detail: "session_unknown",
    } as CodeSessionEvent).state;
    expect(errored.phase).toBe("errored");
    expect(errored.streamStalled).toBe(false);
    // …and the wrapper's rule cancels the timer behind it.
    expect(streamStallCancelEffect(stalled.phase, errored.phase)).toEqual({
      kind: "cancel_timer",
      name: "stream_stall",
    });
  });

  it("a turn end clears it", () => {
    const stalled = reduce(
      applyAll(fresh(), [send(), assistantText()]),
      TICK,
    ).state;
    const ended = reduce(stalled, {
      type: "turn_complete",
      msg_id: "m1",
      result: "success",
    } as CodeSessionEvent).state;
    expect(ended.streamStalled).toBe(false);
  });

  it("the next send clears it", () => {
    const stalled = reduce(
      applyAll(fresh(), [send(), assistantText()]),
      TICK,
    ).state;
    const ended = reduce(stalled, {
      type: "turn_complete",
      msg_id: "m1",
      result: "success",
    } as CodeSessionEvent).state;
    const next = reduce(ended, send("k2")).state;
    expect(next.streamStalled).toBe(false);
  });
});
