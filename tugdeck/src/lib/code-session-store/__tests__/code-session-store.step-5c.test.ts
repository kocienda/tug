/**
 * Step 5c — `handleSend` / `handleAddUserMessage` /
 * `handleTurnComplete` integration tests for the content-block wire
 * shape + JSONL-honest substrate synthesis.
 *
 * These are pure-logic tests over event/state dispatched through the
 * real `CodeSessionStore` wrapper — they pin the contract that:
 *
 *   1. The live-submit path's `handleSend` produces a `UserMessage`
 *      with the synthesized substrate (`image-N` labels), wire frame
 *      with interleaved `ContentBlock[]`, and bytes-store entries
 *      under the editor's original atom ids (no orphans);
 *   2. The replay path's `handleAddUserMessage` produces the same
 *      substrate shape from content-block input (modulo freshly-minted
 *      atom ids, which differ by design);
 *   3. Mid-turn submits land in `queuedSends` carrying both the wire
 *      `content` and the already-synthesized `text` + `atoms`
 *      (synthesis happens once at submit, not deferred to flush);
 *   4. The queue-flush at `turn_complete(success)` mints the next
 *      turn's `UserMessage` directly from the queued entry's
 *      synthesized substrate — no re-synthesis at flush time.
 */

import { describe, it, expect } from "bun:test";

import { CodeSessionStore } from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { FeedId } from "@/protocol";
import type { ContentBlock } from "@/protocol";
import { TUG_ATOM_CHAR, type AtomSegment } from "@/lib/tug-atom-img";
import { PendingContextStore, splitLeadingContext } from "@/lib/pending-context-store";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const C = TUG_ATOM_CHAR;

function constructStore(conn: TestFrameChannel): CodeSessionStore {
  return new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: FIXTURE_IDS.TUG_SESSION_ID,
    sessionMode: "new",
  });
}

function imageAtom(id: string, label: string): AtomSegment {
  return { kind: "atom", type: "image", label, value: label, id };
}

function lastUserMessageFrame(conn: TestFrameChannel): { content: ContentBlock[] } | null {
  const frame = [...conn.recordedFrames].reverse().find(
    (f) =>
      f.feedId === FeedId.CODE_INPUT &&
      (f.decoded as { type?: string }).type === "user_message",
  );
  if (frame === undefined) return null;
  return frame.decoded as { content: ContentBlock[] };
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

// ---------------------------------------------------------------------------
// handleSend — live path resolver wiring
// ---------------------------------------------------------------------------

describe("staged context — prepended to the outgoing user message ([P08])", () => {
  function storeWithContext(conn: TestFrameChannel): {
    store: CodeSessionStore;
    pendingContext: PendingContextStore;
  } {
    const pendingContext = new PendingContextStore();
    const store = new CodeSessionStore({
      conn: conn as unknown as TugConnection,
      lifecycle: new ConnectionLifecycle(),
      tugSessionId: FIXTURE_IDS.TUG_SESSION_ID,
      sessionMode: "new",
      pendingContextStore: pendingContext,
    });
    return { store, pendingContext };
  }

  it("prepends the sentinel prefix ahead of the prose and clears the queue", () => {
    const conn = new TestFrameChannel();
    const { store, pendingContext } = storeWithContext(conn);
    pendingContext.stage({
      source: "shell",
      ref: "sh-1",
      label: "shell",
      body: "```\n$ ls\nfoo\n[exit 0]\n```",
    });

    store.send("what is foo?", []);

    const frame = lastUserMessageFrame(conn);
    expect(frame).not.toBeNull();
    const text = (frame!.content[0] as { type: "text"; text: string }).text;
    const { blocks, rest } = splitLeadingContext(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].source).toBe("shell");
    expect(blocks[0].body).toContain("$ ls");
    expect(rest).toBe("what is foo?");
    // The queue is consumed by the send.
    expect(pendingContext.getSnapshot().items).toHaveLength(0);
  });

  it("a plain send with an empty queue is untouched (no sentinel)", () => {
    const conn = new TestFrameChannel();
    const { store } = storeWithContext(conn);
    store.send("hello", []);
    const frame = lastUserMessageFrame(conn);
    const text = (frame!.content[0] as { type: "text"; text: string }).text;
    expect(splitLeadingContext(text).blocks).toHaveLength(0);
    expect(text).toBe("hello");
  });

  it("a suppressed (programmatic) send does NOT consume the queue", () => {
    const conn = new TestFrameChannel();
    const { store, pendingContext } = storeWithContext(conn);
    pendingContext.stage({ source: "btw", ref: "b1", label: "side question", body: "q/a" });
    store.send("/goal clear", [], { suppress: true });
    expect(pendingContext.getSnapshot().items).toHaveLength(1);
  });
});

describe("Step 5c — handleSend live-path integration", () => {
  it("one image atom: synthesized substrate, wire content blocks, bytes-store under editor id", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);
    const bytes = store.getAtomBytesStore();

    // Editor's substrate: a user-friendly filename atom backed by
    // bytes-store entry under its own id.
    bytes.put("editor-A", { content: "PNG-DATA", mediaType: "image/png" });
    const editorText = `look at ${C} please`;
    const editorAtoms: AtomSegment[] = [imageAtom("editor-A", "raphael.jpeg")];

    store.send(editorText, editorAtoms);

    // The substrate that lands on `pendingTurn.userMessage` is the
    // synthesized form (`image-1` label), NOT the editor's substrate.
    const snap = store.getSnapshot();
    const activeTurn = snap.activeTurn;
    expect(activeTurn).not.toBeNull();
    const userMsg = activeTurn!.messages[0];
    expect(userMsg.kind).toBe("user_message");
    if (userMsg.kind !== "user_message") return;
    expect(userMsg.text).toBe(`look at ${C} please`);
    expect(userMsg.attachments).toHaveLength(1);
    expect(userMsg.attachments[0]).toEqual({
      kind: "atom",
      type: "image",
      label: "image-1",
      value: "image-1",
      id: "editor-A",
    });

    // The wire frame's content blocks carry the interleaved shape.
    const frame = lastUserMessageFrame(conn);
    expect(frame).not.toBeNull();
    expect(frame!.content).toEqual([
      { type: "text", text: "look at " },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "PNG-DATA" },
      },
      { type: "text", text: " please" },
    ]);

    // Bytes-store entry lives at the editor's original atom id — no
    // freshly-minted UUID, no orphans.
    const entry = bytes.get("editor-A");
    expect(entry?.content).toBe("PNG-DATA");
    expect(entry?.mediaType).toBe("image/png");
  });

  it("two image atoms: bytes-store entries land under both editor ids", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);
    const bytes = store.getAtomBytesStore();

    bytes.put("editor-A", { content: "A-DATA", mediaType: "image/png" });
    bytes.put("editor-B", { content: "B-DATA", mediaType: "image/jpeg" });
    const editorText = `${C} and ${C}`;
    const editorAtoms: AtomSegment[] = [
      imageAtom("editor-A", "first.png"),
      imageAtom("editor-B", "second.jpg"),
    ];

    store.send(editorText, editorAtoms);

    const snap = store.getSnapshot();
    const userMsg = snap.activeTurn!.messages[0];
    if (userMsg.kind !== "user_message") throw new Error("expected user_message");
    expect(userMsg.attachments.map((a) => a.id)).toEqual([
      "editor-A",
      "editor-B",
    ]);
    expect(userMsg.attachments.map((a) => a.label)).toEqual([
      "image-1",
      "image-2",
    ]);
    // Both bytes-store entries still resolve under the editor ids.
    expect(bytes.get("editor-A")?.content).toBe("A-DATA");
    expect(bytes.get("editor-B")?.content).toBe("B-DATA");
  });
});

// ---------------------------------------------------------------------------
// handleAddUserMessage — replay path
// ---------------------------------------------------------------------------

describe("Step 5c — handleAddUserMessage replay-path integration", () => {
  it("inbound add_user_message with content blocks produces matching substrate (fresh ids)", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    // Open a replay bracket so handleAddUserMessage's phase guard
    // accepts the frame.
    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "replay_started",
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
    });

    // Inbound replay frame: content blocks (Anthropic-API shape)
    // carried verbatim from JSONL.
    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "add_user_message",
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      content: [
        { type: "text", text: "look at " },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "PNG-DATA" },
        },
        { type: "text", text: " please" },
      ],
    });

    // The replay fold posts at its flush, so close the turn and the bracket
    // and read the committed turn.
    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "assistant_text",
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      status: "complete",
      msg_id: FIXTURE_IDS.MSG_ID_N(1),
      text: "ok",
      is_partial: false,
      rev: 0,
      seq: 0,
    });
    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "turn_complete",
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      seq: 0,
      msg_id: FIXTURE_IDS.MSG_ID_N(1),
      result: "success",
    });
    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "replay_complete",
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      count: 1,
    });

    const snap = store.getSnapshot();
    const userMsg = snap.transcript[0]!.messages[0];
    if (userMsg.kind !== "user_message") throw new Error("expected user_message");

    // Same substrate shape as the live path produces — text has the
    // `U+FFFC` marker; atoms carry the `image-N` label.
    expect(userMsg.text).toBe(`look at ${C} please`);
    expect(userMsg.attachments).toHaveLength(1);
    expect(userMsg.attachments[0].label).toBe("image-1");
    expect(userMsg.attachments[0].value).toBe("image-1");
    expect(userMsg.attachments[0].type).toBe("image");
    // The replay path mints a fresh UUID for the atom id (no editor
    // resolver available). The id is present and non-empty.
    expect(typeof userMsg.attachments[0].id).toBe("string");
    expect((userMsg.attachments[0].id ?? "").length).toBeGreaterThan(0);

    // Bytes-store entry lives at that minted id with the inbound
    // block's data.
    const bytes = store.getAtomBytesStore();
    const entry = bytes.get(userMsg.attachments[0].id!);
    expect(entry?.content).toBe("PNG-DATA");
    expect(entry?.mediaType).toBe("image/png");
  });
});

// ---------------------------------------------------------------------------
// Queue flush — handleTurnComplete consumes already-synthesized substrate
// ---------------------------------------------------------------------------

describe("Step 5c — queued-send + handleTurnComplete flush integration", () => {
  it("mid-turn send: queued entry carries content + synthesized substrate", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);
    const bytes = store.getAtomBytesStore();

    // First submit — starts a turn.
    bytes.put("editor-A", { content: "A-DATA", mediaType: "image/png" });
    store.send(`one ${C}`, [imageAtom("editor-A", "first.png")]);

    // Drive into streaming so the second submit lands in the queue.
    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "assistant_text",
      status: "partial",
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      msg_id: FIXTURE_IDS.MSG_ID_N(1),
      text: "ok",
      is_partial: true,
      rev: 0,
      seq: 0,
    });

    // Mid-turn submit — queues. Bytes-store entry minted at THIS
    // moment must persist across the queue gap.
    bytes.put("editor-B", { content: "B-DATA", mediaType: "image/jpeg" });
    store.send(`two ${C}`, [imageAtom("editor-B", "second.jpg")]);

    const queued = store.getSnapshot().queuedSends;
    expect(queued).toHaveLength(1);
    // Synthesized substrate on the queue entry — same shape that
    // would have landed on `UserMessage` had the submit not been
    // queued.
    expect(queued[0].text).toBe(`two ${C}`);
    expect(queued[0].atoms).toHaveLength(1);
    expect(queued[0].atoms[0].label).toBe("image-1");
    expect(queued[0].atoms[0].id).toBe("editor-B");

    // Bytes-store entry from queue-time submit is still live.
    expect(bytes.get("editor-B")?.content).toBe("B-DATA");
  });

  it("turn_complete flushes the queued entry: mints UserMessage from synthesized substrate; sends wire content", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);
    const bytes = store.getAtomBytesStore();

    bytes.put("editor-A", { content: "A-DATA", mediaType: "image/png" });
    store.send(`one ${C}`, [imageAtom("editor-A", "first.png")]);
    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "assistant_text",
      status: "partial",
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      msg_id: FIXTURE_IDS.MSG_ID_N(1),
      text: "ok",
      is_partial: true,
      rev: 0,
      seq: 0,
    });

    bytes.put("editor-B", { content: "B-DATA", mediaType: "image/jpeg" });
    store.send(`two ${C}`, [imageAtom("editor-B", "second.jpg")]);

    // Snapshot the wire content the first submit produced — we want
    // to confirm the queue-flush emits a NEW wire frame whose
    // content blocks come from the queued entry, not a re-run of
    // buildWirePayload.
    const beforeFlush = lastUserMessageFrame(conn);
    expect(beforeFlush?.content).toEqual([
      { type: "text", text: "one " },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "A-DATA" },
      },
    ]);

    // Flush: turn_complete(success) collapses the queue head into
    // the active turn.
    dispatchTurnCompleteSuccess(conn, FIXTURE_IDS.MSG_ID_N(1));

    // The new active turn's user message comes from the queued
    // entry's synthesized substrate (no re-synthesis).
    const flushedUser = store.getSnapshot().activeTurn?.messages[0];
    expect(flushedUser).toBeDefined();
    if (flushedUser?.kind !== "user_message") throw new Error("expected user_message");
    expect(flushedUser.text).toBe(`two ${C}`);
    expect(flushedUser.attachments).toHaveLength(1);
    expect(flushedUser.attachments[0].id).toBe("editor-B");
    expect(flushedUser.attachments[0].label).toBe("image-1");

    // A fresh wire user_message frame was emitted with the queued
    // entry's content blocks.
    const afterFlush = lastUserMessageFrame(conn);
    expect(afterFlush?.content).toEqual([
      { type: "text", text: "two " },
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "B-DATA" },
      },
    ]);

    // Queue is drained.
    expect(store.getSnapshot().queuedSends).toHaveLength(0);
    // Bytes-store entries from both submits stayed live across the
    // gap (per-card bytes-store, not per-turn).
    expect(bytes.get("editor-A")?.content).toBe("A-DATA");
    expect(bytes.get("editor-B")?.content).toBe("B-DATA");
  });
});
