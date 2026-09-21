/**
 * reducer — a prompt the network cannot carry is held, not refused.
 *
 * The claim, in one sentence: when something has already failed — claude
 * reporting a connection retry, a live turn gone silent, or the host
 * reporting no route at all — a submission enters the queue it would have
 * entered mid-turn, carrying `held`, and waits there for an event that proves
 * the path.
 *
 * Three things this file exists to keep true, beyond the happy path:
 *
 *   - **Nothing is gated on the positive reading.** A send is held only on a
 *     negative that has already happened. There is no test here for "held
 *     because the path was not yet satisfied", because there is no such rule
 *     — a captive portal reports `satisfied` while answering everything with
 *     its login page, so the positive proves nothing and licenses nothing.
 *   - **Release is a state change, and the send that follows is the ordinary
 *     flush.** No timer, no probe, no retry loop: the events are a stream
 *     event, a turn ending, and the host's transition into `satisfied`.
 *   - **A turn that exhausts its retries returns its words to the composer**
 *     ([P07]), through `pendingDraftRestore` and never back onto the queue.
 *     A re-send would write a second user record into claude's JSONL and the
 *     next `--resume` would replay both.
 *
 * The reducer is pure, so everything here is events in and state + effects
 * out. The one impure half — reading the host's hint at submit, and watching
 * for the transition — lives in the store wrapper and arrives here as
 * `pathUnsatisfied` on the `send` and as the `network_path_satisfied` event.
 */

import { describe, it, expect } from "bun:test";

import {
  reduce,
  createInitialState,
  type CodeSessionState,
} from "@/lib/code-session-store/reducer";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";
import type { Effect } from "@/lib/code-session-store/effects";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";

function fresh(): CodeSessionState {
  return createInitialState(FIXTURE_IDS.TUG_SESSION_ID, "test", "new");
}

function send(
  opts: { turnKey?: string; text?: string; pathUnsatisfied?: boolean } = {},
): CodeSessionEvent {
  const text = opts.text ?? "hi";
  return {
    type: "send",
    text,
    atoms: [],
    content: [{ type: "text" as const, text }],
    turnKey: opts.turnKey ?? "k1",
    ...(opts.pathUnsatisfied === true ? { pathUnsatisfied: true } : {}),
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

function apiRetry(
  attempt: number,
  maxRetries: number,
  error = "ECONNRESET: socket hang up",
): CodeSessionEvent {
  return {
    type: "api_retry",
    attempt,
    maxRetries,
    deadline: 1_700_000_010_000,
    error,
    errorStatus: null,
  } as CodeSessionEvent;
}

function turnComplete(
  result: "success" | "error",
  msgId = "m1",
): CodeSessionEvent {
  return {
    type: "turn_complete",
    tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
    msg_id: msgId,
    result,
  } as CodeSessionEvent;
}

const TICK_STALL: CodeSessionEvent = { type: "tick_stream_stall" };
const PATH_SATISFIED: CodeSessionEvent = { type: "network_path_satisfied" };

function step(
  state: CodeSessionState,
  event: CodeSessionEvent,
): { state: CodeSessionState; effects: Effect[] } {
  return reduce(state, event);
}

function applyAll(
  state: CodeSessionState,
  events: ReadonlyArray<CodeSessionEvent>,
): CodeSessionState {
  let current = state;
  for (const ev of events) current = reduce(current, ev).state;
  return current;
}

function sendFrames(effects: ReadonlyArray<Effect>): Effect[] {
  return effects.filter((e) => e.kind === "send-frame");
}

describe("held prompt: what puts a submission on hold", () => {
  it("holds a submission made while the card is stalled", () => {
    // A live turn that has gone silent past its deadline is the `stalled`
    // overlay's second arm. A prompt submitted into that turn is waiting for
    // the network, not merely for the turn.
    const live = applyAll(fresh(), [send({ turnKey: "k1" }), TICK_STALL]);
    expect(live.streamStalled).toBe(true);

    const { state, effects } = step(live, send({ turnKey: "k2", text: "next" }));
    expect(state.queuedSends.length).toBe(1);
    expect(state.queuedSends[0].held).toBe(true);
    expect(sendFrames(effects)).toEqual([]);
  });

  it("holds a submission made while claude is retrying a connection failure", () => {
    // The overlay's first arm: claude's own report, classified as a
    // connection failure. The same hold follows from it.
    const live = applyAll(fresh(), [send({ turnKey: "k1" }), apiRetry(2, 10)]);
    const { state } = step(live, send({ turnKey: "k2", text: "next" }));
    expect(state.queuedSends[0].held).toBe(true);
  });

  it("holds an idle submission when the host reports no route", () => {
    // The believed half of the path hint. An idle card would ordinarily send
    // this straight to the wire; with no route at all it queues instead, and
    // the phase does not move — nothing was sent, so nothing is in flight.
    const { state, effects } = step(
      fresh(),
      send({ pathUnsatisfied: true, text: "on a plane" }),
    );
    expect(state.phase).toBe("idle");
    expect(state.queuedSends.length).toBe(1);
    expect(state.queuedSends[0].held).toBe(true);
    expect(state.queuedSends[0].text).toBe("on a plane");
    expect(sendFrames(effects)).toEqual([]);
  });

  it("sends an idle submission with neither negative standing", () => {
    // The no-regression case, and the reason the two rules above are written
    // as negatives: absent evidence of failure, the send goes.
    const { state, effects } = step(fresh(), send());
    expect(state.phase).toBe("submitting");
    expect(state.queuedSends.length).toBe(0);
    expect(sendFrames(effects).length).toBe(1);
  });

  it("queues a healthy mid-turn submission unheld, exactly as before", () => {
    const live = step(fresh(), send({ turnKey: "k1" })).state;
    const { state, effects } = step(live, send({ turnKey: "k2", text: "next" }));
    expect(state.queuedSends.length).toBe(1);
    expect(state.queuedSends[0].held).toBe(false);
    expect(sendFrames(effects)).toEqual([]);
  });
});

describe("held prompt: what releases one", () => {
  it("releases on a stream event — the path proving itself", () => {
    // No monitor needed: content flowing is the strongest possible evidence
    // that the path carries traffic.
    const stalled = applyAll(fresh(), [
      send({ turnKey: "k1" }),
      TICK_STALL,
      send({ turnKey: "k2", text: "next" }),
    ]);
    expect(stalled.queuedSends[0].held).toBe(true);

    const flowing = step(stalled, assistantText()).state;
    expect(flowing.streamStalled).toBe(false);
    expect(flowing.queuedSends[0].held).toBe(false);
    // Released, not sent: the entry is still queued, and the turn's own end
    // is what flushes it.
    expect(flowing.queuedSends.length).toBe(1);
  });

  it("releases on the host's transition to satisfied, and flushes at idle", () => {
    // An idle card has no turn ending to flush against — this transition is
    // the only event it will ever get, so the release reaches the flush here
    // rather than stranding the words forever.
    const held = step(fresh(), send({ pathUnsatisfied: true })).state;
    expect(held.queuedSends[0].held).toBe(true);

    const { state, effects } = step(held, PATH_SATISFIED);
    expect(state.phase).toBe("submitting");
    expect(state.queuedSends.length).toBe(0);
    expect(sendFrames(effects).length).toBe(1);
  });

  it("releases mid-turn without sending anything of its own", () => {
    // The turn in flight owns the wire. Release is a state change; the flush
    // that was already going to happen at the turn's end does the sending.
    const stalled = applyAll(fresh(), [
      send({ turnKey: "k1" }),
      TICK_STALL,
      send({ turnKey: "k2", text: "next" }),
    ]);
    const { state, effects } = step(stalled, PATH_SATISFIED);
    expect(state.phase).not.toBe("idle");
    expect(state.queuedSends.length).toBe(1);
    expect(state.queuedSends[0].held).toBe(false);
    expect(sendFrames(effects)).toEqual([]);
  });

  it("a repeat of the same path report changes nothing", () => {
    // The store wrapper only dispatches on a transition, but the reducer is
    // asked to be inert anyway: an already-released queue keeps its array
    // reference, which is what keeps [L02] consumers from re-rendering.
    const live = applyAll(fresh(), [
      send({ turnKey: "k1" }),
      send({ turnKey: "k2", text: "next" }),
    ]);
    const after = step(live, PATH_SATISFIED).state;
    expect(after.queuedSends).toBe(live.queuedSends);
    expect(after).toBe(live);
  });

  it("a turn that ends flushes a held head, having proved the path", () => {
    const stalled = applyAll(fresh(), [
      send({ turnKey: "k1" }),
      assistantText("m1", "partial"),
      TICK_STALL,
      send({ turnKey: "k2", text: "next" }),
    ]);
    expect(stalled.queuedSends[0].held).toBe(true);

    const { state, effects } = step(stalled, turnComplete("success"));
    expect(state.phase).toBe("submitting");
    expect(state.queuedSends.length).toBe(0);
    expect(sendFrames(effects).length).toBe(1);
  });
});

describe("held prompt: exhausted retries return to the composer ([P07])", () => {
  it("lands the text in pendingDraftRestore and enqueues nothing", () => {
    // The turn ends having produced nothing but the user's own message, with
    // claude out of retries. The words go back to the composer; the attempt
    // stays in the transcript as the interrupted turn it was.
    const attempted = applyAll(fresh(), [
      send({ text: "the prompt that never landed" }),
      apiRetry(10, 10),
    ]);
    const { state } = step(attempted, turnComplete("error"));

    expect(state.pendingDraftRestore).not.toBeNull();
    expect(state.pendingDraftRestore?.text).toBe(
      "the prompt that never landed",
    );
    expect(state.queuedSends.length).toBe(0);
  });

  it("does not re-send it — there is no re-send path", () => {
    const attempted = applyAll(fresh(), [send(), apiRetry(10, 10)]);
    const { effects } = step(attempted, turnComplete("error"));
    expect(sendFrames(effects)).toEqual([]);
  });

  it("leaves a turn that merely retried and recovered alone", () => {
    // Retries that were not exhausted are ordinary weather. The turn
    // succeeded, so nothing goes back to the composer.
    const recovered = applyAll(fresh(), [
      send(),
      apiRetry(3, 10),
      assistantText("m1", "answer"),
    ]);
    const { state } = step(recovered, turnComplete("success"));
    expect(state.pendingDraftRestore).toBeNull();
  });
});
