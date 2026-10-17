/**
 * An `offWire` store — a session the app-test harness bound by hand, which
 * tugcast never spawned — keeps every write off the wire, and its turn still
 * runs on the frames it is fed. On the wire, the supervisor answers such a
 * session's `user_message` with `session_unknown` and the card errors out of
 * the turn the test is driving (`lib/harness-sessions.ts`).
 */

import { describe, expect, it } from "bun:test";

import { CodeSessionStore } from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { FeedId } from "@/protocol";

function constructStore(conn: TestFrameChannel, offWire: boolean): CodeSessionStore {
  return new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: FIXTURE_IDS.TUG_SESSION_ID,
    sessionMode: "new",
    offWire,
  });
}

const codeInputs = (conn: TestFrameChannel) => conn.recordedFramesExcludingStateChange.filter((f) => f.feedId === FeedId.CODE_INPUT);

describe("an offWire session", () => {
  it("sends nothing, and its turn still runs on the frames it is fed", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn, true);
    store.send("hello", []);
    store.addDirectory("/tmp/elsewhere");
    store.stopJob("t1");
    expect(codeInputs(conn)).toEqual([]);

    for (const [rev, text] of ["Hel", "Hello"].entries()) {
      conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
        type: "assistant_text",
        status: "partial",
        tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
        msg_id: "m1",
        text,
        is_partial: true,
        rev,
        seq: 0,
      });
    }
    expect(store.getSnapshot().phase).toBe("streaming");
    store.dispose();
  });

  it("is the exception: a store without it puts the user_message on the wire", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn, false);
    store.send("hello", []);
    expect(codeInputs(conn).length).toBeGreaterThan(0);
    store.dispose();
  });
});
