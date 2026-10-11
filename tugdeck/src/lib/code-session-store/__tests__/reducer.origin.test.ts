// Origin-first turn model (`tuglaws/turn-metric.md` S01, [P01]): a turn's
// attribution is intrinsic and stated by its opener, never inferred from
// `messages[0]`. These real-frame-driven tests assert that an
// `assistant_opener` commits an `origin: "assistant"` turn with no user
// message (rendered `#a`-only), and an `add_user_message` commits an
// `origin: "user"` turn — over the actual store reducer, not a mock.

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

describe("origin-first turn model — reducer over real frames", () => {
  it("an assistant_opener commits an origin:assistant turn with no user message", () => {
    const { store, conn } = makeStore();
    emit(conn, { type: "replay_started" });
    // Orphan assistant content with no preceding user submission.
    emit(conn, { type: "assistant_opener" });
    emit(conn, {
      type: "assistant_text",
      status: "complete",
      msg_id: FIXTURE_IDS.MSG_ID_N(1),
      text: "continued reply",
      is_partial: false,
      rev: 0,
      seq: 0,
    });
    emit(conn, {
      type: "turn_complete",
      seq: 0,
      msg_id: FIXTURE_IDS.MSG_ID_N(1),
      result: "success",
    });
    emit(conn, { type: "replay_complete", count: 1 });

    const { transcript } = store.getSnapshot();
    expect(transcript).toHaveLength(1);
    expect(transcript[0].origin).toBe("assistant");
    // No fabricated user message — the turn renders #a-only.
    expect(transcript[0].messages.some((m) => m.kind === "user_message")).toBe(
      false,
    );
    expect(transcript[0].messages[0]?.kind).toBe("assistant_text");
  });

  it("an add_user_message commits an origin:user turn carrying the user message", () => {
    const { store, conn } = makeStore();
    emit(conn, { type: "replay_started" });
    emit(conn, {
      type: "add_user_message",
      content: [{ type: "text", text: "a real prompt" }],
    });
    emit(conn, {
      type: "assistant_text",
      status: "complete",
      msg_id: FIXTURE_IDS.MSG_ID_N(2),
      text: "the answer",
      is_partial: false,
      rev: 0,
      seq: 0,
    });
    emit(conn, {
      type: "turn_complete",
      seq: 0,
      msg_id: FIXTURE_IDS.MSG_ID_N(2),
      result: "success",
    });
    emit(conn, { type: "replay_complete", count: 1 });

    const { transcript } = store.getSnapshot();
    expect(transcript).toHaveLength(1);
    expect(transcript[0].origin).toBe("user");
    expect(transcript[0].messages[0]?.kind).toBe("user_message");
  });

  it("mixed: a user turn then an orphan assistant turn carry distinct origins", () => {
    const { store, conn } = makeStore();
    emit(conn, { type: "replay_started" });
    emit(conn, {
      type: "add_user_message",
      content: [{ type: "text", text: "q" }],
    });
    emit(conn, {
      type: "assistant_text",
      status: "complete",
      msg_id: FIXTURE_IDS.MSG_ID_N(1),
      text: "a",
      is_partial: false,
      rev: 0,
      seq: 0,
    });
    emit(conn, {
      type: "turn_complete",
      seq: 0,
      msg_id: FIXTURE_IDS.MSG_ID_N(1),
      result: "success",
    });
    // Orphan assistant turn with no user submission between.
    emit(conn, { type: "assistant_opener" });
    emit(conn, {
      type: "assistant_text",
      status: "complete",
      msg_id: FIXTURE_IDS.MSG_ID_N(2),
      text: "orphan",
      is_partial: false,
      rev: 0,
      seq: 0,
    });
    emit(conn, {
      type: "turn_complete",
      seq: 0,
      msg_id: FIXTURE_IDS.MSG_ID_N(2),
      result: "success",
    });
    emit(conn, { type: "replay_complete", count: 2 });

    const { transcript } = store.getSnapshot();
    expect(transcript.map((t) => t.origin)).toEqual(["user", "assistant"]);
  });
});
