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

/** claude's report on a message the card sent, as tugcode forwards it. */
function dispatchLifecycle(conn: TestFrameChannel, submissionId: string, state: string): void {
  conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
    type: "command_lifecycle",
    tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
    submissionId,
    state,
  });
}

/** The submission ids the deck asked claude to withdraw, in order. */
function withdrawalFrames(conn: TestFrameChannel): string[] {
  return conn.recordedFramesExcludingStateChange
    .map((f) => f.decoded as { type?: string; submission_id?: string })
    .filter((d) => d.type === "cancel_async_message")
    .map((d) => d.submission_id as string);
}

/** tugcode's announcement of the turn claude opened for a waiting message. */
function dispatchFollowOn(conn: TestFrameChannel, submissionId: string, text: string): void {
  dispatchLifecycle(conn, submissionId, "started");
  conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
    type: "follow_on_started",
    tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
    submissionId,
    content: [{ type: "text", text }],
  });
}

describe("CodeSessionStore — a mid-turn send goes at Return and is never sent twice", () => {
  it("sends each mid-turn submit at once, in submit order, and turn_complete sends none again", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("first", []);
    driveToStreaming(conn, store, FIXTURE_IDS.MSG_ID_N(1));

    store.send("a", []);
    store.send("b", []);
    store.send("c", []);
    expect(store.getSnapshot().queuedSends.map((q) => q.sent)).toEqual([true, true, true]);
    expect(userMessageFrames(conn).map((f) => f.text)).toEqual(["first", "a", "b", "c"]);

    // The turn ends with all three still at claude: nothing is flushed, the
    // card goes idle, and the rows keep waiting.
    dispatchTurnCompleteSuccess(conn, FIXTURE_IDS.MSG_ID_N(1));
    let snap = store.getSnapshot();
    expect(snap.phase).toBe("idle");
    expect(snap.queuedSends.map((q) => q.text)).toEqual(["a", "b", "c"]);
    expect(userMessageFrames(conn).map((f) => f.text)).toEqual(["first", "a", "b", "c"]);

    // claude runs the first as a turn of its own and merges the other two.
    const [a, b, c] = snap.queuedSends.map((q) => q.turnKey);
    dispatchFollowOn(conn, a, "a");
    driveToStreaming(conn, store, FIXTURE_IDS.MSG_ID_N(2));
    dispatchLifecycle(conn, b, "started");
    dispatchLifecycle(conn, c, "started");
    dispatchTurnCompleteSuccess(conn, FIXTURE_IDS.MSG_ID_N(2));

    snap = store.getSnapshot();
    expect(snap.phase).toBe("idle");
    expect(snap.queuedSends.length).toBe(0);
    expect(userMessageFrames(conn).map((f) => f.text)).toEqual(["first", "a", "b", "c"]);
    const users = snap.transcript[0].messages.filter((m) => m.kind === "user_message");
    expect(users.map((m) => (m as { text: string }).text)).toEqual(["first", "a", "b", "c"]);
  });

  it("keeps the messages claude still holds when the turn errors, and sends nothing", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("first", []);
    driveToStreaming(conn, store, FIXTURE_IDS.MSG_ID);

    store.send("a", []);
    store.send("b", []);

    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "turn_complete",
      seq: 0,
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      msg_id: FIXTURE_IDS.MSG_ID,
      result: "error",
    });

    const snap = store.getSnapshot();
    expect(snap.phase).toBe("idle");
    expect(snap.queuedSends.map((q) => q.text)).toEqual(["a", "b"]);
    expect(snap.transcript[0].result).toBe("interrupted");
    expect(userMessageFrames(conn).map((f) => f.text)).toEqual(["first", "a", "b"]);
  });

  it("surfaces the waiting payloads on the snapshot, in submit order", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("first", []);
    driveToStreaming(conn, store, FIXTURE_IDS.MSG_ID_N(1));

    // The snapshot exposes the full payloads — text, atoms, turnKey — not
    // just a count, so the transcript can paint a row per waiting send.
    store.send("alpha", []);
    store.send("bravo", []);
    store.send("charlie", []);

    const queued = store.getSnapshot().queuedSends;
    expect(queued.map((q) => q.text)).toEqual(["alpha", "bravo", "charlie"]);
    expect(new Set(queued.map((q) => q.turnKey)).size).toBe(3);
    expect(
      queued.every((q) => typeof q.turnKey === "string" && q.turnKey.length > 0),
    ).toBe(true);

    // The one claude takes in leaves the array; the tail keeps its order.
    dispatchLifecycle(conn, queued[0].turnKey, "started");
    expect(store.getSnapshot().queuedSends.map((q) => q.text)).toEqual([
      "bravo",
      "charlie",
    ]);
  });
});

describe("CodeSessionStore — a send during a wake", () => {
  it("goes at once, and is seated in the wake turn when claude takes it in", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("first", []);
    driveToStreaming(conn, store, FIXTURE_IDS.MSG_ID_N(1));
    dispatchTurnCompleteSuccess(conn, FIXTURE_IDS.MSG_ID_N(1));
    expect(store.getSnapshot().phase).toBe("idle");

    dispatchWakeStarted(conn, "bg-task-1");
    expect(store.getSnapshot().phase).toBe("waking");

    store.send("during-wake", []);
    expect(userMessageFrames(conn).map((f) => f.text)).toEqual(["first", "during-wake"]);
    const key = store.getSnapshot().queuedSends[0].turnKey;

    dispatchLifecycle(conn, key, "started");
    dispatchTurnCompleteSuccess(conn, FIXTURE_IDS.MSG_ID_N(2));

    const snap = store.getSnapshot();
    expect(snap.phase).toBe("idle");
    expect(snap.queuedSends.length).toBe(0);
    expect(userMessageFrames(conn).map((f) => f.text)).toEqual(["first", "during-wake"]);
    const wake = snap.transcript[snap.transcript.length - 1];
    expect(wake.messages.some((m) => m.kind === "user_message" && m.submissionId === key)).toBe(true);
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

    // Cancel the middle send, targeted by its turnKey. It is waiting at
    // claude, so the deck asks claude for it back and claude answers.
    store.cancelQueuedSend(queued[1].turnKey);
    expect(withdrawalFrames(conn)).toEqual([queued[1].turnKey]);
    expect(store.getSnapshot().queuedSends.map((q) => q.text)).toEqual(["alpha", "bravo", "charlie"]);
    dispatchLifecycle(conn, queued[1].turnKey, "cancelled");

    const snap = store.getSnapshot();
    expect(snap.queuedSends.map((q) => q.text)).toEqual(["alpha", "charlie"]);
    // The un-sent prompt is offered back through the draft-restore slot.
    expect(snap.pendingDraftRestore?.text).toBe("bravo");
    // Removing the row sends no second copy of anything.
    expect(userMessageFrames(conn).map((f) => f.text)).toEqual(["first", "alpha", "bravo", "charlie"]);
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

    const [alpha, bravo] = store.getSnapshot().queuedSends.map((q) => q.turnKey);
    const framesBeforePop = conn.recordedFramesExcludingStateChange.length;

    // First pop — the newest queued send ("bravo") is asked back of
    // claude, which holds it; claude's answer takes it out.
    store.popInteractive();
    expect(withdrawalFrames(conn)).toEqual([bravo]);
    dispatchLifecycle(conn, bravo, "cancelled");
    expect(store.getSnapshot().queuedSends.map((q) => q.text)).toEqual([
      "alpha",
    ]);

    // Second pop — "alpha" the same way; the queue is now empty.
    store.popInteractive();
    expect(withdrawalFrames(conn)).toEqual([bravo, alpha]);
    dispatchLifecycle(conn, alpha, "cancelled");
    expect(store.getSnapshot().queuedSends.length).toBe(0);
    expect(conn.recordedFramesExcludingStateChange.length).toBe(
      framesBeforePop + 2,
    );

    // Third pop — the queue is empty, so the gesture reaches the
    // running turn: one `interrupt` frame on the wire.
    store.popInteractive();
    expect(conn.recordedFramesExcludingStateChange.length).toBe(
      framesBeforePop + 3,
    );
    expect(
      conn.recordedFramesExcludingStateChange[framesBeforePop + 2].decoded,
    ).toEqual({
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      type: "interrupt",
    });
    // Nothing the user took back was sent a second time.
    expect(userMessageFrames(conn).map((f) => f.text)).toEqual(["first", "alpha", "bravo"]);
  });
});

describe("CodeSessionStore — a queued send is stamped when the user submits it", () => {
  it("the flushed turn's user message keeps its queue-time stamp, not the flush time", async () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("first", []);
    driveToStreaming(conn, store, FIXTURE_IDS.MSG_ID_N(1));

    store.send("queued", []);
    const { queuedAt, turnKey } = store.getSnapshot().queuedSends[0];

    // Sit in the queue a while — a real turn runs for seconds or minutes,
    // and anything the user does meanwhile (a `$` exchange, [D111]) is
    // timestamped in that gap.
    await Bun.sleep(5);
    dispatchTurnCompleteSuccess(conn, FIXTURE_IDS.MSG_ID_N(1));
    dispatchFollowOn(conn, turnKey, "queued");

    const flushed = store.getSnapshot().activeTurn;
    const opener = flushed!.messages[flushed!.messages.length - 1] as { kind: string; submitAt: number; createdAt: number };
    expect(opener.kind).toBe("user_message");
    expect(opener.submitAt).toBe(queuedAt);
    expect(opener.createdAt).toBe(queuedAt);
    // Telemetry still measures from dispatch — the turn started now.
    expect(flushed!.submitAt).toBeGreaterThan(queuedAt);
  });

});
