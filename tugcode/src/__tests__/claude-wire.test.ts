/**
 * `claude-wire.ts`: the one declaration of Claude's stream-json wire.
 *
 * The runtime half pins {@link isClaudeWireMessage}'s narrowing — a member
 * is recognised by its discriminants, a line whose discriminants the union
 * does not declare is not. The compile-time half pins that the union is
 * built from types that actually resolved: every `@ts-expect-error` below
 * fails `bun run check` if the SDK's types ever degrade to `any`, because
 * an `any`-built union accepts everything and the expected error vanishes.
 */

import { describe, expect, test } from "bun:test";

import {
  type ClaudeWireMessage,
  type WireAssistant,
  type WireStreamEvent,
  isClaudeWireMessage,
  wireKindOf,
} from "../claude-wire.ts";

describe("isClaudeWireMessage", () => {
  test("recognises a member by its top-level type", () => {
    expect(isClaudeWireMessage({ type: "assistant", message: {}, session_id: "s" })).toBe(true);
    expect(isClaudeWireMessage({ type: "user", message: {} })).toBe(true);
    expect(isClaudeWireMessage({ type: "keep_alive" })).toBe(true);
    expect(isClaudeWireMessage({ type: "ai-title", aiTitle: "Fix the drain" })).toBe(true);
    expect(isClaudeWireMessage({ type: "control_response", response: {} })).toBe(true);
  });

  test("recognises system and result members by subtype, including the ones the SDK does not list", () => {
    expect(isClaudeWireMessage({ type: "system", subtype: "init" })).toBe(true);
    expect(isClaudeWireMessage({ type: "system", subtype: "thinking_tokens" })).toBe(true);
    expect(isClaudeWireMessage({ type: "system", subtype: "background_tasks_changed" })).toBe(true);
    expect(isClaudeWireMessage({ type: "result", subtype: "error_during_execution" })).toBe(true);
  });

  test("recognises a stream_event by its event.type", () => {
    expect(
      isClaudeWireMessage({ type: "stream_event", event: { type: "content_block_delta" } }),
    ).toBe(true);
  });

  test("refuses what the union does not declare", () => {
    expect(isClaudeWireMessage({ type: "assistant_v2" })).toBe(false);
    expect(isClaudeWireMessage({ type: "system", subtype: "brand_new" })).toBe(false);
    expect(isClaudeWireMessage({ type: "system" })).toBe(false);
    expect(isClaudeWireMessage({ type: "result", subtype: "partial" })).toBe(false);
    expect(isClaudeWireMessage({ type: "stream_event", event: { type: "ping_v2" } })).toBe(false);
    expect(isClaudeWireMessage({ type: "stream_event" })).toBe(false);
    expect(isClaudeWireMessage({ type: "toString" })).toBe(false);
    expect(isClaudeWireMessage(null)).toBe(false);
    expect(isClaudeWireMessage([{ type: "assistant" }])).toBe(false);
    expect(isClaudeWireMessage("assistant")).toBe(false);
  });
});

describe("wireKindOf", () => {
  test("labels a line by its discriminants", () => {
    expect(wireKindOf({ type: "system", subtype: "init" })).toBe("system/init");
    expect(wireKindOf({ type: "stream_event", event: { type: "message_stop" } })).toBe(
      "stream_event/message_stop",
    );
    expect(wireKindOf({ type: "assistant" })).toBe("assistant");
    expect(wireKindOf({ subtype: "init" })).toBe("<untyped>");
    expect(wireKindOf(42)).toBe("<untyped>");
  });
});

describe("the union's types", () => {
  test("narrow by discriminant to the declared fields, and stay open to the rest", () => {
    const line: unknown = {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      parent_tool_use_id: null,
      uuid: "u",
      session_id: "s",
      ttft_ms_v2: 3,
    };
    if (!isClaudeWireMessage(line) || line.type !== "stream_event") {
      throw new Error("expected a stream_event");
    }
    const event: WireStreamEvent = line;
    if (event.event.type === "content_block_delta" && event.event.delta.type === "text_delta") {
      const text: string = event.event.delta.text;
      expect(text).toBe("hi");
    }
    // An undeclared field reads as `unknown`, never as a compile error.
    const extra: unknown = event.ttft_ms_v2;
    expect(extra).toBe(3);
  });

  test("refuse a discriminant the union does not declare", () => {
    // @ts-expect-error — not a member's `type`.
    const bogusType: ClaudeWireMessage = { type: "assistant_v2" };
    // @ts-expect-error — `session_id` is a string on an assistant message.
    const bogusField: WireAssistant = { type: "assistant", session_id: 7 };
    expect([bogusType, bogusField]).toHaveLength(2);
  });
});
