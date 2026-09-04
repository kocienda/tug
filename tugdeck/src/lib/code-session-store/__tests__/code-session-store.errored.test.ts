/**
 * Step 8 — errored phase triggers + recovery.
 *
 * describes two triggers for the `errored` phase:
 *  - `SESSION_STATE { state: "errored", detail }` delivered through the
 *    filtered FeedStore subscription from Step 3.
 *  - `TugConnection.onClose` firing during an active turn.
 *
 * Both populate `lastError` with a distinct cause tag. The next
 * `send()` from `errored` re-enters `submitting` without clearing
 * `lastError`; a subsequent `turn_complete(success)` is what finally
 * clears it (the manual-recovery semantics from [D08]).
 *
 * CONTROL-error triggers (`session_not_owned`, `session_unknown`) are
 * explicitly out of scope for T3.4.a and have no coverage here.
 */

import { describe, it, expect } from "bun:test";

import { CodeSessionStore } from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import {
  TestFrameChannel,
} from "@/lib/code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { FeedId } from "@/protocol";

function constructStore(
  conn: TestFrameChannel,
  lifecycle: ConnectionLifecycle = new ConnectionLifecycle(),
): CodeSessionStore {
  return new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle,
    tugSessionId: FIXTURE_IDS.TUG_SESSION_ID,
    sessionMode: "new",
  });
}

function driveToStreaming(
  conn: TestFrameChannel,
  store: CodeSessionStore,
  msgId: string,
): void {
  conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
    type: "assistant_text",
    tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
    msg_id: msgId,
    text: "a",
    is_partial: true,
    rev: 0,
    seq: 0,
  });
  conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
    type: "assistant_text",
    tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
    msg_id: msgId,
    text: "b",
    is_partial: true,
    rev: 1,
    seq: 0,
  });
  expect(store.getSnapshot().phase).toBe("streaming");
}

describe("CodeSessionStore — SESSION_STATE errored trigger (Step 8)", () => {
  it("routes a session_state errored frame into the errored phase", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("hello", []);
    driveToStreaming(conn, store, FIXTURE_IDS.MSG_ID);

    const transcriptBefore = store.getSnapshot().transcript;

    // SESSION_STATE payload shape per `build_session_state_frame` in
    // tugcast: `{ tug_session_id, state, detail }` (no top-level type).
    conn.dispatchDecoded(FeedId.SESSION_STATE, {
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      state: "errored",
      detail: "crash_budget_exhausted",
    });

    const snap = store.getSnapshot();
    expect(snap.phase).toBe("errored");
    expect(snap.lastError).not.toBeNull();
    expect(snap.lastError?.cause).toBe("session_state_errored");
    expect(snap.lastError?.message).toContain("crash_budget_exhausted");
    // Errored is NOT a commit — the transcript ref is unchanged.
    expect(snap.transcript).toBe(transcriptBefore);
    expect(snap.transcript.length).toBe(0);
  });

  it("drops non-errored session_state frames silently", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("hi", []);
    driveToStreaming(conn, store, FIXTURE_IDS.MSG_ID);

    conn.dispatchDecoded(FeedId.SESSION_STATE, {
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      state: "pending",
    });
    conn.dispatchDecoded(FeedId.SESSION_STATE, {
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      state: "spawning",
    });

    const snap = store.getSnapshot();
    expect(snap.phase).toBe("streaming");
    expect(snap.lastError).toBeNull();
  });
});

describe("CodeSessionStore — transport close trigger", () => {
  it("routes connectionDidClose into the errored phase during an active turn", () => {
    const conn = new TestFrameChannel();
    const lifecycle = new ConnectionLifecycle();
    const store = constructStore(conn, lifecycle);

    store.send("hello", []);
    expect(store.getSnapshot().phase).toBe("submitting");

    lifecycle.notifyConnectionDidClose();

    const snap = store.getSnapshot();
    expect(snap.phase).toBe("errored");
    expect(snap.transportState).toBe("offline");
    expect(snap.canSubmit).toBe(false);
    // No `lastError`: the offline transportState and its "Reconnecting…"
    // bulletin own this condition. Stamping an error here would raise
    // the card-locking banner for a transient that heals itself — and
    // nothing on the recovery path would clear it.
    expect(snap.lastError).toBeNull();
  });

  it("idle connectionDidClose flips transportState to offline (phase preserved, no lastError)", () => {
    // [D06] reverses the old "drop silently when idle" behavior:
    // transport health is now an axis orthogonal to phase, so an idle
    // card whose wire goes down still needs to gate submit. The phase
    // stays `idle` (nothing to error on); `lastError` is left null
    // because no in-flight turn was disrupted.
    const conn = new TestFrameChannel();
    const lifecycle = new ConnectionLifecycle();
    const store = constructStore(conn, lifecycle);

    expect(store.getSnapshot().phase).toBe("idle");
    expect(store.getSnapshot().transportState).toBe("online");

    lifecycle.notifyConnectionDidClose();

    const snap = store.getSnapshot();
    expect(snap.phase).toBe("idle");
    expect(snap.transportState).toBe("offline");
    expect(snap.canSubmit).toBe(false);
    expect(snap.lastError).toBeNull();
  });
});

describe("CodeSessionStore — wire error event (Step 9a audit)", () => {
  it("routes a CODE_OUTPUT error frame into the errored phase with cause=wire_error", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("hi", []);
    driveToStreaming(conn, store, FIXTURE_IDS.MSG_ID);

    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "error",
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      message: "quota exceeded",
      recoverable: false,
    });

    const snap = store.getSnapshot();
    expect(snap.phase).toBe("errored");
    expect(snap.lastError?.cause).toBe("wire_error");
    expect(snap.lastError?.message).toBe("quota exceeded");
  });
});

describe("CodeSessionStore — a rotation clears the banner it superseded", () => {
  /** Raise a wire-error banner on a card mid-turn. */
  function raiseWireError(
    conn: TestFrameChannel,
    store: CodeSessionStore,
    site?: string,
  ): void {
    store.send("hi", []);
    driveToStreaming(conn, store, FIXTURE_IDS.MSG_ID);
    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "error",
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      message: "Claude process stream ended unexpectedly",
      recoverable: true,
      ...(site !== undefined ? { site } : {}),
    });
    expect(store.getSnapshot().lastError?.cause).toBe("wire_error");
  }

  /** The rotation announcement tugcode writes just before its `session_init`. */
  function rotate(conn: TestFrameChannel): void {
    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "session_segment",
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      kind: "rotation",
      stage: "audit",
      model: "opus",
      document: ".tug/arcs/some-arc/tasks.md",
      arc: "some-arc",
    });
  }

  it("clears a wire_error banner on the rotation segment", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);
    raiseWireError(conn, store);

    rotate(conn);

    // The rotation announced a fresh claude, which disproves a wire error on
    // the one it retired. The banner has no other path off a superseded line:
    // that line's `turn_complete(success)` will never arrive.
    expect(store.getSnapshot().lastError).toBeNull();
  });

  it("leaves a session_state_errored banner standing", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);
    store.send("hi", []);
    driveToStreaming(conn, store, FIXTURE_IDS.MSG_ID);
    conn.dispatchDecoded(FeedId.SESSION_STATE, {
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      state: "errored",
      detail: "crash_budget_exhausted",
    });
    expect(store.getSnapshot().lastError?.cause).toBe("session_state_errored");

    rotate(conn);

    // Process supervision is not what a rotation replaces, so this survives a
    // rotation exactly as it survives a reconnect.
    const snap = store.getSnapshot();
    expect(snap.lastError?.cause).toBe("session_state_errored");
    expect(snap.lastError?.message).toBe("crash_budget_exhausted");
  });

  it("keeps the bridge's emit site on the banner", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);
    raiseWireError(conn, store, "drain_eof_open_turn");

    // "Protocol error" names the frame family and nothing else; the slug is
    // what the detail panel shows so the reader need not read tugcode.
    expect(store.getSnapshot().lastError?.site).toBe("drain_eof_open_turn");
  });

  it("carries no site when the bridge sent none", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);
    raiseWireError(conn, store);

    expect(store.getSnapshot().lastError?.site).toBeUndefined();
  });

  it("leaves the banner standing on a replayed stage divider", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);
    raiseWireError(conn, store);

    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "replay_started",
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
    });
    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "replay_stage",
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      stage: "audit",
      model: "opus",
      document: ".tug/arcs/some-arc/tasks.md",
      arc: "some-arc",
    });

    // A replayed divider redraws a rotation that already happened; it
    // supersedes nothing, so it disproves nothing. Only the live rotation
    // segment clears the banner.
    expect(store.getSnapshot().lastError?.cause).toBe("wire_error");
  });
});

describe("CodeSessionStore — retry recovery from errored (Step 8)", () => {
  it("re-submits from errored, keeps lastError until turn_complete(success)", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("initial", []);
    driveToStreaming(conn, store, FIXTURE_IDS.MSG_ID_N(1));

    // Force errored via SESSION_STATE.
    conn.dispatchDecoded(FeedId.SESSION_STATE, {
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      state: "errored",
      detail: "boom",
    });
    expect(store.getSnapshot().phase).toBe("errored");
    const errAtFirst = store.getSnapshot().lastError;
    expect(errAtFirst).not.toBeNull();

    // Retry. Phase flips to submitting, but lastError stays set.
    store.send("retry", []);
    let snap = store.getSnapshot();
    expect(snap.phase).toBe("submitting");
    expect(snap.lastError).toBe(errAtFirst);

    // The retry also wrote a fresh user_message frame.
    const retryFrame = conn.recordedFrames.find((f, idx) => {
      if (idx === 0) return false; // skip the first submit
      const dec = f.decoded as { type?: string; content?: Array<{ type: string; text?: string }> };
      if (dec.type !== "user_message") return false;
      const content = dec.content ?? [];
      return content.some((b) => b.type === "text" && b.text === "retry");
    });
    expect(retryFrame).toBeDefined();

    // Drive the retry turn to completion.
    driveToStreaming(conn, store, FIXTURE_IDS.MSG_ID_N(2));
    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "turn_complete",
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      msg_id: FIXTURE_IDS.MSG_ID_N(2),
      result: "success",
    });

    snap = store.getSnapshot();
    expect(snap.phase).toBe("idle");
    expect(snap.lastError).toBeNull();
    expect(snap.transcript.length).toBe(1);
    const userMsg = snap.transcript[0].messages.find((m) => m.kind === "user_message");
    expect(userMsg !== undefined && userMsg.kind === "user_message" ? userMsg.text : "").toBe("retry");
  });
});
