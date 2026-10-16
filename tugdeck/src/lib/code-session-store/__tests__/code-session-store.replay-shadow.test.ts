/**
 * A replay that lands mid-turn never drops the live turn.
 *
 * On 2026-10-16 a `request_replay` went out for a session whose card was
 * in `tool_work`, waiting on an `AskUserQuestion` tool block. The reducer
 * refused the `replay_started` ("unexpected phase tool_work; dropping"),
 * which left the bracket's frames to fall through the live handlers: the
 * store ended in `waking` with no active message, five replayed
 * `turn_complete`s were dropped for lack of a pending turn, the
 * `replay_complete` was dropped too, and the live turn's tool block, its
 * text and its question never rendered. The transcript on disk was
 * intact; the card lost the turn.
 *
 * The rule now: a bracket that opens over a live turn is *shadowed*. The
 * live phase and cycle stay exactly as they are, the replay translator's
 * history is set aside, and `replay_complete` lifts the shadow. tugcode
 * keeps the in-flight turn's live frames off the wire while the bracket
 * runs and carries them only in its mid-turn snapshot, just before the
 * close, so from the snapshot's marked opener on the store takes what its
 * live cycle lacks. This file drives those sequences through the real
 * store and pins what survives: the tool block, the question, the text,
 * what streamed inside the window, and the turn's own `turn_complete`.
 */

import { describe, it, expect } from "bun:test";

import {
  CodeSessionStore,
  REPLAY_SHADOW_DEADLINE_MS,
  type TimerSource,
} from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { FeedId } from "@/protocol";

const TUG = FIXTURE_IDS.TUG_SESSION_ID;
const LIVE_MSG = "msg-live";
const ASK_TOOL = "tool-ask";
const ASK_REQUEST = FIXTURE_IDS.REQUEST_ID;

interface FakeTimerEntry {
  id: number;
  cb: () => void;
  fireAt: number;
  cleared: boolean;
}

/** The captured-table fake from `code-session-store.replay-bracket.test.ts`. */
class FakeTimers {
  private now = 0;
  private nextId = 1;
  private entries: FakeTimerEntry[] = [];

  readonly source: TimerSource = {
    setTimeout: (cb, ms) => {
      const id = this.nextId++;
      this.entries.push({ id, cb, fireAt: this.now + ms, cleared: false });
      return id;
    },
    clearTimeout: (handle) => {
      if (typeof handle !== "number") return;
      const entry = this.entries.find((e) => e.id === handle);
      if (entry) entry.cleared = true;
    },
  };

  advance(ms: number): void {
    const target = this.now + ms;
    while (true) {
      const due = this.entries
        .filter((e) => !e.cleared && e.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt);
      if (due.length === 0) break;
      const next = due[0]!;
      this.now = next.fireAt;
      next.cleared = true;
      next.cb();
    }
    this.now = target;
  }
}

function makeStore(): { store: CodeSessionStore; conn: TestFrameChannel; timers: FakeTimers } {
  const conn = new TestFrameChannel();
  const timers = new FakeTimers();
  const store = new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: TUG,
    sessionMode: "resume",
    timerSource: timers.source,
  });
  return { store, conn, timers };
}

function emit(conn: TestFrameChannel, evt: Record<string, unknown>): void {
  conn.dispatchDecoded(FeedId.CODE_OUTPUT, { ...evt, tug_session_id: TUG });
}

/**
 * The live turn as it stood when the replay landed: a prompt, a sentence
 * of assistant text, and the `AskUserQuestion` call that put the store in
 * `tool_work`.
 */
function openLiveTurnInToolWork(store: CodeSessionStore, conn: TestFrameChannel): void {
  store.send("which one?", []);
  emit(conn, { type: "assistant_text", status: "partial", msg_id: LIVE_MSG, text: "Let me ask.", is_partial: true, rev: 0, seq: 0 });
  emit(conn, { type: "assistant_text", status: "partial", msg_id: LIVE_MSG, text: "Let me ask.", is_partial: true, rev: 1, seq: 0 });
  emit(conn, {
    type: "tool_use",
    msg_id: LIVE_MSG,
    tool_use_id: ASK_TOOL,
    tool_name: "AskUserQuestion",
    input: { questions: [{ question: "pick one" }] },
    seq: 1,
  });
  expect(store.getSnapshot().phase).toBe("tool_work");
}

/** Five finished turns, as the translator emits them from the JSONL. */
function emitReplayedHistory(conn: TestFrameChannel): void {
  for (let i = 1; i <= 5; i++) {
    emit(conn, { type: "add_user_message", content: [{ type: "text", text: `earlier prompt ${i}` }] });
    emit(conn, { type: "assistant_text", status: "complete", msg_id: `msg-replayed-${i}`, text: `earlier answer ${i}`, is_partial: false, rev: 0, seq: 0 });
    emit(conn, { type: "turn_complete", seq: 0, msg_id: `msg-replayed-${i}`, result: "success" });
  }
}

/**
 * The bracket's in-flight snapshot: tugcode re-emits the open cycle from
 * its own `ActiveTurn` — the very turn the store has in hand, nothing new.
 */
function emitReplayedInflightSnapshot(conn: TestFrameChannel): void {
  emit(conn, { type: "add_user_message", content: [{ type: "text", text: "which one?" }], inflightSnapshot: true });
  emit(conn, { type: "assistant_text", status: "complete", msg_id: LIVE_MSG, text: "Let me ask.", is_partial: false, rev: 0, seq: 0 });
  emit(conn, {
    type: "tool_use",
    msg_id: LIVE_MSG,
    tool_use_id: ASK_TOOL,
    tool_name: "AskUserQuestion",
    input: { questions: [{ question: "pick one" }] },
    seq: 1,
  });
}

function emitQuestionForward(conn: TestFrameChannel): void {
  emit(conn, {
    type: "control_request_forward",
    request_id: ASK_REQUEST,
    is_question: true,
    tool_name: "AskUserQuestion",
    tool_use_id: ASK_TOOL,
    input: {},
    question: "pick one",
    options: [
      { key: "a", label: "Option A" },
      { key: "b", label: "Option B" },
    ],
  });
}

describe("a replay bracket that opens over a live turn", () => {
  it("leaves the live cycle untouched through the bracket, and the turn still commits", () => {
    const { store, conn } = makeStore();
    openLiveTurnInToolWork(store, conn);
    const before = store.getSnapshot();

    // The bracket lands mid-turn.
    emit(conn, { type: "replay_started", ipc_version: 2 });
    let snap = store.getSnapshot();
    expect(snap.phase, "the store never enters the bracket over a live turn").toBe("tool_work");
    expect(snap.activeTurn).not.toBeNull();

    emitReplayedHistory(conn);
    emitReplayedInflightSnapshot(conn);
    emit(conn, { type: "replay_complete", count: 6, ipc_version: 2 });

    snap = store.getSnapshot();
    expect(snap.phase, "the close returns to the live phase, never idle or waking").toBe("tool_work");
    expect(snap.activeTurn?.turnKey, "the live cycle is the same cycle").toBe(before.activeTurn?.turnKey);
    const tool = snap.activeTurn?.messages.find((m) => m.kind === "tool_use");
    expect(tool, "the live tool block survives the bracket").toBeDefined();
    expect(tool?.kind === "tool_use" ? tool.toolUseId : null).toBe(ASK_TOOL);
    expect(
      snap.activeTurn?.messages.filter((m) => m.kind === "tool_use").length,
      "the snapshot's re-emitted tool_use does not mint a second block",
    ).toBe(1);
    expect(snap.transcript.length, "nothing replayed lands as a turn over a live card").toBe(0);
    expect(snap.lastReplayResult, "a shadowed bracket has no outcome").toBeNull();
    expect(snap.replayEverCompleted, "a shadowed bracket is not a replay the card had").toBe(false);

    // The question's forward reaches the card after the close.
    emitQuestionForward(conn);
    snap = store.getSnapshot();
    expect(snap.phase).toBe("awaiting_approval");
    expect(snap.pendingQuestion?.request_id, "the question reaches the dialog").toBe(ASK_REQUEST);

    store.respondQuestion(ASK_REQUEST, { answers: { pick: "a" } });
    expect(store.getSnapshot().phase).toBe("tool_work");
    emit(conn, { type: "tool_result", seq: 0, tool_use_id: ASK_TOOL, output: "a", is_error: false });
    emit(conn, { type: "assistant_text", status: "complete", msg_id: LIVE_MSG, text: "Let me ask. Option A it is.", is_partial: false, rev: 2, seq: 0 });
    emit(conn, { type: "turn_complete", seq: 0, msg_id: LIVE_MSG, result: "success" });

    snap = store.getSnapshot();
    expect(snap.phase, "the live turn_complete is never discarded").toBe("idle");
    expect(snap.activeTurn).toBeNull();
    expect(snap.transcript.length).toBe(1);
    const committed = snap.transcript[0]!;
    const committedTool = committed.messages.find((m) => m.kind === "tool_use");
    expect(committedTool?.kind === "tool_use" ? committedTool.status : null).toBe("done");
    const committedText = committed.messages.find((m) => m.kind === "assistant_text");
    expect(committedText?.kind === "assistant_text" ? committedText.text : null).toBe("Let me ask. Option A it is.");
  });

  it("takes from the snapshot what streamed, resolved and finished inside the window", () => {
    const { store, conn } = makeStore();
    const READ_TOOL = "tool-read";
    const NEXT_MSG = "msg-live-2";
    store.send("find it", []);
    emit(conn, { type: "content_block_start", msg_id: LIVE_MSG, block_index: 0, kind: "text" });
    emit(conn, { type: "assistant_text", status: "partial", msg_id: LIVE_MSG, block_index: 0, text: "Let me look.", is_partial: true, rev: 0, seq: 0 });
    emit(conn, { type: "content_block_start", msg_id: LIVE_MSG, block_index: 1, kind: "tool_use", tool_use_id: READ_TOOL, tool_name: "Read" });
    emit(conn, { type: "tool_use", msg_id: LIVE_MSG, tool_use_id: READ_TOOL, tool_name: "Read", input: { file_path: "/a" }, seq: 1 });
    expect(store.getSnapshot().phase).toBe("tool_work");

    // The bracket lands; tugcode suppresses the tool's result, the next
    // message and the turn's end, and sends them only in the snapshot.
    emit(conn, { type: "replay_started", ipc_version: 2 });
    emitReplayedHistory(conn);
    emit(conn, { type: "add_user_message", content: [{ type: "text", text: "find it" }], inflightSnapshot: true });
    emit(conn, { type: "content_block_start", msg_id: LIVE_MSG, block_index: 0, kind: "text" });
    emit(conn, { type: "assistant_text", status: "streaming", msg_id: LIVE_MSG, block_index: 0, text: "Let me look.", is_partial: false, rev: 1, seq: 2 });
    emit(conn, { type: "content_block_start", msg_id: LIVE_MSG, block_index: 1, kind: "tool_use", tool_use_id: READ_TOOL, tool_name: "Read" });
    emit(conn, { type: "tool_use", msg_id: LIVE_MSG, tool_use_id: READ_TOOL, tool_name: "Read", input: { file_path: "/a" }, seq: 3 });
    emit(conn, { type: "tool_result", tool_use_id: READ_TOOL, output: "contents", is_error: false });
    emit(conn, { type: "content_block_start", msg_id: NEXT_MSG, block_index: 0, kind: "text" });
    emit(conn, { type: "assistant_text", status: "streaming", msg_id: NEXT_MSG, block_index: 0, text: "Found it.", is_partial: false, rev: 1, seq: 4 });
    emit(conn, { type: "turn_complete", seq: 5, msg_id: NEXT_MSG, result: "success" });
    emit(conn, { type: "replay_complete", count: 6, ipc_version: 2 });

    const snap = store.getSnapshot();
    expect(snap.phase, "the turn that ended inside the window has ended").toBe("idle");
    expect(snap.transcript.length, "the live turn commits, and nothing replayed lands beside it").toBe(1);
    const messages = snap.transcript[0]!.messages;
    const tools = messages.filter((m) => m.kind === "tool_use");
    expect(tools.length, "the re-emitted tool block is not minted twice").toBe(1);
    expect(tools[0]?.kind === "tool_use" ? tools[0].status : null, "the result the window carried lands").toBe("done");
    const texts = messages.flatMap((m) => (m.kind === "assistant_text" ? [m.text] : []));
    expect(texts, "the text streamed inside the window is there, and the earlier text once").toEqual(["Let me look.", "Found it."]);
    expect(snap.lastReplayResult, "a shadowed bracket still has no outcome").toBeNull();
  });

  it("keeps a dialog that was already up, and a second bracket over it", () => {
    const { store, conn } = makeStore();
    openLiveTurnInToolWork(store, conn);
    emitQuestionForward(conn);
    expect(store.getSnapshot().phase).toBe("awaiting_approval");

    emit(conn, { type: "replay_started", ipc_version: 2 });
    emitReplayedHistory(conn);
    emitReplayedInflightSnapshot(conn);
    emit(conn, { type: "replay_complete", count: 6, ipc_version: 2 });

    const snap = store.getSnapshot();
    expect(snap.phase, "the dialog is still up").toBe("awaiting_approval");
    expect(snap.pendingQuestion?.request_id).toBe(ASK_REQUEST);
    expect(snap.activeTurn?.messages.some((m) => m.kind === "tool_use")).toBe(true);
  });

  it("lifts a shadow whose close never comes, so live frames flow again", () => {
    const { store, conn, timers } = makeStore();
    openLiveTurnInToolWork(store, conn);

    emit(conn, { type: "replay_started", ipc_version: 2 });
    emitReplayedHistory(conn);
    // No replay_complete. Until the deadline, replay-vocabulary frames are
    // set aside — a live-looking one too, since none can be live yet.
    timers.advance(REPLAY_SHADOW_DEADLINE_MS - 1);
    emit(conn, { type: "turn_complete", seq: 0, msg_id: LIVE_MSG, result: "success" });
    expect(store.getSnapshot().phase, "still shadowed").toBe("tool_work");

    timers.advance(1);
    emit(conn, { type: "tool_result", seq: 0, tool_use_id: ASK_TOOL, output: "a", is_error: false });
    emit(conn, { type: "turn_complete", seq: 0, msg_id: LIVE_MSG, result: "success" });
    const snap = store.getSnapshot();
    expect(snap.phase, "the shadow lifted on its own").toBe("idle");
    expect(snap.transcript.length).toBe(1);
    expect(snap.lastError, "a lifted shadow raises no error").toBeNull();
  });

  it("still enters a bracket from idle, and still drops one inside a bracket", () => {
    const { store, conn } = makeStore();
    emit(conn, { type: "replay_started", ipc_version: 2 });
    expect(store.getSnapshot().phase).toBe("replaying");
    emit(conn, { type: "replay_started", ipc_version: 2 });
    expect(store.getSnapshot().phase).toBe("replaying");
    emitReplayedHistory(conn);
    emit(conn, { type: "replay_complete", count: 5, ipc_version: 2 });
    const snap = store.getSnapshot();
    expect(snap.phase).toBe("idle");
    expect(snap.transcript.length).toBe(5);
    expect(snap.replayEverCompleted).toBe(true);
  });
});

/**
 * The answer to `request_inflight`: after a reconnect to the same tugcast,
 * a card whose stores stood asks for the turn as it now stands, and tugcode
 * answers with a bracket marked `inflight_only` around its snapshot alone.
 */
describe("an inflight-only bracket, after a reconnect to the same server", () => {
  function snapshotOfTheFinishedTurn(conn: TestFrameChannel): void {
    emit(conn, { type: "replay_started", inflight_only: true, ipc_version: 2 });
    emit(conn, { type: "add_user_message", content: [], inflightSnapshot: true });
    emit(conn, { type: "content_block_start", msg_id: LIVE_MSG, block_index: 0, kind: "text" });
    emit(conn, { type: "assistant_text", status: "streaming", msg_id: LIVE_MSG, block_index: 0, text: "Half of it, and the rest.", is_partial: false, rev: 9, seq: 1 });
    emit(conn, { type: "turn_complete", seq: 2, msg_id: LIVE_MSG, result: "success" });
    emit(conn, { type: "replay_complete", count: 0, ipc_version: 2 });
  }

  it("completes a live turn that finished while the socket was down", () => {
    const { store, conn } = makeStore();
    store.send("go on", []);
    emit(conn, { type: "content_block_start", msg_id: LIVE_MSG, block_index: 0, kind: "text" });
    emit(conn, { type: "assistant_text", status: "partial", msg_id: LIVE_MSG, block_index: 0, text: "Half of it", is_partial: true, rev: 0, seq: 1 });
    expect(store.getSnapshot().phase, "the turn is live").not.toBe("idle");

    // The rest of the text and the turn's end went out while the socket was
    // down; the snapshot is the only record of them.
    snapshotOfTheFinishedTurn(conn);

    const snap = store.getSnapshot();
    expect(snap.phase, "the turn that ended in the gap has ended").toBe("idle");
    expect(snap.transcript.length).toBe(1);
    const texts = snap.transcript[0]!.messages.flatMap((m) => (m.kind === "assistant_text" ? [m.text] : []));
    expect(texts, "the text the gap carried is there").toEqual(["Half of it, and the rest."]);
    expect(snap.lastReplayResult, "the bracket was never entered").toBeNull();
  });

  it("is set aside whole by a card with no turn in flight", () => {
    const { store, conn } = makeStore();
    store.send("go on", []);
    emit(conn, { type: "assistant_text", status: "complete", msg_id: LIVE_MSG, text: "Done.", is_partial: false, rev: 0, seq: 1 });
    emit(conn, { type: "turn_complete", seq: 2, msg_id: LIVE_MSG, result: "success" });
    const before = store.getSnapshot();
    expect(before.phase).toBe("idle");

    snapshotOfTheFinishedTurn(conn);

    const snap = store.getSnapshot();
    expect(snap.phase, "an idle card never enters it").toBe("idle");
    expect(snap.transcript, "nothing in it lands on a settled card").toEqual(before.transcript);
    expect(snap.lastReplayResult).toBeNull();
    expect(snap.replayEverCompleted).toBe(before.replayEverCompleted);
  });
});
