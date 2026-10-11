/**
 * Load-previous prepend — a windowed replay bracket flagged via
 * `beginLoadPreviousBracket()` commits its older turns to the FRONT of
 * the transcript, in arrival order, while every already-loaded turn keeps
 * its `TurnEntry` identity (and thus `turnKey` / React mount) across the
 * index shift ([L26]). The stable-id row keys ([P06]) mean a prepend
 * never re-keys an existing row. Driven through the real store + reducer.
 */

import { describe, it, expect } from "bun:test";

import { CodeSessionStore } from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { FeedId } from "@/protocol";
import { SessionTranscriptDataSource } from "@/lib/session-transcript-data-source";

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
  emit(conn, {
    type: "add_user_message",
    content: [{ type: "text", text: `prompt ${n}` }],
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

/**
 * Replay a turn range `[lo, hi]` inside one bracket carrying turn-based
 * window meta.
 */
function replayRange(
  conn: TestFrameChannel,
  lo: number,
  hi: number,
  meta: { firstLoadedTurnIndex: number; totalTurns: number; hasOlder: boolean },
): void {
  emit(conn, { type: "replay_started" });
  for (let n = lo; n <= hi; n++) emitTurn(conn, n);
  emit(conn, {
    type: "replay_complete",
    count: hi - lo + 1,
    firstLoadedTurnIndex: meta.firstLoadedTurnIndex,
    totalTurns: meta.totalTurns,
    hasOlder: meta.hasOlder,
  });
}

describe("load-previous prepend", () => {
  it("prepends older turns in order, preserving existing turn identity", () => {
    const { store, conn } = makeStore();

    // Initial cold-resume window: the recent 3 of 8 total turns (5,6,7),
    // older turns exist.
    replayRange(conn, 5, 7, {
      firstLoadedTurnIndex: 5,
      totalTurns: 8,
      hasOlder: true,
    });
    const recent = store.getSnapshot().transcript;
    expect(recent).toHaveLength(3);
    const recentKeys = recent.map((t) => t.turnKey);

    // Page in the older range (2,3,4) above the current view.
    store.beginLoadPreviousBracket();
    replayRange(conn, 2, 4, {
      firstLoadedTurnIndex: 2,
      totalTurns: 8,
      hasOlder: true,
    });

    const after = store.getSnapshot().transcript;
    // Older batch lands at the front, in arrival order; existing turns
    // follow, unshifted relative to each other.
    expect(after).toHaveLength(6);
    expect(after.map((t) => t.msgId)).toEqual([
      FIXTURE_IDS.MSG_ID_N(2),
      FIXTURE_IDS.MSG_ID_N(3),
      FIXTURE_IDS.MSG_ID_N(4),
      FIXTURE_IDS.MSG_ID_N(5),
      FIXTURE_IDS.MSG_ID_N(6),
      FIXTURE_IDS.MSG_ID_N(7),
    ]);

    // [L26]: the already-loaded turns keep their exact TurnEntry refs
    // (and turnKeys) — only their index shifted.
    expect(after.slice(3).map((t) => t.turnKey)).toEqual(recentKeys);
    expect(after[3]).toBe(recent[0]);
    expect(after[4]).toBe(recent[1]);
    expect(after[5]).toBe(recent[2]);
  });

  it("a cancelled (aborted) load-previous discards the staged batch, window intact", () => {
    const { store, conn } = makeStore();

    replayRange(conn, 5, 7, {
      firstLoadedTurnIndex: 5,
      totalTurns: 8,
      hasOlder: true,
    });
    const before = store.getSnapshot();
    const beforeKeys = before.transcript.map((t) => t.turnKey);
    const beforeWindow = before.replayWindow;

    // Begin a load-previous bracket, stage some older turns, then the
    // bracket is aborted (user cancelled).
    store.beginLoadPreviousBracket();
    emit(conn, { type: "replay_started" });
    emitTurn(conn, 3);
    emitTurn(conn, 4);
    emit(conn, { type: "replay_complete", count: 2, aborted: true });

    const after = store.getSnapshot();
    // Staged older turns dropped — transcript and window unchanged.
    expect(after.transcript.map((t) => t.turnKey)).toEqual(beforeKeys);
    expect(after.transcript).toHaveLength(3);
    expect(after.replayWindow).toEqual(beforeWindow);
    expect(after.phase).toBe("idle");
  });

  it("keeps row ids content-addressed across the prepend ([P06])", () => {
    const { store, conn } = makeStore();
    const ds = new SessionTranscriptDataSource(store);

    replayRange(conn, 5, 7, {
      firstLoadedTurnIndex: 5,
      totalTurns: 8,
      hasOlder: true,
    });
    // The first loaded turn's user row is row 0 before the prepend.
    const firstTurnUserIdBefore = ds.idForIndex(0);
    expect(ds.numberOfItems()).toBe(6); // 3 turns × 2 rows

    store.beginLoadPreviousBracket();
    replayRange(conn, 2, 4, {
      firstLoadedTurnIndex: 2,
      totalTurns: 8,
      hasOlder: true,
    });

    // 3 older turns prepended → 6 new rows; the same turn's user row is
    // now row 6, but its id is unchanged (keyed by turnKey, not index).
    expect(ds.numberOfItems()).toBe(12);
    expect(ds.idForIndex(6)).toBe(firstTurnUserIdBefore);
  });

  it("exposes hasOlder / oldestLoadedTurnIndex from the window metadata", () => {
    const { store, conn } = makeStore();
    const ds = new SessionTranscriptDataSource(store);

    replayRange(conn, 5, 7, {
      firstLoadedTurnIndex: 5,
      totalTurns: 8,
      hasOlder: true,
    });
    expect(ds.hasOlder()).toBe(true);
    expect(ds.oldestLoadedTurnIndex()).toBe(5);

    store.beginLoadPreviousBracket();
    replayRange(conn, 0, 4, {
      firstLoadedTurnIndex: 0,
      totalTurns: 8,
      hasOlder: false,
    });
    // Everything older is now loaded.
    expect(ds.hasOlder()).toBe(false);
    expect(ds.oldestLoadedTurnIndex()).toBe(0);
  });

  it("a normal (non-prepend) replay still appends", () => {
    const { store, conn } = makeStore();
    replayRange(conn, 1, 3, {
      firstLoadedTurnIndex: 0,
      totalTurns: 3,
      hasOlder: false,
    });
    expect(store.getSnapshot().transcript.map((t) => t.msgId)).toEqual([
      FIXTURE_IDS.MSG_ID_N(1),
      FIXTURE_IDS.MSG_ID_N(2),
      FIXTURE_IDS.MSG_ID_N(3),
    ]);
  });
});
