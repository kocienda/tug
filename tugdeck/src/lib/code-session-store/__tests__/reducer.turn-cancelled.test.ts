/**
 * Reducer tests for `turn_cancelled` — the cancel receipt tugcode writes when
 * a turn ends with `ActiveTurn.interrupted` set, and which the deck dropped at
 * the `KNOWN_CODE_OUTPUT_TYPES` guard until this handler existed.
 *
 * The defect the handler closes: after a CASE B interrupt, the only clearer of
 * `interruptInFlight` was `turn_complete`. When the escalation ladder ran — a
 * wedged claude, which is what a bad network produces — the ladder's receipt
 * was this frame, so nothing ended the turn and the card read "Interrupting"
 * with no frame able to settle it.
 *
 * `canSubmit` lives on the store snapshot (it conjoins phase with transport
 * health), so its reducer-level stand-in here is `phase === "idle"`; the
 * composer's own recovery is pinned by `at0610-turn-cancelled-settles-card`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import {
  reduce,
  createInitialState,
  type CodeSessionState,
} from "@/lib/code-session-store/reducer";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";
import type {
  AppendTranscriptEffect,
  Effect,
  SendFrameEffect,
} from "@/lib/code-session-store/effects";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";

function fresh(): CodeSessionState {
  return createInitialState(FIXTURE_IDS.TUG_SESSION_ID, "test", "new");
}

function appended(effects: ReadonlyArray<Effect>) {
  return effects.filter(
    (e): e is AppendTranscriptEffect => e.kind === "append-transcript",
  );
}

function sentFrames(effects: ReadonlyArray<Effect>) {
  return effects.filter((e): e is SendFrameEffect => e.kind === "send-frame");
}

function applyAll(
  state: CodeSessionState,
  events: ReadonlyArray<CodeSessionEvent>,
): { state: CodeSessionState; effects: Effect[] } {
  let current = state;
  const collected: Effect[] = [];
  for (const ev of events) {
    const r = reduce(current, ev);
    current = r.state;
    collected.push(...r.effects);
  }
  return { state: current, effects: collected };
}

let now = 0;
let originalDateNow: () => number;
beforeEach(() => {
  now = 3_000_000_000;
  originalDateNow = Date.now;
  Date.now = () => now;
});
afterEach(() => {
  Date.now = originalDateNow;
});

function sendEvent(turnKey: string, text: string): CodeSessionEvent {
  return {
    type: "send",
    text,
    atoms: [],
    content: [{ type: "text" as const, text }],
    turnKey,
  };
}

/** A live turn that has streamed one assistant block. */
function streamingTurn(): CodeSessionState {
  return applyAll(fresh(), [
    sendEvent("k1", "hi"),
    {
      type: "assistant_text",
      msg_id: "m1",
      block_index: 0,
      text: "partial",
      is_partial: true,
    },
  ]).state;
}

/** That turn, with the user's Stop in flight (CASE B — content had arrived). */
function caseBInterrupt(): CodeSessionState {
  return applyAll(streamingTurn(), [{ type: "interrupt_action" }]).state;
}

function cancelEvent(
  overrides: Partial<{
    msg_id: string;
    partial_result: string;
    is_recovery: boolean;
  }> = {},
): CodeSessionEvent {
  return {
    type: "turn_cancelled",
    msg_id: "m1",
    seq: 7,
    partial_result: "User interrupted",
    ...overrides,
  } as CodeSessionEvent;
}

describe("reducer — turn_cancelled settles the interrupted turn", () => {
  it("the CASE B state under test really is stuck without the frame", () => {
    // Pins the defect's shape, so this file fails loudly if the flag's
    // clearing ever moves somewhere a cancel no longer reaches.
    const mid = caseBInterrupt();
    expect(mid.interruptInFlight).toBe(true);
    expect(mid.phase).not.toBe("idle");
    expect(mid.interruptInFlightSegmentStartedAt).not.toBeNull();
  });

  it("commits one interrupted turn, clears the flag, and returns to idle", () => {
    const { state, effects } = applyAll(caseBInterrupt(), [cancelEvent()]);
    const entries = appended(effects);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entry.result).toBe("interrupted");
    expect(entries[0]!.entry.turnEndReason).toBe("interrupted");
    expect(state.phase).toBe("idle");
    expect(state.interruptInFlight).toBe(false);
    expect(state.pendingInterruptReason).toBeNull();
    expect(state.pendingTurn).toBeNull();
    expect(state.activeMsgId).toBeNull();
    // The in-flight document is released, so the card stops painting a
    // streaming row for a turn that has ended.
    expect(effects.some((e) => e.kind === "clear-inflight")).toBe(true);
  });

  it("closes the interrupt-in-flight segment onto the intervals array", () => {
    const mid = caseBInterrupt();
    const opened = mid.interruptInFlightSegmentStartedAt!;
    now += 4_000;
    const { state } = applyAll(mid, [cancelEvent()]);
    expect(state.interruptInFlightSegmentStartedAt).toBeNull();
    expect(state.interruptInFlightIntervals).toEqual([[opened, now]]);
  });

  it("a cancel with no is_recovery reads as a user cancel", () => {
    const { effects } = applyAll(caseBInterrupt(), [cancelEvent()]);
    expect(appended(effects)[0]!.entry.interruptReason).toBeUndefined();
  });

  it("a recovery cancel ends the turn and names recovery as the cause", () => {
    const { state, effects } = applyAll(streamingTurn(), [
      cancelEvent({ is_recovery: true }),
    ]);
    const entry = appended(effects)[0]!.entry;
    // Ends the turn identically — the difference is presentation only.
    expect(entry.result).toBe("interrupted");
    expect(state.phase).toBe("idle");
    // And the badge names tugcode's recovery rather than a stop the user
    // never asked for.
    expect(entry.interruptReason).toBe("recovery");
    // Nothing announces it: no banner state is raised on the way through.
    expect(state.lastError).toBeNull();
    expect(state.apiRetry).toBeNull();
  });

  it("an app-flow interrupt keeps its own reason under a recovery cancel", () => {
    const mid = applyAll(streamingTurn(), [
      { type: "interrupt_action", reason: "logout" },
    ]).state;
    const { effects } = applyAll(mid, [cancelEvent({ is_recovery: true })]);
    expect(appended(effects)[0]!.entry.interruptReason).toBe("logout");
  });

  it("partial_result lands in a turn that streamed nothing", () => {
    // No content frame reached the deck, so the frame's text is the only
    // copy of what claude produced.
    const opened = applyAll(fresh(), [sendEvent("k1", "hi")]).state;
    const { effects } = applyAll(opened, [
      cancelEvent({ partial_result: "half a thought" }),
    ]);
    const messages = appended(effects)[0]!.entry.messages;
    const assistant = messages.filter((m) => m.kind === "assistant_text");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.text).toBe("half a thought");
  });

  it("the nothing-streamed sentinel never enters the transcript", () => {
    const opened = applyAll(fresh(), [sendEvent("k1", "hi")]).state;
    const { effects } = applyAll(opened, [
      cancelEvent({ partial_result: "User interrupted" }),
    ]);
    const messages = appended(effects)[0]!.entry.messages;
    expect(messages.some((m) => m.kind === "assistant_text")).toBe(false);
  });

  it("partial_result does not double text the content frames already wrote", () => {
    const { effects } = applyAll(caseBInterrupt(), [
      cancelEvent({ partial_result: "partial" }),
    ]);
    const assistant = appended(effects)[0]!.entry.messages.filter(
      (m) => m.kind === "assistant_text",
    );
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.text).toBe("partial");
  });

  it("a cancel with no turn in flight is dropped, state reference intact", () => {
    const idle = fresh();
    const result = reduce(idle, cancelEvent());
    expect(result.state).toBe(idle);
    expect(result.effects).toEqual([]);
  });

  it("a second cancel for an already-committed turn is dropped", () => {
    const { state: settled } = applyAll(caseBInterrupt(), [cancelEvent()]);
    const again = reduce(settled, cancelEvent());
    expect(again.state).toBe(settled);
    expect(again.effects).toEqual([]);
  });

  it("a queued send flushes on the cancel", () => {
    // The recovery path is where this matters: the user stopped nothing, so
    // the message they posted mid-turn is waiting for this turn boundary.
    const queued = applyAll(streamingTurn(), [
      sendEvent("k2", "and also this"),
    ]).state;
    expect(queued.queuedSends).toHaveLength(1);

    const { state, effects } = applyAll(queued, [
      cancelEvent({ is_recovery: true }),
    ]);
    expect(state.queuedSends).toHaveLength(0);
    expect(state.phase).toBe("submitting");
    expect(state.pendingTurn?.turnKey).toBe("k2");
    const sent = sentFrames(effects);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg.type).toBe("user_message");
  });
});

describe("reducer — interrupt_noop ends the interrupt, not the turn", () => {
  function noopEvent(
    reason: "no_process" | "no_turn" = "no_turn",
  ): CodeSessionEvent {
    return { type: "interrupt_noop", reason } as CodeSessionEvent;
  }

  it("clears the per-interrupt flags and leaves the transcript untouched", () => {
    const mid = caseBInterrupt();
    const { state, effects } = applyAll(mid, [noopEvent()]);
    expect(state.interruptInFlight).toBe(false);
    expect(state.pendingInterruptReason).toBeNull();
    expect(state.interruptInFlightSegmentStartedAt).toBeNull();
    // No turn ended, because by construction tugcode had none to end.
    expect(appended(effects)).toHaveLength(0);
    expect(effects).toEqual([]);
    expect(state.phase).toBe(mid.phase);
    expect(state.pendingTurn).toBe(mid.pendingTurn);
    expect(state.scratch).toBe(mid.scratch);
  });

  it("closes the in-flight segment so the waiting time is still accounted", () => {
    const mid = caseBInterrupt();
    const opened = mid.interruptInFlightSegmentStartedAt!;
    now += 2_500;
    const { state } = applyAll(mid, [noopEvent("no_process")]);
    expect(state.interruptInFlightIntervals).toEqual([[opened, now]]);
  });

  it("a receipt with no interrupt outstanding is inert", () => {
    const idle = fresh();
    const result = reduce(idle, noopEvent());
    expect(result.state).toBe(idle);
    expect(result.effects).toEqual([]);
  });
});
