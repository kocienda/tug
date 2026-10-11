/**
 * Step 9 — per-card filter isolation.
 *
 * The `CodeSessionStore` constructs a filtered `FeedStore` subscribing
 * to `[CODE_OUTPUT, SESSION_STATE]` with a predicate matching only
 * frames whose payload `tug_session_id` matches the store's own. Two
 * stores against the same `TestFrameChannel` must therefore observe
 * disjoint frame streams even though the connection replays every
 * frame to every registered `onFrame` callback.
 *
 * This is the [D11] filter-scope contract: tugdeck-side per-card
 * filters enforce multi-session isolation on the shared CODE_OUTPUT
 * replay buffer; without the predicate, opening two Dev cards against
 * one backend would cross-wire their turn state machines.
 */

import { describe, it, expect } from "bun:test";

import { CodeSessionStore } from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import {
  TestFrameChannel,
} from "@/lib/code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { inflightValue } from "@/lib/code-session-store/testing/inflight-paths";import { FeedId } from "@/protocol";

const TUG_A = FIXTURE_IDS.TUG_SESSION_ID;
const TUG_B = "tug00000-0000-4000-8000-0000000000bb";

function constructStore(
  conn: TestFrameChannel,
  tugSessionId: string,
): CodeSessionStore {
  return new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId,
    sessionMode: "new",
  });
}

describe("CodeSessionStore — multi-instance filter isolation (Step 9)", () => {
  it("routes a resume_failed frame to the matching store only", () => {
    const conn = new TestFrameChannel();
    const storeA = constructStore(conn, TUG_A);
    const storeB = constructStore(conn, TUG_B);

    expect(storeA.getSnapshot().lastError).toBeNull();
    expect(storeB.getSnapshot().lastError).toBeNull();

    // A resume_failed for storeA's session should be visible only to A.
    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "resume_failed",
      reason: "missing_jsonl",
      stale_session_id: TUG_A,
      tug_session_id: TUG_A,
    });

    expect(storeA.getSnapshot().lastError?.cause).toBe("resume_failed");
    expect(storeB.getSnapshot().lastError).toBeNull();

    // And vice versa: a resume_failed for B leaves A's lastError
    // unchanged (already populated above).
    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "resume_failed",
      reason: "missing_jsonl",
      stale_session_id: TUG_B,
      tug_session_id: TUG_B,
    });

    expect(storeA.getSnapshot().lastError?.cause).toBe("resume_failed");
    expect(storeB.getSnapshot().lastError?.cause).toBe("resume_failed");
  });

  it("drives independent turn state machines for each store", () => {
    const conn = new TestFrameChannel();
    const storeA = constructStore(conn, TUG_A);
    const storeB = constructStore(conn, TUG_B);

    storeA.send("from A", []);
    expect(storeA.getSnapshot().phase).toBe("submitting");
    expect(storeB.getSnapshot().phase).toBe("idle");

    // Two outbound frames so far: one from each... wait, only A sent.
    // TestFrameChannel records every outbound frame; we assert both
    // the count and the session attribution.
    let userFrames = conn.recordedFramesExcludingStateChange;
    expect(userFrames.length).toBe(1);
    expect(userFrames[0].decoded).toMatchObject({
      tug_session_id: TUG_A,
      type: "user_message",
      content: [{ type: "text", text: "from A" }],
    });

    storeB.send("from B", []);
    expect(storeA.getSnapshot().phase).toBe("submitting");
    expect(storeB.getSnapshot().phase).toBe("submitting");
    userFrames = conn.recordedFramesExcludingStateChange;
    expect(userFrames.length).toBe(2);
    expect(userFrames[1].decoded).toMatchObject({
      tug_session_id: TUG_B,
      type: "user_message",
      content: [{ type: "text", text: "from B" }],
    });

    // Drive A through a short turn. B sees none of it.
    for (const rev of [0, 1]) {
      conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
        type: "assistant_text",
        status: "partial",
        tug_session_id: TUG_A,
        msg_id: FIXTURE_IDS.MSG_ID,
        text: "a",
        is_partial: true,
        rev,
        seq: 0,
      });
    }
    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "turn_complete",
      seq: 0,
      tug_session_id: TUG_A,
      msg_id: FIXTURE_IDS.MSG_ID,
      result: "success",
    });

    expect(storeA.getSnapshot().phase).toBe("idle");
    expect(storeA.getSnapshot().transcript.length).toBe(1);

    // B is still mid-turn in submitting — no frames ever touched its
    // session, so its state machine is exactly where we left it.
    expect(storeB.getSnapshot().phase).toBe("submitting");
    expect(storeB.getSnapshot().transcript.length).toBe(0);
  });

  it("filters out frames with a mismatched tug_session_id before the reducer", () => {
    const conn = new TestFrameChannel();
    const storeA = constructStore(conn, TUG_A);

    storeA.send("hi", []);

    // A stray frame tagged with some third session should reach no
    // store at all. storeA stays in submitting.
    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "assistant_text",
      status: "partial",
      tug_session_id: "tug00000-0000-4000-8000-0000000000cc",
      msg_id: FIXTURE_IDS.MSG_ID,
      text: "stray",
      is_partial: true,
      rev: 0,
      seq: 0,
    });

    expect(storeA.getSnapshot().phase).toBe("submitting");
    // No text-delta event landed for storeA's turn, so the per-turn
    // path was never written to; `inflightValue` returns undefined.
    expect(inflightValue(storeA, "assistant_text")).toBeUndefined();
  });

  it("routes SESSION_STATE errored only to the matching store", () => {
    const conn = new TestFrameChannel();
    const storeA = constructStore(conn, TUG_A);
    const storeB = constructStore(conn, TUG_B);

    storeA.send("hi", []);
    storeB.send("hi", []);
    expect(storeA.getSnapshot().phase).toBe("submitting");
    expect(storeB.getSnapshot().phase).toBe("submitting");

    conn.dispatchDecoded(FeedId.SESSION_STATE, {
      tug_session_id: TUG_A,
      state: "errored",
      detail: "crash",
    });

    expect(storeA.getSnapshot().phase).toBe("errored");
    expect(storeA.getSnapshot().lastError?.cause).toBe(
      "session_state_errored",
    );
    // B was in submitting on the same connection — unaffected.
    expect(storeB.getSnapshot().phase).toBe("submitting");
    expect(storeB.getSnapshot().lastError).toBeNull();
  });
});
