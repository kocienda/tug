/**
 * reducer.message-sequence.test.ts — pin the [D07] substrate's three
 * load-bearing contracts against synthesized event sequences:
 *
 *   1. **Block boundary correctness** — content_block_start{idx:0, kind:text}
 *      → text deltas → content_block_start{idx:1, kind:tool_use} →
 *      tool_use produces a `messages` array of `[AssistantText,
 *      ToolUseMessage]` in that order.
 *   2. **Multi-msgId concatenation** — events for two msg_ids within
 *      one turn commit a single TurnEntry whose `messages` array
 *      spans BOTH msgIds. This is the correctness improvement over
 *      today's substrate, which dropped intermediate iterations.
 *   3. **Interleaved thinking** — thinking(block 0) + text(block 1)
 *      in one message commit as two distinct Messages in arrival
 *      order, neither merged nor reordered.
 *
 * These three invariants are what the substrate change exists to
 * deliver. A regression to any one of them is what makes the change
 * not actually work.
 */

import { describe, expect, test } from "bun:test";

import {
  reduce,
  createInitialState,
  type CodeSessionState,
} from "@/lib/code-session-store/reducer";
import type {
  AssistantText,
  AssistantThinking,
  Message,
  ToolUseMessage,
} from "@/lib/code-session-store/types";
import type { AppendTranscriptEffect, Effect } from "@/lib/code-session-store/effects";
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

function committedMessages(effects: ReadonlyArray<Effect>): ReadonlyArray<Message> {
  const append = effects.find(
    (e): e is AppendTranscriptEffect => e.kind === "append-transcript",
  );
  return append?.entry.messages ?? [];
}

describe("[D07] reducer message-sequence", () => {
  test("block boundary correctness: text → tool_use → text yields [text, tool, text]", () => {
    const turnKey = "t1";
    const msgId = "msg1";
    const { effects } = applyAll(fresh(), [
      { type: "send", text: "hi", atoms: [], content: [{ type: "text" as const, text: "hi" }], turnKey },
      {
        type: "content_block_start",
        msg_id: msgId,
        block_index: 0,
        kind: "text",
      },
      {
        type: "assistant_text",
        msg_id: msgId,
        block_index: 0,
        text: "Working",
        is_partial: false,
        seq: 0,
        rev: 0,
        status: "complete",
      },
      {
        type: "content_block_start",
        msg_id: msgId,
        block_index: 1,
        kind: "tool_use",
        tool_use_id: "tu1",
        tool_name: "Bash",
      },
      {
        type: "tool_use",
        msg_id: msgId,
        tool_use_id: "tu1",
        tool_name: "Bash",
        input: { command: "ls" },
        seq: 0,
      },
      {
        type: "tool_result",
        tool_use_id: "tu1",
        output: "file1\nfile2",
        is_error: false,
      },
      {
        type: "content_block_start",
        msg_id: msgId,
        block_index: 2,
        kind: "text",
      },
      {
        type: "assistant_text",
        msg_id: msgId,
        block_index: 2,
        text: "Done.",
        is_partial: false,
        seq: 0,
        rev: 0,
        status: "complete",
      },
      { type: "turn_complete", msg_id: msgId, result: "success", seq: 0 },
    ]);

    const messages = committedMessages(effects);
    // [user_message, AssistantText("Working"), ToolUseMessage(Bash done), AssistantText("Done.")]
    expect(messages).toHaveLength(4);
    expect(messages[0].kind).toBe("user_message");
    expect(messages[1].kind).toBe("assistant_text");
    expect((messages[1] as AssistantText).text).toBe("Working");
    expect(messages[2].kind).toBe("tool_use");
    expect((messages[2] as ToolUseMessage).toolUseId).toBe("tu1");
    expect((messages[2] as ToolUseMessage).status).toBe("done");
    expect(messages[3].kind).toBe("assistant_text");
    expect((messages[3] as AssistantText).text).toBe("Done.");
  });

  test("multi-msgId concatenation: events across two msg_ids commit one TurnEntry whose messages span both", () => {
    const turnKey = "t2";
    const { effects } = applyAll(fresh(), [
      { type: "send", text: "tool loop", atoms: [], content: [{ type: "text" as const, text: "tool loop" }], turnKey },
      // First msgId iteration
      {
        type: "content_block_start",
        msg_id: "msgA",
        block_index: 0,
        kind: "thinking",
      },
      {
        type: "thinking_text",
        msg_id: "msgA",
        block_index: 0,
        text: "thinking",
        is_partial: false,
        seq: 0,
        status: "complete",
      },
      {
        type: "content_block_start",
        msg_id: "msgA",
        block_index: 1,
        kind: "tool_use",
        tool_use_id: "tuA",
        tool_name: "Read",
      },
      {
        type: "tool_use",
        msg_id: "msgA",
        tool_use_id: "tuA",
        tool_name: "Read",
        input: { path: "/x" },
        seq: 0,
      },
      { type: "tool_result", tool_use_id: "tuA", output: "data", is_error: false },
      // Second msgId iteration
      {
        type: "content_block_start",
        msg_id: "msgB",
        block_index: 0,
        kind: "text",
      },
      {
        type: "assistant_text",
        msg_id: "msgB",
        block_index: 0,
        text: "The answer.",
        is_partial: false,
        seq: 0,
        rev: 0,
        status: "complete",
      },
      { type: "turn_complete", msg_id: "msgB", result: "success", seq: 0 },
    ]);
    const messages = committedMessages(effects);
    // [user_message, thinking(msgA), tool_use(msgA), assistant_text(msgB)]
    expect(messages).toHaveLength(4);
    expect(messages[0].kind).toBe("user_message");
    expect(messages[1].kind).toBe("assistant_thinking");
    expect((messages[1] as AssistantThinking).text).toBe("thinking");
    expect(messages[2].kind).toBe("tool_use");
    expect((messages[2] as ToolUseMessage).toolUseId).toBe("tuA");
    expect(messages[3].kind).toBe("assistant_text");
    expect((messages[3] as AssistantText).text).toBe("The answer.");
  });

  test("interleaved thinking: thinking(idx 0) + text(idx 1) commits as two distinct Messages in arrival order", () => {
    const turnKey = "t3";
    const msgId = "msg3";
    const { effects } = applyAll(fresh(), [
      { type: "send", text: "interleave", atoms: [], content: [{ type: "text" as const, text: "interleave" }], turnKey },
      {
        type: "content_block_start",
        msg_id: msgId,
        block_index: 0,
        kind: "thinking",
      },
      {
        type: "thinking_text",
        msg_id: msgId,
        block_index: 0,
        text: "pondering",
        is_partial: false,
        seq: 0,
        status: "complete",
      },
      {
        type: "content_block_start",
        msg_id: msgId,
        block_index: 1,
        kind: "text",
      },
      {
        type: "assistant_text",
        msg_id: msgId,
        block_index: 1,
        text: "answer",
        is_partial: false,
        seq: 0,
        rev: 0,
        status: "complete",
      },
      { type: "turn_complete", msg_id: msgId, result: "success", seq: 0 },
    ]);
    const messages = committedMessages(effects);
    expect(messages).toHaveLength(3);
    expect(messages[0].kind).toBe("user_message");
    // Order preserved: thinking before text, not merged
    expect(messages[1].kind).toBe("assistant_thinking");
    expect(messages[2].kind).toBe("assistant_text");
  });
});
