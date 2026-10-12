/**
 * Transcript cap — a session that commits more context turns than the cap
 * holds the newest `cap` in `_transcript`, and the evicted ones become older
 * turns the load-previous door pages back in: the recency window advances
 * past them and reports `hasOlder`, exactly as a partially restored session
 * does. Driven through the real store + reducer with a small cap.
 */

import { describe, it, expect } from "bun:test";

import {
  CodeSessionStore,
  REPLAY_FOLD_FLUSH_THRESHOLD,
  REWIND_ANCHOR_OUTSIDE_WINDOW,
} from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { FeedId } from "@/protocol";
import { evictOldestTurns } from "@/lib/code-session-store/reducer";
import type { TurnEntry } from "@/lib/code-session-store/types";

const TUG = FIXTURE_IDS.TUG_SESSION_ID;
const CAP = 5;

function makeStore(): { store: CodeSessionStore; conn: TestFrameChannel } {
  const conn = new TestFrameChannel();
  const store = new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: TUG,
    sessionMode: "resume",
    transcriptTurnCap: CAP,
    restoreWindowTurns: CAP,
  });
  return { store, conn };
}

function emit(conn: TestFrameChannel, evt: Record<string, unknown>): void {
  conn.dispatchDecoded(FeedId.CODE_OUTPUT, { ...evt, tug_session_id: TUG });
}

function emitTurn(conn: TestFrameChannel, n: number): void {
  emit(conn, {
    type: "add_user_message",
    content: [{ type: "text", text: `prompt ${n}` }],
    promptUuid: anchor(n),
  });
  emit(conn, {
    type: "assistant_text",
    status: "complete",
    msg_id: FIXTURE_IDS.MSG_ID_N(n),
    text: `reply ${n}`,
    is_partial: false,
    rev: 0,
    seq: 0,
  });
  emit(conn, {
    type: "turn_complete",
    seq: 0,
    msg_id: FIXTURE_IDS.MSG_ID_N(n),
    result: "success",
  });
}

/** A live turn: the user sends, the reply streams, the turn commits. */
function liveTurn(
  store: CodeSessionStore,
  conn: TestFrameChannel,
  n: number,
): void {
  store.send(`prompt ${n}`, []);
  emit(conn, { type: "prompt_anchor", promptUuid: anchor(n) });
  emit(conn, {
    type: "assistant_text",
    status: "partial",
    msg_id: FIXTURE_IDS.MSG_ID_N(n),
    text: `reply ${n}`,
    is_partial: true,
    rev: 0,
    seq: 0,
  });
  emit(conn, {
    type: "turn_complete",
    seq: 0,
    msg_id: FIXTURE_IDS.MSG_ID_N(n),
    result: "success",
  });
}

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

function anchor(n: number): string {
  return `prompt-uuid-${n}`;
}

function ids(lo: number, hi: number): string[] {
  const out: string[] = [];
  for (let n = lo; n <= hi; n++) out.push(FIXTURE_IDS.MSG_ID_N(n));
  return out;
}

function msgIds(store: CodeSessionStore): Array<string | null> {
  return store.getSnapshot().transcript.map((t) => t.msgId);
}

describe("transcript cap", () => {
  it("holds the window at the cap and advances the recency window past the evicted turns", () => {
    const { store, conn } = makeStore();
    replayRange(conn, 0, 2, {
      firstLoadedTurnIndex: 0,
      totalTurns: 3,
      hasOlder: false,
    });

    // Cap + N: seven more live turns, ten in all.
    for (let n = 3; n <= 9; n++) {
      liveTurn(store, conn, n);
      expect(store.getSnapshot().transcript.length).toBeLessThanOrEqual(CAP);
      expect(store._committedMsgIdCountForTest()).toBeLessThanOrEqual(CAP);
    }

    const snap = store.getSnapshot();
    expect(snap.transcript).toHaveLength(CAP);
    expect(msgIds(store)).toEqual(ids(5, 9));
    expect(snap.replayWindow).toEqual({
      firstLoadedTurnIndex: 5,
      totalTurns: 10,
      hasOlder: true,
    });
  });

  it("a load-previous bracket restores the evicted turns in order", () => {
    const { store, conn } = makeStore();
    replayRange(conn, 0, 2, {
      firstLoadedTurnIndex: 0,
      totalTurns: 3,
      hasOlder: false,
    });
    for (let n = 3; n <= 9; n++) liveTurn(store, conn, n);
    const kept = store.getSnapshot().transcript;

    store.loadPrevious("all");
    const replay = conn.recordedFrames
      .filter((f) => f.feedId === FeedId.CONTROL)
      .map((f) => JSON.parse(new TextDecoder().decode(f.decoded as Uint8Array)))
      .find((f) => f.action === "request_replay");
    expect(replay.window).toEqual({ turnRange: [0, 5] });

    replayRange(conn, 0, 4, {
      firstLoadedTurnIndex: 0,
      totalTurns: 10,
      hasOlder: false,
    });

    const after = store.getSnapshot();
    expect(msgIds(store)).toEqual(ids(0, 9));
    expect(after.replayWindow?.hasOlder).toBe(false);
    // The window that stayed loaded kept its entries across the prepend.
    expect(after.transcript.slice(5)).toEqual([...kept]);
    expect(after.transcript[5]).toBe(kept[0]);
  });

  it("keeps what the user paged in, sliding one turn per later append", () => {
    const { store, conn } = makeStore();
    replayRange(conn, 0, 2, {
      firstLoadedTurnIndex: 0,
      totalTurns: 3,
      hasOlder: false,
    });
    for (let n = 3; n <= 9; n++) liveTurn(store, conn, n);
    store.loadPrevious("all");
    replayRange(conn, 0, 4, {
      firstLoadedTurnIndex: 0,
      totalTurns: 10,
      hasOlder: false,
    });

    liveTurn(store, conn, 10);
    expect(msgIds(store)).toEqual(ids(1, 10));
    expect(store.getSnapshot().replayWindow).toEqual({
      firstLoadedTurnIndex: 1,
      totalTurns: 11,
      hasOlder: true,
    });
  });

  it("does not evict mid-replay, and holds a long replay to the cap when it closes", () => {
    const { store, conn } = makeStore();
    // An open fold posts nothing until a flush, so the mid-replay reading is
    // taken at the threshold's flush: enough turns to cross it.
    const turns = Math.ceil(REPLAY_FOLD_FLUSH_THRESHOLD / 3);
    const flushedTurns = Math.floor(REPLAY_FOLD_FLUSH_THRESHOLD / 3);
    emit(conn, { type: "replay_started" });
    for (let n = 0; n < turns; n++) emitTurn(conn, n);
    expect(store.getSnapshot().transcript).toHaveLength(flushedTurns);
    emit(conn, { type: "replay_complete", count: turns });

    expect(msgIds(store)).toEqual(ids(turns - CAP, turns - 1));
    expect(store.getSnapshot().replayWindow).toEqual({
      firstLoadedTurnIndex: turns - CAP,
      totalTurns: turns,
      hasOlder: true,
    });
  });

  it("keeps a faithful restore deeper than the cap, so its saved anchor stays loaded", () => {
    const conn = new TestFrameChannel();
    const store = new CodeSessionStore({
      conn: conn as unknown as TugConnection,
      lifecycle: new ConnectionLifecycle(),
      tugSessionId: TUG,
      sessionMode: "resume",
      transcriptTurnCap: CAP,
      restoreWindowTurns: 8,
    });
    replayRange(conn, 2, 9, {
      firstLoadedTurnIndex: 2,
      totalTurns: 10,
      hasOlder: true,
    });
    expect(msgIds(store)).toEqual(ids(2, 9));

    liveTurn(store, conn, 10);
    expect(msgIds(store)).toEqual(ids(3, 10));
    expect(store.getSnapshot().replayWindow?.firstLoadedTurnIndex).toBe(3);
  });
});

describe("rewind past the window", () => {
  function sentRewinds(conn: TestFrameChannel): unknown[] {
    return conn.recordedFrames.filter(
      (f) =>
        f.feedId === FeedId.CODE_INPUT &&
        (f.decoded as { type?: string }).type === "session_rewind",
    );
  }

  it("refuses a conversation rewind whose anchor was evicted, and sends nothing", () => {
    const { store, conn } = makeStore();
    replayRange(conn, 0, 2, {
      firstLoadedTurnIndex: 0,
      totalTurns: 3,
      hasOlder: false,
    });
    for (let n = 3; n <= 9; n++) liveTurn(store, conn, n);
    const before = store.getSnapshot().transcript;

    store.sessionRewind(anchor(2), "conversation");

    expect(sentRewinds(conn)).toEqual([]);
    expect(store.getSnapshot().lastRewindResult).toEqual({
      promptUuid: anchor(2),
      scope: "conversation",
      canRewind: false,
      error: REWIND_ANCHOR_OUTSIDE_WINDOW,
    });
    expect(store.getSnapshot().transcript).toBe(before);
  });

  it("sends a code-only rewind to an evicted anchor, which cuts no transcript", () => {
    const { store, conn } = makeStore();
    replayRange(conn, 0, 2, {
      firstLoadedTurnIndex: 0,
      totalTurns: 3,
      hasOlder: false,
    });
    for (let n = 3; n <= 9; n++) liveTurn(store, conn, n);

    store.sessionRewind(anchor(2), "code");

    expect(sentRewinds(conn)).toHaveLength(1);
  });

  it("holds eviction while a conversation rewind awaits its ack, so the anchor is still there to cut", () => {
    const { store, conn } = makeStore();
    replayRange(conn, 0, 4, {
      firstLoadedTurnIndex: 0,
      totalTurns: 5,
      hasOlder: false,
    });

    // Rewind to the second-oldest loaded turn; a turn commits before the ack
    // and, with the window full, would otherwise evict the oldest — the one
    // turn the cut keeps.
    store.sessionRewind(anchor(1), "conversation");
    expect(sentRewinds(conn)).toHaveLength(1);
    liveTurn(store, conn, 5);
    expect(msgIds(store)).toEqual(ids(0, 5));

    emit(conn, {
      type: "rewind_result",
      promptUuid: anchor(1),
      scope: "conversation",
      canRewind: true,
    });
    expect(msgIds(store)).toEqual(ids(0, 0));
  });
});

describe("evictOldestTurns", () => {
  function turn(key: string, origin: TurnEntry["origin"]): TurnEntry {
    return { turnKey: key, origin } as TurnEntry;
  }

  it("returns the same array when within the limit", () => {
    const t = [turn("a", "user"), turn("b", "user")];
    const r = evictOldestTurns(t, 2);
    expect(r.transcript).toBe(t);
    expect(r.evicted).toEqual([]);
    expect(r.windowTurns).toBe(2);
  });

  it("evicts only context turns, leaving ink rows in their seats", () => {
    const t = [
      turn("s1", "shell"),
      turn("a", "user"),
      turn("r1", "refs"),
      turn("b", "assistant"),
      turn("c", "wheel"),
      turn("s2", "shell"),
      turn("d", "user"),
    ];
    const r = evictOldestTurns(t, 2);
    expect(r.windowTurns).toBe(4);
    expect(r.evicted.map((x) => x.turnKey)).toEqual(["a", "b"]);
    expect(r.transcript.map((x) => x.turnKey)).toEqual([
      "s1",
      "r1",
      "c",
      "s2",
      "d",
    ]);
    // Survivors are the same entries.
    expect(r.transcript[2]).toBe(t[4]);
  });
});
