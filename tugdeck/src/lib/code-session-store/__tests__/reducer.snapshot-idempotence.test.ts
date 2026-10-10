/**
 * reducer.snapshot-idempotence.test.ts — pin [D07]'s replay-snapshot
 * safety invariant: `handleContentBlockStart` is a no-op when
 * `(msg_id, block_index)` is already present in the active turn's
 * `blockIndex`. This is the contract that makes Option 4 (replay
 * the full stream on mid-turn snapshot) safe: tugcode re-emits
 * `content_block_start` for every Message in the active turn,
 * regardless of whether the live path already minted it — the
 * reducer's idempotence ensures the second emission produces no
 * duplicate.
 *
 * Without this contract, a Maker > Reload mid-stream would
 * double-mint every Message, and the user would see the in-flight
 * content twice.
 */

import { describe, expect, test } from "bun:test";

import {
  deriveActiveTurnSnapshot,
  reduce,
  createInitialState,
  type CodeSessionState,
} from "@/lib/code-session-store/reducer";

function fresh(): CodeSessionState {
  return createInitialState("session", "test", "new");
}

describe("[D07] handleContentBlockStart idempotence", () => {
  test("re-emitting content_block_start for an already-minted (msg_id, block_index) is a state-ref-stable no-op", () => {
    const turnKey = "idem-1";
    const r0 = reduce(fresh(), { type: "send", text: "x", atoms: [], content: [{ type: "text" as const, text: "x" }], turnKey });
    const r1 = reduce(r0.state, {
      type: "content_block_start",
      msg_id: "m1",
      block_index: 0,
      kind: "text",
    });
    // First snapshot identity
    const firstActive = deriveActiveTurnSnapshot(r1.state)!;
    expect(firstActive.messages).toHaveLength(2); // user_message + text
    const firstStateRef = r1.state;

    // Re-emit the same content_block_start (the snapshot replay path).
    const r2 = reduce(r1.state, {
      type: "content_block_start",
      msg_id: "m1",
      block_index: 0,
      kind: "text",
    });
    expect(r2.state).toBe(firstStateRef);
    expect(r2.effects).toHaveLength(0);

    const secondActive = deriveActiveTurnSnapshot(r2.state)!;
    expect(secondActive.messages).toHaveLength(2);
  });

  test("re-emit of content_block_start for tool_use is idempotent (same toolCallIndex too)", () => {
    const turnKey = "idem-2";
    const r0 = reduce(fresh(), { type: "send", text: "x", atoms: [], content: [{ type: "text" as const, text: "x" }], turnKey });
    const r1 = reduce(r0.state, {
      type: "content_block_start",
      msg_id: "m1",
      block_index: 0,
      kind: "tool_use",
      tool_use_id: "tu1",
      tool_name: "Bash",
    });
    const minted = deriveActiveTurnSnapshot(r1.state)!.messages.find(
      (m) => m.kind === "tool_use",
    );
    expect(minted).toBeDefined();

    const r2 = reduce(r1.state, {
      type: "content_block_start",
      msg_id: "m1",
      block_index: 0,
      kind: "tool_use",
      tool_use_id: "tu1",
      tool_name: "Bash",
    });
    expect(r2.state).toBe(r1.state);
    const messagesAfter = deriveActiveTurnSnapshot(r2.state)!.messages;
    expect(messagesAfter.filter((m) => m.kind === "tool_use")).toHaveLength(1);
  });

  test("subsequent text delta after a re-emitted content_block_start still mutates the existing Message (no duplicate)", () => {
    const turnKey = "idem-3";
    const r0 = reduce(fresh(), { type: "send", text: "x", atoms: [], content: [{ type: "text" as const, text: "x" }], turnKey });
    const r1 = reduce(r0.state, {
      type: "content_block_start",
      msg_id: "m1",
      block_index: 0,
      kind: "text",
    });
    const r2 = reduce(r1.state, {
      type: "assistant_text",
      msg_id: "m1",
      block_index: 0,
      text: "hello",
      is_partial: true,
      seq: 0,
      rev: 0,
      status: "partial",
    });
    // Replay-style re-emit of the open envelope.
    const r3 = reduce(r2.state, {
      type: "content_block_start",
      msg_id: "m1",
      block_index: 0,
      kind: "text",
    });
    // Then another delta; should append to the same Message.
    const r4 = reduce(r3.state, {
      type: "assistant_text",
      msg_id: "m1",
      block_index: 0,
      text: " world",
      is_partial: true,
      seq: 0,
      rev: 0,
      status: "partial",
    });
    const messages = deriveActiveTurnSnapshot(r4.state)!.messages;
    const texts = messages.filter((m) => m.kind === "assistant_text");
    expect(texts).toHaveLength(1);
    expect((texts[0] as { text: string }).text).toBe("hello world");
  });
});
