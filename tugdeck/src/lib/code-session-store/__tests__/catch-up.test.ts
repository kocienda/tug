/**
 * A dormant body's catch-up — `store.catchUp()` names the turns the card
 * holds by msg-id, the bracket that answers appends without duplicating a
 * turn the card holds, the loaded window keeps its start, and `catchingUp`
 * stands for as long as the bracket does. Driven through the real store and
 * reducer and the recording connection double (the wire contract the store
 * produces).
 *
 * @covers tugdeck/src/lib/code-session-store.ts
 * @covers tugdeck/src/lib/code-session-store/reducer.ts
 */

import { describe, it, expect } from "bun:test";

import { CodeSessionStore } from "@/lib/code-session-store";
import { createInitialState, reduce, type CodeSessionState } from "@/lib/code-session-store/reducer";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { FeedId } from "@/protocol";

const TUG = FIXTURE_IDS.TUG_SESSION_ID;

function makeStore(): { store: CodeSessionStore; conn: TestFrameChannel } {
  const conn = new TestFrameChannel();
  const store = new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: TUG,
    sessionMode: "resume",
  });
  return { store, conn };
}

function emit(conn: TestFrameChannel, evt: Record<string, unknown>): void {
  conn.dispatchDecoded(FeedId.CODE_OUTPUT, { ...evt, tug_session_id: TUG });
}

function emitTurn(conn: TestFrameChannel, n: number): void {
  emit(conn, { type: "add_user_message", content: [{ type: "text", text: `prompt ${n}` }] });
  emit(conn, {
    type: "assistant_text",
    status: "complete",
    msg_id: FIXTURE_IDS.MSG_ID_N(n),
    text: `reply ${n}`,
    is_partial: false,
    rev: 0,
    seq: 0,
  });
  emit(conn, { type: "turn_complete", seq: 0, msg_id: FIXTURE_IDS.MSG_ID_N(n), result: "success" });
}

/** One bracket carrying turns `[lo, hi]` and window meta. */
function replayRange(
  conn: TestFrameChannel,
  lo: number,
  hi: number,
  meta: { firstLoadedTurnIndex: number; totalTurns: number; hasOlder: boolean },
): void {
  emit(conn, { type: "replay_started" });
  for (let n = lo; n <= hi; n++) emitTurn(conn, n);
  emit(conn, { type: "replay_complete", count: hi - lo + 1, ...meta });
}

function controlFramesOf(conn: TestFrameChannel): Array<Record<string, unknown>> {
  return conn.recordedFrames
    .filter((f) => f.feedId === FeedId.CONTROL)
    .map((f) => JSON.parse(new TextDecoder().decode(f.decoded as Uint8Array)) as Record<string, unknown>);
}

describe("catchUp — what a settled card asks for", () => {
  it("names the turns it holds, newest first, with how many it holds", () => {
    const { store, conn } = makeStore();
    // Turns 5–7 of 8 loaded.
    replayRange(conn, 5, 7, { firstLoadedTurnIndex: 5, totalTurns: 8, hasOlder: true });

    store.catchUp();

    const replay = controlFramesOf(conn).find((f) => f.action === "request_replay");
    expect(replay).toBeDefined();
    expect(replay!.reason).toBe("catch-up");
    expect(replay!.window).toEqual({
      afterTurn: { msgIds: [7, 6, 5].map((n) => FIXTURE_IDS.MSG_ID_N(n)), heldTurns: 8 },
    });
    expect(store.getSnapshot().catchingUp).toBe(true);
  });

  it("on a card with no window, counts from turn 0", () => {
    const { store, conn } = makeStore();
    emit(conn, { type: "replay_started" });
    emitTurn(conn, 0);
    emitTurn(conn, 1);
    emit(conn, { type: "replay_complete", count: 2 });

    store.catchUp();

    const replay = controlFramesOf(conn).find((f) => f.action === "request_replay");
    expect(replay!.window).toEqual({
      afterTurn: { msgIds: [1, 0].map((n) => FIXTURE_IDS.MSG_ID_N(n)), heldTurns: 2 },
    });
  });

  it("a card holding no turn names none", () => {
    const { store, conn } = makeStore();
    store.catchUp();
    const replay = controlFramesOf(conn).find((f) => f.action === "request_replay");
    expect(replay!.window).toEqual({ afterTurn: { msgIds: [], heldTurns: 0 } });
  });

  it("names at most its sixteen newest turns", () => {
    const { store, conn } = makeStore();
    replayRange(conn, 0, 19, { firstLoadedTurnIndex: 0, totalTurns: 20, hasOlder: false });
    store.catchUp();
    const replay = controlFramesOf(conn).find((f) => f.action === "request_replay");
    const named = (replay!.window as { afterTurn: { msgIds: string[]; heldTurns: number } }).afterTurn;
    expect(named.msgIds).toEqual(Array.from({ length: 16 }, (_, i) => FIXTURE_IDS.MSG_ID_N(19 - i)));
    expect(named.heldTurns).toBe(20);
  });
});

describe("catchUp — the bracket that answers", () => {
  it("appends the missed turns once, keeps the window's start, and ends the catch-up", () => {
    const { store, conn } = makeStore();
    replayRange(conn, 5, 7, { firstLoadedTurnIndex: 5, totalTurns: 8, hasOlder: true });
    store.catchUp();

    // tugcode answers turns 7 (the overlap) through 10; its window meta
    // describes the slice it sent, which is not the card's window.
    replayRange(conn, 7, 10, { firstLoadedTurnIndex: 7, totalTurns: 11, hasOlder: true });

    const snap = store.getSnapshot();
    expect(snap.transcript.map((t) => t.msgId)).toEqual(
      [5, 6, 7, 8, 9, 10].map((n) => FIXTURE_IDS.MSG_ID_N(n)),
    );
    expect(snap.replayWindow).toEqual({ firstLoadedTurnIndex: 5, totalTurns: 11, hasOlder: true });
    expect(snap.catchingUp).toBe(false);
    expect(snap.phase).toBe("idle");
  });

  it("with nothing new, changes nothing but ends the catch-up", () => {
    const { store, conn } = makeStore();
    replayRange(conn, 5, 7, { firstLoadedTurnIndex: 5, totalTurns: 8, hasOlder: true });
    const before = store.getSnapshot().transcript;
    store.catchUp();
    replayRange(conn, 7, 7, { firstLoadedTurnIndex: 7, totalTurns: 8, hasOlder: true });

    const snap = store.getSnapshot();
    expect(snap.transcript.map((t) => t.msgId)).toEqual(before.map((t) => t.msgId));
    expect(snap.replayWindow).toEqual({ firstLoadedTurnIndex: 5, totalTurns: 8, hasOlder: true });
    expect(snap.catchingUp).toBe(false);
  });

  it("a later ordinary bracket is not a catch-up", () => {
    const { store, conn } = makeStore();
    replayRange(conn, 5, 7, { firstLoadedTurnIndex: 5, totalTurns: 8, hasOlder: true });
    store.catchUp();
    replayRange(conn, 7, 7, { firstLoadedTurnIndex: 7, totalTurns: 8, hasOlder: true });
    // A load-previous after it re-bases the window as it always has.
    store.loadPrevious(2);
    replayRange(conn, 3, 4, { firstLoadedTurnIndex: 3, totalTurns: 8, hasOlder: true });
    expect(store.getSnapshot().replayWindow).toEqual({ firstLoadedTurnIndex: 3, totalTurns: 8, hasOlder: true });
  });
});

describe("catchUp — a card mid-turn", () => {
  it("keeps the cycle it slept through until the bracket supersedes it with the turn, committed", () => {
    const { store, conn } = makeStore();
    replayRange(conn, 0, 1, { firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
    store.send("hi", []);
    const live = store.getSnapshot().phase;
    expect(live).not.toBe("idle");

    store.catchUp();

    const replay = controlFramesOf(conn).find((f) => f.action === "request_replay" && f.reason === "catch-up");
    expect(replay!.window).toEqual({ afterTurn: { msgIds: [1, 0].map((n) => FIXTURE_IDS.MSG_ID_N(n)), heldTurns: 2 } });
    // Nothing is reset on the reveal: the cycle stands until the bracket opens.
    expect(store.getSnapshot()).toMatchObject({ phase: live, catchingUp: true });

    // The turn ended while the body slept: the bracket carries it committed.
    replayRange(conn, 1, 2, { firstLoadedTurnIndex: 1, totalTurns: 3, hasOlder: true });
    const snap = store.getSnapshot();
    expect(snap.transcript.map((t) => t.msgId)).toEqual([0, 1, 2].map((n) => FIXTURE_IDS.MSG_ID_N(n)));
    expect(snap).toMatchObject({ phase: "idle", catchingUp: false });
    expect(snap.replayWindow).toEqual({ firstLoadedTurnIndex: 0, totalTurns: 3, hasOlder: false });
  });

  it("a turn still in flight comes back as the bracket's snapshot, and the live tail ends it once", () => {
    const { store, conn } = makeStore();
    replayRange(conn, 0, 1, { firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
    store.send("hi", []);
    store.catchUp();

    const id = FIXTURE_IDS.MSG_ID_N(2);
    emit(conn, { type: "replay_started" });
    emit(conn, { type: "add_user_message", content: [{ type: "text", text: "hi" }], inflightSnapshot: true });
    emit(conn, { type: "content_block_start", msg_id: id, block_index: 0, kind: "text" });
    emit(conn, { type: "assistant_text", msg_id: id, block_index: 0, seq: 0, rev: 0, text: "so far", is_partial: false, status: "streaming" });
    emit(conn, { type: "replay_complete", count: 0, firstLoadedTurnIndex: 2, totalTurns: 2, hasOlder: true });
    expect(store.getSnapshot()).toMatchObject({ phase: "streaming", catchingUp: false });

    emit(conn, { type: "turn_complete", seq: 1, msg_id: id, result: "success" });
    const snap = store.getSnapshot();
    expect(snap.transcript.map((t) => t.msgId)).toEqual([0, 1, 2].map((n) => FIXTURE_IDS.MSG_ID_N(n)));
    const users = snap.transcript[2].messages.filter((m) => m.kind === "user_message");
    expect(users.length).toBe(1);
    expect(snap.phase).toBe("idle");
  });

  it("a catch-up that never answers leaves the cycle standing", () => {
    const { store, conn } = makeStore();
    replayRange(conn, 0, 1, { firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
    store.send("hi", []);
    const live = store.getSnapshot().phase;
    expect(live).not.toBe("idle");
    const asked = reduce(
      store._getInternalStateForDevPanel(),
      { type: "begin_catch_up" } as CodeSessionEvent,
    ).state;
    const ticked = reduce(asked, { type: "tick_catch_up" } as CodeSessionEvent).state;
    expect(ticked.replayCatchUpActive).toBe(false);
    expect(ticked.phase).toBe(live);
    expect(ticked.pendingTurn).not.toBeNull();
  });
});

describe("catchUp — what the session says before the bracket", () => {
  const WAKE = { type: "wake_started", wake_trigger: { task_id: "t", tool_use_id: "", status: "completed", summary: "done", output_file: "" } };

  /** A live turn's tail, heard from the middle: its last text and its close. */
  function liveTail(conn: TestFrameChannel, n: number): void {
    const id = FIXTURE_IDS.MSG_ID_N(n);
    emit(conn, { type: "assistant_text", status: "complete", msg_id: id, text: "only the tail", is_partial: false, rev: 0, seq: 0 });
    emit(conn, { type: "turn_complete", seq: 0, msg_id: id, result: "success" });
  }

  it("is set aside, so a turn the session began itself comes back whole, once", () => {
    const { store, conn } = makeStore();
    replayRange(conn, 0, 1, { firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
    store.catchUp();
    // The re-scope lands before tugcode reads the ask, and a turn the session
    // began itself is heard live.
    emit(conn, WAKE);
    liveTail(conn, 3);
    expect(store.getSnapshot()).toMatchObject({ phase: "idle", catchingUp: true });
    expect(store.getSnapshot().transcript.map((t) => t.msgId)).toEqual([0, 1].map((n) => FIXTURE_IDS.MSG_ID_N(n)));

    replayRange(conn, 1, 3, { firstLoadedTurnIndex: 1, totalTurns: 4, hasOlder: true });
    const snap = store.getSnapshot();
    expect(snap.transcript.map((t) => t.msgId)).toEqual([0, 1, 2, 3].map((n) => FIXTURE_IDS.MSG_ID_N(n)));
    expect(JSON.stringify(snap.transcript[3])).toContain("reply 3");
    expect(JSON.stringify(snap.transcript[3])).not.toContain("only the tail");
    expect(snap).toMatchObject({ phase: "idle", catchingUp: false });
  });

  it("is set aside over a cycle the card held, so the turn it sent comes back whole", () => {
    const { store, conn } = makeStore();
    replayRange(conn, 0, 1, { firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
    store.send("prompt 2", []);
    store.catchUp();
    liveTail(conn, 2);
    expect(store.getSnapshot().transcript.map((t) => t.msgId)).toEqual([0, 1].map((n) => FIXTURE_IDS.MSG_ID_N(n)));

    replayRange(conn, 1, 2, { firstLoadedTurnIndex: 1, totalTurns: 3, hasOlder: true });
    const snap = store.getSnapshot();
    expect(snap.transcript.map((t) => t.msgId)).toEqual([0, 1, 2].map((n) => FIXTURE_IDS.MSG_ID_N(n)));
    expect(JSON.stringify(snap.transcript[2])).toContain("reply 2");
    expect(JSON.stringify(snap.transcript[2])).not.toContain("only the tail");
    expect(snap).toMatchObject({ phase: "idle", catchingUp: false });
  });

  it("flows again once the bracket has closed", () => {
    const { store, conn } = makeStore();
    replayRange(conn, 0, 1, { firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
    store.catchUp();
    replayRange(conn, 1, 1, { firstLoadedTurnIndex: 1, totalTurns: 2, hasOlder: true });
    emit(conn, WAKE);
    liveTail(conn, 2);
    expect(store.getSnapshot().transcript.map((t) => t.msgId)).toEqual([0, 1, 2].map((n) => FIXTURE_IDS.MSG_ID_N(n)));
  });

  it("flows again at the catch-up's deadline when no bracket comes", () => {
    const { store, conn } = makeStore();
    replayRange(conn, 0, 1, { firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
    const asked = reduce(store._getInternalStateForDevPanel(), { type: "begin_catch_up" } as CodeSessionEvent).state;
    const wake = WAKE as unknown as CodeSessionEvent;
    expect(reduce(asked, wake).state).toBe(asked);
    const ticked = reduce(asked, { type: "tick_catch_up" } as CodeSessionEvent).state;
    expect(ticked.replayCatchUpActive).toBe(false);
    expect(reduce(ticked, wake).state.phase).toBe("waking");
  });
});

describe("catchUp — a card asleep inside a bracket", () => {
  /** A cold read asked for, whose bracket opens and commits turns `[0, upTo]` before the card sleeps. */
  function sleepMidRead(upTo: number, asked: boolean): { store: CodeSessionStore; conn: TestFrameChannel } {
    const made = makeStore();
    if (asked) made.store.noteReplayAsked({ lastTurns: 50 });
    emit(made.conn, { type: "replay_started" });
    for (let n = 0; n <= upTo; n++) emitTurn(made.conn, n);
    // Part of the next turn, then the subscription is gone.
    emit(made.conn, { type: "add_user_message", content: [{ type: "text", text: `prompt ${upTo + 1}` }] });
    return made;
  }

  it("re-asks the window the bracket was asked with, and is never reset", () => {
    const { store, conn } = sleepMidRead(1, true);
    expect(store.getSnapshot().phase).toBe("replaying");

    store.catchUp();

    const replay = controlFramesOf(conn).find((f) => f.action === "request_replay" && f.reason === "catch-up");
    expect(replay!.window).toEqual({ lastTurns: 50 });
    expect(store.getSnapshot()).toMatchObject({ phase: "replaying", catchingUp: true });
    expect(store.getSnapshot().transcript.map((t) => t.msgId)).toEqual([0, 1].map((n) => FIXTURE_IDS.MSG_ID_N(n)));
  });

  it("takes the new bracket as the old one's completion: every turn once, and the read's own window", () => {
    const { store, conn } = sleepMidRead(1, true);
    store.catchUp();
    replayRange(conn, 0, 3, { firstLoadedTurnIndex: 0, totalTurns: 4, hasOlder: false });

    const snap = store.getSnapshot();
    expect(snap.transcript.map((t) => t.msgId)).toEqual([0, 1, 2, 3].map((n) => FIXTURE_IDS.MSG_ID_N(n)));
    expect(snap.transcript.every((t) => t.messages.filter((m) => m.kind === "user_message").length === 1)).toBe(true);
    expect(snap).toMatchObject({ phase: "idle", catchingUp: false });
    expect(snap.replayWindow).toEqual({ firstLoadedTurnIndex: 0, totalTurns: 4, hasOlder: false });
  });

  it("a bracket nobody here asked for is completed by what follows the turns the card holds", () => {
    const { store, conn } = sleepMidRead(1, false);
    store.catchUp();
    const replay = controlFramesOf(conn).find((f) => f.action === "request_replay" && f.reason === "catch-up");
    expect(replay!.window).toEqual({ afterTurn: { msgIds: [1, 0].map((n) => FIXTURE_IDS.MSG_ID_N(n)), heldTurns: 2 } });

    replayRange(conn, 2, 3, { firstLoadedTurnIndex: 2, totalTurns: 4, hasOlder: true });
    const snap = store.getSnapshot();
    expect(snap.transcript.map((t) => t.msgId)).toEqual([0, 1, 2, 3].map((n) => FIXTURE_IDS.MSG_ID_N(n)));
    expect(snap).toMatchObject({ phase: "idle", catchingUp: false });
  });

  it("a second replay_started inside the completing bracket is still a fault", () => {
    const { store, conn } = sleepMidRead(0, true);
    store.catchUp();
    emit(conn, { type: "replay_started" });
    emitTurn(conn, 0);
    emitTurn(conn, 1);
    emit(conn, { type: "replay_started" });
    expect(store.getSnapshot().transcript.map((t) => t.msgId)).toEqual([0, 1].map((n) => FIXTURE_IDS.MSG_ID_N(n)));
    expect(store.getSnapshot().phase).toBe("replaying");
  });
});

describe("catchUp — its horizon", () => {
  const settled = (): CodeSessionState => ({
    ...createInitialState(TUG, "catch-up", "resume"),
    replayWindow: { firstLoadedTurnIndex: 5, totalTurns: 8, hasOlder: true },
  });
  const step = (state: CodeSessionState, event: Record<string, unknown>) => reduce(state, event as unknown as CodeSessionEvent);

  it("with no bracket, the deadline ends the catch-up", () => {
    const asked = step(settled(), { type: "begin_catch_up" }).state;
    expect(step(asked, { type: "tick_catch_up" }).state.replayCatchUpActive).toBe(false);
  });

  it("a bracket that opens takes the catch-up past the deadline, and its close keeps the window's start", () => {
    const asked = step(settled(), { type: "begin_catch_up" }).state;
    const opened = step(asked, { type: "replay_started" });
    expect(opened.effects).toContainEqual({ kind: "cancel_timer", name: "catch_up" });

    // A slow bracket: the deadline's tick, had it been queued, lands inside it.
    const ticked = step(opened.state, { type: "tick_catch_up" }).state;
    expect(ticked.replayCatchUpActive).toBe(true);

    const closed = step(ticked, { type: "replay_complete", count: 3, firstLoadedTurnIndex: 7, totalTurns: 11, hasOlder: true }).state;
    expect(closed.replayCatchUpActive).toBe(false);
    expect(closed.replayWindow).toEqual({ firstLoadedTurnIndex: 5, totalTurns: 11, hasOlder: true });
  });
});
