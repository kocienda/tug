/**
 * Replay-origin turn stamp — turns committed while the replay window
 * is open carry `replayed: true` (the collapsed-history presentation
 * keys off it); turns committed live leave the flag unset.
 */

import { describe, expect, it } from "bun:test";

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

describe("replayed-turn stamp", () => {
  it("stamps turns committed inside the replay window and not after", () => {
    const { store, conn } = makeStore();

    expect(store.getSnapshot().replayEverCompleted).toBe(false);
    emit(conn, { type: "replay_started" });
    emitTurn(conn, 1);
    emitTurn(conn, 2);
    emit(conn, { type: "replay_complete", count: 2 });
    expect(store.getSnapshot().replayEverCompleted).toBe(true);

    const replayed = store.getSnapshot().transcript;
    expect(replayed).toHaveLength(2);
    expect(replayed[0].replayed).toBe(true);
    expect(replayed[1].replayed).toBe(true);

    // A turn committed after the window closes is live history — the
    // live path opens via `send` and binds its msg_id on the first
    // content frame.
    store.send("live prompt", []);
    emit(conn, {
      type: "assistant_text",
      status: "complete",
      msg_id: FIXTURE_IDS.MSG_ID_N(3),
      text: "live reply",
      is_partial: false,
      rev: 0,
      seq: 0,
    });
    emit(conn, {
      type: "turn_complete",
      seq: 0,
      msg_id: FIXTURE_IDS.MSG_ID_N(3),
      result: "success",
    });
    const transcript = store.getSnapshot().transcript;
    expect(transcript).toHaveLength(3);
    expect(transcript[2].replayed).toBeUndefined();
  });

  it("replayEverCompleted is monotonic across a reconnect window", () => {
    const { store, conn } = makeStore();
    emit(conn, { type: "replay_started" });
    emitTurn(conn, 1);
    emit(conn, { type: "replay_complete", count: 1 });
    expect(store.getSnapshot().replayEverCompleted).toBe(true);

    // A reconnect catch-up window opens later: `lastReplayResult`
    // clears, but the monotonic flag must hold so the transcript
    // host's deferred-content hold can never re-engage against a
    // mounted list.
    emit(conn, { type: "replay_started" });
    expect(store.getSnapshot().lastReplayResult).toBeNull();
    expect(store.getSnapshot().replayEverCompleted).toBe(true);
    emit(conn, { type: "replay_complete", count: 0 });
    expect(store.getSnapshot().replayEverCompleted).toBe(true);
  });
});
