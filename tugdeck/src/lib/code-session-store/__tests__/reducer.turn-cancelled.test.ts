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
      seq: 0,
      rev: 0,
      status: "partial",
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

describe("reducer — interrupt_noop: the user's Stop always stops", () => {
  function noopEvent(
    reason: "no_process" | "no_turn" = "no_turn",
  ): CodeSessionEvent {
    return { type: "interrupt_noop", reason } as CodeSessionEvent;
  }

  // The 2026-10-25 stuck card: the deck missed the frames that ended its
  // turn, so it held the turn open; every Stop reached tugcode, which had no
  // turn and said so, and the card stayed on Stop. tugcode is the only writer
  // of that turn's end, so `no_turn` is the end.
  it("no_turn over a turn the deck still holds commits it as interrupted", () => {
    const mid = caseBInterrupt();
    const { state, effects } = applyAll(mid, [noopEvent("no_turn")]);
    expect(state.interruptInFlight).toBe(false);
    expect(state.pendingInterruptReason).toBeNull();
    expect(state.interruptInFlightSegmentStartedAt).toBeNull();
    expect(state.stopStalled).toBe(false);
    expect(state.phase).toBe("idle");
    expect(state.pendingTurn).toBeNull();
    const entries = appended(effects);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entry.result).toBe("interrupted");
    expect(entries[0]!.entry.msgId).toBe("m1");
  });

  it("no_turn over a turn with no Stop in flight still ends it", () => {
    // The receipt is the bridge's word that no turn is open, whatever the
    // deck's flags say by the time it lands.
    const { state } = applyAll(streamingTurn(), [noopEvent("no_turn")]);
    expect(state.phase).toBe("idle");
    expect(state.pendingTurn).toBeNull();
  });

  it("no_process over an open turn offers Force Stop instead of ending it", () => {
    // A claude being put back under the card may yet run the turn, so the
    // turn stands — and the stop control becomes Force Stop, whose answer
    // settles the card either way.
    const mid = caseBInterrupt();
    const { state, effects } = applyAll(mid, [noopEvent("no_process")]);
    expect(state.interruptInFlight).toBe(false);
    expect(state.stopStalled).toBe(true);
    expect(appended(effects)).toHaveLength(0);
    expect(state.pendingTurn).toBe(mid.pendingTurn);
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

describe("reducer — stop_all_work_done settles a turn nothing else will end", () => {
  it("Force Stop's answer commits a turn no turn_cancelled closed", () => {
    // tugcode writes its cancel during the teardown, before `done`; a turn
    // the deck still holds when `done` lands had no tugcode turn behind it.
    const stalled = applyAll(caseBInterrupt(), [
      { type: "interrupt_noop", reason: "no_process" } as CodeSessionEvent,
    ]).state;
    expect(stalled.stopStalled).toBe(true);
    const { state, effects } = applyAll(stalled, [
      { type: "stop_all_work_done" } as CodeSessionEvent,
    ]);
    expect(state.stopStalled).toBe(false);
    expect(state.phase).toBe("idle");
    expect(state.pendingTurn).toBeNull();
    expect(appended(effects)).toHaveLength(1);
  });

  it("after a turn_cancelled already committed, done only clears the flag", () => {
    const stalled = applyAll(caseBInterrupt(), [
      { type: "interrupt_noop", reason: "no_process" } as CodeSessionEvent,
      cancelEvent({ is_recovery: true }),
    ]).state;
    const { effects } = applyAll(stalled, [
      { type: "stop_all_work_done" } as CodeSessionEvent,
    ]);
    expect(appended(effects)).toHaveLength(0);
  });
});
