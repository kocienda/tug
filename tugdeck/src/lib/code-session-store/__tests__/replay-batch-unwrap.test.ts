/**
 * `replay_batch` unwrap at the ingest boundary.
 *
 * A `replay_batch` is a transport-only envelope: the store unwraps it
 * and decodes and dispatches each inner frame exactly as a per-frame
 * replay would. These tests pin the
 * invariant that batched ingest is indistinguishable from per-frame
 * ingest — same transcript, same dispatched-frame count — against the
 * REAL store + reducer (frames delivered through the same
 * `TestFrameChannel` the app-test harness uses).
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

/** Outer CODE_OUTPUT frame — carries the spliced tug_session_id. */
function emit(conn: TestFrameChannel, evt: Record<string, unknown>): void {
  conn.dispatchDecoded(FeedId.CODE_OUTPUT, { ...evt, tug_session_id: TUG });
}

/** The inner frames of one replayed turn (no tug_session_id — those
 *  are spliced only on the outer envelope in production). */
function turnFrames(n: number): Array<Record<string, unknown>> {
  return [
    { type: "add_user_message", content: [{ type: "text", text: `prompt ${n}` }] },
    {
      type: "assistant_text",
      status: "complete",
      msg_id: FIXTURE_IDS.MSG_ID_N(n),
      text: `reply ${n}`,
      is_partial: false,
      rev: 0,
      seq: 0,
    },
    { type: "turn_complete", seq: 0, msg_id: FIXTURE_IDS.MSG_ID_N(n), result: "success" },
  ];
}

describe("CodeSessionStore — replay_batch unwrap", () => {
  it("batched ingest is indistinguishable from per-frame ingest", () => {
    // Store A: bracket → ONE replay_batch carrying two turns → bracket.
    const a = makeStore();
    emit(a.conn, { type: "replay_started" });
    emit(a.conn, { type: "replay_batch", frames: [...turnFrames(1), ...turnFrames(2)] });
    emit(a.conn, { type: "replay_complete", count: 2 });

    // Store B: bracket → the same six frames individually → bracket.
    const b = makeStore();
    emit(b.conn, { type: "replay_started" });
    for (const f of [...turnFrames(1), ...turnFrames(2)]) emit(b.conn, f);
    emit(b.conn, { type: "replay_complete", count: 2 });

    // The batch committed both turns with their real content (the
    // wall-clock-minted timestamps/keys differ between independently
    // ingested stores, so we assert content, not a byte-equal snapshot).
    const tx = a.store.getSnapshot().transcript;
    expect(tx).toHaveLength(2);
    const json = JSON.stringify(tx);
    for (const s of ["prompt 1", "reply 1", "prompt 2", "reply 2"]) {
      expect(json).toContain(s);
    }

    // Identical dispatched-frame count: the batch unwraps to its inner
    // frames, so both windows count replay_started + 6 content +
    // replay_complete = 8. This is the unwrap invariant — every inner
    // frame reached the reducer.
    const af = a.store._getPerfForDevPanel().lastReplay;
    const bf = b.store._getPerfForDevPanel().lastReplay;
    expect(af).not.toBeNull();
    expect(af!.frames).toBe(8);
    expect(af!.frames).toBe(bf!.frames);
  });

  it("a non-batch frame still routes unchanged", () => {
    const { store, conn } = makeStore();
    emit(conn, { type: "replay_started" });
    for (const f of turnFrames(1)) emit(conn, f);
    emit(conn, { type: "replay_complete", count: 1 });

    expect(store.getSnapshot().transcript).toHaveLength(1);
    expect(store._getPerfForDevPanel().lastReplay!.frames).toBe(5);
  });
});
