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

import { CodeSessionStore, heldTurnsOf, type TimerSource, type TurnEntry } from "@/lib/code-session-store";
import {
  buildRefsTurnEntry,
  CATCH_UP_DEADLINE_MS,
  createInitialState,
  mintAskId,
  reduce,
  type CodeSessionState,
} from "@/lib/code-session-store/reducer";
import type { Effect } from "@/lib/code-session-store/effects";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { FeedId } from "@/protocol";

const TUG = FIXTURE_IDS.TUG_SESSION_ID;

/** A reveal's `begin_catch_up`, under a fresh id, as the store dispatches it. */
const begin = (): Record<string, unknown> => ({ type: "begin_catch_up", askId: mintAskId() });

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

/** One bracket carrying turns `[lo, hi]` and window meta, naming the ask it answers if any. */
function replayRange(
  conn: TestFrameChannel,
  lo: number,
  hi: number,
  meta: { firstLoadedTurnIndex: number; totalTurns: number; hasOlder: boolean },
  askId?: string,
): void {
  const named = askId === undefined ? {} : { ask_id: askId };
  emit(conn, { type: "replay_started", ...named });
  for (let n = lo; n <= hi; n++) emitTurn(conn, n);
  emit(conn, { type: "replay_complete", count: hi - lo + 1, ...meta, ...named });
}

function controlFramesOf(conn: TestFrameChannel): Array<Record<string, unknown>> {
  return conn.recordedFrames
    .filter((f) => f.feedId === FeedId.CONTROL)
    .map((f) => JSON.parse(new TextDecoder().decode(f.decoded as Uint8Array)) as Record<string, unknown>);
}

function userMessagesOf(conn: TestFrameChannel): Array<Record<string, unknown>> {
  return conn.recordedFrames
    .filter((f) => f.feedId === FeedId.CODE_INPUT)
    .map((f) => f.decoded as Record<string, unknown>)
    .filter((m) => m.type === "user_message");
}

const catchUpAsks = (conn: TestFrameChannel) =>
  controlFramesOf(conn).filter((f) => f.action === "request_replay" && f.reason === "catch-up");

/** The id the newest catch-up ask was sent with, which tugcode echoes on its answer. */
const lastAsk = (conn: TestFrameChannel): string => {
  const asks = catchUpAsks(conn);
  return asks[asks.length - 1].ask_id as string;
};

/** The id of the newest ask a reduced state has made. */
const askOf = (state: CodeSessionState): string => state.catchUp.asks[state.catchUp.asks.length - 1].id;

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

describe("heldTurnsOf — only turns are named or counted", () => {
  const telemetry = {
    result: "success",
    endedAt: 0,
    wallClockMs: 0,
    awaitingApprovalMs: 0,
    transportDowntimeMs: 0,
    activeMs: 0,
    ttftMs: null,
    ttftcMs: null,
    reconnectCount: 0,
    maxStreamGapMs: 0,
    turnEndReason: "complete",
    cost: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 },
  } as const;

  const claudeTurn = (n: number): TurnEntry => ({
    ...telemetry,
    turnKey: `t-${n}`,
    msgId: FIXTURE_IDS.MSG_ID_N(n),
    origin: "user",
    messages: [],
  });

  const shellTurn = (n: number): TurnEntry => ({
    ...telemetry,
    turnKey: `shell-sh-${n}`,
    msgId: `sh-${n}`,
    origin: "shell",
    messages: [
      {
        kind: "shell_exchange",
        messageKey: `sh-${n}`,
        createdAt: 0,
        exchangeId: `sh-${n}`,
        command: "ls",
        output: "",
        exitCode: 0,
        cwd: "/",
        cwdAfter: null,
        startedAtMs: 0,
        settledAtMs: 0,
      },
    ],
  });

  const refsTurn = (n: number): TurnEntry =>
    buildRefsTurnEntry({
      kind: "refs_result",
      messageKey: `refs-${n}`,
      createdAt: 0,
      runId: `refs-${n}`,
      opKind: "search",
      command: "foo",
      root: "/",
      refs: [],
      inFlight: false,
      cancelled: false,
      notice: null,
      startedAtMs: 0,
      settledAtMs: 0,
    });

  it("names the sixteen newest turns past a crowd of ink, and counts only turns", () => {
    // Twenty turns, each followed by a shell exchange and a refs run: the
    // ink alone would fill the sixteen slots twice over.
    const transcript: TurnEntry[] = [];
    for (let n = 0; n < 20; n++) transcript.push(claudeTurn(n), shellTurn(n), refsTurn(n));

    const held = heldTurnsOf(transcript, 4);

    expect(held.msgIds).toEqual(Array.from({ length: 16 }, (_, i) => FIXTURE_IDS.MSG_ID_N(19 - i)));
    expect(held.heldTurns).toBe(24);
  });

  it("ink at the newest end does not move the count", () => {
    const transcript = [claudeTurn(0), claudeTurn(1), ...Array.from({ length: 30 }, (_, i) => refsTurn(i))];
    expect(heldTurnsOf(transcript, 0)).toEqual({
      msgIds: [1, 0].map((n) => FIXTURE_IDS.MSG_ID_N(n)),
      heldTurns: 2,
    });
  });

  it("passes over an entry carrying a minted run id whatever its origin says", () => {
    const stray: TurnEntry = { ...claudeTurn(9), msgId: "refs-3" };
    const transcript = [claudeTurn(0), refsTurn(3), stray, claudeTurn(1)];
    expect(heldTurnsOf(transcript, 0)).toEqual({
      msgIds: [1, 0].map((n) => FIXTURE_IDS.MSG_ID_N(n)),
      heldTurns: 2,
    });
  });
});

describe("catchUp — the bracket that answers", () => {
  it("appends the missed turns once, keeps the window's start, and ends the catch-up", () => {
    const { store, conn } = makeStore();
    replayRange(conn, 5, 7, { firstLoadedTurnIndex: 5, totalTurns: 8, hasOlder: true });
    store.catchUp();

    // tugcode answers turns 7 (the overlap) through 10; its window meta
    // describes the slice it sent, which is not the card's window.
    replayRange(conn, 7, 10, { firstLoadedTurnIndex: 7, totalTurns: 11, hasOlder: true }, lastAsk(conn));

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
    replayRange(conn, 7, 7, { firstLoadedTurnIndex: 7, totalTurns: 8, hasOlder: true }, lastAsk(conn));

    const snap = store.getSnapshot();
    expect(snap.transcript.map((t) => t.msgId)).toEqual(before.map((t) => t.msgId));
    expect(snap.replayWindow).toEqual({ firstLoadedTurnIndex: 5, totalTurns: 8, hasOlder: true });
    expect(snap.catchingUp).toBe(false);
  });

  it("a later ordinary bracket is not a catch-up", () => {
    const { store, conn } = makeStore();
    replayRange(conn, 5, 7, { firstLoadedTurnIndex: 5, totalTurns: 8, hasOlder: true });
    store.catchUp();
    replayRange(conn, 7, 7, { firstLoadedTurnIndex: 7, totalTurns: 8, hasOlder: true }, lastAsk(conn));
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
    replayRange(conn, 1, 2, { firstLoadedTurnIndex: 1, totalTurns: 3, hasOlder: true }, lastAsk(conn));
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
    emit(conn, { type: "replay_started", ask_id: lastAsk(conn) });
    emit(conn, { type: "add_user_message", content: [{ type: "text", text: "hi" }], inflightSnapshot: true });
    emit(conn, { type: "content_block_start", msg_id: id, block_index: 0, kind: "text" });
    emit(conn, { type: "assistant_text", msg_id: id, block_index: 0, seq: 0, rev: 0, text: "so far", is_partial: false, status: "streaming" });
    emit(conn, { type: "replay_complete", count: 0, firstLoadedTurnIndex: 2, totalTurns: 2, hasOlder: true, ask_id: lastAsk(conn) });
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
      begin() as CodeSessionEvent,
    ).state;
    const ticked = reduce(asked, { type: "tick_catch_up" } as CodeSessionEvent).state;
    expect(ticked.catchUp.stage).toBe("none");
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

    replayRange(conn, 1, 3, { firstLoadedTurnIndex: 1, totalTurns: 4, hasOlder: true }, lastAsk(conn));
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

    replayRange(conn, 1, 2, { firstLoadedTurnIndex: 1, totalTurns: 3, hasOlder: true }, lastAsk(conn));
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
    replayRange(conn, 1, 1, { firstLoadedTurnIndex: 1, totalTurns: 2, hasOlder: true }, lastAsk(conn));
    emit(conn, WAKE);
    liveTail(conn, 2);
    expect(store.getSnapshot().transcript.map((t) => t.msgId)).toEqual([0, 1, 2].map((n) => FIXTURE_IDS.MSG_ID_N(n)));
  });

  it("is applied, in order, at the catch-up's deadline when no bracket comes", () => {
    const { store, conn } = makeStore();
    replayRange(conn, 0, 1, { firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
    const asked = reduce(store._getInternalStateForDevPanel(), begin() as CodeSessionEvent).state;
    const wake = WAKE as unknown as CodeSessionEvent;
    const heard = reduce(asked, wake).state;
    expect(heard.phase).toBe("idle");
    expect(heard.catchUp.held).toEqual([wake]);
    const ticked = reduce(heard, { type: "tick_catch_up" } as CodeSessionEvent).state;
    expect(ticked.catchUp.stage).toBe("none");
    expect(ticked.phase).toBe("waking");
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
    replayRange(conn, 0, 3, { firstLoadedTurnIndex: 0, totalTurns: 4, hasOlder: false }, lastAsk(conn));

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

    replayRange(conn, 2, 3, { firstLoadedTurnIndex: 2, totalTurns: 4, hasOlder: true }, lastAsk(conn));
    const snap = store.getSnapshot();
    expect(snap.transcript.map((t) => t.msgId)).toEqual([0, 1, 2, 3].map((n) => FIXTURE_IDS.MSG_ID_N(n)));
    expect(snap).toMatchObject({ phase: "idle", catchingUp: false });
  });

  it("a second replay_started inside the completing bracket is still a fault", () => {
    const { store, conn } = sleepMidRead(0, true);
    store.catchUp();
    emit(conn, { type: "replay_started", ask_id: lastAsk(conn) });
    emitTurn(conn, 0);
    emitTurn(conn, 1);
    emit(conn, { type: "replay_started" });
    // Dropped, not entered: the bracket's turns stand, and its close ends it.
    // (Read at the close: inside a bracket the mirror folds its posts.)
    emit(conn, { type: "replay_complete", count: 2, firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false, ask_id: lastAsk(conn) });
    expect(store.getSnapshot().transcript.map((t) => t.msgId)).toEqual([0, 1].map((n) => FIXTURE_IDS.MSG_ID_N(n)));
    expect(store.getSnapshot()).toMatchObject({ phase: "idle", catchingUp: false });
  });

  it("a re-ask dropped behind the bracket it completes is asked again when that bracket closes", () => {
    const { store, conn } = sleepMidRead(1, true);
    store.noteDormant();
    store.catchUp();
    // tugcode was still running the old bracket and dropped the ask
    // (`replay_in_flight`): what arrives is that bracket's tail and close.
    emitTurn(conn, 2);
    emit(conn, { type: "replay_complete", count: 3, firstLoadedTurnIndex: 0, totalTurns: 3, hasOlder: false });
    expect(catchUpAsks(conn).map((f) => f.window)).toEqual([{ lastTurns: 50 }, { lastTurns: 50 }]);
    expect(store.getSnapshot()).toMatchObject({ phase: "replaying", catchingUp: true });

    replayRange(conn, 0, 3, { firstLoadedTurnIndex: 0, totalTurns: 4, hasOlder: false }, lastAsk(conn));
    const snap = store.getSnapshot();
    expect(snap.transcript.map((t) => t.msgId)).toEqual([0, 1, 2, 3].map((n) => FIXTURE_IDS.MSG_ID_N(n)));
    expect(snap.transcript.every((t) => t.messages.filter((m) => m.kind === "user_message").length === 1)).toBe(true);
    expect(snap).toMatchObject({ phase: "idle", catchingUp: false });
    expect(snap.replayWindow).toEqual({ firstLoadedTurnIndex: 0, totalTurns: 4, hasOlder: false });
  });

  it("asks again once only: the re-ask's own deadline then closes the old bracket with its tail", () => {
    const step = (state: CodeSessionState, event: Record<string, unknown>) => reduce(state, event as unknown as CodeSessionEvent);
    const turn = (n: number): Array<Record<string, unknown>> => [
      { type: "add_user_message", content: [{ type: "text", text: `prompt ${n}` }] },
      { type: "assistant_text", status: "complete", msg_id: FIXTURE_IDS.MSG_ID_N(n), text: `reply ${n}`, is_partial: false, rev: 0, seq: 0 },
      { type: "turn_complete", seq: 0, msg_id: FIXTURE_IDS.MSG_ID_N(n), result: "success" },
    ];
    const read = { lastTurns: 50 };
    let state = createInitialState(TUG, "catch-up", "resume");
    for (const e of [{ type: "replay_asked", window: read }, { type: "replay_started" }, ...turn(0), { type: "went_dormant" }]) {
      state = step(state, e).state;
    }
    state = step(state, begin()).state;
    state = step(state, { type: "replay_asked", window: read }).state;
    for (const e of turn(1)) state = step(state, e).state;
    const first = step(state, { type: "replay_complete", count: 2, firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
    expect(first.effects).toContainEqual({ kind: "request-replay", window: read, askId: askOf(first.state) });
    expect(first.state.catchUp).toMatchObject({ stage: "asked", behind: null });
    expect(first.state.catchUp.held).toHaveLength(4);

    // Nothing answers the second ask either: the old bracket closes with what
    // it said, and the read's window is the one it reported.
    const ticked = step(first.state, { type: "tick_catch_up" });
    expect(ticked.effects.some((e) => e.kind === "request-replay")).toBe(false);
    expect(ticked.state.catchUp.stage).toBe("none");
    expect(ticked.state.phase).toBe("idle");
    expect(ticked.state.replayWindow).toEqual({ firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
    expect(ticked.effects.filter((e) => e.kind === "append-transcript")).toHaveLength(1);
  });
});

describe("catchUp — its answer, known by name", () => {
  const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => FIXTURE_IDS.MSG_ID_N(from + i));

  /**
   * A card holding turns 2–7 of 8 asks; a bracket nobody here asked for — a
   * cold-boot read, as when tugcast front-queues the ask through a Spawning
   * window — opens and closes before any answer. The ask may have been dropped
   * behind it, so the card asks again.
   */
  function askedBehindAnUnnamedRead(): { store: CodeSessionStore; conn: TestFrameChannel; first: string; second: string } {
    const { store, conn } = makeStore();
    replayRange(conn, 2, 7, { firstLoadedTurnIndex: 2, totalTurns: 8, hasOlder: true });
    store.catchUp();
    const first = lastAsk(conn);
    replayRange(conn, 0, 8, { firstLoadedTurnIndex: 0, totalTurns: 9, hasOlder: false });
    // Set aside whole: it neither stands in for the answer nor re-bases the window.
    expect(store.getSnapshot()).toMatchObject({ catchingUp: true, replayWindow: { firstLoadedTurnIndex: 2, totalTurns: 8, hasOlder: true } });
    expect(store.getSnapshot().transcript.map((t) => t.msgId)).toEqual(ids(2, 7));
    expect(catchUpAsks(conn)).toHaveLength(2);
    const second = lastAsk(conn);
    expect(second).not.toBe(first);
    return { store, conn, first, second };
  }

  it("the first ask was not dropped after all: both answers come, and the window keeps its start through both", () => {
    const { store, conn, first, second } = askedBehindAnUnnamedRead();
    replayRange(conn, 7, 8, { firstLoadedTurnIndex: 7, totalTurns: 9, hasOlder: true }, first);
    expect(store.getSnapshot()).toMatchObject({ catchingUp: false, replayWindow: { firstLoadedTurnIndex: 2, totalTurns: 9, hasOlder: true } });

    // The re-ask's answer lands on a settled card: still the catch-up's.
    replayRange(conn, 7, 8, { firstLoadedTurnIndex: 7, totalTurns: 9, hasOlder: true }, second);
    const snap = store.getSnapshot();
    expect(snap.replayWindow).toEqual({ firstLoadedTurnIndex: 2, totalTurns: 9, hasOlder: true });
    expect(snap.transcript.map((t) => t.msgId)).toEqual(ids(2, 8));
    expect(snap).toMatchObject({ phase: "idle", catchingUp: false });
    expect(catchUpAsks(conn)).toHaveLength(2);
  });

  it("the first ask was dropped: the re-ask's answer is the one, and the window keeps its start", () => {
    const { store, conn, second } = askedBehindAnUnnamedRead();
    replayRange(conn, 7, 8, { firstLoadedTurnIndex: 7, totalTurns: 9, hasOlder: true }, second);
    const snap = store.getSnapshot();
    expect(snap.replayWindow).toEqual({ firstLoadedTurnIndex: 2, totalTurns: 9, hasOlder: true });
    expect(snap.transcript.map((t) => t.msgId)).toEqual(ids(2, 8));
    expect(snap).toMatchObject({ phase: "idle", catchingUp: false });
    // Answering the re-ask settles the ask before it too: tugcode reads in order.
    expect(store._getInternalStateForDevPanel().catchUp.asks).toEqual([]);
  });

  it("the re-ask is answered first, as when tugcast front-queues both through a Spawning window: the first ask's answer, let go, is shadowed and re-bases nothing", () => {
    const { store, conn, first, second } = askedBehindAnUnnamedRead();
    replayRange(conn, 7, 8, { firstLoadedTurnIndex: 7, totalTurns: 9, hasOlder: true }, second);
    expect(store.getSnapshot().replayWindow).toEqual({ firstLoadedTurnIndex: 2, totalTurns: 9, hasOlder: true });

    // The first ask was let go when its re-ask was answered; its bracket comes
    // after all, reporting a window of its own.
    replayRange(conn, 7, 8, { firstLoadedTurnIndex: 7, totalTurns: 9, hasOlder: true }, first);
    const snap = store.getSnapshot();
    expect(snap.replayWindow).toEqual({ firstLoadedTurnIndex: 2, totalTurns: 9, hasOlder: true });
    expect(snap.transcript.map((t) => t.msgId)).toEqual(ids(2, 8));
    expect(snap).toMatchObject({ phase: "idle", catchingUp: false });
    expect(store._getInternalStateForDevPanel().catchUp.stage).toBe("none");
  });

  it("an in-flight read standing at the sleep drops nothing: its close earns no second ask, and the answer keeps the window's start", () => {
    const { store, conn } = makeStore();
    replayRange(conn, 2, 7, { firstLoadedTurnIndex: 2, totalTurns: 8, hasOlder: true });
    emit(conn, { type: "replay_started", inflight_only: true });
    store.noteDormant();
    store.catchUp();
    emit(conn, { type: "replay_complete", count: 0 });
    expect(catchUpAsks(conn)).toHaveLength(1);

    replayRange(conn, 7, 8, { firstLoadedTurnIndex: 7, totalTurns: 9, hasOlder: true }, lastAsk(conn));
    const snap = store.getSnapshot();
    expect(snap.replayWindow).toEqual({ firstLoadedTurnIndex: 2, totalTurns: 9, hasOlder: true });
    expect(snap.transcript.map((t) => t.msgId)).toEqual(ids(2, 8));
    expect(snap).toMatchObject({ phase: "idle", catchingUp: false });
  });
});

describe("catchUp — an ask the read ahead of it outlives", () => {
  const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => FIXTURE_IDS.MSG_ID_N(from + i));

  it("a running bracket that closes after the deadline is asked again: its turns land once, and the window keeps its start", () => {
    const { store, conn, timers } = makeTimedStore();
    replayRange(conn, 2, 7, { firstLoadedTurnIndex: 2, totalTurns: 8, hasOlder: true });
    store.catchUp();
    const first = lastAsk(conn);
    // A read nobody here asked for opens while the ask waits, and runs past
    // the ask's deadline.
    emit(conn, { type: "replay_started" });
    for (let n = 0; n <= 8; n++) emitTurn(conn, n);
    timers.advance(CATCH_UP_DEADLINE_MS);
    expect(store.getSnapshot().catchingUp).toBe(false);
    emit(conn, { type: "replay_complete", count: 9, firstLoadedTurnIndex: 0, totalTurns: 9, hasOlder: false });

    // Its close is the one the ask stood behind: the card asks again, with the
    // lapsed ask let go.
    expect(catchUpAsks(conn)).toHaveLength(2);
    const second = lastAsk(conn);
    expect(store.getSnapshot().catchingUp).toBe(true);
    expect(store._getInternalStateForDevPanel().catchUp).toMatchObject({ stage: "asked", behind: null, letGo: [first] });
    expect(store._getInternalStateForDevPanel().catchUp.asks.map((a) => a.id)).toEqual([second]);

    replayRange(conn, 7, 8, { firstLoadedTurnIndex: 7, totalTurns: 9, hasOlder: true }, second);
    const snap = store.getSnapshot();
    expect(snap.transcript.map((t) => t.msgId)).toEqual(ids(2, 8));
    expect(snap.replayWindow).toEqual({ firstLoadedTurnIndex: 2, totalTurns: 9, hasOlder: true });
    expect(snap).toMatchObject({ phase: "idle", catchingUp: false });
    expect(store._getInternalStateForDevPanel().catchUp.asks).toEqual([]);
  });

  it("an ask tugcode dropped behind a running read ends the catch-up at once", () => {
    const { store, conn, timers } = makeTimedStore();
    replayRange(conn, 0, 1, { firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
    store.catchUp();
    const askId = lastAsk(conn);
    emit(conn, { type: "replay_started" });
    emit(conn, { type: "request_replay_dropped", ask_id: askId });
    expect(store._getInternalStateForDevPanel().catchUp).toMatchObject({ stage: "none", asks: [], letGo: [askId], behind: null });
    expect(store.getSnapshot().catchingUp).toBe(false);

    // The read's close asks nothing more: the drop was the answer.
    emit(conn, { type: "replay_complete", count: 0 });
    expect(catchUpAsks(conn)).toHaveLength(1);
    timers.advance(CATCH_UP_DEADLINE_MS);
    expect(catchUpAsks(conn)).toHaveLength(1);
  });

  it("a reveal on a closed wire asks nothing and arms nothing", () => {
    const step = (state: CodeSessionState, event: Record<string, unknown>) => reduce(state, event as unknown as CodeSessionEvent);
    const offline = step(createInitialState(TUG, "catch-up", "resume"), { type: "transport_close" }).state;
    expect(offline.transportState).toBe("offline");
    const revealed = step(offline, begin());
    expect(revealed.state.catchUp).toMatchObject({ stage: "none", asks: [] });
    expect(revealed.effects.some((e) => e.kind === "schedule_timer" && e.name === "catch_up")).toBe(false);

    const { store, conn } = makeStore();
    replayRange(conn, 0, 1, { firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
    store._simulateTransportForTest("close");
    store.catchUp();
    expect(catchUpAsks(conn)).toHaveLength(0);
    expect(store.getSnapshot().catchingUp).toBe(false);
  });

  it("a lapsed ask stands behind no bracket but a shadow: a read the card was inside closes as itself, and a later read asks nothing", () => {
    const step = (state: CodeSessionState, event: Record<string, unknown>) => reduce(state, event as unknown as CodeSessionEvent);
    const settled: CodeSessionState = {
      ...createInitialState(TUG, "catch-up", "resume"),
      replayWindow: { firstLoadedTurnIndex: 5, totalTurns: 8, hasOlder: true },
    };
    // The card sleeps inside a read and is revealed in it; the re-ask lapses,
    // and the card, still inside that read, hears it close.
    const inRead = step(step(settled, { type: "replay_started" }).state, { type: "went_dormant" }).state;
    const lapsed = step(step(inRead, begin()).state, { type: "tick_catch_up" }).state;
    expect(lapsed.catchUp.stage).toBe("none");
    const closed = step(lapsed, { type: "replay_complete", count: 0, firstLoadedTurnIndex: 5, totalTurns: 8, hasOlder: true });
    expect(closed.state.catchUp.behind).toBeNull();

    // A later read nobody here asked for, set aside, closes: nothing stood
    // behind it, so nothing is asked.
    const later = step(step(closed.state, { type: "replay_started", inflight_only: true }).state, { type: "replay_complete", count: 0 });
    expect(later.effects.some((e) => e.kind === "request-replay")).toBe(false);
    expect(later.state.catchUp.stage).toBe("none");
  });
});

describe("catchUp — its horizon", () => {
  const settled = (): CodeSessionState => ({
    ...createInitialState(TUG, "catch-up", "resume"),
    replayWindow: { firstLoadedTurnIndex: 5, totalTurns: 8, hasOlder: true },
  });
  const step = (state: CodeSessionState, event: Record<string, unknown>) => reduce(state, event as unknown as CodeSessionEvent);

  it("with no bracket, the deadline ends the catch-up", () => {
    const asked = step(settled(), begin()).state;
    expect(step(asked, { type: "tick_catch_up" }).state.catchUp.stage).toBe("none");
  });

  it("a bracket that opens takes the catch-up past the deadline, and its close keeps the window's start", () => {
    const asked = step(settled(), begin()).state;
    const opened = step(asked, { type: "replay_started", ask_id: askOf(asked) });
    expect(opened.effects).toContainEqual({ kind: "cancel_timer", name: "catch_up" });

    // A slow bracket: the deadline's tick, had it been queued, lands inside it.
    const ticked = step(opened.state, { type: "tick_catch_up" }).state;
    expect(ticked.catchUp.stage).toBe("open");

    const closed = step(ticked, { type: "replay_complete", count: 3, firstLoadedTurnIndex: 7, totalTurns: 11, hasOlder: true }).state;
    expect(closed.catchUp.stage).toBe("none");
    expect(closed.replayWindow).toEqual({ firstLoadedTurnIndex: 5, totalTurns: 11, hasOlder: true });
  });
});

describe("catchUp — every way out of it", () => {
  const WAKE = { type: "wake_started", wake_trigger: { task_id: "t", tool_use_id: "", status: "completed", summary: "done", output_file: "" } };
  const settled = (): CodeSessionState => ({
    ...createInitialState(TUG, "catch-up", "resume"),
    replayWindow: { firstLoadedTurnIndex: 5, totalTurns: 8, hasOlder: true },
  });
  const step = (state: CodeSessionState, event: Record<string, unknown>) => reduce(state, event as unknown as CodeSessionEvent);
  const opened = (): CodeSessionState => {
    const asked = step(settled(), begin()).state;
    return step(asked, { type: "replay_started", ask_id: askOf(asked) }).state;
  };

  for (const tick of ["tick_replay_silence", "tick_replay_bracket"]) {
    it(`a bracket abandoned by ${tick} ends it, and the card hears its session again`, () => {
      const abandoned = step(opened(), { type: tick });
      expect(abandoned.state.phase).toBe("errored");
      expect(abandoned.state.catchUp.stage).toBe("none");
      expect(abandoned.state.catchUp.openWindow).toBeNull();
      expect(abandoned.effects).toContainEqual({ kind: "cancel_timer", name: "catch_up" });
      // Nothing is set aside any more: what the session says next reaches
      // its handler rather than waiting on a bracket that will never come.
      expect(step(abandoned.state, WAKE).state.catchUp.held).toEqual([]);
    });
  }

  it("a move it does not make is refused: a second reveal inside the bracket leaves it open", () => {
    const again = step(opened(), begin()).state;
    expect(again.catchUp.stage).toBe("open");
  });

  it("a bracket's deadlines stop while the card sleeps and start again from the reveal", () => {
    const inBracket = step(settled(), { type: "replay_started" }).state;
    expect(inBracket.phase).toBe("replaying");
    const slept = step(inBracket, { type: "went_dormant" });
    expect(slept.effects).toEqual([
      { kind: "cancel_timer", name: "replay_silence" },
      { kind: "cancel_timer", name: "replay_bracket" },
    ]);
    // A tick that raced the cancel, or that a frame in transit re-armed, ends
    // nothing while the card cannot hear.
    expect(step(slept.state, { type: "tick_replay_silence" }).state.phase).toBe("replaying");
    expect(step(slept.state, { type: "tick_replay_bracket" }).state.phase).toBe("replaying");

    const revealed = step(slept.state, begin());
    const armed = revealed.effects.flatMap((e) => (e.kind === "schedule_timer" ? [e.name] : []));
    expect(armed).toEqual(["replay_silence", "replay_bracket", "catch_up"]);
    expect(step(revealed.state, { type: "tick_replay_silence" }).state.phase).toBe("errored");
  });

  it("a reveal with nothing to ask starts the deadlines again too", () => {
    const slept = step(step(settled(), { type: "replay_started" }).state, { type: "went_dormant" }).state;
    const woke = step(slept, { type: "woke" });
    expect(woke.effects.flatMap((e) => (e.kind === "schedule_timer" ? [e.name] : []))).toEqual(["replay_silence", "replay_bracket"]);
    expect(woke.state.catchUp.stage).toBe("none");
    expect(step(woke.state, { type: "tick_replay_silence" }).state.phase).toBe("errored");
  });

  it("a bracket that arrives after the deadline is still the catch-up's: the window keeps its start", () => {
    const lapsed = step(step(settled(), begin()).state, { type: "tick_catch_up" }).state;
    expect(lapsed.catchUp.stage).toBe("none");
    expect(lapsed.catchUp.asks).toHaveLength(1);
    const late = step(lapsed, { type: "replay_started", ask_id: askOf(lapsed) }).state;
    expect(late.catchUp.stage).toBe("open");
    const closed = step(late, { type: "replay_complete", count: 3, firstLoadedTurnIndex: 7, totalTurns: 11, hasOlder: true }).state;
    expect(closed.catchUp.stage).toBe("none");
    expect(closed.replayWindow).toEqual({ firstLoadedTurnIndex: 5, totalTurns: 11, hasOlder: true });
  });

  it("a later ask of any kind is not the lapsed one's answer", () => {
    const lapsed = step(step(settled(), begin()).state, { type: "tick_catch_up" }).state;
    const asked = step(lapsed, { type: "replay_asked", window: { lastTurns: 50 } }).state;
    const read = step(asked, { type: "replay_started" }).state;
    expect(read.catchUp.stage).toBe("none");
    const closed = step(read, { type: "replay_complete", count: 3, firstLoadedTurnIndex: 7, totalTurns: 11, hasOlder: true }).state;
    expect(closed.replayWindow).toEqual({ firstLoadedTurnIndex: 7, totalTurns: 11, hasOlder: true });
  });

  it("a shadow standing at the sleep is dropped at the reveal, and the catch-up's bracket enters its turns", () => {
    const { store, conn } = makeStore();
    replayRange(conn, 0, 1, { firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
    // An in-flight read over the settled card: shadowed inert. Its close is
    // sent while the card sleeps, and never heard.
    emit(conn, { type: "replay_started", inflight_only: true });
    store.noteDormant();
    store.catchUp();
    replayRange(conn, 1, 3, { firstLoadedTurnIndex: 1, totalTurns: 4, hasOlder: true }, lastAsk(conn));

    const snap = store.getSnapshot();
    expect(snap.transcript.map((t) => t.msgId)).toEqual([0, 1, 2, 3].map((n) => FIXTURE_IDS.MSG_ID_N(n)));
    expect(snap).toMatchObject({ phase: "idle", catchingUp: false });
    expect(snap.replayWindow).toEqual({ firstLoadedTurnIndex: 0, totalTurns: 4, hasOlder: false });
  });

  it("a send made while the catch-up stands goes out once its bracket has closed", () => {
    const { store, conn } = makeStore();
    replayRange(conn, 0, 1, { firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
    store.catchUp();
    store.send("prompt 3", []);
    // Sent now, the turn could start before tugcode's snapshot, and the
    // bracket would supersede it with an account that never saw it.
    expect(userMessagesOf(conn)).toHaveLength(0);
    expect(store.getSnapshot().queuedSends).toHaveLength(1);

    replayRange(conn, 1, 2, { firstLoadedTurnIndex: 1, totalTurns: 3, hasOlder: true }, lastAsk(conn));
    const snap = store.getSnapshot();
    expect(userMessagesOf(conn)).toHaveLength(1);
    expect(snap).toMatchObject({ phase: "submitting", catchingUp: false });
    expect(snap.queuedSends).toHaveLength(0);
    expect(snap.transcript.map((t) => t.msgId)).toEqual([0, 1, 2].map((n) => FIXTURE_IDS.MSG_ID_N(n)));
  });

  it("a send made while the catch-up stands goes out at its deadline when no bracket comes", () => {
    const { store } = makeStore();
    store.catchUp();
    store.send("prompt 0", []);
    const ticked = reduce(store._getInternalStateForDevPanel(), { type: "tick_catch_up" } as CodeSessionEvent);
    expect(ticked.state.phase).toBe("submitting");
    expect(ticked.effects.some((e) => e.kind === "send-frame")).toBe(true);
  });

  it("a send made while the catch-up stands waits out a transport loss and goes out once on the rebind", () => {
    const { store, conn } = makeStore();
    replayRange(conn, 0, 1, { firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
    store.catchUp();
    store.send("prompt 2", []);
    emit(conn, { type: "replay_started", ask_id: lastAsk(conn) });

    // The wire goes while the bracket is open: the catch-up ends, and the
    // send stays queued rather than being written to a socket that is gone.
    const lost = step(store._getInternalStateForDevPanel(), { type: "transport_close" });
    expect(lost.state).toMatchObject({ phase: "errored", transportState: "offline" });
    expect(lost.state.catchUp.stage).toBe("none");
    expect(lost.state.queuedSends).toHaveLength(1);
    expect(lost.effects.some((e) => e.kind === "send-frame")).toBe(false);

    // The rebind: the wire comes back and the reconnect's bracket is the
    // boundary that sends it — once.
    const rebind: Array<Record<string, unknown>> = [
      { type: "transport_open" },
      { type: "transport_settled" },
      { type: "replay_started" },
      { type: "replay_complete", count: 0, firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false },
    ];
    let state = lost.state;
    const sent: Effect[] = [];
    for (const event of rebind) {
      const next = step(state, event);
      state = next.state;
      sent.push(...next.effects.filter((e) => e.kind === "send-frame"));
    }
    expect(sent).toHaveLength(1);
    expect(state.phase).toBe("submitting");
    expect(state.queuedSends).toHaveLength(0);
  });
});

/** A clock the test moves by hand, for the store's own deadlines. */
class FakeTimers {
  private now = 0;
  private nextId = 1;
  private entries: Array<{ id: number; cb: () => void; fireAt: number; cleared: boolean }> = [];

  readonly source: TimerSource = {
    setTimeout: (cb, ms) => {
      const id = this.nextId++;
      this.entries.push({ id, cb, fireAt: this.now + ms, cleared: false });
      return id;
    },
    clearTimeout: (handle) => {
      const entry = this.entries.find((e) => e.id === handle);
      if (entry !== undefined) entry.cleared = true;
    },
  };

  /** Timers set and not yet fired or cleared. */
  get pending(): number {
    return this.entries.filter((e) => !e.cleared).length;
  }

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = this.entries.filter((e) => !e.cleared && e.fireAt <= target).sort((a, b) => a.fireAt - b.fireAt);
      if (due.length === 0) break;
      this.now = due[0].fireAt;
      due[0].cleared = true;
      due[0].cb();
    }
    this.now = target;
  }
}

function makeTimedStore(): { store: CodeSessionStore; conn: TestFrameChannel; timers: FakeTimers } {
  const conn = new TestFrameChannel();
  const timers = new FakeTimers();
  const store = new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: TUG,
    sessionMode: "resume",
    timerSource: timers.source,
  });
  return { store, conn, timers };
}

describe("catchUp — an answer after its deadline", () => {
  const WAKE = { type: "wake_started", wake_trigger: { task_id: "t", tool_use_id: "", status: "completed", summary: "done", output_file: "" } };
  const ids = (store: CodeSessionStore) => store.getSnapshot().transcript.map((t) => t.msgId);

  /** A live turn's tail, heard from the middle: its last text and its close. */
  function liveTail(conn: TestFrameChannel, n: number): void {
    const id = FIXTURE_IDS.MSG_ID_N(n);
    emit(conn, { type: "assistant_text", status: "complete", msg_id: id, text: "only the tail", is_partial: false, rev: 0, seq: 0 });
    emit(conn, { type: "turn_complete", seq: 0, msg_id: id, result: "success" });
  }

  it("replaces the tail the deadline applied with the whole turn, and puts what the card missed ahead of it", () => {
    const { store, conn, timers } = makeTimedStore();
    replayRange(conn, 0, 1, { firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
    store.catchUp();
    emit(conn, WAKE);
    liveTail(conn, 3);
    timers.advance(CATCH_UP_DEADLINE_MS);
    // No bracket by the deadline: what was set aside is applied, and the tail
    // stands as the turn.
    expect(ids(store)).toEqual([0, 1, 3].map((n) => FIXTURE_IDS.MSG_ID_N(n)));
    expect(JSON.stringify(store.getSnapshot().transcript[2])).toContain("only the tail");

    replayRange(conn, 1, 3, { firstLoadedTurnIndex: 1, totalTurns: 4, hasOlder: true }, lastAsk(conn));
    const snap = store.getSnapshot();
    expect(snap.transcript.map((t) => t.msgId)).toEqual([0, 1, 2, 3].map((n) => FIXTURE_IDS.MSG_ID_N(n)));
    expect(JSON.stringify(snap.transcript[3])).toContain("reply 3");
    expect(JSON.stringify(snap.transcript[3])).not.toContain("only the tail");
    expect(snap.replayWindow).toEqual({ firstLoadedTurnIndex: 0, totalTurns: 4, hasOlder: false });
    expect(store._getInternalStateForDevPanel().catchUp).toMatchObject({ asks: [], answering: null });
  });

  it("an ask made after the tail stood is answered after it: its turns follow the tail", () => {
    const { store, conn, timers } = makeTimedStore();
    replayRange(conn, 0, 1, { firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
    store.catchUp();
    emit(conn, WAKE);
    liveTail(conn, 3);
    timers.advance(CATCH_UP_DEADLINE_MS);
    expect(ids(store)).toEqual([0, 1, 3].map((n) => FIXTURE_IDS.MSG_ID_N(n)));

    // The first ask is never answered. The next reveal asks for what follows
    // the turns the card holds, the tail among them, so its answer carries
    // nothing the tail could stand in for.
    store.catchUp();
    replayRange(conn, 4, 5, { firstLoadedTurnIndex: 4, totalTurns: 6, hasOlder: true }, lastAsk(conn));
    expect(ids(store)).toEqual([0, 1, 3, 4, 5].map((n) => FIXTURE_IDS.MSG_ID_N(n)));
    expect(store._getInternalStateForDevPanel().catchUp).toMatchObject({ asks: [], answering: null });
  });

  it("two asks lapse over two tails: the later one's answer completes its own tail and puts what the card missed ahead of it, not ahead of the earlier tail", () => {
    const { store, conn, timers } = makeTimedStore();
    replayRange(conn, 0, 2, { firstLoadedTurnIndex: 0, totalTurns: 3, hasOlder: false });
    store.catchUp();
    emit(conn, WAKE);
    liveTail(conn, 3);
    timers.advance(CATCH_UP_DEADLINE_MS);
    expect(ids(store)).toEqual([0, 1, 2, 3].map((n) => FIXTURE_IDS.MSG_ID_N(n)));

    // The card sleeps through turn 4, and the next reveal's ask lapses over
    // turn 5's tail.
    store.catchUp();
    emit(conn, WAKE);
    liveTail(conn, 5);
    timers.advance(CATCH_UP_DEADLINE_MS);
    expect(ids(store)).toEqual([0, 1, 2, 3, 5].map((n) => FIXTURE_IDS.MSG_ID_N(n)));

    // The later ask's answer, late: it asked for what follows turn 3.
    replayRange(conn, 4, 5, { firstLoadedTurnIndex: 4, totalTurns: 6, hasOlder: true }, lastAsk(conn));
    const snap = store.getSnapshot();
    expect(snap.transcript.map((t) => t.msgId)).toEqual([0, 1, 2, 3, 4, 5].map((n) => FIXTURE_IDS.MSG_ID_N(n)));
    expect(JSON.stringify(snap.transcript[5])).toContain("reply 5");
    expect(JSON.stringify(snap.transcript[5])).not.toContain("only the tail");
    expect(snap.replayWindow).toEqual({ firstLoadedTurnIndex: 0, totalTurns: 6, hasOlder: false });
  });

  it("a spawning session's horizon runs from its spawn, once: its ready re-arms nothing", () => {
    const { store, conn, timers } = makeTimedStore();
    replayRange(conn, 0, 1, { firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
    store.catchUp();
    timers.advance(CATCH_UP_DEADLINE_MS - 1_000);
    conn.dispatchDecoded(FeedId.SESSION_STATE, { tug_session_id: TUG, state: "spawning" });
    timers.advance(CATCH_UP_DEADLINE_MS - 1_000);
    expect(store.getSnapshot().catchingUp).toBe(true);
    conn.dispatchDecoded(FeedId.SESSION_STATE, { tug_session_id: TUG, state: "live" });
    timers.advance(1_000);
    expect(store.getSnapshot().catchingUp).toBe(false);
  });

  it("a session that respawns again before answering lets the ask go: the catch-up ends, and the send it held goes out", () => {
    const { store, conn, timers } = makeTimedStore();
    replayRange(conn, 0, 1, { firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
    store.catchUp();
    const askId = lastAsk(conn);
    store.send("prompt 2", []);
    for (const spawn of ["spawning", "live", "spawning"]) {
      conn.dispatchDecoded(FeedId.SESSION_STATE, { tug_session_id: TUG, state: spawn });
    }
    const state = store._getInternalStateForDevPanel();
    expect(state.catchUp).toMatchObject({ stage: "none", asks: [], letGo: [askId] });
    expect(store.getSnapshot().catchingUp).toBe(false);
    expect(userMessagesOf(conn)).toHaveLength(1);
    // No deadline stands over an ask the card let go.
    expect(timers.pending).toBe(0);
  });

  it("the session's spawn moves nothing when no catch-up waits", () => {
    const settled = createInitialState(TUG, "catch-up", "resume");
    for (const spawn of ["spawning", "live"] as const) {
      expect(reduce(settled, { type: "session_spawn_state", state: spawn })).toEqual({ state: settled, effects: [] });
    }
  });
});

describe("catchUp — an ask the session ends", () => {
  const WAKE = { type: "wake_started", wake_trigger: { task_id: "t", tool_use_id: "", status: "completed", summary: "done", output_file: "" } };
  const settled = (): CodeSessionState => ({
    ...createInitialState(TUG, "catch-up", "resume"),
    replayWindow: { firstLoadedTurnIndex: 5, totalTurns: 50, hasOlder: true },
  });
  const step = (state: CodeSessionState, event: Record<string, unknown>) => reduce(state, event as unknown as CodeSessionEvent);
  const RESUME_FAILED = { type: "resume_failed", reason: "no_conversation", stale_session_id: "s" };
  const ERRORED = { type: "session_state_errored", detail: "resume_failed" };

  it("a session that fails to resume lets the lapsed ask go: a bracket naming it later is shadowed, and the window keeps its start", () => {
    const lapsed = step(step(settled(), begin()).state, { type: "tick_catch_up" }).state;
    const askId = askOf(lapsed);
    const failed = step(step(lapsed, RESUME_FAILED).state, ERRORED).state;
    expect(failed.catchUp.asks).toEqual([]);
    expect(failed.catchUp.letGo).toEqual([askId]);
    const read = step(failed, { type: "replay_started", ask_id: askId }).state;
    expect(read.catchUp).toMatchObject({ stage: "none", letGo: [] });
    expect(read).toMatchObject({ replayShadowActive: true, replayShadowInert: true });
    const closed = step(read, { type: "replay_complete", count: 50, firstLoadedTurnIndex: 0, totalTurns: 50, hasOlder: false }).state;
    expect(closed.replayWindow).toEqual({ firstLoadedTurnIndex: 5, totalTurns: 50, hasOlder: true });
    expect(closed.replayShadowActive).toBe(false);
  });

  const deaths: ReadonlyArray<readonly [string, ReadonlyArray<Record<string, unknown>>, string]> = [
    ["resume_failed", [RESUME_FAILED, ERRORED], "resume_failed"],
    ["session_state_errored", [ERRORED], "session_state_errored"],
    ["session_unknown", [{ type: "session_unknown" }], "session_unknown"],
    ["session_not_owned", [{ type: "session_not_owned" }], "session_not_owned"],
  ];
  for (const [name, frames, cause] of deaths) {
    it(`${name} while the catch-up waits ends it, reduces what was set aside, lets the ask go, and writes the queued send nowhere`, () => {
      const { store, conn } = makeStore();
      replayRange(conn, 0, 1, { firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
      store.catchUp();
      store.send("prompt 4", []);
      const id = FIXTURE_IDS.MSG_ID_N(3);
      emit(conn, WAKE);
      emit(conn, { type: "assistant_text", status: "complete", msg_id: id, text: "said meanwhile", is_partial: false, rev: 0, seq: 0 });
      emit(conn, { type: "turn_complete", seq: 0, msg_id: id, result: "success" });
      const heard = store._getInternalStateForDevPanel();
      expect(heard.catchUp.held).toHaveLength(3);
      expect(heard.queuedSends).toHaveLength(1);

      let state = heard;
      const effects: Effect[] = [];
      for (const frame of frames) {
        const next = step(state, frame);
        state = next.state;
        effects.push(...next.effects);
      }
      expect(state.catchUp).toMatchObject({ stage: "none", asks: [], held: [], behind: null });
      expect(effects).toContainEqual({ kind: "cancel_timer", name: "catch_up" });
      // The held turn is the session's last word and is committed, but the
      // boundary it reaches sends nothing to the session that died.
      expect(state.committedMsgIds.has(id)).toBe(true);
      expect(state).toMatchObject({ phase: "errored", lastError: { cause } });
      expect(effects.some((e) => e.kind === "send-frame")).toBe(false);
      expect(state.queuedSends).toHaveLength(1);

      // Nothing later writes it to that session either: a stale deadline,
      // nor the host's network path coming back.
      for (const later of [{ type: "tick_catch_up" }, { type: "network_path_satisfied" }]) {
        const next = step(state, later);
        expect(next.effects.some((e) => e.kind === "send-frame")).toBe(false);
        state = next.state;
      }
      expect(state.queuedSends).toHaveLength(1);
    });
  }

  it("a session that fails to resume after delivering the user's answer commits it: the cycle ends, and nothing is written to it", () => {
    const { store, conn } = makeStore();
    replayRange(conn, 0, 1, { firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
    store.send("prompt 2", []);
    expect(store._getInternalStateForDevPanel().phase).toBe("submitting");
    store.catchUp();
    const id = FIXTURE_IDS.MSG_ID_N(2);
    emit(conn, { type: "assistant_text", status: "complete", msg_id: id, text: "the answer", is_partial: false, rev: 0, seq: 0 });
    emit(conn, { type: "turn_complete", seq: 0, msg_id: id, result: "success" });
    const heard = store._getInternalStateForDevPanel();
    expect(heard.catchUp.held).toHaveLength(2);

    let state = heard;
    const effects: Effect[] = [];
    for (const frame of [RESUME_FAILED, ERRORED]) {
      const next = step(state, frame);
      state = next.state;
      effects.push(...next.effects);
    }
    expect(state.committedMsgIds.has(id)).toBe(true);
    expect(state.pendingTurn).toBeNull();
    expect(state.scratch.size).toBe(0);
    expect(state).toMatchObject({ phase: "errored", lastError: { cause: "resume_failed" } });
    expect(state.catchUp).toMatchObject({ stage: "none", asks: [], held: [] });
    expect(effects.some((e) => e.kind === "send-frame")).toBe(false);
  });

  for (const name of ["session_unknown", "session_not_owned"] as const) {
    it(`${name} on a settled card with no catch-up changes nothing`, () => {
      const idle = settled();
      expect(step(idle, { type: name })).toEqual({ state: idle, effects: [] });
    });
  }

  for (const name of ["session_unknown", "session_not_owned"] as const) {
    it(`${name} inside the catch-up's open bracket ends it, and the send stays queued`, () => {
      const { store, conn } = makeStore();
      replayRange(conn, 0, 1, { firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
      store.catchUp();
      store.send("prompt 2", []);
      emit(conn, { type: "replay_started", ask_id: lastAsk(conn) });
      const out = step(store._getInternalStateForDevPanel(), { type: name });
      expect(out.state).toMatchObject({ phase: "errored", lastError: { cause: name } });
      expect(out.state.catchUp).toMatchObject({ stage: "none", openWindow: null });
      expect(out.effects.some((e) => e.kind === "send-frame")).toBe(false);
      expect(out.state.queuedSends).toHaveLength(1);
    });
  }

  /** tugcast's notice that it dropped the ask named `askId` unanswered. */
  const dropped = (conn: TestFrameChannel, askId: string) =>
    conn.dispatchDecoded(FeedId.CONTROL, { type: "request_replay_dropped", ask_id: askId, tug_session_id: TUG });

  it("a wire that closes while the catch-up waits lets every ask go, sets aside nothing more, and writes nothing", () => {
    const { store, conn } = makeStore();
    replayRange(conn, 0, 1, { firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
    store.catchUp();
    const askId = lastAsk(conn);
    store.send("prompt 4", []);
    const id = FIXTURE_IDS.MSG_ID_N(3);
    emit(conn, WAKE);
    emit(conn, { type: "turn_complete", seq: 0, msg_id: id, result: "success" });
    const lost = step(store._getInternalStateForDevPanel(), { type: "transport_close" });
    expect(lost.state.catchUp).toMatchObject({ stage: "none", asks: [], held: [], letGo: [askId] });
    expect(lost.state).toMatchObject({ transportState: "offline" });
    expect(lost.effects).toContainEqual({ kind: "cancel_timer", name: "catch_up" });
    expect(lost.effects.some((e) => e.kind === "send-frame")).toBe(false);
    expect(lost.state.committedMsgIds.has(id)).toBe(false);
    expect(lost.state.queuedSends).toHaveLength(1);
    // The reconnect's bracket, unnamed, is a read of its own again rather
    // than shadowed behind an ask nobody will answer.
    const read = step(step(lost.state, { type: "transport_open" }).state, { type: "replay_started" }).state;
    expect(read).toMatchObject({ phase: "replaying", replayShadowActive: false });
  });

  it("an ask tugcast dropped ends the catch-up waiting on it at once, and the send it held goes out", () => {
    const { store, conn, timers } = makeTimedStore();
    replayRange(conn, 0, 1, { firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
    store.catchUp();
    const askId = lastAsk(conn);
    store.send("prompt 2", []);
    dropped(conn, askId);
    expect(store._getInternalStateForDevPanel().catchUp).toMatchObject({ stage: "none", asks: [], letGo: [askId] });
    expect(store.getSnapshot().catchingUp).toBe(false);
    expect(userMessagesOf(conn)).toHaveLength(1);
    expect(timers.pending).toBe(0);

    // Its answer, should one come after all, re-bases nothing.
    replayRange(conn, 1, 2, { firstLoadedTurnIndex: 1, totalTurns: 3, hasOlder: true }, askId);
    expect(store.getSnapshot().replayWindow).toEqual({ firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
  });

  it("a lapsed ask tugcast dropped is let go, and the catch-up waiting on a later one stands", () => {
    const { store, conn, timers } = makeTimedStore();
    replayRange(conn, 0, 1, { firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
    store.catchUp();
    const lapsed = lastAsk(conn);
    timers.advance(CATCH_UP_DEADLINE_MS);
    store.catchUp();
    const waited = lastAsk(conn);
    dropped(conn, lapsed);
    const { catchUp } = store._getInternalStateForDevPanel();
    expect(catchUp.stage).toBe("asked");
    expect(catchUp.asks.map((a) => a.id)).toEqual([waited]);
    expect(catchUp.letGo).toEqual([lapsed]);
  });

  it("a drop naming no ask the card owes changes nothing", () => {
    const settled = createInitialState(TUG, "catch-up", "resume");
    expect(step(settled, { type: "request_replay_dropped", askId: "ask-elsewhere" })).toEqual({ state: settled, effects: [] });
  });

  it("a re-ask that lapses keeps its choice of window into its late answer", () => {
    // A read asked for, whose bracket the card sleeps inside and re-asks with
    // the read's own window: the answer closes as the read would have.
    const reading = step(step(settled(), { type: "replay_asked", window: { lastTurns: 50 } }).state, { type: "replay_started" }).state;
    const reasked = step(step(reading, { type: "went_dormant" }).state, begin()).state;
    expect(reasked.catchUp.asks[reasked.catchUp.asks.length - 1].keepsWindow).toBe(false);
    const askId = askOf(reasked);
    // Its deadline passes, the old bracket is abandoned by its silence, and
    // the answer comes late.
    const abandoned = step(step(reasked, { type: "tick_catch_up" }).state, { type: "tick_replay_silence" }).state;
    expect(abandoned.phase).toBe("errored");
    const late = step(abandoned, { type: "replay_started", ask_id: askId }).state;
    expect(late.catchUp).toMatchObject({ stage: "open", answering: { id: askId, keepsWindow: false } });
    const closed = step(late, { type: "replay_complete", count: 4, firstLoadedTurnIndex: 7, totalTurns: 11, hasOlder: true }).state;
    expect(closed.replayWindow).toEqual({ firstLoadedTurnIndex: 7, totalTurns: 11, hasOlder: true });
  });

  it("a reveal inside the catch-up's own bracket asks nothing and arms nothing", () => {
    const asked = step(settled(), begin()).state;
    const open = step(asked, { type: "replay_started", ask_id: askOf(asked) }).state;
    const again = step(open, begin());
    expect(again.state.catchUp).toBe(open.catchUp);
    expect(again.effects.some((e) => e.kind === "schedule_timer" && e.name === "catch_up")).toBe(false);

    const { store, conn } = makeStore();
    replayRange(conn, 0, 1, { firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
    store.catchUp();
    emit(conn, { type: "replay_started", ask_id: lastAsk(conn) });
    store.catchUp();
    expect(catchUpAsks(conn)).toHaveLength(1);
  });
});

describe("catchUp — every exit from an open bracket, and the send it held", () => {
  const step = (state: CodeSessionState, event: Record<string, unknown>) => reduce(state, event as unknown as CodeSessionEvent);

  /** A settled card whose catch-up's bracket is open, with a send queued behind it. */
  function openWithASend(): { store: CodeSessionStore; conn: TestFrameChannel; timers: FakeTimers } {
    const made = makeTimedStore();
    replayRange(made.conn, 0, 1, { firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
    made.store.catchUp();
    made.store.send("prompt 2", []);
    emit(made.conn, { type: "replay_started", ask_id: lastAsk(made.conn) });
    expect(made.store._getInternalStateForDevPanel().catchUp.stage).toBe("open");
    return made;
  }
  const sends = (effects: Effect[]) => effects.filter((e) => e.kind === "send-frame");

  it("a wire error ends it, and the send goes out to the session still there", () => {
    const { store } = openWithASend();
    const out = step(store._getInternalStateForDevPanel(), { type: "error", message: "boom", recoverable: true, site: "x" });
    expect(out.state.catchUp).toMatchObject({ stage: "none", openWindow: null });
    expect(out.effects).toContainEqual({ kind: "cancel_timer", name: "catch_up" });
    expect(sends(out.effects)).toHaveLength(1);
    expect(out.state.queuedSends).toHaveLength(0);
  });

  it("a transport close ends it, lets every ask go, and the send waits for the reconnect", () => {
    const { store } = openWithASend();
    const out = step(store._getInternalStateForDevPanel(), { type: "transport_close" });
    expect(out.state).toMatchObject({ phase: "errored", transportState: "offline" });
    expect(out.state.catchUp).toMatchObject({ stage: "none", openWindow: null, answering: null, asks: [] });
    expect(out.effects).toContainEqual({ kind: "cancel_timer", name: "catch_up" });
    expect(sends(out.effects)).toHaveLength(0);
    expect(out.state.queuedSends).toHaveLength(1);
  });

  it("a wire error before the bracket opens leaves the catch-up waiting, and its deadline sends to the session still there", () => {
    const made = makeTimedStore();
    replayRange(made.conn, 0, 1, { firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
    made.store.catchUp();
    made.store.send("prompt 2", []);
    const errored = step(made.store._getInternalStateForDevPanel(), { type: "error", message: "boom", recoverable: true, site: "x" });
    expect(errored.state.catchUp.stage).toBe("asked");
    expect(sends(errored.effects)).toHaveLength(0);
    const lapsed = step(errored.state, { type: "tick_catch_up" });
    expect(lapsed.state.catchUp.stage).toBe("none");
    expect(sends(lapsed.effects)).toHaveLength(1);
    expect(lapsed.state.queuedSends).toHaveLength(0);
  });

  it("a session that fails to resume ends it, and the send stays queued for the card's next session", () => {
    const { store } = openWithASend();
    const failed = step(store._getInternalStateForDevPanel(), { type: "resume_failed", reason: "r", stale_session_id: "s" });
    const out = step(failed.state, { type: "session_state_errored", detail: "resume_failed" });
    expect(out.state.phase).toBe("errored");
    expect(out.state.catchUp).toMatchObject({ stage: "none", openWindow: null, asks: [] });
    expect(sends([...failed.effects, ...out.effects])).toHaveLength(0);
    expect(out.state.queuedSends).toHaveLength(1);
  });

  it("a session that errors ends it, and the send stays queued", () => {
    const { store } = openWithASend();
    const out = step(store._getInternalStateForDevPanel(), { type: "session_state_errored", detail: "crash_budget_exhausted" });
    expect(out.state.catchUp).toMatchObject({ stage: "none", openWindow: null, asks: [] });
    expect(sends(out.effects)).toHaveLength(0);
    expect(out.state.queuedSends).toHaveLength(1);
  });

  it("an aborted close ends it, and the send goes out", () => {
    const { store } = openWithASend();
    const out = step(store._getInternalStateForDevPanel(), { type: "replay_complete", count: 0, aborted: true });
    expect(out.state.catchUp).toMatchObject({ stage: "none", openWindow: null });
    expect(sends(out.effects)).toHaveLength(1);
    expect(out.state.phase).toBe("submitting");
  });

  it("a disposed store ends its wait: no timer stands and nothing more is written", () => {
    const { store, conn, timers } = openWithASend();
    const written = conn.recordedFrames.length;
    store.dispose();
    expect(timers.pending).toBe(0);
    // The dead store owes nothing and remembers nothing.
    expect(store._getInternalStateForDevPanel().catchUp).toMatchObject({ stage: "none", asks: [], letGo: [], answering: null });
    emit(conn, { type: "replay_complete", count: 0, firstLoadedTurnIndex: 0, totalTurns: 2, hasOlder: false });
    timers.advance(CATCH_UP_DEADLINE_MS);
    store.catchUp();
    expect(conn.recordedFrames.length).toBe(written);
    expect(userMessagesOf(conn)).toHaveLength(0);
  });
});
