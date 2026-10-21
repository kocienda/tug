/**
 * A dormant body's catch-up — `store.catchUp()` asks for exactly what the
 * card lacks, the bracket that answers appends without duplicating a turn the
 * card holds, the loaded window keeps its start, and `catchingUp` stands for
 * as long as the bracket does. Driven through the real store and reducer and
 * the recording connection double (the wire contract the store produces).
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
  it("asks from the turn before the first it lacks to the end, as a catch-up", () => {
    const { store, conn } = makeStore();
    // Turns 5–7 of 8 loaded.
    replayRange(conn, 5, 7, { firstLoadedTurnIndex: 5, totalTurns: 8, hasOlder: true });

    store.catchUp();

    const replay = controlFramesOf(conn).find((f) => f.action === "request_replay");
    expect(replay).toBeDefined();
    expect(replay!.reason).toBe("catch-up");
    expect(replay!.window).toEqual({ turnRange: [7, Number.MAX_SAFE_INTEGER] });
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
    expect(replay!.window).toEqual({ turnRange: [1, Number.MAX_SAFE_INTEGER] });
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
  it("drops the cycle it slept through and takes the turn back from the bracket", () => {
    const { store, conn } = makeStore();
    replayRange(conn, 0, 1, { firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
    store.send("hi", []);
    expect(store.getSnapshot().phase).not.toBe("idle");

    store.catchUp();

    const replay = controlFramesOf(conn).find((f) => f.action === "request_replay" && f.reason === "catch-up");
    expect(replay!.window).toEqual({ turnRange: [1, Number.MAX_SAFE_INTEGER] });
    expect(store.getSnapshot()).toMatchObject({ phase: "idle", catchingUp: true });

    // The turn ended while the body slept: the bracket carries it committed.
    replayRange(conn, 1, 2, { firstLoadedTurnIndex: 1, totalTurns: 3, hasOlder: true });
    const snap = store.getSnapshot();
    expect(snap.transcript.map((t) => t.msgId)).toEqual([0, 1, 2].map((n) => FIXTURE_IDS.MSG_ID_N(n)));
    expect(snap).toMatchObject({ phase: "idle", catchingUp: false });
    expect(snap.replayWindow).toEqual({ firstLoadedTurnIndex: 0, totalTurns: 3, hasOlder: false });
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
