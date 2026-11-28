/**
 * reducer.steering.test.ts — a message submitted while a turn runs ([B07]).
 *
 * The message goes to claude at Return and waits in `queuedSends` as `sent`,
 * drawn as a `Waiting` row, until claude reports where it took it in. A
 * `command_lifecycle started` while the turn is open seats it in that turn's
 * `messages`, keyed by its own queue-time key ([P04]); one that comes after
 * the turn's end is a follow-on, opened by `follow_on_started`. These are the
 * load-bearing invariants:
 *
 *   1. Forwarded exactly once, at Return — never again at a tool result or at
 *      `turn_complete`.
 *   2. Seated where claude took it in, stamped when the user posted it.
 *   3. Several messages land in the order they were sent.
 *   4. A wake turn takes the same rule ([B05]).
 *   5. A message claude reports it will not act on leaves the queue and
 *      offers its words back; removing or stopping sends no second copy.
 *   6. A waiting message taken back — its remove button, or Stop before it
 *      interrupts — is withdrawn through claude ([B06]): the row stays until
 *      claude answers, and a withdrawn message sends nothing the model acts
 *      on; one claude had already taken in is seated where it was.
 *   7. The other holds are unchanged ([B08]): a submit that must wait off
 *      the wire still flushes at the turn's end.
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

/** The submission ids the effects ask claude to withdraw. */
function withdrawals(effects: ReadonlyArray<Effect>): string[] {
  return sendFrames(effects).flatMap((f) => (f.msg.type === "cancel_async_message" ? [f.msg.submission_id] : []));
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

function lifecycle(
  submissionId: string,
  state: "queued" | "started" | "completed" | "cancelled" | "discarded" | "refused",
): CodeSessionEvent {
  return { type: "command_lifecycle", submissionId, state };
}

const TOOL_RESULT: CodeSessionEvent = { type: "tool_result", tool_use_id: "tu1", output: "ok", is_error: false };

function finishTurn(msgId: string, text: string): CodeSessionEvent[] {
  return [
    { type: "content_block_start", msg_id: msgId, block_index: 1, kind: "text" },
    { type: "assistant_text", msg_id: msgId, block_index: 1, text, is_partial: false, seq: 0, rev: 0, status: "complete" },
    { type: "turn_complete", msg_id: msgId, result: "success", seq: 0 },
  ];
}

describe("mid-turn steering — sent at Return, seated where claude took it in", () => {
  test("a mid-turn submit goes on the wire at Return, once, and waits", () => {
    let state = openTurnWithPendingTool("t1");

    const sent = reduce(state, send("steer me", "s1"));
    state = sent.state;
    expect(userMessageFrames(sent.effects)).toEqual(["steer me"]);
    expect(state.queuedSends.map((q) => q.sent)).toEqual([true]);

    // The tool's result is not a boundary the deck acts on any more.
    const result = reduce(state, TOOL_RESULT);
    expect(userMessageFrames(result.effects)).toEqual([]);
    expect(result.state.queuedSends.length).toBe(1);
  });

  test("claude's started seats it in the running turn, stamped when the user posted it", async () => {
    let state = openTurnWithPendingTool("t1");
    state = reduce(state, send("steer me", "s1")).state;
    const queuedAt = state.queuedSends[0].queuedAt;
    await Bun.sleep(5);
    state = reduce(state, TOOL_RESULT).state;

    const started = reduce(state, lifecycle("s1", "started"));
    state = started.state;
    expect(userMessageFrames(started.effects)).toEqual([]);
    expect(state.queuedSends.length).toBe(0);
    const msgs = state.scratch.get("t1")!.messages;
    expect(msgs.map((m) => m.kind)).toEqual(["user_message", "tool_use", "user_message"]);
    expect(msgs[0].messageKey).toBe("t1-user");
    const steered = msgs[2] as UserMessage;
    expect(steered.messageKey).toBe("s1-user");
    expect(steered.text).toBe("steer me");
    expect(steered.submitAt).toBe(queuedAt);
    expect(steered.createdAt).toBe(queuedAt);
  });

  test("forwarded exactly once: turn_complete re-sends nothing", () => {
    let state = openTurnWithPendingTool("t1");
    state = reduce(state, send("steer me", "s1")).state;
    state = applyAll(state, [TOOL_RESULT, lifecycle("s1", "started")]).state;

    const done = applyAll(state, finishTurn("m1", "done"));
    expect(userMessageFrames(done.effects)).toEqual([]);
    expect(done.state.phase).toBe("idle");
    expect(done.state.queuedSends.length).toBe(0);
    const committed = committedMessages(done.effects);
    expect(committed.map((m) => m.kind)).toEqual(["user_message", "tool_use", "user_message", "assistant_text"]);
    expect(committed[2].messageKey).toBe("s1-user");
  });

  test("a message claude has not taken in by the turn's end is never flushed; its follow-on opens from it", () => {
    const { state: opened } = applyAll(fresh(), [
      send("go", "t1"),
      { type: "content_block_start", msg_id: "m1", block_index: 0, kind: "text" },
      { type: "assistant_text", msg_id: "m1", block_index: 0, text: "h", is_partial: true, seq: 0, rev: 0, status: "partial" },
      { type: "assistant_text", msg_id: "m1", block_index: 0, text: "hi", is_partial: true, seq: 0, rev: 0, status: "partial" },
    ]);
    expect(opened.phase).toBe("streaming");
    let state = reduce(opened, send("next", "s1")).state;

    const complete = reduce(state, { type: "turn_complete", msg_id: "m1", result: "success", seq: 0 });
    state = complete.state;
    expect(userMessageFrames(complete.effects)).toEqual([]);
    expect(state.phase).toBe("idle");
    expect(state.queuedSends.map((q) => [q.turnKey, q.sent])).toEqual([["s1", true]]);

    // claude starts it with no turn open: the row waits for the follow-on.
    state = reduce(state, lifecycle("s1", "started")).state;
    expect(state.queuedSends.length).toBe(1);
    const follow = reduce(state, { type: "follow_on_started", submissionId: "s1", text: "next", atoms: [], turnKey: "minted" });
    state = follow.state;
    expect(userMessageFrames(follow.effects)).toEqual([]);
    expect(state.phase).toBe("submitting");
    expect(state.queuedSends.length).toBe(0);
    const msgs = state.scratch.get(state.pendingTurn!.turnKey)!.messages;
    expect(msgs[msgs.length - 1].messageKey).toBe("s1-user");
  });

  test("a submit at idle behind a message claude still holds waits behind it", () => {
    let state = openTurnWithPendingTool("t1");
    state = reduce(state, send("first", "s1")).state;
    state = applyAll(state, [TOOL_RESULT, ...finishTurn("m1", "done")]).state;
    expect(state.phase).toBe("idle");

    const behind = reduce(state, send("second", "s2"));
    expect(userMessageFrames(behind.effects)).toEqual(["second"]);
    expect(behind.state.phase).toBe("idle");
    expect(behind.state.pendingTurn).toBeNull();
    expect(behind.state.queuedSends.map((q) => [q.turnKey, q.sent])).toEqual([
      ["s1", true],
      ["s2", true],
    ]);
  });

  test("several messages land in the order they were sent", () => {
    const { state: opened } = applyAll(fresh(), [
      send("go", "t1"),
      { type: "content_block_start", msg_id: "m1", block_index: 0, kind: "tool_use", tool_use_id: "tu1", tool_name: "Bash" },
      { type: "tool_use", msg_id: "m1", tool_use_id: "tu1", tool_name: "Bash", input: {}, seq: 0 },
    ]);
    const sent = applyAll(opened, [send("first steer", "s1"), send("second steer", "s2")]);
    expect(userMessageFrames(sent.effects)).toEqual(["first steer", "second steer"]);

    const { state } = applyAll(sent.state, [TOOL_RESULT, lifecycle("s1", "started"), lifecycle("s2", "started")]);
    expect(state.queuedSends.length).toBe(0);
    const userKeys = state.scratch
      .get("t1")!
      .messages.filter((m) => m.kind === "user_message")
      .map((m) => m.messageKey);
    expect(userKeys).toEqual(["t1-user", "s1-user", "s2-user"]);
  });

  test("a wake turn takes a mid-turn submit at once", () => {
    const wake: CodeSessionEvent = {
      type: "wake_started",
      wake_trigger: { task_id: "job", tool_use_id: "", status: "completed", summary: "done", output_file: "" },
      turnKey: "w1",
    };
    let state = reduce(fresh(), wake).state;
    expect(state.phase).toBe("waking");
    const sent = reduce(state, send("while it wakes", "s1"));
    expect(userMessageFrames(sent.effects)).toEqual(["while it wakes"]);
    state = reduce(sent.state, lifecycle("s1", "started")).state;
    expect(state.scratch.get("w1")!.messages.map((m) => m.messageKey)).toEqual(["w1-sys0", "s1-user"]);
  });

  test("a message claude will not act on leaves the queue and offers its words back", () => {
    for (const outcome of ["cancelled", "discarded", "refused"] as const) {
      let state = openTurnWithPendingTool("t1");
      state = reduce(state, send("steer me", "s1")).state;
      const r = reduce(state, lifecycle("s1", outcome));
      expect(userMessageFrames(r.effects)).toEqual([]);
      expect(r.state.queuedSends.length).toBe(0);
      expect(r.state.pendingDraftRestore?.text).toBe("steer me");
    }
  });

  test("removing a waiting row asks claude for it back, once, and sends no second copy", () => {
    let state = openTurnWithPendingTool("t1");
    state = reduce(state, send("steer me", "s1")).state;
    const cancel = reduce(state, { type: "cancel_queued_send", turnKey: "s1" });
    expect(userMessageFrames(cancel.effects)).toEqual([]);
    expect(withdrawals(cancel.effects)).toEqual(["s1"]);
    // claude holds it until it answers, so the row stays, marked.
    expect(cancel.state.queuedSends.map((q) => q.withdrawing)).toEqual([true]);
    expect(cancel.state.pendingDraftRestore).toBeNull();
    const again = reduce(cancel.state, { type: "cancel_queued_send", turnKey: "s1" });
    expect(again.effects).toEqual([]);
  });

  test("a withdrawn message leaves the queue, offers its words back, and sends nothing the model acts on", () => {
    let state = openTurnWithPendingTool("t1");
    state = reduce(state, send("steer me", "s1")).state;
    state = reduce(state, { type: "cancel_queued_send", turnKey: "s1" }).state;
    const withdrawn = reduce(state, lifecycle("s1", "cancelled"));
    expect(withdrawn.state.queuedSends.length).toBe(0);
    expect(withdrawn.state.pendingDraftRestore?.text).toBe("steer me");
    const done = applyAll(withdrawn.state, [TOOL_RESULT, ...finishTurn("m1", "done")]);
    expect(userMessageFrames(done.effects)).toEqual([]);
    expect(done.state.phase).toBe("idle");
    expect(done.state.pendingTurn).toBeNull();
    expect(committedMessages(done.effects).some((m) => m.kind === "user_message" && m.text === "steer me")).toBe(false);
  });

  test("a message claude had already taken in when it was asked back is seated where it was", () => {
    let state = openTurnWithPendingTool("t1");
    state = reduce(state, send("steer me", "s1")).state;
    state = reduce(state, { type: "cancel_queued_send", turnKey: "s1" }).state;
    state = reduce(state, lifecycle("s1", "started")).state;
    expect(state.queuedSends.length).toBe(0);
    expect(state.scratch.get("t1")!.messages.map((m) => m.messageKey)).toContain("s1-user");
    expect(state.pendingDraftRestore).toBeNull();
  });

  test("Stop takes waiting messages back newest first, then interrupts the turn", () => {
    let state = openTurnWithPendingTool("t1");
    state = applyAll(state, [send("steer me", "s1"), send("and again", "s2")]).state;
    const first = reduce(state, { type: "pop_interactive" });
    expect(withdrawals(first.effects)).toEqual(["s2"]);
    const second = reduce(first.state, { type: "pop_interactive" });
    expect(withdrawals(second.effects)).toEqual(["s1"]);
    const third = reduce(second.state, { type: "pop_interactive" });
    expect(sendFrames(third.effects).map((f) => f.msg.type)).toEqual(["interrupt"]);
    expect(userMessageFrames([...first.effects, ...second.effects, ...third.effects])).toEqual([]);
  });

  test("an interrupt asks claude for every waiting message back ahead of the stop", () => {
    let state = openTurnWithPendingTool("t1");
    state = applyAll(state, [send("steer me", "s1"), send("and again", "s2")]).state;
    const interrupted = reduce(state, { type: "interrupt_action" });
    expect(userMessageFrames(interrupted.effects)).toEqual([]);
    expect(sendFrames(interrupted.effects).map((f) => f.msg.type)).toEqual([
      "cancel_async_message",
      "cancel_async_message",
      "interrupt",
    ]);
    expect(interrupted.state.queuedSends.map((q) => q.withdrawing)).toEqual([true, true]);
  });

  test("a message asked back when claude is ended is not given to the next claude", () => {
    let state = openTurnWithPendingTool("t1");
    state = applyAll(state, [send("steer me", "s1"), { type: "cancel_queued_send", turnKey: "s1" }]).state;
    const ended = reduce(state, { type: "turn_cancelled", msg_id: "m1", seq: 0, partial_result: "" } as CodeSessionEvent);
    expect(userMessageFrames(ended.effects)).toEqual([]);
    expect(ended.state.queuedSends.length).toBe(0);
    expect(ended.state.pendingDraftRestore?.text).toBe("steer me");
  });

  test("a submit that must wait off the wire still flushes at the turn's end", () => {
    let state = openTurnWithPendingTool("t1");
    const parked = reduce(state, { ...send("handed over", "s1"), queueOnly: true } as CodeSessionEvent);
    state = parked.state;
    expect(userMessageFrames(parked.effects)).toEqual([]);
    expect(state.queuedSends.map((q) => q.sent)).toEqual([undefined]);

    const done = applyAll(state, [TOOL_RESULT, ...finishTurn("m1", "done")]);
    expect(userMessageFrames(done.effects)).toEqual(["handed over"]);
    expect(done.state.pendingTurn?.turnKey).toBe("s1");
  });
});

describe("mid-turn steering — reload-authoritative placement (JSONL replay)", () => {
  function addUserMessage(turnKey: string, text: string, submissionId?: string): CodeSessionEvent {
    return { type: "add_user_message", turnKey, text, atoms: [], ...(submissionId !== undefined ? { submissionId } : {}) };
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

  test("a submission the bracket carries twice renders once", () => {
    // A catch-up during a turn: the journal's never-drop synthetic of a
    // pending row, then the JSONL's own record of the same submission —
    // here, the message claude absorbed mid-turn. One submission, one row.
    const { state } = applyAll(fresh(), [
      { type: "replay_started" },
      addUserMessage("t1", "opener", "sub-opener"),
      { type: "content_block_start", msg_id: "m1", block_index: 0, kind: "tool_use", tool_use_id: "tu1", tool_name: "Bash" },
      { type: "tool_use", msg_id: "m1", tool_use_id: "tu1", tool_name: "Bash", input: {}, seq: 0 },
      { type: "tool_result", tool_use_id: "tu1", output: "ok", is_error: false },
      addUserMessage("s1", "steered", "sub-steer"),
      addUserMessage("s2", "steered", "sub-steer"),
      // A different submission with the same words is its own row.
      addUserMessage("s3", "steered", "sub-again"),
    ]);

    const users = state.scratch
      .get("t1")!
      .messages.filter((m): m is UserMessage => m.kind === "user_message");
    expect(users.map((m) => m.submissionId)).toEqual(["sub-opener", "sub-steer", "sub-again"]);
    expect(users.map((m) => m.messageKey)).toEqual(["t1-user", "s1-user", "s3-user"]);
  });
});

describe("mid-turn steering — the submission id", () => {
  function submissionIds(effects: ReadonlyArray<Effect>): unknown[] {
    return sendFrames(effects)
      .filter((f) => (f.msg as { type?: string }).type === "user_message")
      .map((f) => (f.msg as { submission_id?: unknown }).submission_id);
  }

  test("every send carries its turnKey as the submission id, and the message keeps it", () => {
    // The opener, sent at once.
    const opened = reduce(fresh(), send("go", "t1"));
    expect(submissionIds(opened.effects)).toEqual(["t1"]);
    const opener = opened.state.scratch.get("t1")!.messages[0] as UserMessage;
    expect(opener.submissionId).toBe("t1");

    // A mid-turn message, sent at Return and seated when claude takes it in.
    let state = openTurnWithPendingTool("t2");
    const steer = reduce(state, send("steer me", "s1"));
    expect(submissionIds(steer.effects)).toEqual(["s1"]);
    const seated = applyAll(steer.state, [TOOL_RESULT, lifecycle("s1", "started")]);
    const t2Messages = seated.state.scratch.get("t2")!.messages;
    const steered = t2Messages[t2Messages.length - 1] as UserMessage;
    expect(steered.submissionId).toBe("s1");

    // A message held off the wire, sent at the turn's end.
    state = reduce(seated.state, { ...send("after", "s2"), queueOnly: true } as CodeSessionEvent).state;
    const flushed = reduce(state, { type: "turn_complete", msg_id: "m1", result: "success", seq: 0 });
    expect(submissionIds(flushed.effects)).toEqual(["s2"]);
    const queued = flushed.state.scratch.get("s2")!.messages[0] as UserMessage;
    expect(queued.submissionId).toBe("s2");
  });
});

describe("a waiting message across a reconnect — never sent twice, never stranded", () => {
  /** The queue a card holds when a message waits at claude mid-turn. */
  function waitingQueue(): CodeSessionState["queuedSends"] {
    let state = openTurnWithPendingTool("t1");
    state = reduce(state, send("steer me", "s1")).state;
    expect(state.queuedSends.map((q) => q.sent)).toEqual([true]);
    return state.queuedSends;
  }

  /** A fresh store, seeded the way a reconnect hands its queue over, with its bracket open. */
  function seededAndReplaying(): CodeSessionState {
    const seeded = reduce(fresh(), { type: "seed_queued_sends", sends: waitingQueue() });
    expect(seeded.state.queuedSends.map((q) => q.sent)).toEqual([true]);
    expect(userMessageFrames(seeded.effects)).toEqual([]);
    return reduce(seeded.state, { type: "replay_started" } as CodeSessionEvent).state;
  }

  const REPLAY_COMPLETE = { type: "replay_complete", count: 1 } as CodeSessionEvent;

  test("a bracket that draws the message takes the waiting row out, and nothing is sent again", () => {
    const state = seededAndReplaying();
    const closed = applyAll(state, [
      { type: "add_user_message", text: "go", atoms: [], turnKey: "r1", submissionId: "t1" } as CodeSessionEvent,
      { type: "add_user_message", text: "steer me", atoms: [], turnKey: "r2", submissionId: "s1" } as CodeSessionEvent,
      { type: "turn_complete", msg_id: "m1", result: "success", seq: 0 },
      REPLAY_COMPLETE,
    ]);
    expect(userMessageFrames(closed.effects)).toEqual([]);
    expect(closed.state.queuedSends).toEqual([]);
    expect(closed.state.phase).toBe("idle");
  });

  test("claude's report during the bracket settles the row, and nothing is sent again", () => {
    const state = seededAndReplaying();
    const closed = applyAll(state, [lifecycle("s1", "started"), REPLAY_COMPLETE]);
    expect(userMessageFrames(closed.effects)).toEqual([]);
    expect(closed.state.queuedSends).toEqual([]);
    expect(closed.state.pendingDraftRestore).toBeNull();
  });

  test("a message claude will not run, reported during the bracket, offers its words back", () => {
    const state = seededAndReplaying();
    const closed = applyAll(state, [lifecycle("s1", "discarded"), REPLAY_COMPLETE]);
    expect(userMessageFrames(closed.effects)).toEqual([]);
    expect(closed.state.queuedSends).toEqual([]);
    expect(closed.state.pendingDraftRestore?.text).toBe("steer me");
  });

  test("a bracket that ends idle without the message gives it to the claude that is there, once", () => {
    const state = seededAndReplaying();
    const closed = reduce(state, REPLAY_COMPLETE);
    expect(userMessageFrames(closed.effects)).toEqual(["steer me"]);
    expect(closed.state.queuedSends).toEqual([]);
    expect(closed.state.phase).toBe("submitting");
  });

  test("a completed whose started was lost seats the message in the open turn", () => {
    let state = openTurnWithPendingTool("t1");
    state = reduce(state, send("steer me", "s1")).state;
    const done = applyAll(state, [TOOL_RESULT, lifecycle("s1", "completed")]);
    expect(done.state.queuedSends).toEqual([]);
    const msgs = done.state.scratch.get("t1")!.messages;
    expect(msgs[msgs.length - 1].messageKey).toBe("s1-user");
  });
});
