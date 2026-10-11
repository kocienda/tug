/**
 * Perf-counter tests for `CodeSessionStore` — the replay-ingest and
 * live-turn commit counters behind `perf.replay_ingest` /
 * `perf.live_commits`.
 *
 * Counters are asserted through the `_getPerfForDevPanel()` dev
 * accessor against the REAL store + reducer (frames dispatched via
 * the same `_ingestFrameForTest` path the app-test harness uses).
 * The properties pinned here:
 *
 *   - a replay window counts every dispatched frame and every
 *     listener notification between `replay_started` and
 *     `replay_complete`, then closes into `lastReplay`;
 *   - a second window resets the counts (no accumulation across
 *     windows);
 *   - a live turn counts notifications between `send` and its
 *     `turn_complete`;
 *   - replayed `turn_complete` frames never close a live-turn
 *     window (the replay window owns them).
 */

import { describe, it, expect } from "bun:test";

import { CodeSessionStore } from "@/lib/code-session-store";
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

/** One full replayed turn: opener, content, terminal. */
function emitReplayedTurn(conn: TestFrameChannel, n: number): void {
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

describe("CodeSessionStore — replay-ingest perf counters", () => {
  it("counts frames and commits inside the replay window, closes into lastReplay", () => {
    const { store, conn } = makeStore();

    expect(store._getPerfForDevPanel().replay).toBeNull();
    expect(store._getPerfForDevPanel().lastReplay).toBeNull();

    emit(conn, { type: "replay_started" });
    expect(store._getPerfForDevPanel().replay).not.toBeNull();

    emitReplayedTurn(conn, 1);
    emitReplayedTurn(conn, 2);
    emit(conn, { type: "replay_complete", count: 2 });

    const perf = store._getPerfForDevPanel();
    expect(perf.replay).toBeNull();
    const last = perf.lastReplay;
    expect(last).not.toBeNull();
    // replay_started + 2 × (add_user_message, assistant_text,
    // turn_complete) + replay_complete = 8 dispatched frames.
    expect(last!.frames).toBe(8);
    // Replay fold: one publish at replay_started (paint gate mounts)
    // plus one flush at replay_complete carrying the 6 deferred
    // content frames — 2 commits, 1 fold.
    expect(last!.commits).toBe(2);
    expect(last!.folds).toBe(1);
    expect(last!.completedAtMs).not.toBeNull();
    expect(last!.completedAtMs!).toBeGreaterThanOrEqual(last!.startedAtMs);

    // The replayed transcript actually committed both turns.
    expect(store.getSnapshot().transcript).toHaveLength(2);
  });

  it("resets per window — a second replay does not accumulate the first's counts", () => {
    const { store, conn } = makeStore();

    emit(conn, { type: "replay_started" });
    emitReplayedTurn(conn, 1);
    emitReplayedTurn(conn, 2);
    emit(conn, { type: "replay_complete", count: 2 });

    emit(conn, { type: "replay_started" });
    emitReplayedTurn(conn, 3);
    emit(conn, { type: "replay_complete", count: 1 });

    const last = store._getPerfForDevPanel().lastReplay;
    expect(last).not.toBeNull();
    // Second window only: replay_started + 3 turn frames + replay_complete.
    expect(last!.frames).toBe(5);
    expect(last!.commits).toBe(2);
  });
});

describe("CodeSessionStore — live-turn perf counters", () => {
  it("counts commits between send and turn_complete, closes into lastLiveTurn", () => {
    const { store, conn } = makeStore();

    store.send("hello", []);
    const open = store._getPerfForDevPanel().liveTurn;
    expect(open).not.toBeNull();
    const turnKey = open!.turnKey;

    emit(conn, {
      type: "assistant_text",
      status: "partial",
      msg_id: FIXTURE_IDS.MSG_ID_N(1),
      text: "partial",
      is_partial: true,
      rev: 0,
      seq: 0,
    });
    emit(conn, {
      type: "assistant_text",
      status: "partial",
      msg_id: FIXTURE_IDS.MSG_ID_N(1),
      text: "partial more",
      is_partial: true,
      rev: 0,
      seq: 1,
    });
    emit(conn, {
      type: "turn_complete",
      seq: 0,
      msg_id: FIXTURE_IDS.MSG_ID_N(1),
      result: "success",
    });

    const perf = store._getPerfForDevPanel();
    expect(perf.liveTurn).toBeNull();
    const last = perf.lastLiveTurn;
    expect(last).not.toBeNull();
    expect(last!.turnKey).toBe(turnKey);
    // send + 2 deltas + turn_complete each notified — 4 commits on
    // the pre-render-once baseline.
    expect(last!.commits).toBe(4);
  });

  it("replayed turn_complete frames never close a live-turn window", () => {
    const { store, conn } = makeStore();

    // A replay window with turns inside it must not produce
    // lastLiveTurn records — those turn_completes are history.
    emit(conn, { type: "replay_started" });
    emitReplayedTurn(conn, 1);
    emit(conn, { type: "replay_complete", count: 1 });

    expect(store._getPerfForDevPanel().lastLiveTurn).toBeNull();
  });
});
