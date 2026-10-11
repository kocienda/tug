/**
 * Step 7 — queue flush on `turn_complete(success)`.
 *
 * The single-tick collapse () guarantees that a queued send
 * flushes in the same dispatch that commits the preceding turn, so
 * subscribers observe a final phase of `submitting`, not a transient
 * `idle`, and are notified exactly once per collapse.
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

function constructStore(conn: TestFrameChannel): CodeSessionStore {
  return new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: FIXTURE_IDS.TUG_SESSION_ID,
    sessionMode: "new",
  });
}

/**
 * Drive the store from `submitting` (just after a `send`) through two
 * assistant_text partials to `streaming`. Uses `msgId` so each turn's
 * scratch buffer is isolated.
 */
function driveToStreaming(
  conn: TestFrameChannel,
  store: CodeSessionStore,
  msgId: string,
): void {
  conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
    type: "assistant_text",
    status: "partial",
    tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
    msg_id: msgId,
    text: "a",
    is_partial: true,
    rev: 0,
    seq: 0,
  });
  conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
    type: "assistant_text",
    status: "partial",
    tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
    msg_id: msgId,
    text: "b",
    is_partial: true,
    rev: 1,
    seq: 0,
  });
  expect(store.getSnapshot().phase).toBe("streaming");
}

function dispatchTurnCompleteSuccess(
  conn: TestFrameChannel,
  msgId: string,
): void {
  conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
    type: "turn_complete",
    seq: 0,
    tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
    msg_id: msgId,
    result: "success",
  });
}

/**
 * Open a wake bracket — the spontaneous resume claude fires when an
 * async deferred completion (a background task, a scheduled wake)
 * lands while the card is idle. Drives `idle → waking`.
 */
function dispatchWakeStarted(conn: TestFrameChannel, taskId: string): void {
  conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
    type: "wake_started",
    tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
    wake_trigger: {
      task_id: taskId,
      tool_use_id: "",
      status: "completed",
      summary: "background task done",
      output_file: "",
    },
  });
}

function userMessageFrames(
  conn: TestFrameChannel,
): Array<{ text: string }> {
  // Post-Step-5c the wire shape is content blocks. Concatenate the
  // `text` block contents back into a single string so existing
  // tests' `.text === "foo"` assertions keep working — they pin
  // submission identity, not block structure.
  return conn.recordedFrames
    .filter(
      (f) =>
        f.feedId === FeedId.CODE_INPUT &&
        (f.decoded as { type?: string }).type === "user_message",
    )
    .map((f) => {
      const content = (f.decoded as { content?: Array<{ type: string; text?: string }> }).content ?? [];
      const text = content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      return { text };
    });
}

describe("CodeSessionStore — queue flush via turn_complete(success) collapse (Step 7)", () => {
  it("flushes exactly one queued send per successful turn and stays in submitting", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("first", []);
    driveToStreaming(conn, store, FIXTURE_IDS.MSG_ID_N(1));

    // Queue three mid-stream sends.
    store.send("a", []);
    store.send("b", []);
    store.send("c", []);
    expect(store.getSnapshot().queuedSends.length).toBe(3);
    expect(userMessageFrames(conn).map((f) => f.text)).toEqual(["first"]);

    // Subscribe *after* the send + driveToStreaming so we count only
    // the collapse notification on the next turn_complete.
    let notifyCount = 0;
    store.subscribe(() => {
      notifyCount += 1;
    });

    // First successful turn completes. Observers see final phase
    // `submitting` and are notified exactly once during the collapse.
    dispatchTurnCompleteSuccess(conn, FIXTURE_IDS.MSG_ID_N(1));

    let snap = store.getSnapshot();
    expect(snap.phase).toBe("submitting");
    expect(snap.queuedSends.length).toBe(2);
    expect(snap.transcript.length).toBe(1);
    expect(userMessageFrames(conn).map((f) => f.text)).toEqual([
      "first",
      "a",
    ]);
    expect(notifyCount).toBe(1);

    // Drive the next turn: two partials → streaming → turn_complete.
    driveToStreaming(conn, store, FIXTURE_IDS.MSG_ID_N(2));
    dispatchTurnCompleteSuccess(conn, FIXTURE_IDS.MSG_ID_N(2));

    snap = store.getSnapshot();
    expect(snap.phase).toBe("submitting");
    expect(snap.queuedSends.length).toBe(1);
    expect(snap.transcript.length).toBe(2);
    expect(userMessageFrames(conn).map((f) => f.text)).toEqual([
      "first",
      "a",
      "b",
    ]);

    // Third turn drains the last queued entry.
    driveToStreaming(conn, store, FIXTURE_IDS.MSG_ID_N(3));
    dispatchTurnCompleteSuccess(conn, FIXTURE_IDS.MSG_ID_N(3));

    snap = store.getSnapshot();
    expect(snap.phase).toBe("submitting");
    expect(snap.queuedSends.length).toBe(0);
    expect(snap.transcript.length).toBe(3);
    expect(userMessageFrames(conn).map((f) => f.text)).toEqual([
      "first",
      "a",
      "b",
      "c",
    ]);

    // Final turn with empty queue lands on idle, not submitting.
    driveToStreaming(conn, store, FIXTURE_IDS.MSG_ID_N(4));
    dispatchTurnCompleteSuccess(conn, FIXTURE_IDS.MSG_ID_N(4));

    snap = store.getSnapshot();
    expect(snap.phase).toBe("idle");
    expect(snap.queuedSends.length).toBe(0);
    expect(snap.transcript.length).toBe(4);
  });

  it("clears a non-empty queue on turn_complete(error) without flushing", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("first", []);
    driveToStreaming(conn, store, FIXTURE_IDS.MSG_ID);

    store.send("a", []);
    store.send("b", []);
    expect(store.getSnapshot().queuedSends.length).toBe(2);

    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "turn_complete",
      seq: 0,
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      msg_id: FIXTURE_IDS.MSG_ID,
      result: "error",
    });

    const snap = store.getSnapshot();
    expect(snap.phase).toBe("idle");
    expect(snap.queuedSends.length).toBe(0);
    expect(snap.transcript[0].result).toBe("interrupted");
    // No flushed user_message frame was written — only "first".
    expect(userMessageFrames(conn).map((f) => f.text)).toEqual(["first"]);
  });

  it("surfaces the queued-send payloads on the snapshot, in submit order", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("first", []);
    driveToStreaming(conn, store, FIXTURE_IDS.MSG_ID_N(1));

    // Queue three mid-stream sends. The snapshot exposes the full
    // payloads — text, atoms, turnKey — not just a count, so the
    // transcript can paint a ghost row per send.
    store.send("alpha", []);
    store.send("bravo", []);
    store.send("charlie", []);

    const queued = store.getSnapshot().queuedSends;
    expect(queued.map((q) => q.text)).toEqual(["alpha", "bravo", "charlie"]);
    // Each entry carries the turnKey minted at its queueing `send`;
    // the three are distinct.
    expect(new Set(queued.map((q) => q.turnKey)).size).toBe(3);
    expect(
      queued.every((q) => typeof q.turnKey === "string" && q.turnKey.length > 0),
    ).toBe(true);

    // The flushed head leaves the array; the tail keeps its order.
    dispatchTurnCompleteSuccess(conn, FIXTURE_IDS.MSG_ID_N(1));
    expect(store.getSnapshot().queuedSends.map((q) => q.text)).toEqual([
      "bravo",
      "charlie",
    ]);
  });
});

describe("CodeSessionStore — queue flush when a wake settles", () => {
  it("flushes a send queued during a wake instead of stranding it at idle", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    // A normal turn runs and settles to idle with an empty queue.
    store.send("first", []);
    driveToStreaming(conn, store, FIXTURE_IDS.MSG_ID_N(1));
    dispatchTurnCompleteSuccess(conn, FIXTURE_IDS.MSG_ID_N(1));
    expect(store.getSnapshot().phase).toBe("idle");

    // A background completion fires a wake — the card goes busy again
    // with no user submission of its own.
    dispatchWakeStarted(conn, "bg-task-1");
    expect(store.getSnapshot().phase).toBe("waking");

    // The user submits a follow-up while the wake is in flight; it
    // queues (a wake is a non-idle phase, so `send` parks it).
    store.send("during-wake", []);
    expect(store.getSnapshot().phase).toBe("waking");
    expect(store.getSnapshot().queuedSends.map((q) => q.text)).toEqual([
      "during-wake",
    ]);
    // Nothing has gone to the wire yet — only the opening "first".
    expect(userMessageFrames(conn).map((f) => f.text)).toEqual(["first"]);

    // The wake completes. The queued send drains in the same dispatch:
    // phase collapses to `submitting` (not a transient idle), the ghost
    // clears, and the message finally goes out on the wire.
    dispatchTurnCompleteSuccess(conn, FIXTURE_IDS.MSG_ID_N(2));

    const snap = store.getSnapshot();
    expect(snap.phase).toBe("submitting");
    expect(snap.queuedSends.length).toBe(0);
    expect(userMessageFrames(conn).map((f) => f.text)).toEqual([
      "first",
      "during-wake",
    ]);
  });
});

describe("CodeSessionStore — cancelling and peeling queued sends", () => {
  it("cancelQueuedSend removes the targeted send and offers it back via pendingDraftRestore", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("first", []);
    driveToStreaming(conn, store, FIXTURE_IDS.MSG_ID_N(1));

    store.send("alpha", []);
    store.send("bravo", []);
    store.send("charlie", []);
    const queued = store.getSnapshot().queuedSends;
    expect(queued.map((q) => q.text)).toEqual(["alpha", "bravo", "charlie"]);

    // Cancel the middle send, targeted by its turnKey.
    store.cancelQueuedSend(queued[1].turnKey);

    const snap = store.getSnapshot();
    expect(snap.queuedSends.map((q) => q.text)).toEqual(["alpha", "charlie"]);
    // The un-sent prompt is offered back through the draft-restore slot.
    expect(snap.pendingDraftRestore?.text).toBe("bravo");
    // A true un-send — no wire traffic; only "first" ever went out.
    expect(userMessageFrames(conn).map((f) => f.text)).toEqual(["first"]);
  });

  it("cancelQueuedSend is a no-op for an unknown turnKey", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("first", []);
    driveToStreaming(conn, store, FIXTURE_IDS.MSG_ID_N(1));
    store.send("alpha", []);

    store.cancelQueuedSend("no-such-turnkey");

    expect(store.getSnapshot().queuedSends.map((q) => q.text)).toEqual([
      "alpha",
    ]);
    expect(store.getSnapshot().pendingDraftRestore).toBeNull();
  });

  it("popInteractive drains the queue newest-first (LIFO), then interrupts the turn", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("first", []);
    driveToStreaming(conn, store, FIXTURE_IDS.MSG_ID_N(1));
    store.send("alpha", []);
    store.send("bravo", []);
    expect(store.getSnapshot().queuedSends.map((q) => q.text)).toEqual([
      "alpha",
      "bravo",
    ]);

    const framesBeforePop = conn.recordedFramesExcludingStateChange.length;

    // First pop — the newest queued send ("bravo") goes; a true
    // un-send, so no wire frame.
    store.popInteractive();
    expect(store.getSnapshot().queuedSends.map((q) => q.text)).toEqual([
      "alpha",
    ]);
    expect(conn.recordedFramesExcludingStateChange.length).toBe(
      framesBeforePop,
    );

    // Second pop — "alpha" goes; the queue is now empty; still no
    // wire frame.
    store.popInteractive();
    expect(store.getSnapshot().queuedSends.length).toBe(0);
    expect(conn.recordedFramesExcludingStateChange.length).toBe(
      framesBeforePop,
    );

    // Third pop — the queue is empty, so the gesture reaches the
    // running turn: one `interrupt` frame on the wire.
    store.popInteractive();
    expect(conn.recordedFramesExcludingStateChange.length).toBe(
      framesBeforePop + 1,
    );
    expect(
      conn.recordedFramesExcludingStateChange[framesBeforePop].decoded,
    ).toEqual({
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      type: "interrupt",
    });
  });
});

describe("CodeSessionStore — a queued send is stamped when the user submits it", () => {
  it("the flushed turn's user message keeps its queue-time stamp, not the flush time", async () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("first", []);
    driveToStreaming(conn, store, FIXTURE_IDS.MSG_ID_N(1));

    store.send("queued", []);
    const queuedAt = store.getSnapshot().queuedSends[0].queuedAt;

    // Sit in the queue a while — a real turn runs for seconds or minutes,
    // and anything the user does meanwhile (a `$` exchange, [D111]) is
    // timestamped in that gap.
    await Bun.sleep(5);
    dispatchTurnCompleteSuccess(conn, FIXTURE_IDS.MSG_ID_N(1));

    const flushed = store.getSnapshot().activeTurn;
    expect(flushed?.messages[0].kind).toBe("user_message");
    const opener = flushed!.messages[0] as { submitAt: number; createdAt: number };
    expect(opener.submitAt).toBe(queuedAt);
    expect(opener.createdAt).toBe(queuedAt);
    // Telemetry still measures from dispatch — the turn started now.
    expect(flushed!.submitAt).toBeGreaterThan(queuedAt);
  });

});
