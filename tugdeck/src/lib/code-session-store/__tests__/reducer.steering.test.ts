/**
 * reducer.steering.test.ts — mid-turn message steering ([Q01]/[P06]/[P07]).
 *
 * A message submitted while a turn runs is parked in `queuedSends`
 * (held off the wire, retractable). At the next agent-loop boundary —
 * a live `tool_result` — the reducer picks up the head entry
 * atomically: forwards it (a single `send-frame`), removes it from the
 * queue, and appends it as a `user_message` to the in-flight turn's
 * `messages` so it becomes a real mid-turn user row keyed by its own
 * queue-time key ([P04]). These are the load-bearing invariants:
 *
 *   1. Pickup forwards + removes + places, exactly once, before
 *      `turn_complete`.
 *   2. No double-forward — a picked-up entry is gone, so the
 *      `turn_complete` collapse never re-sends it (Risk R03).
 *   3. A turn with no mid-turn tool step still flushes its queue at
 *      `turn_complete` (the fallback) — the boundary pickup didn't
 *      break it.
 *   4. Retraction (`cancel_queued_send`) and `interrupt` clear parked
 *      entries with no `user_message` frame.
 *   5. Multiple entries pick up one-per-boundary, in order.
 */

import { describe, expect, test } from "bun:test";

import {
  reduce,
  createInitialState,
  type CodeSessionState,
} from "@/lib/code-session-store/reducer";
import type { Message, UserMessage } from "@/lib/code-session-store/types";
import type {
  AppendTranscriptEffect,
  Effect,
  SendFrameEffect,
} from "@/lib/code-session-store/effects";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";

function fresh(): CodeSessionState {
  return createInitialState("session", "test", "new");
}

function applyAll(
  state: CodeSessionState,
  events: ReadonlyArray<CodeSessionEvent>,
): { state: CodeSessionState; effects: Effect[] } {
  let current = state;
  const collected: Effect[] = [];
  for (const ev of events) {
    const r = reduce(current, ev);
    current = r.state;
    collected.push(...r.effects);
  }
  return { state: current, effects: collected };
}

function sendFrames(effects: ReadonlyArray<Effect>): SendFrameEffect[] {
  return effects.filter((e): e is SendFrameEffect => e.kind === "send-frame");
}

/** User-message wire frames only (steering forwards these). */
function userMessageFrames(effects: ReadonlyArray<Effect>): string[] {
  return sendFrames(effects)
    .filter((f) => (f.msg as { type?: string }).type === "user_message")
    .map((f) => {
      const content =
        (f.msg as { content?: Array<{ type: string; text?: string }> })
          .content ?? [];
      return content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
    });
}

function committedMessages(
  effects: ReadonlyArray<Effect>,
): ReadonlyArray<Message> {
  const append = effects.find(
    (e): e is AppendTranscriptEffect => e.kind === "append-transcript",
  );
  return append?.entry.messages ?? [];
}

function send(text: string, turnKey: string): CodeSessionEvent {
  return {
    type: "send",
    text,
    atoms: [],
    content: [{ type: "text", text }],
    turnKey,
  };
}

/** Open a turn and drive it to `tool_work` with one pending tool `tu1`. */
function openTurnWithPendingTool(turnKey: string): CodeSessionState {
  const { state } = applyAll(fresh(), [
    send("go", turnKey),
    {
      type: "content_block_start",
      msg_id: "m1",
      block_index: 0,
      kind: "tool_use",
      tool_use_id: "tu1",
      tool_name: "Bash",
    },
    {
      type: "tool_use",
      msg_id: "m1",
      tool_use_id: "tu1",
      tool_name: "Bash",
      input: { command: "ls" },
      seq: 0,
    },
  ]);
  expect(state.phase).toBe("tool_work");
  return state;
}

describe("mid-turn steering — boundary pickup at tool_result", () => {
  test("parks the queued send off the wire, then forwards + removes + places it at the tool_result", () => {
    let state = openTurnWithPendingTool("t1");

    // Mid-turn submit — parked, no frame on the wire.
    const parked = reduce(state, send("steer me", "s1"));
    state = parked.state;
    expect(userMessageFrames(parked.effects)).toEqual([]);
    expect(state.queuedSends.length).toBe(1);

    // Boundary: the tool completes. The head entry is picked up.
    const pickup = reduce(state, { type: "tool_result", tool_use_id: "tu1", output: "ok", is_error: false });
    state = pickup.state;

    // Exactly one user_message frame forwarded — the steered content.
    expect(userMessageFrames(pickup.effects)).toEqual(["steer me"]);
    // The entry left the queue.
    expect(state.queuedSends.length).toBe(0);

    // It was appended to THIS turn's messages as a mid-turn user row,
    // after the tool block, keyed by its own queue-time key.
    const msgs = state.scratch.get("t1")!.messages;
    expect(msgs.map((m) => m.kind)).toEqual([
      "user_message", // opener
      "tool_use", // tu1 (now done)
      "user_message", // steered, merged mid-turn
    ]);
    expect(msgs[0].messageKey).toBe("t1-user");
    const steered = msgs[2] as UserMessage;
    expect(steered.messageKey).toBe("s1-user");
    expect(steered.text).toBe("steer me");
  });

  test("the picked-up row is stamped when the user submitted it, not at the boundary", async () => {
    let state = openTurnWithPendingTool("t1");
    state = reduce(state, send("steer me", "s1")).state;
    const queuedAt = state.queuedSends[0].queuedAt;

    // The boundary can be a long way from the submission — a tool call runs
    // for as long as it runs. The row's timestamp is the user's submit.
    await Bun.sleep(5);
    state = reduce(state, { type: "tool_result", tool_use_id: "tu1", output: "ok", is_error: false }).state;

    const steered = state.scratch.get("t1")!.messages[2] as UserMessage;
    expect(steered.submitAt).toBe(queuedAt);
    expect(steered.createdAt).toBe(queuedAt);
    expect(Date.now()).toBeGreaterThan(queuedAt);
  });

  test("no double-forward: the picked-up entry is gone, so turn_complete re-sends nothing", () => {
    let state = openTurnWithPendingTool("t1");
    state = reduce(state, send("steer me", "s1")).state;

    const pickup = reduce(state, { type: "tool_result", tool_use_id: "tu1", output: "ok", is_error: false });
    state = pickup.state;
    expect(state.queuedSends.length).toBe(0);

    // Finish the turn. No further user_message frame; the committed turn
    // carries the merged shape [user, tool, user, assistant].
    const done = applyAll(state, [
      { type: "content_block_start", msg_id: "m1", block_index: 1, kind: "text" },
      { type: "assistant_text", msg_id: "m1", block_index: 1, text: "done", is_partial: false, seq: 0, rev: 0, status: "complete" },
      { type: "turn_complete", msg_id: "m1", result: "success", seq: 0 },
    ]);
    expect(userMessageFrames(done.effects)).toEqual([]);
    expect(done.state.phase).toBe("idle");
    expect(done.state.queuedSends.length).toBe(0);

    const committed = committedMessages(done.effects);
    expect(committed.map((m) => m.kind)).toEqual([
      "user_message",
      "tool_use",
      "user_message",
      "assistant_text",
    ]);
    expect(committed[2].messageKey).toBe("s1-user");
  });

  test("a turn with no mid-turn tool step still flushes its queue at turn_complete (fallback intact)", () => {
    // Open a turn, drive to `streaming` (no tool), queue a send.
    const { state: opened } = applyAll(fresh(), [
      send("go", "t1"),
      { type: "content_block_start", msg_id: "m1", block_index: 0, kind: "text" },
      { type: "assistant_text", msg_id: "m1", block_index: 0, text: "h", is_partial: true, seq: 0, rev: 0, status: "partial" },
      { type: "assistant_text", msg_id: "m1", block_index: 0, text: "hi", is_partial: true, seq: 0, rev: 0, status: "partial" },
    ]);
    expect(opened.phase).toBe("streaming");
    let state = reduce(opened, send("next turn", "s1")).state;
    expect(state.queuedSends.length).toBe(1);

    // No tool_result ever fired, so the queue flushes at turn_complete:
    // one user_message frame, and the entry opens the next turn.
    const complete = reduce(state, { type: "turn_complete", msg_id: "m1", result: "success", seq: 0 });
    state = complete.state;
    expect(userMessageFrames(complete.effects)).toEqual(["next turn"]);
    expect(state.phase).toBe("submitting");
    expect(state.queuedSends.length).toBe(0);
    expect(state.pendingTurn?.turnKey).toBe("s1");
  });

  test("cancel_queued_send retracts a parked entry with no frame", () => {
    let state = openTurnWithPendingTool("t1");
    state = reduce(state, send("steer me", "s1")).state;
    expect(state.queuedSends.length).toBe(1);

    const cancel = reduce(state, { type: "cancel_queued_send", turnKey: "s1" });
    state = cancel.state;
    expect(userMessageFrames(cancel.effects)).toEqual([]);
    expect(state.queuedSends.length).toBe(0);
    // A retraction offers the prompt back through the draft-restore slot.
    expect(state.pendingDraftRestore?.text).toBe("steer me");
  });

  test("interrupt clears parked entries without forwarding them", () => {
    let state = openTurnWithPendingTool("t1");
    state = reduce(state, send("steer me", "s1")).state;
    state = reduce(state, send("and again", "s2")).state;
    expect(state.queuedSends.length).toBe(2);

    const interrupted = reduce(state, { type: "interrupt_action" });
    state = interrupted.state;
    // No queued message was forwarded; the queue is cleared.
    expect(userMessageFrames(interrupted.effects)).toEqual([]);
    expect(state.queuedSends.length).toBe(0);
  });

  test("multiple queued entries pick up one-per-boundary, in order", () => {
    // Open a turn with TWO pending tools.
    const { state: opened } = applyAll(fresh(), [
      send("go", "t1"),
      { type: "content_block_start", msg_id: "m1", block_index: 0, kind: "tool_use", tool_use_id: "tu1", tool_name: "Bash" },
      { type: "tool_use", msg_id: "m1", tool_use_id: "tu1", tool_name: "Bash", input: {}, seq: 0 },
      { type: "content_block_start", msg_id: "m1", block_index: 1, kind: "tool_use", tool_use_id: "tu2", tool_name: "Read" },
      { type: "tool_use", msg_id: "m1", tool_use_id: "tu2", tool_name: "Read", input: {}, seq: 0 },
    ]);
    expect(opened.phase).toBe("tool_work");

    let state = reduce(opened, send("first steer", "s1")).state;
    state = reduce(state, send("second steer", "s2")).state;
    expect(state.queuedSends.map((q) => q.text)).toEqual([
      "first steer",
      "second steer",
    ]);

    // First boundary picks up the head only.
    const b1 = reduce(state, { type: "tool_result", tool_use_id: "tu1", output: "ok", is_error: false });
    state = b1.state;
    expect(userMessageFrames(b1.effects)).toEqual(["first steer"]);
    expect(state.queuedSends.map((q) => q.text)).toEqual(["second steer"]);

    // Second boundary picks up the next.
    const b2 = reduce(state, { type: "tool_result", tool_use_id: "tu2", output: "ok", is_error: false });
    state = b2.state;
    expect(userMessageFrames(b2.effects)).toEqual(["second steer"]);
    expect(state.queuedSends.length).toBe(0);

    // Both landed in arrival order, each with its own key.
    const userKeys = state.scratch
      .get("t1")!
      .messages.filter((m) => m.kind === "user_message")
      .map((m) => m.messageKey);
    expect(userKeys).toEqual(["t1-user", "s1-user", "s2-user"]);
  });
});

describe("mid-turn steering — reload-authoritative placement (JSONL replay)", () => {
  function addUserMessage(turnKey: string, text: string): CodeSessionEvent {
    return { type: "add_user_message", turnKey, text, atoms: [] };
  }

  test("a replayed add_user_message threaded after a mid-turn tool_result appends to the in-flight turn (no new turn opened)", () => {
    // Enter replay, then replay a turn: opener → tool → (steered merge) →
    // continuation. The steered add_user_message arrives mid-bracket.
    const { state } = applyAll(fresh(), [
      { type: "replay_started" },
      addUserMessage("t1", "opener"),
      { type: "content_block_start", msg_id: "m1", block_index: 0, kind: "tool_use", tool_use_id: "tu1", tool_name: "Bash" },
      { type: "tool_use", msg_id: "m1", tool_use_id: "tu1", tool_name: "Bash", input: {}, seq: 0 },
      { type: "tool_result", tool_use_id: "tu1", output: "ok", is_error: false },
      // Steered message merged after the tool_result — its own turnKey.
      addUserMessage("s1", "steered"),
    ]);

    expect(state.phase).toBe("replaying");
    // The fork appended to the host turn; it did NOT open a new turn.
    expect(state.pendingTurn?.turnKey).toBe("t1");
    expect(state.scratch.get("s1")).toBeUndefined();

    const msgs = state.scratch.get("t1")!.messages;
    expect(msgs.map((m) => m.kind)).toEqual([
      "user_message", // opener
      "tool_use", // tu1
      "user_message", // steered, merged mid-turn (appended, not a new turn)
    ]);
    expect(msgs[0].messageKey).toBe("t1-user");
    const steered = msgs[2] as UserMessage;
    expect(steered.messageKey).toBe("s1-user");
    expect(steered.text).toBe("steered");
  });

  test("a replayed opener after a turn_complete still opens a new turn (the fork only fires mid-bracket)", () => {
    const { state } = applyAll(fresh(), [
      { type: "replay_started" },
      addUserMessage("t1", "first"),
      { type: "assistant_text", msg_id: "m1", block_index: 0, text: "a", is_partial: false, seq: 0, rev: 0, status: "complete" },
      { type: "turn_complete", msg_id: "m1", result: "success", seq: 0 },
      // pendingTurn is null here → the next opener opens a fresh turn.
      addUserMessage("t2", "second"),
    ]);

    expect(state.pendingTurn?.turnKey).toBe("t2");
    const t2 = state.scratch.get("t2")!;
    expect(t2.messages.map((m) => m.kind)).toEqual(["user_message"]);
    expect(t2.messages[0].messageKey).toBe("t2-user");
  });
});
