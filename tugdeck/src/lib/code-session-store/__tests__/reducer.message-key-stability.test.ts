/**
 * reducer.message-key-stability.test.ts — pin [D07]'s React-identity
 * invariant: `messageKey` is byte-identical for the same Message
 * across the inflight → committed transition. The per-Message
 * analogue of `TurnEntry.turnKey`'s stability test.
 *
 * The substrate writes per-Message PropertyStore paths keyed by
 * `messageKey`; if the key shifted at commit, [L26] would break and
 * the cell wrapper's child subscriptions would tear down (the same
 * scroll-jump regression `turnKey` was introduced to prevent, but at
 * the Message level).
 */

import { describe, expect, test } from "bun:test";

import {
  deriveActiveTurnSnapshot,
  reduce,
  createInitialState,
  type CodeSessionState,
} from "@/lib/code-session-store/reducer";
import type { Effect, AppendTranscriptEffect } from "@/lib/code-session-store/effects";
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

describe("[D07] messageKey stability across inflight → committed", () => {
  test("user_message: same key on the active snapshot and the committed TurnEntry", () => {
    const turnKey = "stable-1";
    const r1 = reduce(fresh(), { type: "send", text: "hi", atoms: [], content: [{ type: "text" as const, text: "hi" }], turnKey });
    const active = deriveActiveTurnSnapshot(r1.state)!;
    const activeUserKey = active.messages[0].messageKey;

    // Drive through a complete turn.
    const { effects } = applyAll(r1.state, [
      {
        type: "content_block_start",
        msg_id: "m",
        block_index: 0,
        kind: "text",
      },
      {
        type: "assistant_text",
        msg_id: "m",
        block_index: 0,
        text: "ok",
        is_partial: false,
        seq: 0,
        rev: 0,
        status: "complete",
      },
      { type: "turn_complete", msg_id: "m", result: "success", seq: 0 },
    ]);
    const committed = effects.find(
      (e): e is AppendTranscriptEffect => e.kind === "append-transcript",
    )!.entry;
    const committedUserKey = committed.messages[0].messageKey;

    expect(committedUserKey).toBe(activeUserKey);
  });

  test("assistant_text: messageKey from content_block_start carries through every delta + commit", () => {
    const turnKey = "stable-2";
    const r0 = reduce(fresh(), { type: "send", text: "x", atoms: [], content: [{ type: "text" as const, text: "x" }], turnKey });
    // First, mint the block.
    const r1 = reduce(r0.state, {
      type: "content_block_start",
      msg_id: "m1",
      block_index: 0,
      kind: "text",
    });
    const minted = deriveActiveTurnSnapshot(r1.state)!
      .messages.find((m) => m.kind === "assistant_text");
    expect(minted).toBeDefined();
    const mintedKey = minted!.messageKey;

    // Stream three deltas; messageKey should not change.
    let cur = r1.state;
    for (const piece of ["hel", "lo ", "wo"]) {
      cur = reduce(cur, {
        type: "assistant_text",
        msg_id: "m1",
        block_index: 0,
        text: piece,
        is_partial: true,
        seq: 0,
        rev: 0,
        status: "partial",
      }).state;
      const m = deriveActiveTurnSnapshot(cur)!
        .messages.find((mm) => mm.kind === "assistant_text");
      expect(m?.messageKey).toBe(mintedKey);
    }

    // Commit; key still identical on the TurnEntry.
    const { effects } = applyAll(cur, [
      { type: "turn_complete", msg_id: "m1", result: "success", seq: 0 },
    ]);
    const committed = effects.find(
      (e): e is AppendTranscriptEffect => e.kind === "append-transcript",
    )!.entry;
    const committedKey = committed.messages
      .find((m) => m.kind === "assistant_text")
      ?.messageKey;
    expect(committedKey).toBe(mintedKey);
  });

  test("tool_use: messageKey from content_block_start carries through input fill + result + commit", () => {
    const turnKey = "stable-3";
    const r0 = reduce(fresh(), {
      type: "send",
      text: "use tool",
      atoms: [],
      content: [{ type: "text" as const, text: "use tool" }],
      turnKey,
    });
    const r1 = reduce(r0.state, {
      type: "content_block_start",
      msg_id: "m1",
      block_index: 0,
      kind: "tool_use",
      tool_use_id: "tu1",
      tool_name: "Bash",
    });
    const minted = deriveActiveTurnSnapshot(r1.state)!
      .messages.find((m) => m.kind === "tool_use");
    expect(minted).toBeDefined();
    const mintedKey = minted!.messageKey;

    const { state, effects } = applyAll(r1.state, [
      {
        type: "tool_use",
        msg_id: "m1",
        tool_use_id: "tu1",
        tool_name: "Bash",
        input: { command: "ls" },
        seq: 0,
      },
      { type: "tool_result", tool_use_id: "tu1", output: "files", is_error: false },
      { type: "turn_complete", msg_id: "m1", result: "success", seq: 0 },
    ]);
    // Sanity check (state lifecycle drains the in-flight cycle, so
    // deriveActiveTurnSnapshot returns null after commit — the key
    // is preserved on the committed entry below).
    expect(deriveActiveTurnSnapshot(state)).toBeNull();
    const committed = effects.find(
      (e): e is AppendTranscriptEffect => e.kind === "append-transcript",
    )!.entry;
    const committedKey = committed.messages
      .find((m) => m.kind === "tool_use")
      ?.messageKey;
    expect(committedKey).toBe(mintedKey);
  });
});
