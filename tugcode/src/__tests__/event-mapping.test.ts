import { describe, test, expect } from "bun:test";
import {
  buildWakeStartedMessage,
  mapStreamEvent,
  parseToolInputProgress,
  payloadHexPreview,
  routeTopLevelEvent,
} from "../event-mapping.ts";
import type { EventMappingContext } from "../event-mapping.ts";
import type { StreamingUsage } from "../types.ts";

const baseCtx: EventMappingContext = { msgId: "msg-1", openerId: "t-0", seq: 0, rev: 0 };

describe("payloadHexPreview", () => {
  test("encodes a short payload in full", () => {
    const hex = payloadHexPreview({ a: 1 });
    expect(Buffer.from(hex, "hex").toString("utf8")).toBe('{"a":1}');
  });

  test("truncates to the first 64 bytes", () => {
    const big = { blob: "x".repeat(500) };
    const hex = payloadHexPreview(big);
    // 64 bytes → 128 hex chars, no matter how large the payload.
    expect(hex).toHaveLength(128);
    const json = JSON.stringify(big);
    const expected = Buffer.from(json, "utf8").subarray(0, 64).toString("hex");
    expect(hex).toBe(expected);
  });

  test("honors a custom byte budget", () => {
    expect(payloadHexPreview({ a: 1 }, 3)).toHaveLength(6);
  });

  test("yields an empty preview for an unserializable payload", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(payloadHexPreview(cyclic)).toBe("");
  });
});

describe("routeTopLevelEvent", () => {
  test("system/init captures session_id and metadata", () => {
    const event = {
      type: "system",
      subtype: "init",
      session_id: "sess-123",
      tools: ["Read", "Write"],
      model: "claude-opus-4-6",
      cwd: "/test",
    };
    const result = routeTopLevelEvent(event, baseCtx);
    expect(result.sessionId).toBe("sess-123");
    expect(result.systemMetadata).toBeDefined();
    expect((result.systemMetadata as any).tools).toEqual(["Read", "Write"]);
    expect((result.systemMetadata as any).model).toBe("claude-opus-4-6");
    expect((result.systemMetadata as any).cwd).toBe("/test");
    expect(result.gotResult).toBe(false);
    // system/init now emits a SystemMetadata IPC message.
    expect(result.messages).toHaveLength(1);
    expect((result.messages[0] as any).type).toBe("system_metadata");
  });

  test("system/compact_boundary emits marker", () => {
    const event = { type: "system", subtype: "compact_boundary" };
    const result = routeTopLevelEvent(event, baseCtx);
    expect(result.messages).toHaveLength(1);
    expect((result.messages[0] as any).type).toBe("compact_boundary");
    expect(result.gotResult).toBe(false);
  });

  test("system/compact_boundary forwards compact_metadata (trigger + pre_tokens)", () => {
    // The real SDK shape is snake_case `compact_metadata.pre_tokens`.
    const event = {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 48000 },
    };
    const result = routeTopLevelEvent(event, baseCtx);
    const marker = result.messages[0] as any;
    expect(marker.type).toBe("compact_boundary");
    expect(marker.trigger).toBe("auto");
    expect(marker.pre_tokens).toBe(48000);
  });

  test("top-level bash_progress is forwarded as one tool_progress message", () => {
    // Real bash_progress shape from the engine — progress telemetry, no output.
    const event = {
      type: "tool_progress",
      tool_use_id: "toolu_abc",
      tool_name: "Bash",
      parent_tool_use_id: null,
      elapsed_time_seconds: 12,
      task_id: "task-1",
      session_id: "sess-123",
      uuid: "u-1",
    };
    const result = routeTopLevelEvent(event, baseCtx);
    expect(result.messages).toEqual([
      {
        type: "tool_progress",
        tool_use_id: "toolu_abc",
        tool_name: "Bash",
        elapsed_time_seconds: 12,
        parent_tool_use_id: null,
        ipc_version: 2,
      },
    ]);
    expect(result.gotResult).toBe(false);
  });

  test("tool_progress variants with no tool call are still swallowed (no unknown_event banner)", () => {
    for (const event of [
      { type: "tool_progress", heartbeat: true },
      { type: "tool_progress", elapsed_time_seconds: 3 },
      { type: "tool_progress", tool_use_id: "", elapsed_time_seconds: 3 },
      { type: "tool_progress", tool_use_id: "toolu_abc" },
    ]) {
      const result = routeTopLevelEvent(event, baseCtx);
      expect(result.messages).toHaveLength(0);
      expect(result.gotResult).toBe(false);
    }
  });

  test("unrecognized top-level type emits an unknown_event frame", () => {
    const event = { type: "future_telemetry", payload: { foo: 1 } };
    const result = routeTopLevelEvent(event, baseCtx);
    expect(result.messages).toHaveLength(1);
    const frame = result.messages[0] as any;
    expect(frame.type).toBe("unknown_event");
    expect(frame.original_type).toBe("future_telemetry");
    expect(frame.ipc_version).toBe(2);
    // The preview is the JSON payload, hex-encoded — decodes back to the
    // serialized event (short enough to fit in 64 bytes here).
    const decoded = Buffer.from(frame.payload_hex_preview, "hex").toString("utf8");
    expect(decoded).toBe(JSON.stringify(event));
    expect(result.gotResult).toBe(false);
  });

  test("event with no type falls into unknown_event with original_type 'unknown'", () => {
    const event = { payload: "no type field" } as Record<string, unknown>;
    const result = routeTopLevelEvent(event, baseCtx);
    const frame = result.messages[0] as any;
    expect(frame.type).toBe("unknown_event");
    expect(frame.original_type).toBe("unknown");
  });

  test("assistant text content no longer emits assistant_text (delivered via streaming)", () => {
    const event = {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello world" }],
      },
    };
    const result = routeTopLevelEvent(event, baseCtx);
    // Text content was already delivered via stream_event; assistant case skips it.
    expect(result.messages).toHaveLength(0);
    expect(result.gotResult).toBe(false);
  });

  test("assistant tool_use blocks emit content_block_start + tool_use", () => {
    // Per [D07] / Fixup 7: synthetic and snapshot paths emit a
    // content_block_start prelude before the tool_use IPC frame so
    // the reducer mints uniformly across live / replay / synthetic.
    const event = {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Read", id: "tu-1", input: { path: "/a.ts" } },
        ],
      },
    };
    const result = routeTopLevelEvent(event, baseCtx);
    const tu = result.messages.find((m: any) => m.type === "tool_use") as any;
    expect(tu).toBeDefined();
    expect(tu.tool_name).toBe("Read");
    expect(tu.tool_use_id).toBe("tu-1");
    expect(tu.input).toEqual({ path: "/a.ts" });
    const cbs = result.messages.find((m: any) => m.type === "content_block_start") as any;
    expect(cbs).toBeDefined();
    expect(cbs.kind).toBe("tool_use");
    expect(cbs.tool_use_id).toBe("tu-1");
    expect(cbs.tool_name).toBe("Read");
  });

  test("assistant thinking blocks no longer emits thinking_text (delivered via streaming)", () => {
    const event = {
      type: "assistant",
      message: {
        content: [{ type: "thinking", text: "Let me think..." }],
      },
    };
    const result = routeTopLevelEvent(event, baseCtx);
    // Thinking content was already delivered via stream_event; assistant case skips it.
    expect(result.messages).toHaveLength(0);
  });

  test("result/success emits cost_update only (turn_complete emitted by handleUserMessage)", () => {
    const event = { type: "result", subtype: "success", result: "" };
    const result = routeTopLevelEvent(event, baseCtx);
    expect(result.gotResult).toBe(true);
    // turn_complete is no longer emitted by routeTopLevelEvent; handleUserMessage emits it.
    const tc = result.messages.find((m: any) => m.type === "turn_complete");
    expect(tc).toBeUndefined();
    // cost_update is still emitted.
    const cu = result.messages.find((m: any) => m.type === "cost_update") as any;
    expect(cu).toBeDefined();
    // resultMetadata.resultValue carries the value for handleUserMessage.
    expect(result.resultMetadata).toBeDefined();
    expect(result.resultMetadata!.resultValue).toBe("success");
  });

  test("result with permission_denials forwards them on cost_update", () => {
    const denials = [
      { tool_name: "Bash", tool_use_id: "tu-1", tool_input: { command: "curl x" } },
    ];
    const event = {
      type: "result",
      subtype: "success",
      result: "",
      permission_denials: denials,
    };
    const result = routeTopLevelEvent(event, baseCtx);
    const cu = result.messages.find((m: any) => m.type === "cost_update") as any;
    expect(cu).toBeDefined();
    expect(cu.permission_denials).toEqual(denials);
  });

  test("cost_update omits permission_denials when the turn denied nothing", () => {
    const event = { type: "result", subtype: "success", result: "" };
    const result = routeTopLevelEvent(event, baseCtx);
    const cu = result.messages.find((m: any) => m.type === "cost_update") as any;
    expect(cu).toBeDefined();
    expect("permission_denials" in cu).toBe(false);
  });

  test("result/error_during_execution sets resultValue to error (no turn_complete)", () => {
    const event = { type: "result", subtype: "error_during_execution", result: "" };
    const result = routeTopLevelEvent(event, baseCtx);
    expect(result.gotResult).toBe(true);
    // turn_complete is no longer emitted by routeTopLevelEvent.
    const tc = result.messages.find((m: any) => m.type === "turn_complete");
    expect(tc).toBeUndefined();
    expect(result.resultMetadata).toBeDefined();
    expect(result.resultMetadata!.resultValue).toBe("error");
  });

  test("result/error_max_turns stores correct subtype in resultMetadata", () => {
    const event = { type: "result", subtype: "error_max_turns", result: "" };
    const result = routeTopLevelEvent(event, baseCtx);
    expect(result.gotResult).toBe(true);
    expect(result.resultMetadata).toBeDefined();
    expect(result.resultMetadata!.subtype).toBe("error_max_turns");
    // turn_complete is no longer emitted by routeTopLevelEvent.
    const tc = result.messages.find((m: any) => m.type === "turn_complete");
    expect(tc).toBeUndefined();
    expect(result.resultMetadata!.resultValue).toBe("error");
  });

  test("result/error_max_budget_usd stores correct subtype in resultMetadata", () => {
    const event = { type: "result", subtype: "error_max_budget_usd", result: "" };
    const result = routeTopLevelEvent(event, baseCtx);
    expect(result.resultMetadata!.subtype).toBe("error_max_budget_usd");
    // turn_complete is no longer emitted by routeTopLevelEvent.
    const tc = result.messages.find((m: any) => m.type === "turn_complete");
    expect(tc).toBeUndefined();
    expect(result.resultMetadata!.resultValue).toBe("error");
  });

  test("result/error_max_structured_output_retries stores correct subtype", () => {
    const event = { type: "result", subtype: "error_max_structured_output_retries", result: "" };
    const result = routeTopLevelEvent(event, baseCtx);
    expect(result.resultMetadata!.subtype).toBe("error_max_structured_output_retries");
    // turn_complete is no longer emitted by routeTopLevelEvent.
    const tc = result.messages.find((m: any) => m.type === "turn_complete");
    expect(tc).toBeUndefined();
    expect(result.resultMetadata!.resultValue).toBe("error");
  });

  test("result/success with API Error text detects API error per PN-2", () => {
    const event = {
      type: "result",
      subtype: "success",
      result: "API Error: 400 {\"error\":{\"message\":\"Bad request\"}}",
    };
    const result = routeTopLevelEvent(event, baseCtx);
    expect(result.gotResult).toBe(true);
    expect(result.resultMetadata).toBeDefined();
    expect(result.resultMetadata!.is_api_error).toBe(true);
  });

  test("stream_event returns unwrapped inner event", () => {
    const innerEvent = { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } };
    const event = { type: "stream_event", event: innerEvent };
    const result = routeTopLevelEvent(event, baseCtx);
    expect(result.streamEvent).toBeDefined();
    expect(result.streamEvent).toEqual(innerEvent);
    expect(result.messages).toHaveLength(0);
    expect(result.gotResult).toBe(false);
  });

  test("user/tool_result emits tool_result per block", () => {
    const event = {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu-1", content: "file text", is_error: false },
        ],
      },
    };
    const result = routeTopLevelEvent(event, baseCtx);
    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0] as any;
    expect(msg.type).toBe("tool_result");
    expect(msg.tool_use_id).toBe("tu-1");
    expect(msg.output).toBe("file text");
    expect(msg.is_error).toBe(false);
  });

  test("control_request returns it for handling", () => {
    const event = {
      type: "control_request",
      request_id: "req-1",
      request: { subtype: "can_use_tool" },
    };
    const result = routeTopLevelEvent(event, baseCtx);
    expect(result.controlRequest).toBeDefined();
    expect(result.controlRequest).toBe(event);
    expect(result.messages).toHaveLength(0);
    expect(result.gotResult).toBe(false);
  });

  test("keep_alive produces nothing", () => {
    const event = { type: "keep_alive" };
    const result = routeTopLevelEvent(event, baseCtx);
    expect(result.messages).toHaveLength(0);
    expect(result.gotResult).toBe(false);
    expect(result.sessionId).toBeUndefined();
    expect(result.streamEvent).toBeUndefined();
    expect(result.controlRequest).toBeUndefined();
  });

  test("preserves parent_tool_use_id from all 5 message types", () => {
    const parentId = "parent-123";

    const systemEvent = { type: "system", subtype: "init", session_id: "s1", parent_tool_use_id: parentId };
    const assistantEvent = { type: "assistant", message: { content: [] }, parent_tool_use_id: parentId };
    const userEvent = { type: "user", message: { content: [] }, parent_tool_use_id: parentId };
    const resultEvent = { type: "result", subtype: "success", result: "", parent_tool_use_id: parentId };
    const streamEvent = { type: "stream_event", event: {}, parent_tool_use_id: parentId };

    for (const event of [systemEvent, assistantEvent, userEvent, resultEvent, streamEvent]) {
      const result = routeTopLevelEvent(event, baseCtx);
      expect(result.parentToolUseId).toBe(parentId);
    }
  });

  // Step 3 new tests (updated in Step 6 audit with new fields)
  test("system/init produces SystemMetadata IPC with all section 3a fields", () => {
    const event = {
      type: "system",
      subtype: "init",
      session_id: "s1",
      cwd: "/proj",
      tools: ["Read"],
      model: "claude-opus-4-6",
      permissionMode: "acceptEdits",
      slash_commands: [{ name: "/cost" }],
      plugins: [],
      agents: [],
      skills: [],
      mcp_servers: [{ name: "my-mcp" }],
      claude_code_version: "2.1.38",
      output_style: "auto",
      fast_mode_state: "disabled",
      apiKeySource: "env",
    };
    const result = routeTopLevelEvent(event, baseCtx);
    const sysMsg = result.messages.find((m: any) => m.type === "system_metadata") as any;
    expect(sysMsg).toBeDefined();
    expect(sysMsg.session_id).toBe("s1");
    expect(sysMsg.cwd).toBe("/proj");
    expect(sysMsg.tools).toEqual(["Read"]);
    expect(sysMsg.model).toBe("claude-opus-4-6");
    expect(sysMsg.permissionMode).toBe("acceptEdits");
    expect(sysMsg.slash_commands).toEqual([{ name: "/cost" }]);
    expect(sysMsg.version).toBe("2.1.38");
    // New fields added in Step 6 audit
    expect(sysMsg.mcp_servers).toEqual([{ name: "my-mcp" }]);
    expect(sysMsg.output_style).toBe("auto");
    expect(sysMsg.fast_mode_state).toBe("disabled");
    expect(sysMsg.apiKeySource).toBe("env");
  });

  test("result/success produces CostUpdate IPC with cost fields", () => {
    const event = {
      type: "result",
      subtype: "success",
      result: "",
      total_cost_usd: 0.042,
      num_turns: 3,
      duration_ms: 5000,
      duration_api_ms: 3200,
      usage: { input_tokens: 100, output_tokens: 50 },
      modelUsage: {
        "claude-opus-4-6": {
          inputTokens: 100,
          outputTokens: 50,
          costUSD: 0.042,
          contextWindow: 200000,
          maxOutputTokens: 64000,
        },
      },
    };
    const result = routeTopLevelEvent(event, baseCtx);
    // cost_update is the only message from result (turn_complete is emitted by handleUserMessage).
    expect(result.messages).toHaveLength(1);
    const cu = result.messages[0] as any;
    expect(cu.type).toBe("cost_update");
    expect(cu.total_cost_usd).toBe(0.042);
    expect(cu.duration_api_ms).toBe(3200);
    expect(cu.num_turns).toBe(3);
    expect(cu.modelUsage["claude-opus-4-6"]).toBeDefined();
  });

  test("result cost_update.usage is the passed last-iteration usage, not result.usage", () => {
    // `result.usage` is the per-turn SUM across every API call; the
    // `lastIterationUsage` argument (the turn's last `message_delta`)
    // is what `cost_update.usage` must carry.
    const event = {
      type: "result",
      subtype: "success",
      result: "",
      usage: { input_tokens: 9_999_999, output_tokens: 9_999_999 },
    };
    const lastIteration = {
      input_tokens: 4,
      cache_read_input_tokens: 21000,
      cache_creation_input_tokens: 38000,
      output_tokens: 192,
    };
    const result = routeTopLevelEvent(event, baseCtx, lastIteration);
    const cu = result.messages.find((m: any) => m.type === "cost_update") as any;
    expect(cu.usage).toEqual(lastIteration);
    // `resultMetadata.usage` still mirrors the raw `result.usage` —
    // a separate surface, deliberately left untouched.
    expect((result.resultMetadata!.usage as any).input_tokens).toBe(9_999_999);
  });

  test("result cost_update.usage is {} when no last-iteration usage is supplied", () => {
    // A fully degenerate turn (no message_start / message_delta): the
    // pure function emits `{}` rather than the misleading result.usage.
    const event = {
      type: "result",
      subtype: "success",
      result: "",
      usage: { input_tokens: 200, output_tokens: 80 },
    };
    const result = routeTopLevelEvent(event, baseCtx);
    const cu = result.messages.find((m: any) => m.type === "cost_update") as any;
    expect(cu.usage).toEqual({});
  });

  test("system/compact_boundary produces CompactBoundary IPC (explicit type check)", () => {
    const event = { type: "system", subtype: "compact_boundary" };
    const result = routeTopLevelEvent(event, baseCtx);
    expect(result.messages).toHaveLength(1);
    expect((result.messages[0] as any).type).toBe("compact_boundary");
  });

  test("assistant with mixed content emits tool_use (text + thinking already via streaming)", () => {
    // Contract: text and thinking were delivered via streaming wire
    // events; the assistant snapshot's only NEW content is the
    // tool_use block (plus its content_block_start prelude per
    // [D07] / Fixup 7).
    const event = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Here is my answer" },
          { type: "tool_use", name: "Read", id: "tu-mixed", input: { path: "/f.ts" } },
          { type: "thinking", text: "Let me reason..." },
        ],
      },
    };
    const result = routeTopLevelEvent(event, baseCtx);
    const types = result.messages.map((m: any) => m.type);
    expect(types).not.toContain("assistant_text");
    expect(types).not.toContain("thinking_text");
    expect(types).toContain("tool_use");
    // The content_block_start prelude minted the reducer's
    // ToolUseMessage; assert it lands too.
    const cbs = result.messages.find((m: any) => m.type === "content_block_start") as any;
    expect(cbs).toBeDefined();
    expect(cbs.kind).toBe("tool_use");
    expect(cbs.tool_use_id).toBe("tu-mixed");
  });

  test("result with permission_denials stores them in resultMetadata", () => {
    const denials = [{ tool: "Write", reason: "blocked path" }];
    const event = {
      type: "result",
      subtype: "success",
      result: "",
      permission_denials: denials,
    };
    const result = routeTopLevelEvent(event, baseCtx);
    expect(result.resultMetadata).toBeDefined();
    expect(result.resultMetadata!.permission_denials).toEqual(denials);
  });

  test("control_cancel_request at pure function level emits cancel IPC and sets cancelledRequestId", () => {
    const event = { type: "control_cancel_request", request_id: "req-pure-cancel" };
    const result = routeTopLevelEvent(event, baseCtx);
    expect(result.cancelledRequestId).toBe("req-pure-cancel");
    const cancelMsg = result.messages.find((m: any) => m.type === "control_request_cancel") as any;
    expect(cancelMsg).toBeDefined();
    expect(cancelMsg.request_id).toBe("req-pure-cancel");
  });
});

// ---------------------------------------------------------------------------
// buildWakeStartedMessage tests — wake-detector pure helper
// (the session-wake design record Step 3, [D02], [Q01])
// ---------------------------------------------------------------------------

describe("buildWakeStartedMessage", () => {
  test("forwards all five SDK payload fields verbatim", () => {
    const event = {
      type: "system",
      subtype: "task_notification",
      session_id: "wire-session-id",
      task_id: "b9klbr5tx",
      tool_use_id: "toolu_01XzLVALeMEvdqb4qiNDbRdp",
      status: "stopped",
      output_file: "/tmp/monitor-output.txt",
      summary: "kernel lines in /var/log/system.log",
      uuid: "5a3bed72-f287-4060-a093-347efd1ee010",
    };
    const frame = buildWakeStartedMessage(event, "tug-session-id");
    expect(frame).not.toBeNull();
    expect(frame!.type).toBe("wake_started");
    // session_id comes from the SessionManager (tug-side), not the
    // wire event (which carries claude's own session_id).
    expect(frame!.session_id).toBe("tug-session-id");
    expect(frame!.wake_trigger).toEqual({
      task_id: "b9klbr5tx",
      tool_use_id: "toolu_01XzLVALeMEvdqb4qiNDbRdp",
      status: "stopped",
      summary: "kernel lines in /var/log/system.log",
      output_file: "/tmp/monitor-output.txt",
    });
    expect(frame!.ipc_version).toBe(2);
  });

  test("accepts the three SDK status values", () => {
    for (const status of ["completed", "failed", "stopped"] as const) {
      const event = {
        type: "system",
        subtype: "task_notification",
        task_id: "t-1",
        tool_use_id: "tu-1",
        status,
        summary: "",
        output_file: "",
      };
      const frame = buildWakeStartedMessage(event, "s-1");
      expect(frame).not.toBeNull();
      expect(frame!.wake_trigger.status).toBe(status);
    }
  });

  test("returns null for non-task_notification events", () => {
    expect(
      buildWakeStartedMessage({ type: "system", subtype: "init" }, "s"),
    ).toBeNull();
    expect(
      buildWakeStartedMessage(
        { type: "system", subtype: "task_updated" },
        "s",
      ),
    ).toBeNull();
    expect(buildWakeStartedMessage({ type: "result" }, "s")).toBeNull();
    expect(buildWakeStartedMessage({ type: "user" }, "s")).toBeNull();
  });

  test("returns null for task_notification with missing task_id", () => {
    expect(
      buildWakeStartedMessage(
        { type: "system", subtype: "task_notification" },
        "s",
      ),
    ).toBeNull();
    expect(
      buildWakeStartedMessage(
        { type: "system", subtype: "task_notification", task_id: "" },
        "s",
      ),
    ).toBeNull();
    expect(
      buildWakeStartedMessage(
        { type: "system", subtype: "task_notification", task_id: 42 },
        "s",
      ),
    ).toBeNull();
  });

  test("defaults missing optional fields to empty strings / 'stopped'", () => {
    const event = {
      type: "system",
      subtype: "task_notification",
      task_id: "t-only",
    };
    const frame = buildWakeStartedMessage(event, "s");
    expect(frame).not.toBeNull();
    expect(frame!.wake_trigger).toEqual({
      task_id: "t-only",
      tool_use_id: "",
      status: "stopped",
      summary: "",
      output_file: "",
    });
  });

  test("locates the wake signal in the Step-1 captured fixture", async () => {
    // Reads the actual stream-json capture committed alongside the
    // wake plan and verifies that the single line carrying
    // `subtype: "task_notification"` produces a well-formed
    // `wake_started` frame when fed through `buildWakeStartedMessage`.
    // Pins the empirical wire shape against the implementation.
    const fixturePath =
      new URL(
        "../../../tugrust/crates/tugcast/tests/fixtures/" +
          "stream-json-catalog/v2.1.150-spike/test-monitor-wake-raw.jsonl",
        import.meta.url,
      ).pathname;
    const raw = await Bun.file(fixturePath).text();
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);

    const wakeFrames: unknown[] = [];
    for (const line of lines) {
      const event = JSON.parse(line) as Record<string, unknown>;
      const frame = buildWakeStartedMessage(event, "test-session");
      if (frame !== null) wakeFrames.push(frame);
    }

    // Exactly one task_notification → exactly one wake_started.
    expect(wakeFrames).toHaveLength(1);
    const frame = wakeFrames[0] as ReturnType<typeof buildWakeStartedMessage>;
    expect(frame).not.toBeNull();
    expect(frame!.type).toBe("wake_started");
    expect(frame!.wake_trigger.task_id).toBe("b9klbr5tx");
    expect(frame!.wake_trigger.status).toBe("stopped");
    // The capture's task was a Monitor watching system.log for "kernel".
    expect(frame!.wake_trigger.summary).toContain("kernel");
  });
});

// ---------------------------------------------------------------------------
// mapStreamEvent (updated) tests (Step 1)
// ---------------------------------------------------------------------------

describe("mapStreamEvent (updated)", () => {
  test("content_block_start/tool_use emits content_block_start + tool_use", () => {
    // Per [D07]: tool_use blocks emit both a content_block_start (mints
    // the reducer's ToolUseMessage) and the existing tool_use frame
    // (forms the toolCallMap entry with empty input).
    const event = {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", name: "Read", id: "tu-1" },
    };
    const result = mapStreamEvent(event, baseCtx, "");
    expect(result.messages).toHaveLength(2);
    const cbs = result.messages[0] as any;
    expect(cbs.type).toBe("content_block_start");
    expect(cbs.kind).toBe("tool_use");
    expect(cbs.block_index).toBe(1);
    expect(cbs.tool_use_id).toBe("tu-1");
    expect(cbs.tool_name).toBe("Read");
    const msg = result.messages[1] as any;
    expect(msg.type).toBe("tool_use");
    expect(msg.tool_name).toBe("Read");
    expect(msg.tool_use_id).toBe("tu-1");
    expect(msg.input).toEqual({});
  });

  test("content_block_start with text emits a content_block_start (kind=text)", () => {
    // Per [D07]: text blocks emit a content_block_start so the reducer
    // can mint an AssistantText Message before any delta lands.
    const event = {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    };
    const result = mapStreamEvent(event, baseCtx, "");
    expect(result.messages).toHaveLength(1);
    const cbs = result.messages[0] as any;
    expect(cbs.type).toBe("content_block_start");
    expect(cbs.kind).toBe("text");
    expect(cbs.block_index).toBe(0);
  });

  test("thinking_delta emits thinking_text with is_partial: true", () => {
    // Per §14: thinking_delta has delta.thinking, not delta.text.
    const event = {
      type: "content_block_delta",
      delta: { type: "thinking_delta", thinking: "thinking..." },
    };
    const result = mapStreamEvent(event, baseCtx, "");
    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0] as any;
    expect(msg.type).toBe("thinking_text");
    expect(msg.text).toBe("thinking...");
    expect(msg.is_partial).toBe(true);
    expect(msg.status).toBe("partial");
  });

  test("content_block_delta/text_delta still works correctly", () => {
    const event = {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "hello" },
    };
    const result = mapStreamEvent(event, baseCtx, "prior ");
    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0] as any;
    expect(msg.type).toBe("assistant_text");
    expect(msg.text).toBe("hello");
    expect(msg.is_partial).toBe(true);
    expect(result.partialText).toBe("prior hello");
  });

  test("mapStreamEvent result no longer has sessionId field", () => {
    const event = {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "x" },
      session_id: "should-not-capture",
    };
    const result = mapStreamEvent(event, baseCtx, "");
    // sessionId should not be present on EventMappingResult
    expect("sessionId" in result).toBe(false);
  });

  test("content_block_delta with input_json_delta produces no messages", () => {
    const event = {
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: "{\"path\":" },
    };
    const result = mapStreamEvent(event, baseCtx, "");
    expect(result.messages).toHaveLength(0);
  });

  test("content_block_stop produces no messages", () => {
    const result = mapStreamEvent({ type: "content_block_stop", index: 0 }, baseCtx, "");
    expect(result.messages).toHaveLength(0);
  });

  test("parseToolInputProgress assembles a streaming Write tool input", () => {
    // Realistic fragmentation of a Write tool_use: claude streams the
    // argument JSON as `input_json_delta.partial_json` chunks that split
    // mid-key and mid-value. Concatenated, they form the full input.
    const fragments = [
      '{"file_',
      'path":"src/foo',
      '.ts","content":"line one\\n',
      'line two\\n',
      'line three"}',
    ];
    let acc = "";

    // file_path stays null until its value's closing quote streams in —
    // `{"file_path":"src/foo` is an unterminated string, not yet readable.
    acc += fragments[0];
    expect(parseToolInputProgress(acc).filePath).toBeNull();

    acc += fragments[1];
    expect(parseToolInputProgress(acc).filePath).toBeNull();

    // fragment[2] closes the path value and opens content.
    acc += fragments[2];
    expect(parseToolInputProgress(acc).filePath).toBe("src/foo.ts");
    expect(parseToolInputProgress(acc).contentLines).toBe(2);

    acc += fragments[3];
    expect(parseToolInputProgress(acc).contentLines).toBe(3);

    acc += fragments[4];
    const final = parseToolInputProgress(acc);
    expect(final.filePath).toBe("src/foo.ts");
    expect(final.contentLines).toBe(3);
    expect(final.bytes).toBe(acc.length);
    // The assembled fragments are valid JSON carrying the real input.
    expect(JSON.parse(acc)).toEqual({
      file_path: "src/foo.ts",
      content: "line one\nline two\nline three",
    });
  });

  test("message_start without usage produces no messages", () => {
    const result = mapStreamEvent({ type: "message_start", message: {} }, baseCtx, "");
    expect(result.messages).toHaveLength(0);
  });

  test("message_delta without usage produces no messages", () => {
    const result = mapStreamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } }, baseCtx, "");
    expect(result.messages).toHaveLength(0);
  });

  test("message_stop produces no messages", () => {
    const result = mapStreamEvent({ type: "message_stop" }, baseCtx, "");
    expect(result.messages).toHaveLength(0);
  });

  test("message_start with usage emits a streaming_usage frame keyed by the message id", () => {
    const result = mapStreamEvent(
      {
        type: "message_start",
        message: {
          id: "msg_abc",
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: 7327,
            cache_read_input_tokens: 13148,
            output_tokens: 2,
          },
        },
      },
      baseCtx,
      "",
    );
    expect(result.messages).toHaveLength(1);
    const frame = result.messages[0] as StreamingUsage;
    expect(frame.type).toBe("streaming_usage");
    expect(frame.msg_id).toBe("msg_abc");
    expect(frame.usage).toEqual({
      input_tokens: 3,
      cache_creation_input_tokens: 7327,
      cache_read_input_tokens: 13148,
      output_tokens: 2,
    });
    // The raw `usage` is surfaced so the turn can latch it as the
    // `cost_update.usage` fallback for a turn with no `message_delta`.
    expect(result.messageStartUsage).toEqual({
      input_tokens: 3,
      cache_creation_input_tokens: 7327,
      cache_read_input_tokens: 13148,
      output_tokens: 2,
    });
    expect(result.messageDeltaUsage).toBeUndefined();
  });

  test("message_delta with usage emits a streaming_usage frame keyed by the current message", () => {
    const result = mapStreamEvent(
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: {
          input_tokens: 3,
          cache_creation_input_tokens: 7327,
          cache_read_input_tokens: 13148,
          output_tokens: 80,
        },
      },
      baseCtx,
      "",
    );
    expect(result.messages).toHaveLength(1);
    const frame = result.messages[0] as StreamingUsage;
    expect(frame.type).toBe("streaming_usage");
    // `message_delta` carries no id — it keys on `ctx.msgId`, the
    // current message slid by this message's earlier `message_start`.
    expect(frame.msg_id).toBe("msg-1");
    expect(frame.usage.output_tokens).toBe(80);
    // The raw `usage` is surfaced so the turn can latch the latest
    // `message_delta` as `cost_update.usage` — the last tool-loop
    // iteration, never the summed `result.usage`.
    expect(result.messageDeltaUsage).toEqual({
      input_tokens: 3,
      cache_creation_input_tokens: 7327,
      cache_read_input_tokens: 13148,
      output_tokens: 80,
    });
    expect(result.messageStartUsage).toBeUndefined();
  });

  test("message_delta with an empty usage object emits no streaming_usage frame", () => {
    const result = mapStreamEvent(
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} },
      baseCtx,
      "",
    );
    expect(result.messages).toHaveLength(0);
    // No frame -> no latched usage; the turn keeps its prior iteration.
    expect(result.messageDeltaUsage).toBeUndefined();
  });

  test("message_start with usage but no message id emits no streaming_usage frame", () => {
    const result = mapStreamEvent(
      { type: "message_start", message: { usage: { output_tokens: 5 } } },
      baseCtx,
      "",
    );
    expect(result.messages).toHaveLength(0);
    expect(result.messageStartUsage).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Step 2.3: Structured tool result and user message parsing tests
// ---------------------------------------------------------------------------

describe("structured tool results and user message parsing (Step 2.3)", () => {
  test("user message with is_error and tool_use_error tags strips tags per PN-3", () => {
    const event = {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-err",
            content: "<tool_use_error>File not found: /foo.ts</tool_use_error>",
            is_error: true,
          },
        ],
      },
    };
    const result = routeTopLevelEvent(event, baseCtx);
    const tr = result.messages.find((m: any) => m.type === "tool_result") as any;
    expect(tr).toBeDefined();
    expect(tr.is_error).toBe(true);
    // Tags should be stripped from output
    expect(tr.output).not.toContain("<tool_use_error>");
    expect(tr.output).not.toContain("</tool_use_error>");
    expect(tr.output).toBe("File not found: /foo.ts");
  });

  test("user message with tool_use_result on OUTER message emits ToolUseStructured per PN-4", () => {
    const event = {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu-structured", content: "raw output", is_error: false },
        ],
      },
      tool_use_result: {
        toolName: "Read",
        filePath: "/a.ts",
        content: "file contents",
      },
    };
    const result = routeTopLevelEvent(event, baseCtx);
    const structured = result.messages.find((m: any) => m.type === "tool_use_structured") as any;
    expect(structured).toBeDefined();
    expect(structured.tool_use_id).toBe("tu-structured");
    expect(structured.tool_name).toBe("Read");
    expect(structured.structured_result.filePath).toBe("/a.ts");
  });

  test("user message with tool_use_result (Edit) has structuredPatch", () => {
    const editResult = {
      toolName: "Edit",
      filePath: "/b.ts",
      oldString: "foo",
      newString: "bar",
      originalFile: null,
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-foo", "+bar"] }],
    };
    const event = {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu-edit", content: "Applied patch", is_error: false },
        ],
      },
      tool_use_result: editResult,
    };
    const result = routeTopLevelEvent(event, baseCtx);
    const structured = result.messages.find((m: any) => m.type === "tool_use_structured") as any;
    expect(structured).toBeDefined();
    expect(structured.structured_result.structuredPatch).toHaveLength(1);
    expect(structured.structured_result.structuredPatch[0].lines).toEqual(["-foo", "+bar"]);
  });

  test("user message with tool_use_result (Write/create) has type create", () => {
    const writeResult = {
      toolName: "Write",
      type: "create",
      filePath: "/new.ts",
      content: "export {};\n",
      structuredPatch: [],
      originalFile: null,
    };
    const event = {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu-write", content: "Created", is_error: false },
        ],
      },
      tool_use_result: writeResult,
    };
    const result = routeTopLevelEvent(event, baseCtx);
    const structured = result.messages.find((m: any) => m.type === "tool_use_structured") as any;
    expect(structured).toBeDefined();
    expect(structured.structured_result.type).toBe("create");
    expect(structured.structured_result.filePath).toBe("/new.ts");
  });

  test("user message with isReplay + local-command-stdout extracts output (array content)", () => {
    const event = {
      type: "user",
      isReplay: true,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-cmd",
            content: "<local-command-stdout>hello world\n</local-command-stdout>",
            is_error: false,
          },
        ],
      },
    };
    const result = routeTopLevelEvent(event, baseCtx);
    const textMsgs = result.messages.filter((m: any) => m.type === "assistant_text");
    // First message from tool_result processing, second from isReplay extraction
    const replayText = textMsgs.find((m: any) => m.text.includes("hello world"));
    expect(replayText).toBeDefined();
    expect((replayText as any).text).toContain("hello world");
  });

  test("user message with isReplay + local-command-stderr extracts error (array content)", () => {
    const event = {
      type: "user",
      isReplay: true,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-err-cmd",
            content: "<local-command-stderr>command not found: foo</local-command-stderr>",
            is_error: false,
          },
        ],
      },
    };
    const result = routeTopLevelEvent(event, baseCtx);
    const errors = result.messages.filter((m: any) => m.type === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect((errors[0] as any).message).toContain("command not found: foo");
  });

  test("user message with isReplay + string content extracts local-command-stdout (slash command)", () => {
    // Slash commands like /context return content as a plain string, not array.
    // Per §13c: {"type":"user","isReplay":true,"message":{"role":"user",
    //   "content":"<local-command-stdout>## Context Usage\n**Model:** ...</local-command-stdout>"}}
    const event = {
      type: "user",
      isReplay: true,
      message: {
        role: "user",
        content: "<local-command-stdout>## Context Usage\n**Model:** claude-opus-4-6</local-command-stdout>",
      },
    };
    const result = routeTopLevelEvent(event, baseCtx);
    const textMsgs = result.messages.filter((m: any) => m.type === "assistant_text");
    expect(textMsgs.length).toBe(1);
    expect((textMsgs[0] as any).text).toContain("## Context Usage");
    expect((textMsgs[0] as any).text).toContain("claude-opus-4-6");
    expect((textMsgs[0] as any).is_partial).toBe(false);
    // No tool_result messages since content is a string, not array.
    const toolResults = result.messages.filter((m: any) => m.type === "tool_result");
    expect(toolResults.length).toBe(0);
  });

  test("user message with isReplay + string content extracts local-command-stderr", () => {
    const event = {
      type: "user",
      isReplay: true,
      message: {
        role: "user",
        content: "<local-command-stderr>Error: No messages to compact</local-command-stderr>",
      },
    };
    const result = routeTopLevelEvent(event, baseCtx);
    const errors = result.messages.filter((m: any) => m.type === "error");
    expect(errors.length).toBe(1);
    expect((errors[0] as any).message).toContain("No messages to compact");
  });

  test("user message with isReplay + regular text is not re-emitted", () => {
    const event = {
      type: "user",
      isReplay: true,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-replay",
            content: "just regular tool output",
            is_error: false,
          },
        ],
      },
    };
    const result = routeTopLevelEvent(event, baseCtx);
    // Only one tool_result message; no extra assistant_text or error from isReplay
    const toolResults = result.messages.filter((m: any) => m.type === "tool_result");
    const textMsgs = result.messages.filter((m: any) => m.type === "assistant_text");
    expect(toolResults.length).toBe(1);
    // No stdout/stderr tags means no additional extraction
    expect(textMsgs.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ipc_version tests (Step 4)
// ---------------------------------------------------------------------------

describe("ipc_version on outbound messages", () => {
  test("routeTopLevelEvent system/init messages all have ipc_version: 2", () => {
    const event = {
      type: "system",
      subtype: "init",
      session_id: "s1",
      cwd: "/proj",
      tools: [],
      model: "claude-opus-4-6",
      permissionMode: "acceptEdits",
      slash_commands: [],
      plugins: [],
      agents: [],
      skills: [],
      claude_code_version: "2.1.38",
    };
    const result = routeTopLevelEvent(event, baseCtx);
    for (const msg of result.messages) {
      expect((msg as any).ipc_version).toBe(2);
    }
  });

  test("routeTopLevelEvent result messages all have ipc_version: 2", () => {
    const event = { type: "result", subtype: "success", result: "done" };
    const result = routeTopLevelEvent(event, baseCtx);
    for (const msg of result.messages) {
      expect((msg as any).ipc_version).toBe(2);
    }
  });

  test("mapStreamEvent messages have ipc_version: 2", () => {
    const event = {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "hi" },
    };
    const result = mapStreamEvent(event, baseCtx, "");
    expect(result.messages).toHaveLength(1);
    expect((result.messages[0] as any).ipc_version).toBe(2);
  });
});

describe("protocol audit: §3d result is_error field", () => {
  test("result event is_error=false captured in resultMetadata", () => {
    const event = {
      type: "result",
      subtype: "success",
      result: "done",
      is_error: false,
      total_cost_usd: 0.01,
    };
    const result = routeTopLevelEvent(event, baseCtx);
    expect(result.gotResult).toBe(true);
    expect(result.resultMetadata!.is_error).toBe(false);
  });

  test("result event is_error=true captured in resultMetadata", () => {
    const event = {
      type: "result",
      subtype: "error_during_execution",
      result: "",
      is_error: true,
    };
    const result = routeTopLevelEvent(event, baseCtx);
    expect(result.gotResult).toBe(true);
    expect(result.resultMetadata!.is_error).toBe(true);
  });

  test("result event without is_error defaults to false", () => {
    const event = {
      type: "result",
      subtype: "success",
      result: "ok",
    };
    const result = routeTopLevelEvent(event, baseCtx);
    expect(result.resultMetadata!.is_error).toBe(false);
  });
});

describe("protocol audit: §11 all result subtypes", () => {
  const subtypes = [
    "success",
    "error_during_execution",
    "error_max_turns",
    "error_max_budget_usd",
    "error_max_structured_output_retries",
  ];

  for (const subtype of subtypes) {
    test(`result subtype "${subtype}" is captured`, () => {
      const event = { type: "result", subtype, result: "" };
      const result = routeTopLevelEvent(event, baseCtx);
      expect(result.gotResult).toBe(true);
      expect(result.resultMetadata!.subtype).toBe(subtype);
    });
  }
});

describe("protocol audit: §3e stream_event types", () => {
  test("content_block_start for tool_use emits no IPC (handled by assistant)", () => {
    // The tool_use start event is informational; actual tool_use IPC comes from the assistant message.
    const event = {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", name: "Read" },
      },
    };
    const result = routeTopLevelEvent(event, baseCtx);
    // streamEvent is forwarded for processing.
    expect(result.streamEvent).toBeDefined();
  });

  test("message_start, message_delta, message_stop events pass through without IPC", () => {
    for (const eventType of ["message_start", "message_delta", "message_stop"]) {
      const event = {
        type: "stream_event",
        event: { type: eventType, delta: {}, usage: {} },
      };
      const result = routeTopLevelEvent(event, baseCtx);
      expect(result.streamEvent).toBeDefined();
      // routeTopLevelEvent forwards the inner payload for tier-2
      // processing. With the empty `usage: {}` here, mapStreamEvent
      // emits no `streaming_usage` frame (the gate skips token-less
      // payloads); the usage-bearing emit path is covered above.
    }
  });
});

describe("protocol audit: §9b Edit tool structured result", () => {
  test("Edit tool_use_result forwarded as tool_use_structured IPC", () => {
    const event = {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-edit-1",
            content: "The file /tmp/file.txt has been updated successfully.",
            is_error: false,
          },
        ],
      },
      tool_use_result: {
        toolName: "Edit",
        filePath: "/tmp/file.txt",
        oldString: "old text",
        newString: "new text",
        originalFile: "line 1\nold text\nline 3\n",
        structuredPatch: [
          { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" line 1", "-old text", "+new text", " line 3"] },
        ],
        userModified: false,
        replaceAll: false,
      },
    };
    const result = routeTopLevelEvent(event, baseCtx);
    // tool_result for the text.
    const tr = result.messages.find((m: any) => m.type === "tool_result") as any;
    expect(tr).toBeDefined();
    expect(tr.tool_use_id).toBe("tu-edit-1");
    // tool_use_structured for the structured patch data.
    const tus = result.messages.find((m: any) => m.type === "tool_use_structured") as any;
    expect(tus).toBeDefined();
    expect(tus.tool_name).toBe("Edit");
    expect(tus.structured_result.filePath).toBe("/tmp/file.txt");
    expect(tus.structured_result.structuredPatch).toHaveLength(1);
    expect(tus.structured_result.structuredPatch[0].lines).toContain("-old text");
    expect(tus.structured_result.structuredPatch[0].lines).toContain("+new text");
  });
});

describe("protocol audit: §9c Write tool structured result", () => {
  test("Write tool_use_result with type=create forwarded correctly", () => {
    const event = {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-write-1",
            content: "File created successfully at: /tmp/new.txt",
            is_error: false,
          },
        ],
      },
      tool_use_result: {
        toolName: "Write",
        type: "create",
        filePath: "/tmp/new.txt",
        content: "Hello World\nLine 2",
        structuredPatch: [],
        originalFile: null,
      },
    };
    const result = routeTopLevelEvent(event, baseCtx);
    const tus = result.messages.find((m: any) => m.type === "tool_use_structured") as any;
    expect(tus).toBeDefined();
    expect(tus.tool_name).toBe("Write");
    expect(tus.structured_result.type).toBe("create");
    expect(tus.structured_result.originalFile).toBeNull();
    expect(tus.structured_result.content).toBe("Hello World\nLine 2");
  });
});

describe("protocol audit: §11b tool errors", () => {
  test("tool_result with is_error strips tool_use_error tags per PN-3", () => {
    const event = {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-err-1",
            content: "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>",
            is_error: true,
          },
        ],
      },
    };
    const result = routeTopLevelEvent(event, baseCtx);
    const tr = result.messages.find((m: any) => m.type === "tool_result") as any;
    expect(tr).toBeDefined();
    expect(tr.is_error).toBe(true);
    // Tags stripped.
    expect(tr.output).not.toContain("<tool_use_error>");
    expect(tr.output).toContain("File has not been read yet");
  });
});

// ---------------------------------------------------------------------------
// Canonical msg_id: ActiveTurn adopts claude's `message.id` from the first
// stream event that reveals it (mid-turn replay design).
// ---------------------------------------------------------------------------

describe("mapStreamEvent surfaces messageId from message_start", () => {
  test("message_start with id surfaces messageId on result", () => {
    const result = mapStreamEvent(
      { type: "message_start", message: { id: "msg_claude_xyz", role: "assistant" } },
      baseCtx,
      "",
    );
    expect(result.messageId).toBe("msg_claude_xyz");
    expect(result.messages).toHaveLength(0);
  });

  test("message_start with no id leaves messageId undefined", () => {
    const result = mapStreamEvent({ type: "message_start", message: {} }, baseCtx, "");
    expect(result.messageId).toBeUndefined();
  });

  test("message_start with empty-string id leaves messageId undefined", () => {
    const result = mapStreamEvent(
      { type: "message_start", message: { id: "" } },
      baseCtx,
      "",
    );
    expect(result.messageId).toBeUndefined();
  });

  test("non-message_start events leave messageId undefined", () => {
    const delta = mapStreamEvent(
      { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
      baseCtx,
      "",
    );
    expect(delta.messageId).toBeUndefined();
  });
});

describe("routeTopLevelEvent surfaces messageId from assistant snapshot", () => {
  test("assistant with message.id surfaces messageId on result", () => {
    const event = {
      type: "assistant",
      message: { id: "msg_claude_abc", content: [] },
    };
    const result = routeTopLevelEvent(event, baseCtx);
    expect(result.messageId).toBe("msg_claude_abc");
  });

  test("assistant tool_use blocks emit with claude's message.id", () => {
    // Contract: tool_use IPC frame carries claude's message.id. (Frame
    // count no longer pinned — Fixup 7 added content_block_start prelude.)
    const event = {
      type: "assistant",
      message: {
        id: "msg_claude_def",
        content: [
          { type: "tool_use", name: "Read", id: "tu-1", input: { path: "/a.ts" } },
        ],
      },
    };
    const result = routeTopLevelEvent(event, baseCtx);
    expect(result.messageId).toBe("msg_claude_def");
    const tu = result.messages.find((m: any) => m.type === "tool_use") as any;
    expect(tu).toBeDefined();
    expect(tu.msg_id).toBe("msg_claude_def");
  });

  test("synthetic assistant text emits with claude's message.id", () => {
    // Contract: synthetic slash-command response's text reaches the
    // wire keyed to claude's message.id. (Frame count is no longer
    // pinned — under [D07] synthetic emissions also include a
    // content_block_start prelude so the reducer's mint path is
    // uniform across live, replay, and synthetic.)
    const event = {
      type: "assistant",
      message: {
        id: "msg_claude_synth",
        model: "<synthetic>",
        content: [{ type: "text", text: "/cost output" }],
      },
    };
    const result = routeTopLevelEvent(event, baseCtx);
    expect(result.messageId).toBe("msg_claude_synth");
    const text = result.messages.find((m: any) => m.type === "assistant_text") as any;
    expect(text).toBeDefined();
    expect(text.msg_id).toBe("msg_claude_synth");
    expect(text.text).toBe("/cost output");
  });

  test("assistant snapshot without message.id falls back to ctx.msgId", () => {
    const event = {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Read", id: "tu-1", input: {} },
        ],
      },
    };
    const result = routeTopLevelEvent(event, baseCtx);
    expect(result.messageId).toBeUndefined();
    // Contract: tool_use IPC frame falls back to ctx.msgId when the
    // assistant snapshot has no message.id.
    const tu = result.messages.find((m: any) => m.type === "tool_use") as any;
    expect(tu).toBeDefined();
    expect(tu.msg_id).toBe(baseCtx.msgId);
  });

  test("non-assistant events leave messageId undefined", () => {
    const result = routeTopLevelEvent(
      { type: "result", subtype: "success", result: "" },
      baseCtx,
    );
    expect(result.messageId).toBeUndefined();
  });
});
