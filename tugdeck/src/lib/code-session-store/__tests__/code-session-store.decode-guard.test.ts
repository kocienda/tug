/**
 * The CODE_OUTPUT boundary decodes before it dispatches.
 *
 * Every frame is run through its tag's decoder (`@tugproto/outbound-decoders`)
 * on the way in. A frame whose shape has drifted from the wire type is logged
 * as one decode error, naming the tag, the path, what was expected and what
 * arrived, and is dropped there: the reducer never sees it, so its state does
 * not move. A tag the table does not know is dropped without a word, as an
 * unknown tag always was, and a drifted frame inside a `replay_batch` drops
 * alone.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { CodeSessionStore } from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { tugDevLogStore } from "@/lib/tug-dev-log-store/tug-dev-log-store";
import { FeedId } from "@/protocol";

const TUG = FIXTURE_IDS.TUG_SESSION_ID;

function constructStore(conn: TestFrameChannel): CodeSessionStore {
  return new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: TUG,
    sessionMode: "new",
  });
}

const text = (seq: unknown, text: string) => ({
  type: "assistant_text",
  tug_session_id: TUG,
  msg_id: FIXTURE_IDS.MSG_ID,
  block_index: 0,
  seq,
  rev: 0,
  text,
  is_partial: true,
  status: "partial",
});

interface Warning {
  source: string;
  message: string;
  data: unknown;
}

let warnings: Warning[];
const originalWarn = tugDevLogStore.warn;

beforeEach(() => {
  warnings = [];
  tugDevLogStore.warn = (source, message, data) => {
    warnings.push({ source, message, data });
  };
});

afterEach(() => {
  tugDevLogStore.warn = originalWarn;
});

/** The decode-error lines among the warnings; the reducer logs its own. */
const decodeErrors = () =>
  warnings.filter((w) => w.message.startsWith("CODE_OUTPUT decode error"));

describe("CodeSessionStore — CODE_OUTPUT decode guard", () => {
  it("logs a drifted frame as a decode error and leaves the reducer state unchanged", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);
    store.send("hi", []);
    const before = store.getSnapshot();

    // `seq` drifted from a number to a string.
    conn.dispatchDecoded(FeedId.CODE_OUTPUT, text("0", "h"));

    expect(store.getSnapshot()).toBe(before);
    expect(decodeErrors()).toEqual([
      {
        source: "code-session-store",
        message: 'CODE_OUTPUT decode error: assistant_text at $.seq: expected number, got string "0"',
        data: {
          tag: "assistant_text",
          path: "$.seq",
          expected: "number",
          got: 'string "0"',
        },
      },
    ]);
  });

  it("dispatches the same frame once it matches the wire type", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);
    store.send("hi", []);
    const before = store.getSnapshot();

    conn.dispatchDecoded(FeedId.CODE_OUTPUT, text(0, "h"));

    expect(before.phase).toBe("submitting");
    expect(store.getSnapshot().phase).toBe("awaiting_first_token");
    expect(decodeErrors()).toEqual([]);
  });

  it("drops an unknown tag without a word", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);
    const before = store.getSnapshot();

    conn.dispatchDecoded(FeedId.CODE_OUTPUT, { type: "not_a_tag", tug_session_id: TUG });

    expect(store.getSnapshot()).toBe(before);
    expect(decodeErrors()).toEqual([]);
  });

  it("drops a drifted frame inside a replay_batch alone", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "replay_batch",
      tug_session_id: TUG,
      frames: [
        { type: "replay_started" },
        // `content` drifted from an array of blocks to a bare string.
        { type: "add_user_message", content: "lost" },
        { type: "add_user_message", content: [{ type: "text", text: "kept" }] },
        { type: "turn_complete", msg_id: FIXTURE_IDS.MSG_ID, seq: 0, result: "success" },
        { type: "replay_complete", count: 1 },
      ],
    });

    const { transcript } = store.getSnapshot();
    expect(transcript).toHaveLength(1);
    expect(
      transcript[0].messages.flatMap((m) => (m.kind === "user_message" ? [m.text] : [])),
    ).toEqual(["kept"]);
    expect(decodeErrors().map((w) => w.data)).toEqual([
      {
        tag: "add_user_message",
        path: "$.content",
        expected: "array",
        got: 'string "lost"',
      },
    ]);
  });
});
