/**
 * The answer to a folder grant or removal reaches the Session card's
 * snapshot.
 *
 * tugcode answers every grant and removal with a `directory_result` — done,
 * or refused with the reason, and which it was on `op` — on CODE_OUTPUT. The
 * store admits it and projects it onto `lastDirectoryResult`, a fresh object
 * per answer. It is never an error: a refused folder leaves the session
 * where it was.
 */

import { describe, expect, it } from "bun:test";

import { CodeSessionStore } from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { FeedId } from "@/protocol";

function constructStore(conn: TestFrameChannel): CodeSessionStore {
  return new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: FIXTURE_IDS.TUG_SESSION_ID,
    sessionMode: "new",
  });
}

/** A grant's `directory_result` as tugcode writes it. */
function result(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "directory_result",
    op: "add",
    tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
    ipc_version: 2,
    ...extra,
  };
}

describe("CodeSessionStore — directory_result", () => {
  it("a granted folder is the latest answer, with no reason", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);
    expect(store.getSnapshot().lastDirectoryResult).toBeNull();

    conn.dispatchDecoded(
      FeedId.CODE_OUTPUT,
      result({ directory: "/u/shared", ok: true, additional_directories: ["/u/shared"] }),
    );

    expect(store.getSnapshot().lastDirectoryResult).toEqual({
      op: "add",
      directory: "/u/shared",
      ok: true,
      reason: null,
    });
  });

  it("a refusal carries its reason and leaves the session out of error", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);
    const phaseBefore = store.getSnapshot().phase;

    conn.dispatchDecoded(
      FeedId.CODE_OUTPUT,
      result({
        directory: "/u/missing",
        ok: false,
        reason: "/u/missing does not exist",
        additional_directories: [],
      }),
    );

    const snap = store.getSnapshot();
    expect(snap.lastDirectoryResult).toEqual({
      op: "add",
      directory: "/u/missing",
      ok: false,
      reason: "/u/missing does not exist",
    });
    expect(snap.phase).toBe(phaseBefore);
    expect(snap.lastError).toBeNull();
  });

  it("two refusals of the same folder are two answers", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);
    const refusal = result({
      directory: "/u/file.txt",
      ok: false,
      reason: "/u/file.txt is not a directory",
      additional_directories: [],
    });

    conn.dispatchDecoded(FeedId.CODE_OUTPUT, refusal);
    const first = store.getSnapshot().lastDirectoryResult;
    conn.dispatchDecoded(FeedId.CODE_OUTPUT, { ...refusal });
    const second = store.getSnapshot().lastDirectoryResult;

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it("a removal's answer says it was a removal", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    conn.dispatchDecoded(
      FeedId.CODE_OUTPUT,
      result({ op: "remove", directory: "/u/shared", ok: true, additional_directories: [] }),
    );

    expect(store.getSnapshot().lastDirectoryResult).toEqual({
      op: "remove",
      directory: "/u/shared",
      ok: true,
      reason: null,
    });
  });

  it("an answer for another session is not this card's", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    conn.dispatchDecoded(
      FeedId.CODE_OUTPUT,
      result({
        tug_session_id: "someone-else",
        directory: "/u/shared",
        ok: true,
        additional_directories: ["/u/shared"],
      }),
    );

    expect(store.getSnapshot().lastDirectoryResult).toBeNull();
  });
});
