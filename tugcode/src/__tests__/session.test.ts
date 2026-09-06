import { describe, test, expect } from "bun:test";
import { ActiveTurn, SessionManager, buildClaudeArgs, buildContentBlocksFromLegacyJournal, buildWakeStartedMessage, routeTopLevelEvent, mapStreamEvent, payloadHexPreview, parseToolInputProgress } from "../session.ts";
import type { EventMappingContext } from "../session.ts";
import type { ContentBlock, ContentBlockText, StreamingUsage } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers (needed for stdin spy test and future Steps 1-4)
// ---------------------------------------------------------------------------

/**
 * Build a mock subprocess suitable for injection into SessionManager
 * via {@link injectMockSubprocess}.
 *
 * `stdoutLines` is the script the SessionManager's stdout drain (Step
 * R1e) will read and dispatch. The stream emits all lines in one
 * chunk then closes (`controller.close()`); the drain task observes
 * EOF after the final line and calls `signalEofToActiveTurn` on its
 * way out — which is harmless if the script already contains a
 * `result` event (the active turn finished before EOF).
 *
 * Returns `{ mockProcess, mockStdin }`. The drain calls `getReader()`
 * on `mockProcess.stdout` itself; tests must not pre-acquire the
 * reader.
 */
function makeMockSubprocess(stdoutLines: unknown[]): {
  mockProcess: Record<string, unknown>;
  mockStdin: Record<string, unknown>;
} {
  // Build a single Uint8Array of all newline-terminated JSON lines
  const encoder = new TextEncoder();
  const allBytes = stdoutLines
    .map((obj) => encoder.encode(JSON.stringify(obj) + "\n"))
    .reduce((acc, chunk) => {
      const merged = new Uint8Array(acc.length + chunk.length);
      merged.set(acc, 0);
      merged.set(chunk, acc.length);
      return merged;
    }, new Uint8Array(0));

  // Construct a ReadableStream that yields allBytes in one chunk then closes
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (allBytes.length > 0) {
        controller.enqueue(allBytes);
      }
      controller.close();
    },
  });

  // Mock FileSink for stdin (Bun.spawn returns a FileSink, not a WritableStream)
  const mockStdin: Record<string, unknown> = {
    write(_data: unknown) {},
    flush() {},
    end() {},
  };

  const mockProcess: Record<string, unknown> = {
    stdin: mockStdin,
    stdout: stream,
    kill: (_signal: string) => {},
  };

  return { mockProcess, mockStdin };
}

/**
 * Inject a mock subprocess into a SessionManager instance, bypassing
 * `initialize()`. Sets `claudeProcess` and starts the Step R1e
 * stdout drain on the mock's stdout stream so subsequent
 * `handleUserMessage` calls observe the scripted lines exactly as
 * they would observe real claude output in production.
 *
 * Returns mockStdin so callers can spy on write calls.
 */
function injectMockSubprocess(
  manager: SessionManager,
  stdoutLines: unknown[]
): Record<string, unknown> {
  const { mockProcess, mockStdin } = makeMockSubprocess(stdoutLines);
  (manager as any).claudeProcess = mockProcess;
  (manager as any).startStdoutDrain(mockProcess);
  return mockStdin;
}

/**
 * Capture IPC output written to Bun.stdout during an async operation.
 * writeLine() in ipc.ts calls Bun.write(Bun.stdout, json + "\n").
 * We intercept by temporarily replacing Bun.write.
 */
async function captureIpcOutput(fn: () => Promise<void>): Promise<unknown[]> {
  const captured: unknown[] = [];
  const originalWrite = Bun.write;
  const decoder = new TextDecoder();

  // Bun.write is typed as an overloaded function; cast to any for mocking
  (Bun as any).write = (dest: unknown, data: unknown) => {
    if (dest === Bun.stdout && typeof data === "string") {
      for (const line of data.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          try {
            captured.push(JSON.parse(trimmed));
          } catch {
            // ignore non-JSON lines
          }
        }
      }
    } else if (dest === Bun.stdout && data instanceof Uint8Array) {
      const text = decoder.decode(data);
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          try {
            captured.push(JSON.parse(trimmed));
          } catch {
            // ignore non-JSON lines
          }
        }
      }
    }
    // Always return a resolved promise (Bun.write returns Promise<number>)
    return Promise.resolve(data instanceof Uint8Array ? data.length : (data as string).length);
  };

  try {
    await fn();
    // writeLine is serialized through a Promise chain in `ipc.ts`;
    // drain it before restoring the mock so all queued writes have
    // hit the capture above.
    const { drainPendingWrites } = await import("../ipc.ts");
    await drainPendingWrites();
  } finally {
    (Bun as any).write = originalWrite;
  }

  return captured;
}

// ---------------------------------------------------------------------------
// buildClaudeArgs tests
// ---------------------------------------------------------------------------

// Reusable default config
const defaultConfig = {
  pluginDir: "/repo",
  permissionMode: "acceptEdits",
  sessionId: null,
};

describe("buildClaudeArgs", () => {
  test("default config does NOT include -p", () => {
    const args = buildClaudeArgs(defaultConfig);
    expect(args).not.toContain("-p");
  });

  test("includes --permission-prompt-tool stdio", () => {
    const args = buildClaudeArgs(defaultConfig);
    const idx = args.indexOf("--permission-prompt-tool");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("stdio");
  });

  test("includes --replay-user-messages", () => {
    const args = buildClaudeArgs(defaultConfig);
    expect(args).toContain("--replay-user-messages");
  });

  test("registers the Tug data root as a read dir via --add-dir", () => {
    const args = buildClaudeArgs(defaultConfig);
    const idx = args.indexOf("--add-dir");
    expect(idx).toBeGreaterThan(-1);
    // The registered path is the Tug app-data root — one entry covering every
    // per-project runtime-state subdir.
    expect(args[idx + 1].endsWith("/Tug")).toBe(true);
  });

  test("carries the work grammar in the one --append-system-prompt", () => {
    const args = buildClaudeArgs({ ...defaultConfig, workGrammar: "GRAMMAR" });
    // One flag, not two: the option is a string and repeating it is not
    // documented to concatenate, so both texts ride one value.
    expect(args.filter((a) => a === "--append-system-prompt").length).toBe(1);
    const value = args[args.indexOf("--append-system-prompt") + 1];
    expect(value.startsWith("The user is reading this conversation in Dev")).toBe(true);
    expect(value.endsWith("GRAMMAR")).toBe(true);
  });

  test("with no work grammar the appended prompt is the nudge alone", () => {
    const args = buildClaudeArgs(defaultConfig);
    expect(args.filter((a) => a === "--append-system-prompt").length).toBe(1);
    const value = args[args.indexOf("--append-system-prompt") + 1];
    expect(value.startsWith("The user is reading this conversation in Dev")).toBe(true);
    expect(value.endsWith("the next step you're about to take).")).toBe(true);
  });

  test("with sessionId includes --resume", () => {
    const args = buildClaudeArgs({ ...defaultConfig, sessionId: "abc" });
    const idx = args.indexOf("--resume");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("abc");
  });

  test("emits a --add-dir for each additional directory (/add-dir)", () => {
    const args = buildClaudeArgs({
      ...defaultConfig,
      additionalDirectories: ["/Users/me/Desktop/a", "/Users/me/b"],
    });
    // The Tug data root --add-dir is always present; the two extra dirs add two
    // more --add-dir pairs.
    const addDirCount = args.filter((a) => a === "--add-dir").length;
    expect(addDirCount).toBe(3);
    expect(args).toContain("/Users/me/Desktop/a");
    expect(args).toContain("/Users/me/b");
  });

  test("omits extra --add-dir when no additional directories", () => {
    const args = buildClaudeArgs(defaultConfig);
    // Only the Tug data root.
    expect(args.filter((a) => a === "--add-dir").length).toBe(1);
  });

  test("with continue: true includes --continue", () => {
    const args = buildClaudeArgs({ ...defaultConfig, continue: true });
    expect(args).toContain("--continue");
  });

  test("with forkSession: true and sessionId includes --fork-session", () => {
    const args = buildClaudeArgs({ ...defaultConfig, sessionId: "sess-1", forkSession: true });
    expect(args).toContain("--fork-session");
  });

  test("with sessionIdOverride includes --session-id", () => {
    const args = buildClaudeArgs({ ...defaultConfig, sessionIdOverride: "override-id-xyz" });
    const idx = args.indexOf("--session-id");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("override-id-xyz");
  });

  test("throws if both sessionId and continue are set", () => {
    expect(() =>
      buildClaudeArgs({ ...defaultConfig, sessionId: "sess-abc", continue: true })
    ).toThrow("Only one of sessionId, continue, or sessionIdOverride may be set");
  });

  test("throws if both sessionId and sessionIdOverride are set", () => {
    expect(() =>
      buildClaudeArgs({ ...defaultConfig, sessionId: "sess-abc", sessionIdOverride: "override-xyz" })
    ).toThrow("Only one of sessionId, continue, or sessionIdOverride may be set");
  });

  test("throws if forkSession without sessionId or continue", () => {
    expect(() =>
      buildClaudeArgs({ ...defaultConfig, forkSession: true })
    ).toThrow("forkSession requires either sessionId or continue to be set");
  });

  test("forkSession with continue does not throw", () => {
    expect(() =>
      buildClaudeArgs({ ...defaultConfig, continue: true, forkSession: true })
    ).not.toThrow();
  });

  test("all required base flags are present", () => {
    const args = buildClaudeArgs(defaultConfig);
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--input-format");
    expect(args[args.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("--include-partial-messages");
    expect(args).toContain("--replay-user-messages");
  });

  test("includes --append-system-prompt with Dev rendering nudge", () => {
    const args = buildClaudeArgs(defaultConfig);
    const idx = args.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThan(-1);
    const nudge = args[idx + 1];
    expect(nudge).toBeDefined();
    // The nudge is the contract between Dev's structured tool-call
    // rendering and the model's "should I restate this?" judgment —
    // pin both the surface description and the carve-out for analysis
    // so a future edit can't quietly drop one or the other.
    expect(nudge).toContain("Dev");
    expect(nudge).toContain("tool call");
    expect(nudge).toContain("analysis");
    // Summary-shaped tools (WebFetch / Read) get an extra-force
    // carve-out because their result IS the model-readable rendering
    // of the source — restating those bullets is pure duplication.
    expect(nudge).toContain("WebFetch");
    expect(nudge).toContain("Read");
  });

  test("config values are correctly mapped to CLI flags", () => {
    const config = {
      pluginDir: "/my/plugin/dir",
      model: "claude-haiku-3-5",
      permissionMode: "bypassPermissions",
      sessionId: null,
    };
    const args = buildClaudeArgs(config);
    expect(args[args.indexOf("--plugin-dir") + 1]).toBe("/my/plugin/dir");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-3-5");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  });

  test("omits --model when model is not set, letting the CLI use its default", () => {
    const args = buildClaudeArgs(defaultConfig);
    expect(args).not.toContain("--model");
  });
});

// ---------------------------------------------------------------------------
// stdin message format tests
// ---------------------------------------------------------------------------

describe("stdin message format", () => {
  test("stdin write produces correct user envelope", async () => {
    const manager = new SessionManager("/tmp/tugcode-stdin-test-" + Date.now(), crypto.randomUUID());

    // Inject mock with a result event so handleUserMessage terminates cleanly
    const mockStdin = injectMockSubprocess(manager, [
      { type: "result", subtype: "success", result: "" },
    ]);

    // Spy on mockStdin.write to capture what gets written
    const writtenData: string[] = [];
    mockStdin.write = (data: unknown) => {
      writtenData.push(String(data));
    };

    const userMsg = { type: "user_message" as const, content: [{ type: "text" as const, text: "hello world" }] };
    await captureIpcOutput(() => manager.handleUserMessage(userMsg));

    // Should have captured at least one write
    expect(writtenData.length).toBeGreaterThan(0);

    // Parse the first write (the user message envelope)
    const rawJson = writtenData[0].replace(/\n$/, "");
    const parsed = JSON.parse(rawJson);

    expect(parsed.type).toBe("user");
    expect(parsed.session_id).toBe("");
    expect(parsed.parent_tool_use_id).toBeNull();
    expect(parsed.message).toBeDefined();
    expect(parsed.message.role).toBe("user");
    expect(Array.isArray(parsed.message.content)).toBe(true);
    expect(parsed.message.content.length).toBe(1);
    expect(parsed.message.content[0].type).toBe("text");
    expect(parsed.message.content[0].text).toBe("hello world");
  });
});

// ---------------------------------------------------------------------------
// routeTopLevelEvent tests (Step 1)
// ---------------------------------------------------------------------------

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

  test("top-level tool_progress is swallowed (no unknown_event banner)", () => {
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
    expect(result.messages).toHaveLength(0);
    expect(result.gotResult).toBe(false);
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

  test("recordToolInputDelta correlates, throttles, and reports progress", () => {
    const turn = new ActiveTurn(7, [{ type: "text", text: "" }]);
    // Mint the tool_use block the way dispatchEventToTurn does, via the
    // content_block_start message — this is what gives the delta's
    // block_index its tool_use_id / tool_name.
    turn.updateBlockStateFromMessages([
      {
        type: "content_block_start",
        msg_id: "m1",
        block_index: 0,
        kind: "tool_use",
        tool_use_id: "toolu_1",
        tool_name: "Write",
        ipc_version: 2,
      },
    ]);

    // Fragment 1: opens the JSON, path value not yet closed → nothing
    // narratable yet, so no frame.
    expect(turn.recordToolInputDelta("m1", 0, '{"file_path":"src/a')).toBeNull();

    // Fragment 2: closes the path and opens content's first line.
    const p1 = turn.recordToolInputDelta("m1", 0, '.ts","content":"one\\n');
    expect(p1).not.toBeNull();
    expect(p1!.type).toBe("tool_input_progress");
    expect(p1!.tool_use_id).toBe("toolu_1");
    expect(p1!.tool_name).toBe("Write");
    expect(p1!.file_path).toBe("src/a.ts");
    expect(p1!.content_lines).toBe(2);

    // Fragment 3: line count advances → a fresh frame.
    const p2 = turn.recordToolInputDelta("m1", 0, "two\\nthree");
    expect(p2!.content_lines).toBe(3);

    // Fragment 4: no narratable change (still 3 lines, same path) → throttled.
    expect(turn.recordToolInputDelta("m1", 0, " words")).toBeNull();

    // Unknown block index → no correlation, no frame.
    expect(turn.recordToolInputDelta("m1", 9, '{"x":1}')).toBeNull();
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
// Step 2.2: Control protocol wiring tests
// ---------------------------------------------------------------------------

describe("control protocol (Step 2.2)", () => {
  test("control_request with can_use_tool emits ControlRequestForward IPC", async () => {
    const manager = new SessionManager("/tmp/tugcode-ctrl-test-" + Date.now(), crypto.randomUUID());

    // Inject mock with: a control_request event then a result event (to end the turn).
    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "control_request",
        request_id: "req-ctrl-1",
        request: { subtype: "can_use_tool", tool_name: "Write", input: { path: "/foo.ts" } },
      },
      { type: "result", subtype: "success", result: "" },
    ]);
    // Spy on stdin to suppress control_response writes from breaking the test
    mockStdin.write = (_data: unknown) => {};

    const userMsg = { type: "user_message" as const, content: [{ type: "text" as const, text: "do something" }] };
    const ipcMessages = await captureIpcOutput(() => manager.handleUserMessage(userMsg));

    const forwards = ipcMessages.filter((m: any) => m.type === "control_request_forward");
    expect(forwards.length).toBe(1);
    expect((forwards[0] as any).request_id).toBe("req-ctrl-1");
    expect((forwards[0] as any).tool_name).toBe("Write");
    expect((forwards[0] as any).is_question).toBe(false);
  });

  test("control_request with AskUserQuestion emits ControlRequestForward with is_question: true", async () => {
    const manager = new SessionManager("/tmp/tugcode-ctrl-question-" + Date.now(), crypto.randomUUID());

    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "control_request",
        request_id: "req-q-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "AskUserQuestion",
          input: { questions: [{ question: "Which file?" }] },
        },
      },
      { type: "result", subtype: "success", result: "" },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const userMsg = { type: "user_message" as const, content: [{ type: "text" as const, text: "ask me" }] };
    const ipcMessages = await captureIpcOutput(() => manager.handleUserMessage(userMsg));

    const forwards = ipcMessages.filter((m: any) => m.type === "control_request_forward");
    expect(forwards.length).toBe(1);
    expect((forwards[0] as any).is_question).toBe(true);
  });

  test("handleToolApproval allow sends correct control_response to stdin", async () => {
    const manager = new SessionManager("/tmp/tugcode-ctrl-allow-" + Date.now(), crypto.randomUUID());

    // Populate pendingControlRequests directly.
    const pendingCR = {
      type: "control_request",
      request_id: "req-allow-1",
      request: { subtype: "can_use_tool", tool_name: "Write", input: { path: "/bar.ts" } },
    };
    (manager as any).pendingControlRequests.set("req-allow-1", pendingCR);

    // Set up a mock process with stdin spy.
    const writtenData: string[] = [];
    (manager as any).claudeProcess = {
      stdin: {
        write: (data: unknown) => writtenData.push(String(data)),
        flush: () => {},
      },
    };

    manager.handleToolApproval({
      type: "tool_approval",
      request_id: "req-allow-1",
      decision: "allow",
    });

    expect(writtenData.length).toBeGreaterThan(0);
    const parsed = JSON.parse(writtenData[0].replace(/\n$/, ""));
    expect(parsed.type).toBe("control_response");
    const response = parsed.response;
    expect(response.subtype).toBe("success");
    expect(response.request_id).toBe("req-allow-1");
    // CRITICAL: "behavior" not "decision" per PN-1
    expect(response.response.behavior).toBe("allow");
    expect("decision" in response.response).toBe(false);
    // Pending request should be removed
    expect((manager as any).pendingControlRequests.has("req-allow-1")).toBe(false);
  });

  test("handleToolApproval allow forwards updatedPermissions for a durable scope", () => {
    const manager = new SessionManager("/tmp/tugcode-ctrl-allow-perm-" + Date.now(), crypto.randomUUID());

    const pendingCR = {
      type: "control_request",
      request_id: "req-allow-perm",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "tokei" } },
    };
    (manager as any).pendingControlRequests.set("req-allow-perm", pendingCR);

    const writtenData: string[] = [];
    (manager as any).claudeProcess = {
      stdin: {
        write: (data: unknown) => writtenData.push(String(data)),
        flush: () => {},
      },
    };

    const update = {
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "tokei:*" }],
      behavior: "allow",
      destination: "localSettings",
    };
    manager.handleToolApproval({
      type: "tool_approval",
      request_id: "req-allow-perm",
      decision: "allow",
      updatedPermissions: [update],
    });

    const parsed = JSON.parse(writtenData[0].replace(/\n$/, ""));
    // The chosen scope rides back so the CLI records the rule.
    expect(parsed.response.response.behavior).toBe("allow");
    expect(parsed.response.response.updatedPermissions).toEqual([update]);
  });

  test("handleToolApproval deny sends correct control_response to stdin", () => {
    const manager = new SessionManager("/tmp/tugcode-ctrl-deny-" + Date.now(), crypto.randomUUID());

    const pendingCR = {
      type: "control_request",
      request_id: "req-deny-1",
      request: { subtype: "can_use_tool", tool_name: "Write", input: {} },
    };
    (manager as any).pendingControlRequests.set("req-deny-1", pendingCR);

    const writtenData: string[] = [];
    (manager as any).claudeProcess = {
      stdin: {
        write: (data: unknown) => writtenData.push(String(data)),
        flush: () => {},
      },
    };

    manager.handleToolApproval({
      type: "tool_approval",
      request_id: "req-deny-1",
      decision: "deny",
      message: "Not allowed",
    });

    expect(writtenData.length).toBeGreaterThan(0);
    const parsed = JSON.parse(writtenData[0].replace(/\n$/, ""));
    expect(parsed.type).toBe("control_response");
    expect(parsed.response.response.behavior).toBe("deny");
    expect(parsed.response.response.message).toBe("Not allowed");
  });

  test("handleQuestionAnswer sends control_response with answers nested under 'answers' key per §5b", () => {
    const manager = new SessionManager("/tmp/tugcode-ctrl-qa-" + Date.now(), crypto.randomUUID());

    const pendingCR = {
      type: "control_request",
      request_id: "req-qa-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        input: { questions: [{ question: "Pick a color?" }] },
      },
    };
    (manager as any).pendingControlRequests.set("req-qa-1", pendingCR);

    const writtenData: string[] = [];
    (manager as any).claudeProcess = {
      stdin: {
        write: (data: unknown) => writtenData.push(String(data)),
        flush: () => {},
      },
    };

    manager.handleQuestionAnswer({
      type: "question_answer",
      request_id: "req-qa-1",
      answers: { "Pick a color?": "Red" },
    });

    expect(writtenData.length).toBeGreaterThan(0);
    const parsed = JSON.parse(writtenData[0].replace(/\n$/, ""));
    expect(parsed.type).toBe("control_response");
    expect(parsed.response.response.behavior).toBe("allow");
    // Per §5b: answers nested under "answers" key.
    expect(parsed.response.response.updatedInput.answers["Pick a color?"]).toBe("Red");
    // Original questions preserved.
    expect(parsed.response.response.updatedInput.questions).toBeDefined();
    expect((manager as any).pendingControlRequests.has("req-qa-1")).toBe(false);
  });

  test("handleInterrupt sends control_request with subtype interrupt (not SIGINT)", () => {
    const manager = new SessionManager("/tmp/tugcode-ctrl-interrupt-" + Date.now(), crypto.randomUUID());

    const writtenData: string[] = [];
    let killCalled = false;
    (manager as any).claudeProcess = {
      stdin: {
        write: (data: unknown) => writtenData.push(String(data)),
        flush: () => {},
      },
      kill: () => { killCalled = true; },
    };

    manager.handleInterrupt();

    // Step R1e: the interrupted flag now lives on the active turn,
    // not on SessionManager. With no turn in flight, handleInterrupt
    // still sends the control_request — the per-turn flag flip is
    // tested separately when a turn is active.
    // Must use control protocol, not SIGINT.
    expect(killCalled).toBe(false);
    expect(writtenData.length).toBeGreaterThan(0);
    const parsed = JSON.parse(writtenData[0].replace(/\n$/, ""));
    expect(parsed.type).toBe("control_request");
    expect(parsed.request.subtype).toBe("interrupt");
    expect(parsed.request_id.startsWith("ctrl-")).toBe(true);
  });

  test("control_cancel_request cancels pending permission", async () => {
    const manager = new SessionManager("/tmp/tugcode-ctrl-cancel-" + Date.now(), crypto.randomUUID());

    // Inject: a control_request to populate pendingControlRequests, then a
    // control_cancel_request for the same id, then a result to end the turn.
    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "control_request",
        request_id: "req-cancel-1",
        request: { subtype: "can_use_tool", tool_name: "Write", input: { path: "/x.ts" } },
      },
      {
        type: "control_cancel_request",
        request_id: "req-cancel-1",
      },
      { type: "result", subtype: "success", result: "" },
    ]);
    // Suppress any stdin writes (control_request_forward ack etc.)
    mockStdin.write = (_data: unknown) => {};

    const userMsg = { type: "user_message" as const, content: [{ type: "text" as const, text: "do something" }] };
    const ipcMessages = await captureIpcOutput(() => manager.handleUserMessage(userMsg));

    // A control_request_cancel IPC must be emitted so the frontend dismisses the dialog.
    const cancels = ipcMessages.filter((m: any) => m.type === "control_request_cancel");
    expect(cancels.length).toBe(1);
    expect((cancels[0] as any).request_id).toBe("req-cancel-1");

    // The pending entry must have been removed from pendingControlRequests.
    expect((manager as any).pendingControlRequests.has("req-cancel-1")).toBe(false);
  });

  test("handleModelChange sends control_request with subtype set_model", () => {
    const manager = new SessionManager("/tmp/tugcode-ctrl-model-" + Date.now(), crypto.randomUUID());

    const writtenData: string[] = [];
    (manager as any).claudeProcess = {
      stdin: {
        write: (data: unknown) => writtenData.push(String(data)),
        flush: () => {},
      },
    };

    manager.handleModelChange("claude-haiku-3-5");

    expect(writtenData.length).toBeGreaterThan(0);
    const parsed = JSON.parse(writtenData[0].replace(/\n$/, ""));
    expect(parsed.type).toBe("control_request");
    expect(parsed.request.subtype).toBe("set_model");
    expect(parsed.request.model).toBe("claude-haiku-3-5");
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
// buildContentBlocksFromLegacyJournal tests (Step 4)
// ---------------------------------------------------------------------------

describe("buildContentBlocksFromLegacyJournal", () => {
  test("text-only message produces single text block", () => {
    const blocks = buildContentBlocksFromLegacyJournal("hello world", []);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect((blocks[0] as ContentBlockText).text).toBe("hello world");
  });

  test("non-image attachment is silently dropped (images-only contract)", () => {
    // Inline attachments are images-only per the Claude Agent SDK's
    // user-message input pipeline. A legacy journal row carrying a
    // text-typed attachment (an artifact of an older drop pipeline
    // that briefly supported text-file attachments) is skipped — the
    // text block of the prompt itself still rides.
    const blocks = buildContentBlocksFromLegacyJournal("intro", [
      { filename: "file.txt", content: "file contents", media_type: "text/plain" },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect((blocks[0] as ContentBlockText).text).toBe("intro");
  });

  test("image attachment produces image content block with base64 source", () => {
    // ~10 bytes of fake base64 (well under 5MB)
    const fakeBase64 = "aGVsbG8=";
    const blocks = buildContentBlocksFromLegacyJournal("see image", [
      { filename: "photo.png", content: fakeBase64, media_type: "image/png" },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("text");
    const imgBlock = blocks[1] as any;
    expect(imgBlock.type).toBe("image");
    expect(imgBlock.source.type).toBe("base64");
    expect(imgBlock.source.media_type).toBe("image/png");
    expect(imgBlock.source.data).toBe(fakeBase64);
  });

  test("unsupported image media type is rejected per PN-12", () => {
    expect(() =>
      buildContentBlocksFromLegacyJournal("img", [
        { filename: "photo.bmp", content: "abc", media_type: "image/bmp" },
      ])
    ).toThrow("Unsupported image type: image/bmp");
  });

  test("image exceeding ~5MB is rejected per PN-12", () => {
    // ~5MB base64 = 5*1024*1024 * 4/3 ≈ 7MB of base64 chars; use slightly more
    const oversizedContent = "A".repeat(7 * 1024 * 1024 + 1);
    expect(() =>
      buildContentBlocksFromLegacyJournal("big", [
        { filename: "huge.png", content: oversizedContent, media_type: "image/png" },
      ])
    ).toThrow("~5MB limit");
  });

  test("mixed text and image produces correct ordered content array", () => {
    const blocks = buildContentBlocksFromLegacyJournal("caption", [
      { filename: "img.jpg", content: "aGVsbG8=", media_type: "image/jpeg" },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("text");
    expect(blocks[1].type).toBe("image");
    expect((blocks[1] as any).source.media_type).toBe("image/jpeg");
  });

  test("empty text with no attachments produces fallback empty text block", () => {
    const blocks = buildContentBlocksFromLegacyJournal("", []);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect((blocks[0] as ContentBlockText).text).toBe("");
  });

  test("all four supported image types are accepted", () => {
    const types = ["image/png", "image/jpeg", "image/gif", "image/webp"];
    for (const mediaType of types) {
      expect(() =>
        buildContentBlocksFromLegacyJournal("img", [
          { filename: "img", content: "aGVsbG8=", media_type: mediaType },
        ])
      ).not.toThrow();
    }
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

// ---------------------------------------------------------------------------
// Session management method tests (Step 4)
// ---------------------------------------------------------------------------

describe("session management", () => {
  test("buildClaudeArgs with continue + forkSession produces --continue --fork-session", () => {
    const args = buildClaudeArgs({
      pluginDir: "/repo",
      model: "claude-opus-4-6",
      permissionMode: "acceptEdits",
      sessionId: null,
      continue: true,
      forkSession: true,
    });
    expect(args).toContain("--continue");
    expect(args).toContain("--fork-session");
    expect(args).not.toContain("--resume");
  });

  test("buildClaudeArgs with continue only produces --continue without --fork-session", () => {
    const args = buildClaudeArgs({
      pluginDir: "/repo",
      model: "claude-opus-4-6",
      permissionMode: "acceptEdits",
      sessionId: null,
      continue: true,
    });
    expect(args).toContain("--continue");
    expect(args).not.toContain("--fork-session");
    expect(args).not.toContain("--resume");
  });

  test("session commands compose claude args without --resume for the fresh path", () => {
    // handleSessionFork uses continue: true, forkSession: true.
    const forkArgs = buildClaudeArgs({
      pluginDir: "/repo",
      permissionMode: "acceptEdits", sessionId: null,
      continue: true, forkSession: true,
    });
    expect(forkArgs).toContain("--continue");
    expect(forkArgs).toContain("--fork-session");

    // handleSessionContinue uses continue: true only.
    const continueArgs = buildClaudeArgs({
      pluginDir: "/repo",
      permissionMode: "acceptEdits", sessionId: null,
      continue: true,
    });
    expect(continueArgs).toContain("--continue");
    expect(continueArgs).not.toContain("--fork-session");

    // handleNewSession uses no session flags.
    const newArgs = buildClaudeArgs({
      pluginDir: "/repo",
      permissionMode: "acceptEdits", sessionId: null,
    });
    expect(newArgs).not.toContain("--continue");
    expect(newArgs).not.toContain("--fork-session");
    expect(newArgs).not.toContain("--resume");
  });

  test("shutdown completes without error when no process is attached", async () => {
    const manager = new SessionManager("/tmp/tugcode-shutdown-" + Date.now(), crypto.randomUUID());
    await expect(manager.shutdown()).resolves.toBeUndefined();
  });

  test("stdin close (EOF) triggers graceful shutdown sequence", async () => {
    const manager = new SessionManager("/tmp/tugcode-shutdown-eof-" + Date.now(), crypto.randomUUID());

    // Record the call order so we can assert stdin.end() happens before kill().
    const callOrder: string[] = [];

    // Build a mock process where:
    //   - stdin.end() is spied on and resolves immediately (no real process)
    //   - exited is a Promise that resolves immediately (simulates fast exit)
    //   - kill() is spied on to verify it is called after stdin.end()
    const mockProcess = {
      stdin: {
        write: (_data: unknown) => {},
        flush: () => {},
        end: () => {
          callOrder.push("stdin.end");
        },
      },
      // Resolves immediately so killAndCleanup doesn't wait 5 seconds.
      exited: Promise.resolve(0),
      kill: (_signal?: string) => {
        callOrder.push("kill");
      },
      // stdout is unused after injection but must be present for type shape.
      stdout: new ReadableStream(),
    };

    // Inject the mock process directly, bypassing initialize().
    (manager as any).claudeProcess = mockProcess;
    (manager as any).stdoutReader = null;
    (manager as any).stdoutBuffer = "";

    await manager.shutdown();

    // A claude that exits within its EOF grace needs no signal at all —
    // the graceful path is EOF, wait, done.
    expect(callOrder).toEqual(["stdin.end"]);

    // claudeProcess must be nulled out after shutdown.
    expect((manager as any).claudeProcess).toBeNull();
  });

  test("a claude that outlives its EOF grace is escalated to SIGKILL", async () => {
    const manager = new SessionManager(
      "/tmp/tugcode-shutdown-wedged-" + Date.now(),
      crypto.randomUUID(),
    );

    const callOrder: string[] = [];
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((res) => {
      resolveExit = res;
    });
    // A wedged claude: ignores EOF and SIGTERM, dies only to SIGKILL.
    // The ladder must reach SIGKILL — otherwise the stdout drain never
    // sees EOF and shutdown hangs forever.
    const mockProcess = {
      stdin: {
        write: (_data: unknown) => {},
        flush: () => {},
        end: () => {
          callOrder.push("stdin.end");
        },
      },
      exited,
      kill: (signal?: string) => {
        callOrder.push(signal ?? "SIGTERM");
        if (signal === "SIGKILL") resolveExit(137);
      },
      stdout: new ReadableStream(),
    };
    (manager as any).claudeProcess = mockProcess;
    (manager as any).stdoutReader = null;
    (manager as any).stdoutBuffer = "";

    await manager.shutdown({ graceMs: 50 });

    expect(callOrder).toEqual(["stdin.end", "SIGTERM", "SIGKILL"]);
    expect((manager as any).claudeProcess).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SessionManager behavioral tests (Step 5)
// ---------------------------------------------------------------------------

describe("SessionManager behavioral", () => {
  test("constructor does not throw", () => {
    expect(() => new SessionManager("/tmp/test-constructor", crypto.randomUUID())).not.toThrow();
  });

  test("initialize() in 'new' mode spawns claude with --session-id and emits synthetic session_init", async () => {
    // Both modes share a single codepath: spawn claude with the
    // appropriate flag, emit a synthetic `session_init` IPC line
    // (claude in stream-json mode never emits `system:init` until it
    // receives input), and let the early-exit watcher run in the
    // background.
    const suffix = Date.now();
    const projectDir = `/tmp/init-new-${suffix}`;
    const id = crypto.randomUUID();
    const manager = new SessionManager(projectDir, id);

    const calls: Array<{ id: string | null; mode: string }> = [];
    (manager as any).spawnClaude = (
      sid: string | null,
      mode: "session-id" | "resume",
    ) => {
      calls.push({ id: sid, mode });
      return {
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        stdin: { write: () => {}, end: () => {}, flush: () => {} },
        // Never resolves: simulates a healthy claude waiting for input.
        // The watcher's timeout would resolve `kind: "timeout"` and noop.
        exited: new Promise<number>(() => {}),
        kill: () => {},
      };
    };

    const emitted = await captureIpcOutput(async () => {
      await manager.initialize();
    });

    expect(calls).toEqual([{ id, mode: "session-id" }]);
    const initLines = emitted.filter(
      (e: any) => e?.type === "session_init",
    );
    expect(initLines.length).toBe(1);
    expect((initLines[0] as any).session_id).toBe(id);
    // The spawn-time cwd frame ([#step-12a]) carries the project dir so the
    // client knows the resolved cwd from the drop.
    const cwdMeta = emitted.filter((e: any) => e?.type === "system_metadata");
    expect(cwdMeta.length).toBe(1);
    expect((cwdMeta[0] as any).cwd).toBe(projectDir);
  });

  test("initialize() in 'resume' mode spawns claude with --resume and emits synthetic session_init", async () => {
    const suffix = Date.now();
    const projectDir = `/tmp/init-resume-${suffix}`;
    const id = crypto.randomUUID();

    const manager = new SessionManager(projectDir, id, "resume");
    const calls: Array<{ id: string | null; mode: string }> = [];
    (manager as any).spawnClaude = (
      sid: string | null,
      mode: "session-id" | "resume",
    ) => {
      calls.push({ id: sid, mode });
      return {
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        stdin: { write: () => {}, end: () => {}, flush: () => {} },
        // Healthy claude — never exits during the watcher window.
        exited: new Promise<number>(() => {}),
        kill: () => {},
      };
    };

    const emitted = await captureIpcOutput(async () => {
      await manager.initialize();
    });

    expect(calls).toEqual([{ id, mode: "resume" }]);
    const initLines = emitted.filter(
      (e: any) => e?.type === "session_init",
    );
    expect(initLines.length).toBe(1);
    expect((initLines[0] as any).session_id).toBe(id);
    // No `resume_failed` should fire on the happy path.
    const failedLines = emitted.filter(
      (e: any) => e?.type === "resume_failed",
    );
    expect(failedLines.length).toBe(0);
    // The spawn-time cwd frame fires on resume too ([#step-12a]) — symmetric
    // with new mode, so a resumed-but-never-used session still knows its cwd.
    const cwdMeta = emitted.filter((e: any) => e?.type === "system_metadata");
    expect(cwdMeta.length).toBe(1);
    expect((cwdMeta[0] as any).cwd).toBe(projectDir);
  });

  // Test helper: build a mock claude subprocess with controllable
  // exit + optional stderr stream. Returns the controls so each test
  // drives the lifecycle deterministically.
  function makeWatcherMock(opts?: { stderrLines?: string[] }) {
    let exitResolve: ((code: number) => void) | null = null;
    const stderr =
      opts?.stderrLines && opts.stderrLines.length > 0
        ? new ReadableStream<Uint8Array>({
            start(controller) {
              const enc = new TextEncoder();
              for (const line of opts.stderrLines!) {
                controller.enqueue(enc.encode(line + "\n"));
              }
              controller.close();
            },
          })
        : new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          });
    const child = {
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      stderr,
      stdin: { write: () => {}, end: () => {}, flush: () => {} },
      exited: new Promise<number>((r) => {
        exitResolve = r;
      }),
      kill: () => {},
    };
    return {
      child,
      exit: (code: number) => exitResolve!(code),
    };
  }

  function stubProcessExit(): { restore: () => void; calledWith: () => number | undefined } {
    const original = process.exit;
    let called: number | undefined;
    (process as any).exit = (code?: number) => {
      called = code;
    };
    return {
      restore: () => {
        (process as any).exit = original;
      },
      calledWith: () => called,
    };
  }

  test("watcher emits resume_failed when claude exits and mode is resume (no stderr signal)", async () => {
    const id = crypto.randomUUID();
    const manager = new SessionManager(`/tmp/init-stale-${Date.now()}`, id, "resume");
    const m = makeWatcherMock();
    (manager as any).spawnClaude = () => m.child;

    const exitStub = stubProcessExit();
    let emitted: unknown[] = [];
    try {
      emitted = await captureIpcOutput(async () => {
        await manager.initialize();
        m.exit(1);
        // Two ticks: one for child.exited, one for writeLineAndExit's await.
        await new Promise((r) => setTimeout(r, 10));
      });
    } finally {
      exitStub.restore();
    }

    const failed = emitted.filter((e: any) => e?.type === "resume_failed");
    expect(failed.length).toBe(1);
    expect((failed[0] as any).stale_session_id).toBe(id);
    expect((failed[0] as any).reason).toContain("code 1");
    expect(exitStub.calledWith()).toBe(0);
  });

  test("watcher emits error when claude exits and mode is fresh (no stderr signal)", async () => {
    const id = crypto.randomUUID();
    const manager = new SessionManager(`/tmp/init-fresh-collide-${Date.now()}`, id);
    const m = makeWatcherMock();
    (manager as any).spawnClaude = () => m.child;

    const exitStub = stubProcessExit();
    let emitted: unknown[] = [];
    try {
      emitted = await captureIpcOutput(async () => {
        await manager.initialize();
        m.exit(1);
        await new Promise((r) => setTimeout(r, 10));
      });
    } finally {
      exitStub.restore();
    }

    const errors = emitted.filter((e: any) => e?.type === "error");
    expect(errors.length).toBe(1);
    expect((errors[0] as any).message).toContain("code 1");
    const failed = emitted.filter((e: any) => e?.type === "resume_failed");
    expect(failed.length).toBe(0);
  });

  // Fix #1: indefinite watch — the watcher fires no matter how late
  // claude exits, as long as no input has been written yet.
  test("watcher classifies init failure regardless of how long claude takes to exit", async () => {
    const id = crypto.randomUUID();
    const manager = new SessionManager(`/tmp/init-slow-${Date.now()}`, id, "resume");
    const m = makeWatcherMock();
    (manager as any).spawnClaude = () => m.child;

    const exitStub = stubProcessExit();
    let emitted: unknown[] = [];
    try {
      emitted = await captureIpcOutput(async () => {
        await manager.initialize();
        // Wait WELL past the old 3s window before triggering exit.
        // The point of fix #1 is that there is no window any more.
        await new Promise((r) => setTimeout(r, 50));
        m.exit(1);
        await new Promise((r) => setTimeout(r, 10));
      });
    } finally {
      exitStub.restore();
    }

    const failed = emitted.filter((e: any) => e?.type === "resume_failed");
    expect(failed.length).toBe(1);
  });

  // Fix #1: once claude has received input, a subsequent exit is a
  // runtime crash, not an init failure. Watcher must NOT emit.
  test("watcher does NOT emit when claude exits after first user input", async () => {
    const id = crypto.randomUUID();
    const manager = new SessionManager(`/tmp/init-after-input-${Date.now()}`, id, "resume");
    const m = makeWatcherMock();
    (manager as any).spawnClaude = () => m.child;

    const exitStub = stubProcessExit();
    let emitted: unknown[] = [];
    try {
      emitted = await captureIpcOutput(async () => {
        await manager.initialize();
        // Simulate the side-effect of a successful first turn write.
        (manager as any).claudeReceivedInput = true;
        m.exit(137); // killed by SIGKILL mid-turn, for example
        await new Promise((r) => setTimeout(r, 10));
      });
    } finally {
      exitStub.restore();
    }

    const failed = emitted.filter((e: any) => e?.type === "resume_failed");
    expect(failed.length).toBe(0);
    const errors = emitted.filter((e: any) => e?.type === "error");
    expect(errors.length).toBe(0);
    expect(exitStub.calledWith()).toBeUndefined();
  });

  // Fix #2: shutdown cancels the watcher's IPC emission.
  test("watcher does NOT emit when shutdown is in progress", async () => {
    const id = crypto.randomUUID();
    const manager = new SessionManager(`/tmp/init-shutdown-${Date.now()}`, id, "resume");
    const m = makeWatcherMock();
    (manager as any).spawnClaude = () => m.child;

    const exitStub = stubProcessExit();
    let emitted: unknown[] = [];
    try {
      emitted = await captureIpcOutput(async () => {
        await manager.initialize();
        // Mark shutdown (as killAndCleanup would).
        (manager as any).isShuttingDown = true;
        m.exit(0);
        await new Promise((r) => setTimeout(r, 10));
      });
    } finally {
      exitStub.restore();
    }

    const failed = emitted.filter((e: any) => e?.type === "resume_failed");
    expect(failed.length).toBe(0);
    const errors = emitted.filter((e: any) => e?.type === "error");
    expect(errors.length).toBe(0);
    expect(exitStub.calledWith()).toBeUndefined();
  });

  // Fix #4: stderr "No conversation found" forces resume_failed even
  // when the session mode is fresh (definitive classification wins
  // over the mode-based default).
  test("stderr 'No conversation found' classifies as resume_failed regardless of mode", async () => {
    const id = crypto.randomUUID();
    const manager = new SessionManager(`/tmp/init-stderr-rf-${Date.now()}`, id);
    const m = makeWatcherMock({
      stderrLines: ["No conversation found with session ID: " + id],
    });
    (manager as any).spawnClaude = () => m.child;

    const exitStub = stubProcessExit();
    let emitted: unknown[] = [];
    try {
      emitted = await captureIpcOutput(async () => {
        await manager.initialize();
        // Yield so the stderr reader picks up the line before exit fires.
        await new Promise((r) => setTimeout(r, 10));
        m.exit(1);
        await new Promise((r) => setTimeout(r, 10));
      });
    } finally {
      exitStub.restore();
    }

    const failed = emitted.filter((e: any) => e?.type === "resume_failed");
    expect(failed.length).toBe(1);
    expect((failed[0] as any).reason).toContain("No conversation found");
  });

  // A `--session-id` collision ("is already in use") is a deterministic,
  // non-retrying failure: re-spawning with the same args just re-collides.
  // It routes to the `resume_failed` IPC (the bridge's non-retrying path
  // that clears the binding and offers the picker), NOT a generic `error`
  // frame — an `error` frame reads to the bridge as a crash and burns the
  // crash budget on three identical collisions before locking the card.
  test("stderr 'is already in use' emits a non-retrying resume_failed", async () => {
    const id = crypto.randomUUID();
    const manager = new SessionManager(`/tmp/init-stderr-coll-${Date.now()}`, id);
    const m = makeWatcherMock({
      stderrLines: ["Error: Session ID " + id + " is already in use."],
    });
    (manager as any).spawnClaude = () => m.child;

    const exitStub = stubProcessExit();
    let emitted: unknown[] = [];
    try {
      emitted = await captureIpcOutput(async () => {
        await manager.initialize();
        await new Promise((r) => setTimeout(r, 10));
        m.exit(1);
        await new Promise((r) => setTimeout(r, 10));
      });
    } finally {
      exitStub.restore();
    }

    const failed = emitted.filter((e: any) => e?.type === "resume_failed");
    expect(failed.length).toBe(1);
    expect((failed[0] as any).reason).toContain("already in use");
    expect((failed[0] as any).stale_session_id).toBe(id);
    const errors = emitted.filter((e: any) => e?.type === "error");
    expect(errors.length).toBe(0);
  });

  test("handlePermissionMode updates permissionManager state", () => {
    const manager = new SessionManager("/tmp/tugcode-perm-mode-" + Date.now(), crypto.randomUUID());
    manager.handlePermissionMode({ type: "permission_mode", mode: "bypassPermissions" });
    expect((manager as any).permissionManager.getMode()).toBe("bypassPermissions");
  });

  test("handlePermissionMode accepts all valid mode values", () => {
    const manager = new SessionManager("/tmp/tugcode-perm-all-" + Date.now(), crypto.randomUUID());
    const modes = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "delegate"] as const;
    for (const mode of modes) {
      manager.handlePermissionMode({ type: "permission_mode", mode });
      expect((manager as any).permissionManager.getMode()).toBe(mode);
    }
  });
});

// ---------------------------------------------------------------------------
// handleUserMessage integration tests (Step 5)
// ---------------------------------------------------------------------------

describe("handleUserMessage integration", () => {
  test("full round-trip: system init -> stream deltas -> result produces correct IPC sequence", async () => {
    const manager = new SessionManager("/tmp/tugcode-roundtrip-" + Date.now(), crypto.randomUUID());

    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "system",
        subtype: "init",
        session_id: "integration-sess-1",
        cwd: "/proj",
        tools: ["Read"],
        model: "claude-opus-4-6",
        permissionMode: "acceptEdits",
        slash_commands: [],
        plugins: [],
        agents: [],
        skills: [],
        claude_code_version: "2.1.38",
      },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: " World" } } },
      { type: "result", subtype: "success", result: "" },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const userMsg = { type: "user_message" as const, content: [{ type: "text" as const, text: "hi" }] };
    const ipcMessages = await captureIpcOutput(() => manager.handleUserMessage(userMsg));

    // System metadata must have been emitted.
    const sysMeta = ipcMessages.find((m: any) => m.type === "system_metadata");
    expect(sysMeta).toBeDefined();
    expect((sysMeta as any).session_id).toBe("integration-sess-1");

    // At least one assistant_text with "Hello" from stream deltas.
    const assistantTexts = ipcMessages.filter((m: any) => m.type === "assistant_text");
    const helloMsg = assistantTexts.find((m: any) => m.text === "Hello");
    expect(helloMsg).toBeDefined();

    // CostUpdate before turn_complete.
    const costUpdate = ipcMessages.find((m: any) => m.type === "cost_update");
    expect(costUpdate).toBeDefined();
    const turnComplete = ipcMessages.find((m: any) => m.type === "turn_complete");
    expect(turnComplete).toBeDefined();
    expect((turnComplete as any).result).toBe("success");
    const cuIdx = ipcMessages.findIndex((m: any) => m.type === "cost_update");
    const tcIdx = ipcMessages.findIndex((m: any) => m.type === "turn_complete");
    expect(cuIdx).toBeLessThan(tcIdx);
  });


  test("stdin receives correct user envelope with image attachment", async () => {
    const manager = new SessionManager("/tmp/tugcode-img-envelope-" + Date.now(), crypto.randomUUID());

    const writtenData: string[] = [];
    const mockStdin = injectMockSubprocess(manager, [
      { type: "result", subtype: "success", result: "" },
    ]);
    mockStdin.write = (data: unknown) => writtenData.push(String(data));

    const fakeBase64 = "aGVsbG8="; // "hello" in base64
    const userMsg = {
      type: "user_message" as const,
      content: [
        { type: "text" as const, text: "look at this image" },
        {
          type: "image" as const,
          source: { type: "base64" as const, media_type: "image/png", data: fakeBase64 },
        },
      ],
    };
    await captureIpcOutput(() => manager.handleUserMessage(userMsg));

    expect(writtenData.length).toBeGreaterThan(0);
    const parsed = JSON.parse(writtenData[0].replace(/\n$/, ""));
    expect(parsed.type).toBe("user");
    expect(Array.isArray(parsed.message.content)).toBe(true);

    const textBlock = parsed.message.content.find((b: any) => b.type === "text");
    expect(textBlock).toBeDefined();
    expect(textBlock.text).toBe("look at this image");

    const imageBlock = parsed.message.content.find((b: any) => b.type === "image");
    expect(imageBlock).toBeDefined();
    expect(imageBlock.source.type).toBe("base64");
    expect(imageBlock.source.media_type).toBe("image/png");
    expect(imageBlock.source.data).toBe(fakeBase64);
  });

  test("error_during_execution result produces turn_complete with result: error", async () => {
    const manager = new SessionManager("/tmp/tugcode-err-turn-" + Date.now(), crypto.randomUUID());
    const mockStdin = injectMockSubprocess(manager, [
      { type: "result", subtype: "error_during_execution", result: "" },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const userMsg = { type: "user_message" as const, content: [{ type: "text" as const, text: "go" }] };
    const ipcMessages = await captureIpcOutput(() => manager.handleUserMessage(userMsg));

    const tc = ipcMessages.find((m: any) => m.type === "turn_complete") as any;
    expect(tc).toBeDefined();
    expect(tc.result).toBe("error");
  });

  test("isReplay slash command stdout extracted from replayed user message (array content)", async () => {
    const manager = new SessionManager("/tmp/tugcode-replay-" + Date.now(), crypto.randomUUID());
    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "user",
        isReplay: true,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu-slash",
              content: "<local-command-stdout>slash output text</local-command-stdout>",
              is_error: false,
            },
          ],
        },
      },
      { type: "result", subtype: "success", result: "" },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const userMsg = { type: "user_message" as const, content: [{ type: "text" as const, text: "run slash" }] };
    const ipcMessages = await captureIpcOutput(() => manager.handleUserMessage(userMsg));

    const textMsgs = ipcMessages.filter((m: any) => m.type === "assistant_text");
    const slashOutput = textMsgs.find((m: any) => m.text.includes("slash output text"));
    expect(slashOutput).toBeDefined();
  });

  test("slash command with string content (/context flow) produces output and no empty assistant_text", async () => {
    // Simulates the exact /context protocol flow: user isReplay with string content,
    // then result with empty result text. No streaming events.
    const manager = new SessionManager("/tmp/tugcode-slash-str-" + Date.now(), crypto.randomUUID());
    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "user",
        isReplay: true,
        message: {
          role: "user",
          content: "<local-command-stdout>## Context Usage\n**Model:** claude-opus-4-6\n**Tokens:** 23.9k / 200k (12%)</local-command-stdout>",
        },
      },
      { type: "result", subtype: "success", result: "" },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const userMsg = { type: "user_message" as const, content: [{ type: "text" as const, text: "/context" }] };
    const ipcMessages = await captureIpcOutput(() => manager.handleUserMessage(userMsg));

    // Must have the command output as assistant_text.
    const textMsgs = ipcMessages.filter((m: any) => m.type === "assistant_text");
    const contextOutput = textMsgs.find((m: any) => m.text.includes("Context Usage"));
    expect(contextOutput).toBeDefined();
    expect((contextOutput as any).is_partial).toBe(false);

    // Must NOT have an empty assistant_text (the partialText-based one should be skipped).
    const emptyTexts = textMsgs.filter((m: any) => m.text === "");
    expect(emptyTexts.length).toBe(0);

    // Must have turn_complete.
    const turnComplete = ipcMessages.find((m: any) => m.type === "turn_complete");
    expect(turnComplete).toBeDefined();
    expect((turnComplete as any).result).toBe("success");
  });
});

// ---------------------------------------------------------------------------
// Step 6 audit fixup tests
// ---------------------------------------------------------------------------

describe("ControlRequestForward blocked_path and tool_use_id (Step 6)", () => {
  test("control_request with blocked_path and tool_use_id forwards them in IPC", async () => {
    const manager = new SessionManager("/tmp/tugcode-ctrl-blocked-" + Date.now(), crypto.randomUUID());

    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "control_request",
        request_id: "req-blocked-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Write",
          input: { path: "/etc/passwd" },
          blocked_path: "/etc/passwd",
          tool_use_id: "tu-write-blocked",
        },
      },
      { type: "result", subtype: "success", result: "" },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const userMsg = { type: "user_message" as const, content: [{ type: "text" as const, text: "write to etc" }] };
    const ipcMessages = await captureIpcOutput(() => manager.handleUserMessage(userMsg));

    const forward = ipcMessages.find((m: any) => m.type === "control_request_forward") as any;
    expect(forward).toBeDefined();
    expect(forward.request_id).toBe("req-blocked-1");
    expect(forward.blocked_path).toBe("/etc/passwd");
    expect(forward.tool_use_id).toBe("tu-write-blocked");
  });

  test("control_request without blocked_path/tool_use_id still produces valid forward", async () => {
    const manager = new SessionManager("/tmp/tugcode-ctrl-noblocked-" + Date.now(), crypto.randomUUID());

    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "control_request",
        request_id: "req-no-extra-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Read",
          input: { path: "/safe.ts" },
        },
      },
      { type: "result", subtype: "success", result: "" },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const userMsg = { type: "user_message" as const, content: [{ type: "text" as const, text: "read file" }] };
    const ipcMessages = await captureIpcOutput(() => manager.handleUserMessage(userMsg));

    const forward = ipcMessages.find((m: any) => m.type === "control_request_forward") as any;
    expect(forward).toBeDefined();
    expect(forward.blocked_path).toBeUndefined();
    expect(forward.tool_use_id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §13 Slash Commands — Comprehensive coverage for all 12 commands
// ---------------------------------------------------------------------------

describe("slash commands: all 12 from §13", () => {
  // =========================================================================
  // LOCAL COMMANDS: /compact, /cost, /context
  // Protocol: user(isReplay, string content) → result(success, "")
  // =========================================================================

  test("/context success: string content with local-command-stdout", async () => {
    const manager = new SessionManager("/tmp/tugcode-slash-context-" + Date.now(), crypto.randomUUID());
    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "user",
        isReplay: true,
        message: {
          role: "user",
          content: "<local-command-stdout>## Context Usage\n**Model:** claude-opus-4-6\n**Tokens:** 23.9k / 200k (12%)\n\n| Category | Tokens |\n|----------|--------|\n| System prompt | 3,200 |</local-command-stdout>",
        },
      },
      { type: "result", subtype: "success", result: "" },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const ipcMessages = await captureIpcOutput(() =>
      manager.handleUserMessage({ type: "user_message", content: [{ type: "text" as const, text: "/context" }] })
    );

    const textMsgs = ipcMessages.filter((m: any) => m.type === "assistant_text");
    expect(textMsgs.length).toBe(1);
    expect((textMsgs[0] as any).text).toContain("Context Usage");
    expect((textMsgs[0] as any).text).toContain("23.9k / 200k");
    expect((textMsgs[0] as any).is_partial).toBe(false);
    // No empty ghost message.
    expect(textMsgs.filter((m: any) => m.text === "").length).toBe(0);
    // turn_complete present.
    expect(ipcMessages.find((m: any) => m.type === "turn_complete")).toBeDefined();
  });

  test("/cost success: string content with cost data", async () => {
    const manager = new SessionManager("/tmp/tugcode-slash-cost-" + Date.now(), crypto.randomUUID());
    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "user",
        isReplay: true,
        message: {
          role: "user",
          content: "<local-command-stdout>Total cost: $0.04\nDuration: 12.3s\nInput tokens: 5,000\nOutput tokens: 1,200</local-command-stdout>",
        },
      },
      { type: "result", subtype: "success", result: "" },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const ipcMessages = await captureIpcOutput(() =>
      manager.handleUserMessage({ type: "user_message", content: [{ type: "text" as const, text: "/cost" }] })
    );

    const textMsgs = ipcMessages.filter((m: any) => m.type === "assistant_text");
    expect(textMsgs.length).toBe(1);
    expect((textMsgs[0] as any).text).toContain("Total cost: $0.04");
    expect((textMsgs[0] as any).is_partial).toBe(false);
    expect(ipcMessages.find((m: any) => m.type === "turn_complete")).toBeDefined();
  });

  test("/compact success: no output (just result)", async () => {
    // Per §13a: /compact has "No output if successful."
    // The CLI may emit no user message at all, just the result.
    const manager = new SessionManager("/tmp/tugcode-slash-compact-ok-" + Date.now(), crypto.randomUUID());
    const mockStdin = injectMockSubprocess(manager, [
      { type: "result", subtype: "success", result: "" },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const ipcMessages = await captureIpcOutput(() =>
      manager.handleUserMessage({ type: "user_message", content: [{ type: "text" as const, text: "/compact" }] })
    );

    // No assistant_text (no output to show, partialText empty).
    const textMsgs = ipcMessages.filter((m: any) => m.type === "assistant_text");
    expect(textMsgs.length).toBe(0);
    // turn_complete must still be emitted.
    const tc = ipcMessages.find((m: any) => m.type === "turn_complete") as any;
    expect(tc).toBeDefined();
    expect(tc.result).toBe("success");
  });

  test("/compact error: string content with local-command-stderr", async () => {
    // Per §13c: even errors have result subtype "success".
    const manager = new SessionManager("/tmp/tugcode-slash-compact-err-" + Date.now(), crypto.randomUUID());
    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "user",
        isReplay: true,
        message: {
          role: "user",
          content: "<local-command-stderr>Error: No messages to compact</local-command-stderr>",
        },
      },
      { type: "result", subtype: "success", result: "" },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const ipcMessages = await captureIpcOutput(() =>
      manager.handleUserMessage({ type: "user_message", content: [{ type: "text" as const, text: "/compact" }] })
    );

    // Error message extracted from stderr tags.
    const errors = ipcMessages.filter((m: any) => m.type === "error");
    expect(errors.length).toBe(1);
    expect((errors[0] as any).message).toContain("No messages to compact");
    expect((errors[0] as any).recoverable).toBe(true);
    // No assistant_text (no stdout).
    const textMsgs = ipcMessages.filter((m: any) => m.type === "assistant_text");
    expect(textMsgs.length).toBe(0);
    // turn_complete present.
    expect(ipcMessages.find((m: any) => m.type === "turn_complete")).toBeDefined();
  });

  // =========================================================================
  // AGENT COMMANDS: /init, /review, /security-review, /pr-comments,
  //                 /release-notes, /insights
  // Protocol: system(init) → stream_event(deltas) → assistant → result
  // Same as a regular "hello" message — full model turn with streaming.
  // =========================================================================

  // (deleted: 5 slash-command tests — /init, /pr-comments, /release-notes,
  // /insights, /commit-message — and the `hello: regular message` test.
  // All pinned the partial-count + complete-count + turn_complete-presence
  // shape across nearly-identical wire input. Slash-command dispatch
  // is exercised by /review (tool lifecycle) and /security-review
  // (multi-phase). End-to-end coverage is the harness probes.)

  test("/review: agent command with tool use (Read) works correctly", async () => {
    const manager = new SessionManager("/tmp/tugcode-slash-review-" + Date.now(), crypto.randomUUID());
    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "system", subtype: "init", session_id: "s-review",
        cwd: "/proj", tools: ["Read", "Bash"], model: "claude-opus-4-6",
        permissionMode: "acceptEdits", slash_commands: [], plugins: [],
        agents: [], skills: [], claude_code_version: "2.1.38",
      },
      // Claude streams some text, then uses a tool.
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Reviewing PR..." } } },
      { type: "assistant", message: { content: [
        { type: "text", text: "Reviewing PR..." },
        { type: "tool_use", name: "Bash", id: "tu-gh", input: { command: "gh pr view" } },
      ] } },
      // Tool result.
      { type: "user", message: { content: [
        { type: "tool_result", tool_use_id: "tu-gh", content: "PR #42: Fix bug", is_error: false },
      ] } },
      // Claude responds.
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: " LGTM!" } } },
      { type: "assistant", message: { content: [{ type: "text", text: " LGTM!" }] } },
      { type: "result", subtype: "success", result: "" },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const ipcMessages = await captureIpcOutput(() =>
      manager.handleUserMessage({ type: "user_message", content: [{ type: "text" as const, text: "/review" }] })
    );

    // Tool use emitted from assistant event.
    const toolUses = ipcMessages.filter((m: any) => m.type === "tool_use");
    expect(toolUses.length).toBeGreaterThanOrEqual(1);
    expect((toolUses[0] as any).tool_name).toBe("Bash");
    // Tool result emitted.
    const toolResults = ipcMessages.filter((m: any) => m.type === "tool_result");
    expect(toolResults.length).toBe(1);
    expect((toolResults[0] as any).output).toBe("PR #42: Fix bug");
    // turn_complete.
    expect(ipcMessages.find((m: any) => m.type === "turn_complete")).toBeDefined();
  });

  test("/security-review: agent command streams multi-phase response", async () => {
    const manager = new SessionManager("/tmp/tugcode-slash-secreview-" + Date.now(), crypto.randomUUID());
    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "system", subtype: "init", session_id: "s-sec",
        cwd: "/proj", tools: [], model: "claude-opus-4-6",
        permissionMode: "acceptEdits", slash_commands: [], plugins: [],
        agents: [], skills: [], claude_code_version: "2.1.38",
      },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "## Phase 1: Static Analysis\nNo issues found." } } },
      { type: "result", subtype: "success", result: "" },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const ipcMessages = await captureIpcOutput(() =>
      manager.handleUserMessage({ type: "user_message", content: [{ type: "text" as const, text: "/security-review" }] })
    );

    const partials = ipcMessages.filter((m: any) => m.type === "assistant_text" && m.is_partial);
    expect(partials.length).toBe(1);
    expect((partials[0] as any).text).toContain("Phase 1");
    expect(ipcMessages.find((m: any) => m.type === "turn_complete")).toBeDefined();
  });

  // (deleted: /pr-comments, /release-notes, /insights — same shape pin
  // as /init above.)

  // =========================================================================
  // SKILL COMMANDS: /commit-message, /keybindings-help, /debug
  // /commit-message: full model turn (same as agent commands).
  // /keybindings-help: returns empty in stream-json.
  // /debug: TUI-oriented, returns empty or minimal in stream-json.
  // =========================================================================

  // (deleted: /commit-message — same shape pin.)

  test("/keybindings-help: skill returns empty in stream-json (just result)", async () => {
    // Per §13a: "Outputs to TUI; returns empty in stream-json."
    const manager = new SessionManager("/tmp/tugcode-slash-keybind-" + Date.now(), crypto.randomUUID());
    const mockStdin = injectMockSubprocess(manager, [
      { type: "result", subtype: "success", result: "" },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const ipcMessages = await captureIpcOutput(() =>
      manager.handleUserMessage({ type: "user_message", content: [{ type: "text" as const, text: "/keybindings-help" }] })
    );

    // No assistant_text (nothing to show).
    const textMsgs = ipcMessages.filter((m: any) => m.type === "assistant_text");
    expect(textMsgs.length).toBe(0);
    // turn_complete still emitted so frontend exits loading state.
    const tc = ipcMessages.find((m: any) => m.type === "turn_complete") as any;
    expect(tc).toBeDefined();
    expect(tc.result).toBe("success");
  });

  test("/debug: skill returns empty in stream-json (just result)", async () => {
    // Per §13a: "TUI-oriented."
    const manager = new SessionManager("/tmp/tugcode-slash-debug-" + Date.now(), crypto.randomUUID());
    const mockStdin = injectMockSubprocess(manager, [
      { type: "result", subtype: "success", result: "" },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const ipcMessages = await captureIpcOutput(() =>
      manager.handleUserMessage({ type: "user_message", content: [{ type: "text" as const, text: "/debug" }] })
    );

    // No assistant_text.
    const textMsgs = ipcMessages.filter((m: any) => m.type === "assistant_text");
    expect(textMsgs.length).toBe(0);
    // turn_complete present.
    expect(ipcMessages.find((m: any) => m.type === "turn_complete")).toBeDefined();
  });

  // =========================================================================
  // REGULAR MESSAGE: "hello" (baseline for comparison)
  // Protocol: system(init) → stream_event(deltas) → assistant → result
  // =========================================================================

  // (deleted: `hello: regular message produces streaming + complete +
  // turn_complete` — same shape pin as /init. The cost_update-before-
  // turn_complete ordering is covered separately by the cost_update
  // tests.)
});

describe("handlePermissionMode control_request (Step 6)", () => {
  test("handlePermissionMode sends set_permission_mode control_request to stdin", () => {
    const manager = new SessionManager("/tmp/tugcode-perm-ctrl-" + Date.now(), crypto.randomUUID());

    const writtenData: string[] = [];
    (manager as any).claudeProcess = {
      stdin: {
        write: (data: unknown) => writtenData.push(String(data)),
        flush: () => {},
      },
    };

    manager.handlePermissionMode({ type: "permission_mode", mode: "bypassPermissions" });

    // Must have written a control_request
    expect(writtenData.length).toBeGreaterThan(0);
    const parsed = JSON.parse(writtenData[0].replace(/\n$/, ""));
    expect(parsed.type).toBe("control_request");
    expect(parsed.request.subtype).toBe("set_permission_mode");
    expect(parsed.request.mode).toBe("bypassPermissions");

    // Local state must also be updated
    expect((manager as any).permissionManager.getMode()).toBe("bypassPermissions");
  });

  test("handlePermissionMode without active process only updates local state", () => {
    const manager = new SessionManager("/tmp/tugcode-perm-noproc-" + Date.now(), crypto.randomUUID());
    // No claudeProcess set -- should not throw, just update local state
    expect(() => {
      manager.handlePermissionMode({ type: "permission_mode", mode: "plan" });
    }).not.toThrow();
    expect((manager as any).permissionManager.getMode()).toBe("plan");
  });
});

// ---------------------------------------------------------------------------
// Protocol audit: §1-§23 section-by-section verification
// ---------------------------------------------------------------------------

describe("protocol audit: §2e stop_task handler", () => {
  test("handleStopTask sends stop_task control_request to stdin per §2e", () => {
    const manager = new SessionManager("/tmp/tugcode-stoptask-" + Date.now(), crypto.randomUUID());
    const writtenData: string[] = [];
    (manager as any).claudeProcess = {
      stdin: {
        write: (data: unknown) => writtenData.push(String(data)),
        flush: () => {},
      },
    };

    manager.handleStopTask("task-abc-123");

    expect(writtenData.length).toBe(1);
    const parsed = JSON.parse(writtenData[0].replace(/\n$/, ""));
    expect(parsed.type).toBe("control_request");
    expect(parsed.request.subtype).toBe("stop_task");
    expect(parsed.request.task_id).toBe("task-abc-123");
    expect(parsed.request_id).toMatch(/^ctrl-/);
  });

  test("handleStopTask without active process does not throw", () => {
    const manager = new SessionManager("/tmp/tugcode-stoptask-noproc-" + Date.now(), crypto.randomUUID());
    expect(() => manager.handleStopTask("task-xyz")).not.toThrow();
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

describe("protocol audit: §12 cost/usage fields in result", () => {
  test("all cost fields from result event are captured in resultMetadata", () => {
    const event = {
      type: "result",
      subtype: "success",
      result: "",
      total_cost_usd: 0.042,
      num_turns: 3,
      duration_ms: 5000,
      duration_api_ms: 4800,
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 15000 },
      modelUsage: {
        "claude-opus-4-6": {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 15000,
          costUSD: 0.042,
          contextWindow: 200000,
          maxOutputTokens: 64000,
        },
      },
      permission_denials: [{ tool_name: "Bash", tool_use_id: "tu-1" }],
    };
    const result = routeTopLevelEvent(event, baseCtx);
    const meta = result.resultMetadata!;
    expect(meta.total_cost_usd).toBe(0.042);
    expect(meta.num_turns).toBe(3);
    expect(meta.duration_ms).toBe(5000);
    expect(meta.duration_api_ms).toBe(4800);
    expect((meta.usage as any).cache_read_input_tokens).toBe(15000);
    expect((meta.modelUsage as any)["claude-opus-4-6"].costUSD).toBe(0.042);
    expect(meta.permission_denials).toHaveLength(1);
  });

  test("cost_update IPC carries the last-iteration usage, not result.usage", async () => {
    // A two-iteration tool-loop turn. `result.usage` is the SUM across
    // every API call (the inflated billing total); `cost_update.usage`
    // must instead be the turn's LAST `message_delta` — the resident
    // context window after the turn. The `result.usage` here is set
    // deliberately huge to prove the wire `usage` ignores it.
    const manager = new SessionManager("/tmp/tugcode-cost-fields-" + Date.now(), crypto.randomUUID());
    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: {
            id: "msg_iter1",
            usage: {
              input_tokens: 4,
              cache_creation_input_tokens: 1166,
              cache_read_input_tokens: 18000,
              output_tokens: 1,
            },
          },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: {
            input_tokens: 4,
            cache_creation_input_tokens: 1166,
            cache_read_input_tokens: 18000,
            output_tokens: 184,
          },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: {
            id: "msg_iter2",
            usage: {
              input_tokens: 4,
              cache_creation_input_tokens: 38000,
              cache_read_input_tokens: 21000,
              output_tokens: 1,
            },
          },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: {
            input_tokens: 4,
            cache_creation_input_tokens: 38000,
            cache_read_input_tokens: 21000,
            output_tokens: 192,
          },
        },
      },
      {
        type: "result",
        subtype: "success",
        result: "",
        total_cost_usd: 0.05,
        num_turns: 2,
        duration_ms: 3000,
        duration_api_ms: 2800,
        usage: { input_tokens: 9_999_999, output_tokens: 9_999_999 },
        modelUsage: { "claude-opus-4-6": { costUSD: 0.05 } },
      },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const ipcMessages = await captureIpcOutput(() =>
      manager.handleUserMessage({ type: "user_message", content: [{ type: "text" as const, text: "test" }] })
    );

    const cu = ipcMessages.find((m: any) => m.type === "cost_update") as any;
    expect(cu).toBeDefined();
    // Cost / duration fields still come straight off the `result` event.
    expect(cu.total_cost_usd).toBe(0.05);
    expect(cu.num_turns).toBe(2);
    expect(cu.duration_ms).toBe(3000);
    expect(cu.duration_api_ms).toBe(2800);
    expect(cu.modelUsage["claude-opus-4-6"].costUSD).toBe(0.05);
    // `usage` is the LAST `message_delta` — the second iteration —
    // NOT the summed `result.usage`.
    expect(cu.usage).toEqual({
      input_tokens: 4,
      cache_creation_input_tokens: 38000,
      cache_read_input_tokens: 21000,
      output_tokens: 192,
    });
  });

  test("cost_update usage falls back to the last message_start for a turn with no message_delta", async () => {
    // A degenerate/interrupted turn that opened a message but never
    // produced its terminal `message_delta`. The last `message_start`
    // is the best resident-window estimate available.
    const manager = new SessionManager("/tmp/tugcode-cost-fallback-" + Date.now(), crypto.randomUUID());
    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: {
            id: "msg_only",
            usage: {
              input_tokens: 2,
              cache_read_input_tokens: 9000,
              output_tokens: 1,
            },
          },
        },
      },
      {
        type: "result",
        subtype: "success",
        result: "",
        total_cost_usd: 0.01,
        usage: { input_tokens: 9_999_999, output_tokens: 9_999_999 },
      },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const ipcMessages = await captureIpcOutput(() =>
      manager.handleUserMessage({ type: "user_message", content: [{ type: "text" as const, text: "test" }] })
    );

    const cu = ipcMessages.find((m: any) => m.type === "cost_update") as any;
    expect(cu).toBeDefined();
    expect(cu.usage).toEqual({
      input_tokens: 2,
      cache_read_input_tokens: 9000,
      output_tokens: 1,
    });
  });

  test("cost_update usage is {} for a fully degenerate turn (no stream events)", async () => {
    // No `message_start`, no `message_delta` — there is no iteration
    // to report, so `cost_update.usage` is `{}` rather than the
    // misleading `result.usage` sum.
    const manager = new SessionManager("/tmp/tugcode-cost-degenerate-" + Date.now(), crypto.randomUUID());
    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "result",
        subtype: "success",
        result: "",
        total_cost_usd: 0.01,
        usage: { input_tokens: 200, output_tokens: 80 },
      },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const ipcMessages = await captureIpcOutput(() =>
      manager.handleUserMessage({ type: "user_message", content: [{ type: "text" as const, text: "test" }] })
    );

    const cu = ipcMessages.find((m: any) => m.type === "cost_update") as any;
    expect(cu).toBeDefined();
    expect(cu.total_cost_usd).toBe(0.01);
    expect(cu.usage).toEqual({});
  });
});

describe("protocol audit: §14 extended thinking", () => {
  test("thinking_delta stream events produce thinking_text IPC messages", async () => {
    const manager = new SessionManager("/tmp/tugcode-thinking-" + Date.now(), crypto.randomUUID());
    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "system", subtype: "init", session_id: "s-think",
        cwd: "/proj", tools: [], model: "claude-opus-4-6",
        permissionMode: "default", slash_commands: [], plugins: [],
        agents: [], skills: [], claude_code_version: "2.1.38",
      },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Let me think about this..." } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Here's my answer." } } },
      { type: "result", subtype: "success", result: "" },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const ipcMessages = await captureIpcOutput(() =>
      manager.handleUserMessage({ type: "user_message", content: [{ type: "text" as const, text: "think hard" }] })
    );

    // Thinking text emitted before regular text.
    const thinkMsgs = ipcMessages.filter((m: any) => m.type === "thinking_text");
    expect(thinkMsgs.length).toBe(1);
    expect((thinkMsgs[0] as any).text).toBe("Let me think about this...");
    expect((thinkMsgs[0] as any).is_partial).toBe(true);
    // Regular text also emitted.
    const textMsgs = ipcMessages.filter((m: any) => m.type === "assistant_text" && m.is_partial);
    expect(textMsgs.length).toBe(1);
    // Thinking comes before text in the output stream.
    const thinkIdx = ipcMessages.findIndex((m: any) => m.type === "thinking_text");
    const textIdx = ipcMessages.findIndex((m: any) => m.type === "assistant_text" && m.is_partial);
    expect(thinkIdx).toBeLessThan(textIdx);
  });
});

describe("protocol audit: §15 parent_tool_use_id forwarding", () => {
  test("subagent events have parent_tool_use_id stamped on IPC messages", async () => {
    const manager = new SessionManager("/tmp/tugcode-subagent-" + Date.now(), crypto.randomUUID());
    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "system", subtype: "init", session_id: "s-sub",
        parent_tool_use_id: "toolu_task_1",
        cwd: "/proj", tools: [], model: "claude-opus-4-6",
        permissionMode: "default", slash_commands: [], plugins: [],
        agents: [], skills: [], claude_code_version: "2.1.38",
      },
      {
        type: "stream_event",
        parent_tool_use_id: "toolu_task_1",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Subagent working..." } },
      },
      {
        type: "result", subtype: "success", result: "",
        parent_tool_use_id: "toolu_task_1",
      },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const ipcMessages = await captureIpcOutput(() =>
      manager.handleUserMessage({ type: "user_message", content: [{ type: "text" as const, text: "spawn task" }] })
    );

    // system_metadata should have parent_tool_use_id.
    const sysMeta = ipcMessages.find((m: any) => m.type === "system_metadata") as any;
    expect(sysMeta).toBeDefined();
    expect(sysMeta.parent_tool_use_id).toBe("toolu_task_1");

    // Streaming text should have parent_tool_use_id.
    const textMsg = ipcMessages.find((m: any) => m.type === "assistant_text" && m.is_partial) as any;
    expect(textMsg).toBeDefined();
    expect(textMsg.parent_tool_use_id).toBe("toolu_task_1");
  });

  test("top-level events have no parent_tool_use_id", async () => {
    const manager = new SessionManager("/tmp/tugcode-toplevel-" + Date.now(), crypto.randomUUID());
    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "system", subtype: "init", session_id: "s-top",
        parent_tool_use_id: null,
        cwd: "/proj", tools: [], model: "claude-opus-4-6",
        permissionMode: "default", slash_commands: [], plugins: [],
        agents: [], skills: [], claude_code_version: "2.1.38",
      },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } },
      { type: "result", subtype: "success", result: "" },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const ipcMessages = await captureIpcOutput(() =>
      manager.handleUserMessage({ type: "user_message", content: [{ type: "text" as const, text: "test" }] })
    );

    // No parent_tool_use_id on top-level messages.
    const sysMeta = ipcMessages.find((m: any) => m.type === "system_metadata") as any;
    expect(sysMeta.parent_tool_use_id).toBeUndefined();
    const textMsg = ipcMessages.find((m: any) => m.type === "assistant_text" && m.is_partial) as any;
    expect(textMsg.parent_tool_use_id).toBeUndefined();
  });
});

describe("protocol audit: §16 multiple parallel tool uses", () => {
  test("multiple tool_use blocks in one assistant message all produce IPC", async () => {
    const manager = new SessionManager("/tmp/tugcode-parallel-tools-" + Date.now(), crypto.randomUUID());
    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "system", subtype: "init", session_id: "s-par",
        cwd: "/proj", tools: ["Glob", "Bash"], model: "claude-opus-4-6",
        permissionMode: "acceptEdits", slash_commands: [], plugins: [],
        agents: [], skills: [], claude_code_version: "2.1.38",
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "I'll do both..." },
            { type: "tool_use", id: "tu-1", name: "Glob", input: { pattern: "*.ts" } },
            { type: "tool_use", id: "tu-2", name: "Bash", input: { command: "echo hi" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu-1", content: "a.ts\nb.ts", is_error: false },
            { type: "tool_result", tool_use_id: "tu-2", content: "hi", is_error: false },
          ],
        },
      },
      { type: "result", subtype: "success", result: "" },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const ipcMessages = await captureIpcOutput(() =>
      manager.handleUserMessage({ type: "user_message", content: [{ type: "text" as const, text: "do both" }] })
    );

    // Both tool_use IPC messages.
    const toolUses = ipcMessages.filter((m: any) => m.type === "tool_use");
    expect(toolUses.length).toBe(2);
    expect((toolUses[0] as any).tool_name).toBe("Glob");
    expect((toolUses[1] as any).tool_name).toBe("Bash");

    // Both tool_result IPC messages with matching IDs.
    const toolResults = ipcMessages.filter((m: any) => m.type === "tool_result");
    expect(toolResults.length).toBe(2);
    expect((toolResults[0] as any).tool_use_id).toBe("tu-1");
    expect((toolResults[1] as any).tool_use_id).toBe("tu-2");
  });
});

describe("protocol audit: §17 context compaction", () => {
  test("compact_boundary system event produces compact_boundary IPC", async () => {
    const manager = new SessionManager("/tmp/tugcode-compact-" + Date.now(), crypto.randomUUID());
    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "system", subtype: "init", session_id: "s-cmp",
        cwd: "/proj", tools: [], model: "claude-opus-4-6",
        permissionMode: "default", slash_commands: [], plugins: [],
        agents: [], skills: [], claude_code_version: "2.1.38",
      },
      { type: "system", subtype: "compact_boundary" },
      {
        type: "system", subtype: "init", session_id: "s-cmp",
        cwd: "/proj", tools: [], model: "claude-opus-4-6",
        permissionMode: "default", slash_commands: [], plugins: [],
        agents: [], skills: [], claude_code_version: "2.1.38",
      },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "After compact." } } },
      { type: "result", subtype: "success", result: "" },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const ipcMessages = await captureIpcOutput(() =>
      manager.handleUserMessage({ type: "user_message", content: [{ type: "text" as const, text: "long conversation" }] })
    );

    // compact_boundary emitted.
    const compacts = ipcMessages.filter((m: any) => m.type === "compact_boundary");
    expect(compacts.length).toBe(1);
    // Two system_metadata (one before compact, one after).
    const sysMetas = ipcMessages.filter((m: any) => m.type === "system_metadata");
    expect(sysMetas.length).toBe(2);
    // Text still arrives after compaction.
    const textMsgs = ipcMessages.filter((m: any) => m.type === "assistant_text" && m.is_partial);
    expect(textMsgs.length).toBe(1);
  });
});

describe("api_retry events forwarded through transport", () => {
  test("api_retry system events produce api_retry IPC messages", async () => {
    const manager = new SessionManager("/tmp/tugcode-apiretry-" + Date.now(), crypto.randomUUID());
    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "system", subtype: "init", session_id: "s-retry",
        cwd: "/proj", tools: [], model: "claude-opus-4-6",
        permissionMode: "default", slash_commands: [], plugins: [],
        agents: [], skills: [], claude_code_version: "2.1.38",
      },
      // First API call fails — retry #1
      {
        type: "system", subtype: "api_retry",
        attempt: 1, max_retries: 10, retry_delay_ms: 1000,
        error_status: 529, error: "server_error",
      },
      // Retry #2
      {
        type: "system", subtype: "api_retry",
        attempt: 2, max_retries: 10, retry_delay_ms: 2000,
        error_status: 529, error: "server_error",
      },
      // Third attempt succeeds — normal response follows
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Success after retries." } } },
      { type: "result", subtype: "success", result: "Success after retries." },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const ipcMessages = await captureIpcOutput(() =>
      manager.handleUserMessage({ type: "user_message", content: [{ type: "text" as const, text: "hello" }] })
    );

    // Two api_retry events forwarded.
    const retries = ipcMessages.filter((m: any) => m.type === "api_retry");
    expect(retries.length).toBe(2);

    // First retry has correct fields.
    expect((retries[0] as any).attempt).toBe(1);
    expect((retries[0] as any).max_retries).toBe(10);
    expect((retries[0] as any).retry_delay_ms).toBe(1000);
    expect((retries[0] as any).error_status).toBe(529);
    expect((retries[0] as any).error).toBe("server_error");

    // Second retry has incremented attempt and delay.
    expect((retries[1] as any).attempt).toBe(2);
    expect((retries[1] as any).retry_delay_ms).toBe(2000);

    // Response text still arrives after retries.
    const textMsgs = ipcMessages.filter((m: any) => m.type === "assistant_text" && m.is_partial);
    expect(textMsgs.length).toBe(1);
    expect((textMsgs[0] as any).text).toBe("Success after retries.");

    // Turn completes successfully.
    const turns = ipcMessages.filter((m: any) => m.type === "turn_complete");
    expect(turns.length).toBe(1);
    expect((turns[0] as any).result).toBe("success");
  });

  test("api_retry with rate_limit error and null status", async () => {
    const manager = new SessionManager("/tmp/tugcode-ratelimit-" + Date.now(), crypto.randomUUID());
    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "system", subtype: "init", session_id: "s-rl",
        cwd: "/proj", tools: [], model: "claude-opus-4-6",
        permissionMode: "default", slash_commands: [], plugins: [],
        agents: [], skills: [], claude_code_version: "2.1.38",
      },
      {
        type: "system", subtype: "api_retry",
        attempt: 1, max_retries: 10, retry_delay_ms: 5000,
        error_status: null, error: "rate_limit",
      },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "OK" } } },
      { type: "result", subtype: "success", result: "OK" },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const ipcMessages = await captureIpcOutput(() =>
      manager.handleUserMessage({ type: "user_message", content: [{ type: "text" as const, text: "test" }] })
    );

    const retries = ipcMessages.filter((m: any) => m.type === "api_retry");
    expect(retries.length).toBe(1);
    expect((retries[0] as any).error).toBe("rate_limit");
    expect((retries[0] as any).error_status).toBeNull();
    expect((retries[0] as any).retry_delay_ms).toBe(5000);
  });

  test("model_refusal_fallback system events produce one IPC message", async () => {
    const manager = new SessionManager("/tmp/tugcode-refusal-" + Date.now(), crypto.randomUUID());
    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "system", subtype: "init", session_id: "s-refusal",
        cwd: "/proj", tools: [], model: "claude-fable-5",
        permissionMode: "default", slash_commands: [], plugins: [],
        agents: [], skills: [], claude_code_version: "2.1.38",
      },
      // The model declined; the SDK retries on a fallback model. Field names
      // mirror the real JSONL audit shape (camelCase on the wire here).
      {
        type: "system", subtype: "model_refusal_fallback",
        trigger: "refusal", direction: "retry",
        originalModel: "claude-fable-5", fallbackModel: "claude-opus-4-8",
      },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Done." } } },
      { type: "result", subtype: "success", result: "Done." },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const ipcMessages = await captureIpcOutput(() =>
      manager.handleUserMessage({ type: "user_message", content: [{ type: "text" as const, text: "hi" }] })
    );

    const fallbacks = ipcMessages.filter((m: any) => m.type === "model_refusal_fallback");
    expect(fallbacks.length).toBe(1);
    expect((fallbacks[0] as any).original_model).toBe("claude-fable-5");
    expect((fallbacks[0] as any).fallback_model).toBe("claude-opus-4-8");
    expect((fallbacks[0] as any).trigger).toBe("refusal");
    expect((fallbacks[0] as any).direction).toBe("retry");
  });

  test("an assistant message closing on max_tokens emits one output_truncated", async () => {
    const manager = new SessionManager("/tmp/tugcode-truncate-" + Date.now(), crypto.randomUUID());
    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "system", subtype: "init", session_id: "s-trunc",
        cwd: "/proj", tools: [], model: "claude-opus-4-8",
        permissionMode: "default", slash_commands: [], plugins: [],
        agents: [], skills: [], claude_code_version: "2.1.38",
      },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "A long answer cut" } } },
      // The assistant snapshot closes on max_tokens — truncated, not end_turn.
      {
        type: "assistant",
        message: {
          id: "msg_trunc", role: "assistant", model: "claude-opus-4-8",
          content: [{ type: "text", text: "A long answer cut" }],
          stop_reason: "max_tokens",
        },
      },
      { type: "result", subtype: "success", result: "A long answer cut" },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const ipcMessages = await captureIpcOutput(() =>
      manager.handleUserMessage({ type: "user_message", content: [{ type: "text" as const, text: "write a lot" }] })
    );

    const truncs = ipcMessages.filter((m: any) => m.type === "output_truncated");
    expect(truncs.length).toBe(1);
  });

  test("a clean end_turn message emits no output_truncated", async () => {
    const manager = new SessionManager("/tmp/tugcode-notrunc-" + Date.now(), crypto.randomUUID());
    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "system", subtype: "init", session_id: "s-clean",
        cwd: "/proj", tools: [], model: "claude-opus-4-8",
        permissionMode: "default", slash_commands: [], plugins: [],
        agents: [], skills: [], claude_code_version: "2.1.38",
      },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Done." } } },
      {
        type: "assistant",
        message: {
          id: "msg_clean", role: "assistant", model: "claude-opus-4-8",
          content: [{ type: "text", text: "Done." }],
          stop_reason: "end_turn",
        },
      },
      { type: "result", subtype: "success", result: "Done." },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const ipcMessages = await captureIpcOutput(() =>
      manager.handleUserMessage({ type: "user_message", content: [{ type: "text" as const, text: "hi" }] })
    );

    expect(ipcMessages.filter((m: any) => m.type === "output_truncated").length).toBe(0);
  });
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

describe("protocol audit: §8 file and image attachments", () => {
  test("user message with image attachment produces base64 content block", async () => {
    const manager = new SessionManager("/tmp/tugcode-attach-" + Date.now(), crypto.randomUUID());
    const writtenData: string[] = [];
    const mockStdin = injectMockSubprocess(manager, [
      { type: "result", subtype: "success", result: "" },
    ]);
    mockStdin.write = (data: unknown) => writtenData.push(String(data));

    await captureIpcOutput(() =>
      manager.handleUserMessage({
        type: "user_message",
        content: [
          { type: "text", text: "What is this?" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
          },
        ],
      })
    );

    // Parse what was written to stdin.
    const userMsg = JSON.parse(writtenData[0].replace(/\n$/, ""));
    expect(userMsg.type).toBe("user");
    expect(userMsg.message.content).toHaveLength(2);
    // First block is text.
    expect(userMsg.message.content[0].type).toBe("text");
    expect(userMsg.message.content[0].text).toBe("What is this?");
    // Second block is image.
    expect(userMsg.message.content[1].type).toBe("image");
    expect(userMsg.message.content[1].source.type).toBe("base64");
    expect(userMsg.message.content[1].source.media_type).toBe("image/png");
    expect(userMsg.message.content[1].source.data).toBe("iVBORw0KGgo=");
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

describe("protocol audit: §2f permission response format", () => {
  test("allow response uses 'behavior' not 'decision' per §2f", () => {
    const manager = new SessionManager("/tmp/tugcode-perm-allow-" + Date.now(), crypto.randomUUID());
    const pendingCR = {
      type: "control_request",
      request_id: "req-perm-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "echo hi" },
      },
    };
    (manager as any).pendingControlRequests.set("req-perm-1", pendingCR);

    const writtenData: string[] = [];
    (manager as any).claudeProcess = {
      stdin: {
        write: (data: unknown) => writtenData.push(String(data)),
        flush: () => {},
      },
    };

    manager.handleToolApproval({
      type: "tool_approval",
      request_id: "req-perm-1",
      decision: "allow",
      updatedInput: { command: "echo hi" },
    });

    const parsed = JSON.parse(writtenData[0].replace(/\n$/, ""));
    expect(parsed.type).toBe("control_response");
    // CRITICAL: must be "behavior" not "decision".
    expect(parsed.response.response.behavior).toBe("allow");
    expect(parsed.response.response.updatedInput).toEqual({ command: "echo hi" });
    // Must NOT have "decision" key.
    expect("decision" in parsed.response.response).toBe(false);
  });

  test("deny response uses 'behavior' not 'decision' per §2f", () => {
    const manager = new SessionManager("/tmp/tugcode-perm-deny-" + Date.now(), crypto.randomUUID());
    const pendingCR = {
      type: "control_request",
      request_id: "req-perm-2",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "rm -rf /" },
      },
    };
    (manager as any).pendingControlRequests.set("req-perm-2", pendingCR);

    const writtenData: string[] = [];
    (manager as any).claudeProcess = {
      stdin: {
        write: (data: unknown) => writtenData.push(String(data)),
        flush: () => {},
      },
    };

    manager.handleToolApproval({
      type: "tool_approval",
      request_id: "req-perm-2",
      decision: "deny",
      message: "Too dangerous",
    });

    const parsed = JSON.parse(writtenData[0].replace(/\n$/, ""));
    expect(parsed.response.response.behavior).toBe("deny");
    expect(parsed.response.response.message).toBe("Too dangerous");
    expect("decision" in parsed.response.response).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SessionManager resumeSessionId plumbing
// ---------------------------------------------------------------------------

describe("SessionManager resumeSessionId", () => {
  test("constructor without fourth arg leaves resumeSessionId null", () => {
    const m = new SessionManager(
      "/tmp/resume-default-" + Date.now(),
      crypto.randomUUID(),
    );
    expect((m as any).resumeSessionId).toBe(null);
  });

  test("constructor with fourth arg captures the value", () => {
    const m = new SessionManager(
      "/tmp/resume-set-" + Date.now(),
      crypto.randomUUID(),
      "resume",
      "claude-internal-id-42",
    );
    expect((m as any).resumeSessionId).toBe("claude-internal-id-42");
  });

  test("constructor coerces empty-string resumeSessionId to null", () => {
    // tugcast spawning with an unset field could pass an empty string
    // through CLI argv; the field's `null`-or-non-empty contract gives
    // the resume-id-selection logic in `initialize()` a single test
    // (`!= null`) instead of two.
    const m = new SessionManager(
      "/tmp/resume-empty-" + Date.now(),
      crypto.randomUUID(),
      "resume",
      "",
    );
    expect((m as any).resumeSessionId).toBe(null);
  });

  test("constructor coerces undefined resumeSessionId to null", () => {
    const m = new SessionManager(
      "/tmp/resume-undef-" + Date.now(),
      crypto.randomUUID(),
      "resume",
      undefined,
    );
    expect((m as any).resumeSessionId).toBe(null);
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

describe("dispatchEventToTurn slides ActiveTurn.currentMessageId", () => {
  // ActiveTurn carries a sliding pointer to claude's most recent
  // `message.id` for the turn. Every `message_start` (stream event) and
  // every top-level `assistant` snapshot updates it. Nothing rejects.
  // Nothing freezes. Multi-message claude turns simply move the pointer
  // forward; each message's content frames go out under its own id.
  function setupTurn(
    text: string,
    attachments: Array<{ filename: string; content: string; media_type: string }> = [],
  ): { manager: SessionManager; turn: ActiveTurn } {
    const manager = new SessionManager(
      "/tmp/slide-msgid-" + Date.now() + "-" + Math.random().toString(36).slice(2),
      crypto.randomUUID(),
    );
    const seq = (manager as any).nextSeq();
    const content: ContentBlock[] = [];
    if (text.length > 0) content.push({ type: "text", text });
    for (const att of attachments) {
      if (att.media_type.startsWith("image/")) {
        content.push({
          type: "image",
          source: { type: "base64", media_type: att.media_type, data: att.content },
        });
      } else {
        content.push({ type: "text", text: att.content });
      }
    }
    if (content.length === 0) content.push({ type: "text", text: "" });
    return { manager, turn: new ActiveTurn(seq, content) };
  }

  test("message_start slides currentMessageId from null", async () => {
    const { manager, turn } = setupTurn("hi");
    expect(turn.currentMessageId).toBeNull();
    await captureIpcOutput(async () => {
      (manager as any).dispatchEventToTurn(turn, {
        type: "stream_event",
        event: { type: "message_start", message: { id: "msg_X", role: "assistant" } },
      });
    });
    expect(turn.currentMessageId).toBe("msg_X");
  });

  test("top-level assistant snapshot slides currentMessageId from null", async () => {
    const { manager, turn } = setupTurn("hi");
    await captureIpcOutput(async () => {
      (manager as any).dispatchEventToTurn(turn, {
        type: "assistant",
        message: { id: "msg_Y", content: [] },
      });
    });
    expect(turn.currentMessageId).toBe("msg_Y");
  });

  test("repeated message_start with same id leaves pointer at that id", async () => {
    const { manager, turn } = setupTurn("hi");
    await captureIpcOutput(async () => {
      (manager as any).dispatchEventToTurn(turn, {
        type: "stream_event",
        event: { type: "message_start", message: { id: "msg_Z" } },
      });
      (manager as any).dispatchEventToTurn(turn, {
        type: "stream_event",
        event: { type: "message_start", message: { id: "msg_Z" } },
      });
    });
    expect(turn.currentMessageId).toBe("msg_Z");
  });

  test("multi-message turn: second message_start slides pointer to new id (no rejection)", async () => {
    // claude's multi-message turns (text → tool_use → tool_result →
    // second text) emit a fresh `message_start` for the second message.
    // The pointer must follow — content for the second message keys on
    // its own id so the reducer renders it as a separate panel.
    const { manager, turn } = setupTurn("hi");
    const errors: string[] = [];
    const originalErr = console.error;
    console.error = (msg: any) => {
      errors.push(String(msg));
    };
    try {
      await captureIpcOutput(async () => {
        (manager as any).dispatchEventToTurn(turn, {
          type: "stream_event",
          event: { type: "message_start", message: { id: "msg_first" } },
        });
        (manager as any).dispatchEventToTurn(turn, {
          type: "assistant",
          message: { id: "msg_second", content: [] },
        });
      });
    } finally {
      console.error = originalErr;
    }
    expect(turn.currentMessageId).toBe("msg_second");
    // No "divergence" warning — the slide is silent. We don't reject;
    // we don't even notice.
    expect(errors.some((e) => e.includes("divergence"))).toBe(false);
  });

  test("content_block_delta after message_start emits with claude's id", async () => {
    const { manager, turn } = setupTurn("hi");
    const ipc = await captureIpcOutput(async () => {
      (manager as any).dispatchEventToTurn(turn, {
        type: "stream_event",
        event: { type: "message_start", message: { id: "msg_canon" } },
      });
      (manager as any).dispatchEventToTurn(turn, {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
      });
    });
    const assistantText = ipc.find((m: any) => m.type === "assistant_text") as any;
    expect(assistantText).toBeDefined();
    expect(assistantText.msg_id).toBe("msg_canon");
  });

  test("multi-message turn: deltas for each message carry that message's id", async () => {
    // The bug Step 5.10 exposed: pre-fix, the second message's deltas
    // went out under the first message's id (canonicalize rejected the
    // new id, ctx.msgId stayed frozen). Post-fix the wire carries two
    // separate streams of assistant_text, one per claude message.id.
    const { manager, turn } = setupTurn("hi");
    const ipc = await captureIpcOutput(async () => {
      (manager as any).dispatchEventToTurn(turn, {
        type: "stream_event",
        event: { type: "message_start", message: { id: "msg_first" } },
      });
      (manager as any).dispatchEventToTurn(turn, {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "alpha" } },
      });
      (manager as any).dispatchEventToTurn(turn, {
        type: "stream_event",
        event: { type: "message_start", message: { id: "msg_second" } },
      });
      (manager as any).dispatchEventToTurn(turn, {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "beta" } },
      });
    });
    const texts = ipc.filter((m: any) => m.type === "assistant_text") as any[];
    expect(texts.length).toBe(2);
    expect(texts[0].msg_id).toBe("msg_first");
    expect(texts[0].text).toBe("alpha");
    expect(texts[1].msg_id).toBe("msg_second");
    expect(texts[1].text).toBe("beta");
  });

  test("top-level assistant first (synthetic slash command path) emits with claude's id", async () => {
    // Synthetic slash-command response (e.g. /cost) bypasses
    // `message_start` — the drain's first id-bearing event is the
    // top-level `assistant` snapshot. Messages built within that branch
    // already key on claude's id.
    const { manager, turn } = setupTurn("/cost");
    const ipc = await captureIpcOutput(async () => {
      (manager as any).dispatchEventToTurn(turn, {
        type: "assistant",
        message: {
          id: "msg_synth",
          model: "<synthetic>",
          content: [{ type: "text", text: "Cost summary" }],
        },
      });
    });
    const assistantText = ipc.find((m: any) => m.type === "assistant_text") as any;
    expect(assistantText).toBeDefined();
    expect(assistantText.msg_id).toBe("msg_synth");
  });
});

describe("ActiveTurn carries userContent after handleUserMessage", () => {
  // Build a mock subprocess whose stdout NEVER closes, so handleUserMessage
  // installs an ActiveTurn and stays awaiting turn.completion. The test
  // inspects the activeTurn while it's pending, then resolves the await
  // by signaling EOF (which closes the stream from the controller side).
  function injectNonTerminatingMock(manager: SessionManager): {
    closeStream: () => void;
    mockStdin: Record<string, unknown>;
  } {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const mockStdin: Record<string, unknown> = {
      write(_data: unknown) {},
      flush() {},
      end() {},
    };
    const mockProcess: Record<string, unknown> = {
      stdin: mockStdin,
      stdout: stream,
      kill: (_signal: string) => {},
    };
    (manager as any).claudeProcess = mockProcess;
    (manager as any).startStdoutDrain(mockProcess);
    return {
      closeStream: () => streamController?.close(),
      mockStdin,
    };
  }

  test("plain text submission populates userContent as a single text block", async () => {
    const manager = new SessionManager(
      "/tmp/canon-userText-" + Date.now(),
      crypto.randomUUID(),
    );
    const { closeStream, mockStdin } = injectNonTerminatingMock(manager);
    mockStdin.write = (_data: unknown) => {};

    const userMsg = {
      type: "user_message" as const,
      content: [{ type: "text" as const, text: "hello there" }]
    };
    const turnPromise = captureIpcOutput(() => manager.handleUserMessage(userMsg));
    // Yield so handleUserMessage's pre-await synchronous block (which
    // installs the activeTurn) gets to run.
    await new Promise((r) => setTimeout(r, 5));
    const active = (manager as any).activeTurn;
    expect(active).not.toBeNull();
    expect(active.userContent).toEqual([{ type: "text", text: "hello there" }]);
    // Cleanup: close the stream → drain sees EOF → signalEofToActiveTurn
    // resolves turn.completion → handleUserMessage's finally fires.
    closeStream();
    await turnPromise;
  });

  test("image-bearing submission preserves the interleaved content blocks on ActiveTurn", async () => {
    const manager = new SessionManager(
      "/tmp/canon-userAtt-" + Date.now(),
      crypto.randomUUID(),
    );
    const { closeStream, mockStdin } = injectNonTerminatingMock(manager);
    mockStdin.write = (_data: unknown) => {};

    const userMsg = {
      type: "user_message" as const,
      content: [
        { type: "text" as const, text: "see attached" },
        {
          type: "image" as const,
          source: { type: "base64" as const, media_type: "image/png", data: "DATA" },
        },
      ],
    };
    const turnPromise = captureIpcOutput(() => manager.handleUserMessage(userMsg));
    await new Promise((r) => setTimeout(r, 5));
    const active = (manager as any).activeTurn;
    expect(active).not.toBeNull();
    expect(active.userContent).toHaveLength(2);
    expect(active.userContent[0]).toEqual({ type: "text", text: "see attached" });
    expect(active.userContent[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "DATA" },
    });
    closeStream();
    await turnPromise;
  });
});

describe("handleUserMessage integration: live emits use canonical msg_id", () => {
  test("full turn through drain emits assistant_text and turn_complete keyed by claude's message.id", async () => {
    const manager = new SessionManager(
      "/tmp/canon-integration-" + Date.now(),
      crypto.randomUUID(),
    );
    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "system",
        subtype: "init",
        session_id: "sess-canon-1",
        cwd: "/proj",
        tools: [],
        model: "claude-opus-4-6",
        permissionMode: "acceptEdits",
      },
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "msg_claude_real_id", role: "assistant" },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hello" },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: " world" },
        },
      },
      { type: "result", subtype: "success", result: "" },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const ipc = await captureIpcOutput(() =>
      manager.handleUserMessage({
        type: "user_message",
        content: [{ type: "text" as const, text: "hi" }]
      }),
    );

    const assistantTexts = ipc.filter((m: any) => m.type === "assistant_text") as any[];
    const turnComplete = ipc.find((m: any) => m.type === "turn_complete") as any;

    expect(assistantTexts.length).toBeGreaterThan(0);
    for (const at of assistantTexts) {
      // Every assistant_text on the wire — partial deltas and the final
      // complete snapshot — must carry claude's id, not the install-time
      // placeholder.
      expect(at.msg_id).toBe("msg_claude_real_id");
    }
    expect(turnComplete).toBeDefined();
    expect(turnComplete.msg_id).toBe("msg_claude_real_id");
    // No back-reference field on the wire — the wire is keyed only by
    // claude's `message.id` (mid-turn-replay step 5.1 invariant).
    expect((turnComplete as any).claude_message_id).toBeUndefined();
  });

  test("synthetic-only turn (no message_start) still canonicalizes from top-level assistant", async () => {
    // Slash-command-style flows where claude emits a top-level assistant
    // snapshot with no preceding message_start. The belt-and-suspenders
    // branch in routeTopLevelEvent picks up message.id.
    const manager = new SessionManager(
      "/tmp/canon-synth-" + Date.now(),
      crypto.randomUUID(),
    );
    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "system",
        subtype: "init",
        session_id: "sess-canon-synth",
        cwd: "/proj",
        tools: [],
        model: "claude-opus-4-6",
        permissionMode: "acceptEdits",
      },
      {
        type: "assistant",
        message: {
          id: "msg_synth_id",
          model: "<synthetic>",
          content: [{ type: "text", text: "/cost reply" }],
        },
      },
      { type: "result", subtype: "success", result: "" },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const ipc = await captureIpcOutput(() =>
      manager.handleUserMessage({
        type: "user_message",
        content: [{ type: "text" as const, text: "/cost" }]
      }),
    );

    const synthText = ipc.find(
      (m: any) => m.type === "assistant_text" && m.text === "/cost reply",
    ) as any;
    expect(synthText).toBeDefined();
    expect(synthText.msg_id).toBe("msg_synth_id");

    const turnComplete = ipc.find((m: any) => m.type === "turn_complete") as any;
    expect(turnComplete).toBeDefined();
    expect(turnComplete.msg_id).toBe("msg_synth_id");
  });
});

describe("Step 5.1 wire-shape pin: claude's id flows through unchanged", () => {
  // Pinned post-Step-5.1 ([DM08] / Step 5 rip-and-simplify): the
  // outbound wire carries no `tug_turn_id` on `user_message` and no
  // `claude_message_id` on `turn_complete` / `turn_cancelled`. The
  // reducer's existing msg_id-keyed accumulation handles the live
  // and replay paths via claude's `message.id` alone.

  test("turn_complete on a normal turn omits claude_message_id from the wire", async () => {
    const manager = new SessionManager(
      "/tmp/wire-shape-complete-" + Date.now(),
      crypto.randomUUID(),
    );
    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "system",
        subtype: "init",
        session_id: "sess-wire-shape-1",
        cwd: "/proj",
        tools: [],
        model: "claude-opus-4-6",
        permissionMode: "acceptEdits",
      },
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "msg_claude_id", role: "assistant" },
        },
      },
      { type: "result", subtype: "success", result: "" },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const ipc = await captureIpcOutput(() =>
      manager.handleUserMessage({
        type: "user_message",
        content: [{ type: "text" as const, text: "hi" }]
      }),
    );

    const turnComplete = ipc.find((m: any) => m.type === "turn_complete") as any;
    expect(turnComplete).toBeDefined();
    expect(turnComplete.msg_id).toBe("msg_claude_id");
    // Pin: no Step-4 back-reference field on the wire.
    expect("claude_message_id" in turnComplete).toBe(false);
  });

  test("ActiveTurn.currentMessageId starts null; deltas after message_start emit with claude's id", async () => {
    // The wire's id is claude's `message.id`, end of story. ActiveTurn
    // holds a sliding pointer (currentMessageId) that starts null and
    // moves to claude's id on the first id-bearing event
    // (`message_start` or top-level `assistant`). All emits keyed by
    // the pointer carry claude's id from that point on.
    const manager = new SessionManager(
      "/tmp/wire-shape-slide-" + Date.now(),
      crypto.randomUUID(),
    );
    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "system",
        subtype: "init",
        session_id: "sess-wire-shape-2",
        cwd: "/proj",
        tools: [],
        model: "claude-opus-4-6",
        permissionMode: "acceptEdits",
      },
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "msg_claude_id", role: "assistant" },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "ok" },
        },
      },
      { type: "result", subtype: "success", result: "" },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const ipc = await captureIpcOutput(() =>
      manager.handleUserMessage({
        type: "user_message",
        content: [{ type: "text" as const, text: "hi" }]
      }),
    );

    const assistantTexts = ipc.filter((m: any) => m.type === "assistant_text") as any[];
    expect(assistantTexts.length).toBeGreaterThan(0);
    for (const at of assistantTexts) {
      expect(at.msg_id).toBe("msg_claude_id");
    }
  });
});

// ---------------------------------------------------------------------------
// suppressEmit gate: dispatchEventToTurn updates state but holds back wire
// emits during runReplay's bracket window (mid-turn replay design).
// ---------------------------------------------------------------------------

describe("ActiveTurn.suppressEmit gates dispatchEventToTurn", () => {
  function setupTurn(opts: {
    suppressEmit: boolean;
    currentMessageId?: string;
  }): { manager: SessionManager; turn: ActiveTurn } {
    const manager = new SessionManager(
      "/tmp/suppress-" + Date.now() + "-" + Math.random().toString(36).slice(2),
      crypto.randomUUID(),
    );
    const turn = new ActiveTurn((manager as any).nextSeq(), [{ type: "text", text: "" }]);
    if (opts.currentMessageId !== undefined) {
      turn.currentMessageId = opts.currentMessageId;
    }
    turn.suppressEmit = opts.suppressEmit;
    return { manager, turn };
  }

  test("text delta with suppress=true: no wire emit; partialText accumulates", async () => {
    const { manager, turn } = setupTurn({
      suppressEmit: true,
      currentMessageId: "msg_X",
    });
    const ipc = await captureIpcOutput(async () => {
      (manager as any).dispatchEventToTurn(turn, {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "hello " },
        },
      });
      (manager as any).dispatchEventToTurn(turn, {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "world" },
        },
      });
    });
    expect(ipc.filter((m: any) => m.type === "assistant_text")).toHaveLength(0);
    expect(turn.partialText).toBe("hello world");
  });

  test("result event with suppress=true: no turn_complete on wire; gotResult latches", async () => {
    const { manager, turn } = setupTurn({
      suppressEmit: true,
      currentMessageId: "msg_X",
    });
    turn.partialText = "the answer";
    const ipc = await captureIpcOutput(async () => {
      (manager as any).dispatchEventToTurn(turn, {
        type: "result",
        subtype: "success",
        result: "",
      });
    });
    // Cost update (from routeResult.messages — site 1) is ALSO gated.
    // Verify nothing per-turn lands.
    expect(ipc.filter((m: any) => m.type === "turn_complete")).toHaveLength(0);
    expect(ipc.filter((m: any) => m.type === "assistant_text")).toHaveLength(0);
    expect(ipc.filter((m: any) => m.type === "cost_update")).toHaveLength(0);
    expect(turn.gotResult).toBe(true);
  });

  test("suppress=false: same dispatches emit normally to wire", async () => {
    const { manager, turn } = setupTurn({
      suppressEmit: false,
      currentMessageId: "msg_Y",
    });
    const ipc = await captureIpcOutput(async () => {
      (manager as any).dispatchEventToTurn(turn, {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "hi" },
        },
      });
      (manager as any).dispatchEventToTurn(turn, {
        type: "result",
        subtype: "success",
        result: "",
      });
    });
    const ats = ipc.filter((m: any) => m.type === "assistant_text");
    const tcs = ipc.filter((m: any) => m.type === "turn_complete");
    // Live delta + the gotResult complete-text snapshot = 2 assistant_text.
    expect(ats.length).toBeGreaterThanOrEqual(1);
    expect(tcs).toHaveLength(1);
  });

  test("control_request with suppress=true: forward held back; pendingControlRequests still records", async () => {
    const { manager, turn } = setupTurn({
      suppressEmit: true,
      currentMessageId: "msg_Z",
    });
    const ipc = await captureIpcOutput(async () => {
      (manager as any).dispatchEventToTurn(turn, {
        type: "control_request",
        request_id: "req-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Read",
          input: { path: "/x" },
        },
      });
    });
    expect(ipc.filter((m: any) => m.type === "control_request_forward")).toHaveLength(0);
    // The pendingControlRequests map still got the entry — the gate
    // is on the wire emit only. (Documented as a known v1 limitation.)
    expect((manager as any).pendingControlRequests.get("req-1")).toBeDefined();
  });
});

describe("signalEofToActiveTurn honors suppressEmit", () => {
  test("suppress=true on interrupted turn: no turn_cancelled on wire; finish() runs", async () => {
    const manager = new SessionManager(
      "/tmp/eof-suppress-" + Date.now(),
      crypto.randomUUID(),
    );
    const turn = {
      currentMessageId: "msg_eof",
      seq: 0,
      userContent: [{ type: "text", text: "" }],
      rev: 0,
      partialText: "partial",
      gotResult: false,
      interrupted: true,
      suppressEmit: true,
      finishCalled: false,
      finish() {
        this.finishCalled = true;
      },
    };
    (manager as any).activeTurn = turn;
    const ipc = await captureIpcOutput(async () => {
      (manager as any).signalEofToActiveTurn();
    });
    expect(ipc.filter((m: any) => m.type === "turn_cancelled")).toHaveLength(0);
    expect(ipc.filter((m: any) => m.type === "error")).toHaveLength(0);
    expect(turn.finishCalled).toBe(true);
  });

  test("suppress=true on unfinished turn: no error emit; finish() runs", async () => {
    const manager = new SessionManager(
      "/tmp/eof-suppress-2-" + Date.now(),
      crypto.randomUUID(),
    );
    const turn = {
      currentMessageId: "msg_eof2",
      seq: 0,
      userContent: [{ type: "text", text: "" }],
      rev: 0,
      partialText: "",
      gotResult: false,
      interrupted: false,
      suppressEmit: true,
      finishCalled: false,
      finish() {
        this.finishCalled = true;
      },
    };
    (manager as any).activeTurn = turn;
    const ipc = await captureIpcOutput(async () => {
      (manager as any).signalEofToActiveTurn();
    });
    expect(ipc.filter((m: any) => m.type === "error")).toHaveLength(0);
    expect(turn.finishCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// emitInflightTurnFromActiveTurn — synthetic block emitted inside the
// replay bracket from authoritative ActiveTurn state.
// ---------------------------------------------------------------------------

describe("emitInflightTurnFromActiveTurn", () => {
  // Helper to build an ActiveTurn pre-populated with a single text
  // block in messageBlocks — mirrors what dispatchEventToTurn would
  // produce after a content_block_start + delta sequence on the live
  // wire ([D07] § Mid-turn replay snapshot). Tests that don't care
  // about content set `textBlock: null`.
  function setupTurn(overrides: {
    msgId?: string;
    userText?: string;
    userAttachments?: Array<{ filename: string; content: string; media_type: string }>;
    textBlock?: string | null;     // null = no content block
    partialText?: string;           // for interrupt path's partial_result
    gotResult?: boolean;
    interrupted?: boolean;
  } = {}): { manager: SessionManager; turn: ActiveTurn } {
    const manager = new SessionManager(
      "/tmp/emit-inflight-" + Date.now() + "-" + Math.random().toString(36).slice(2),
      crypto.randomUUID(),
    );
    // Build content blocks from legacy `(text, attachments)` test
    // overrides so existing test bodies don't need rewriting. Flat
    // shape — interleaving was already lost by the old setup helper
    // since it took separate text + attachments parameters.
    // Non-image attachments are silently dropped per the images-only
    // inline-attachment contract.
    const content: ContentBlock[] = [];
    const userText = overrides.userText ?? "";
    if (userText.length > 0) {
      content.push({ type: "text", text: userText });
    }
    for (const att of overrides.userAttachments ?? []) {
      if (!att.media_type.startsWith("image/")) continue;
      content.push({
        type: "image",
        source: { type: "base64", media_type: att.media_type, data: att.content },
      });
    }
    if (content.length === 0) content.push({ type: "text", text: "" });
    const turn = new ActiveTurn(100, content);
    turn.currentMessageId = overrides.msgId ?? "msg_X";
    if (overrides.textBlock !== null && overrides.textBlock !== undefined) {
      turn.messageBlocks.set(turn.currentMessageId, [
        { index: 0, kind: "text", text: overrides.textBlock },
      ]);
    }
    if (overrides.partialText !== undefined) turn.partialText = overrides.partialText;
    if (overrides.gotResult !== undefined) turn.gotResult = overrides.gotResult;
    if (overrides.interrupted !== undefined) turn.interrupted = overrides.interrupted;
    return { manager, turn };
  }

  test("live turn with a text block: snapshot emits add_user_message + the text", async () => {
    // Contract: the add_user_message carries the user's text (no
    // msg_id field per [D15]); the block's text reaches the wire as a
    // complete (is_partial: false) assistant_text under claude's
    // real msg_id, which is what the reducer's `activeMsgId` will
    // pick up at the first content event per [D14].
    const { manager, turn } = setupTurn({
      msgId: "msg_X",
      userText: "hi",
      textBlock: "hello world",
    });
    const ipc = await captureIpcOutput(async () => {
      (manager as any).emitInflightTurnFromActiveTurn(turn);
    });
    const userReplay = ipc.find((m: any) => m.type === "add_user_message") as any;
    expect(userReplay).toBeDefined();
    expect(userReplay.msg_id).toBeUndefined();
    expect(userReplay.content).toEqual([{ type: "text", text: "hi" }]);

    const text = ipc.find((m: any) => m.type === "assistant_text" && !m.is_partial) as any;
    expect(text).toBeDefined();
    expect(text.msg_id).toBe("msg_X");
    expect(text.text).toBe("hello world");

    // No terminal turn_complete / turn_cancelled for a still-live turn.
    expect(ipc.some((m: any) => m.type === "turn_complete")).toBe(false);
    expect(ipc.some((m: any) => m.type === "turn_cancelled")).toBe(false);
  });

  test("content blocks pass through add_user_message verbatim", async () => {
    const fakeBase64 = "aGVsbG8=";
    const { manager, turn } = setupTurn({
      msgId: "msg_att",
      userText: "see",
      userAttachments: [{ filename: "f.png", content: fakeBase64, media_type: "image/png" }],
      textBlock: "ok",
    });
    const ipc = await captureIpcOutput(async () => {
      (manager as any).emitInflightTurnFromActiveTurn(turn);
    });
    const userReplay = ipc.find((m: any) => m.type === "add_user_message") as any;
    // Setup helper produced a text block (the prompt) + an image
    // block (the attachment). Verbatim pass-through.
    expect(userReplay.content).toEqual([
      { type: "text", text: "see" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: fakeBase64 },
      },
    ]);
  });

  test("no content blocks: snapshot emits add_user_message only (no text frame)", async () => {
    // Contract: when the wire hasn't produced any blocks yet, the
    // snapshot still emits add_user_message (so the reducer's
    // `pendingTurn` is seeded) but no assistant content. The reducer's
    // `activeMsgId` stays `null` until the first content event arrives
    // per [D14]; if the turn is interrupted before that, the no-content
    // fallback in `handleTurnComplete` commits `pendingTurn`.
    const { manager, turn } = setupTurn({
      msgId: "msg_empty",
      userText: "go",
      textBlock: null,
    });
    const ipc = await captureIpcOutput(async () => {
      (manager as any).emitInflightTurnFromActiveTurn(turn);
    });
    expect(ipc.some((m: any) => m.type === "add_user_message")).toBe(true);
    expect(ipc.some((m: any) => m.type === "assistant_text")).toBe(false);
  });

  test("gotResult=true: terminal turn_complete present, keyed to msg_id", async () => {
    // Contract: a turn that already finished while suppressed gets its
    // terminal frame synthesized so the reducer commits the TurnEntry.
    const { manager, turn } = setupTurn({
      msgId: "msg_done",
      userText: "ask",
      textBlock: "answer",
      gotResult: true,
    });
    const ipc = await captureIpcOutput(async () => {
      (manager as any).emitInflightTurnFromActiveTurn(turn);
    });
    const tc = ipc.find((m: any) => m.type === "turn_complete") as any;
    expect(tc).toBeDefined();
    expect(tc.msg_id).toBe("msg_done");
    expect(tc.result).toBe("success");
  });

  test("interrupted=true: turn_cancelled present with partial_result from partialText", async () => {
    // Contract: an interrupted turn's terminal carries partialText as
    // partial_result for transcript display.
    const { manager, turn } = setupTurn({
      msgId: "msg_intr",
      userText: "ask",
      textBlock: "I was saying",
      partialText: "I was saying",
      interrupted: true,
    });
    const ipc = await captureIpcOutput(async () => {
      (manager as any).emitInflightTurnFromActiveTurn(turn);
    });
    const tcanc = ipc.find((m: any) => m.type === "turn_cancelled") as any;
    expect(tcanc).toBeDefined();
    expect(tcanc.msg_id).toBe("msg_intr");
    expect(tcanc.partial_result).toBe("I was saying");
  });

  // (deleted: "interrupted=true with empty partialText defaults partial_result"
  // — edge-case redundancy; covered implicitly by the default-string path.)

  test("gotResult takes precedence over interrupted (defensive)", async () => {
    // Contract: if both flags are set, gotResult wins (turn_complete,
    // not turn_cancelled). Shouldn't happen in practice but pinned
    // for safety.
    const { manager, turn } = setupTurn({
      msgId: "msg_both",
      userText: "ask",
      textBlock: "ok",
      gotResult: true,
      interrupted: true,
    });
    const ipc = await captureIpcOutput(async () => {
      (manager as any).emitInflightTurnFromActiveTurn(turn);
    });
    expect(ipc.some((m: any) => m.type === "turn_complete")).toBe(true);
    expect(ipc.some((m: any) => m.type === "turn_cancelled")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Overlapping-turn routing
//
// A `user_message` submitted while a turn is already in flight must
// not clobber the running turn or strand the follow-on turn's events.
// Turn ownership is drain-bounded: one `ActiveTurn` per claude
// `result`. `handleUserMessage` opens the turn for the idle case and
// queues an overlapping message in `pendingTurnInputs`; the stdout
// drain opens the follow-on turn when claude's events for it arrive.
// ---------------------------------------------------------------------------

describe("overlapping-turn routing", () => {
  // System-init line shared by the scripted turns below.
  const initLine = (sid: string) => ({
    type: "system",
    subtype: "init",
    session_id: sid,
    cwd: "/p",
    tools: ["Read"],
    model: "m",
    permissionMode: "acceptEdits",
    slash_commands: [],
    plugins: [],
    agents: [],
    skills: [],
    claude_code_version: "2.1",
  });
  const textDelta = (text: string) => ({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  });
  const resultLine = { type: "result", subtype: "success", result: "" };

  // Count the `user`-envelope writes to claude's stdin.
  const userWriteCount = (writes: string[]): number =>
    writes.filter((w) => {
      try {
        return (JSON.parse(w.replace(/\n$/, "")) as { type?: string }).type === "user";
      } catch {
        return false;
      }
    }).length;

  test("a message queued mid-turn runs as a bracketed follow-on turn", async () => {
    // claude buffered the mid-turn message and runs it as turn 2 — the
    // regression case: pre-fix, turn 2's events arrived with no active
    // turn and were dropped as inter-turn, so turn 2 never completed.
    const manager = new SessionManager(
      "/tmp/tugcode-overlap-buffered-" + Date.now(),
      crypto.randomUUID(),
    );
    const writes: string[] = [];
    const mockStdin = injectMockSubprocess(manager, [
      initLine("sess-overlap"),
      textDelta("TurnOne"),
      resultLine,
      initLine("sess-overlap"),
      textDelta("TurnTwo"),
      resultLine,
    ]);
    mockStdin.write = (data: unknown) => writes.push(String(data));

    const captured = await captureIpcOutput(async () => {
      const p1 = manager.handleUserMessage({
        type: "user_message",
        content: [{ type: "text" as const, text: "first" }]
      });
      const p2 = manager.handleUserMessage({
        type: "user_message",
        content: [{ type: "text" as const, text: "second" }]
      });
      await Promise.all([p1, p2]);
    });

    // Both turns bracketed — two turn_complete frames.
    const turnCompletes = captured.filter((m: any) => m.type === "turn_complete");
    expect(turnCompletes.length).toBe(2);

    // The follow-on turn's content was routed, not dropped.
    const turnTwoIdx = captured.findIndex(
      (m: any) => m.type === "assistant_text" && m.text === "TurnTwo",
    );
    expect(turnTwoIdx).toBeGreaterThan(-1);

    // ...and it streamed after the first turn closed.
    const firstTcIdx = captured.findIndex((m: any) => m.type === "turn_complete");
    expect(turnTwoIdx).toBeGreaterThan(firstTcIdx);

    // Both messages reached claude's stdin.
    expect(userWriteCount(writes)).toBe(2);
  });

  test("a merged mid-turn message brackets as a single turn", async () => {
    // claude merged the mid-turn message into the running turn (one
    // `result`). tugcode brackets exactly one turn — no spurious
    // second turn_complete — and both messages still reached claude.
    const manager = new SessionManager(
      "/tmp/tugcode-overlap-merged-" + Date.now(),
      crypto.randomUUID(),
    );
    const writes: string[] = [];
    const mockStdin = injectMockSubprocess(manager, [
      initLine("sess-merged"),
      textDelta("Merged"),
      resultLine,
    ]);
    mockStdin.write = (data: unknown) => writes.push(String(data));

    const captured = await captureIpcOutput(async () => {
      const p1 = manager.handleUserMessage({
        type: "user_message",
        content: [{ type: "text" as const, text: "first" }]
      });
      const p2 = manager.handleUserMessage({
        type: "user_message",
        content: [{ type: "text" as const, text: "second" }]
      });
      await Promise.all([p1, p2]);
    });

    const turnCompletes = captured.filter((m: any) => m.type === "turn_complete");
    expect(turnCompletes.length).toBe(1);
    expect(userWriteCount(writes)).toBe(2);
  });

  test("a single non-overlapping turn brackets unchanged", async () => {
    const manager = new SessionManager(
      "/tmp/tugcode-overlap-single-" + Date.now(),
      crypto.randomUUID(),
    );
    const mockStdin = injectMockSubprocess(manager, [
      initLine("sess-single"),
      textDelta("OnlyTurn"),
      resultLine,
    ]);
    mockStdin.write = (_data: unknown) => {};

    const captured = await captureIpcOutput(() =>
      manager.handleUserMessage({
        type: "user_message",
        content: [{ type: "text" as const, text: "only" }]
      }),
    );

    const turnCompletes = captured.filter((m: any) => m.type === "turn_complete");
    expect(turnCompletes.length).toBe(1);
    // The turn-input FIFO was never touched; the drain cleared the
    // active turn on `result`.
    expect((manager as any).pendingTurnInputs.length).toBe(0);
    expect((manager as any).activeTurn).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// No-content turn terminal identity (the /compact-after-/model failure)
// ---------------------------------------------------------------------------

describe("no-content turn terminal frames carry the opener id", () => {
  test("ActiveTurn mints t-<seq> as its opener id", () => {
    const turn = new ActiveTurn(7, []);
    expect(turn.openerId).toBe("t-7");
    expect(turn.currentMessageId).toBeNull();
  });

  test("a local-command-only turn's turn_complete and stdout echo share a non-empty t- msg_id", async () => {
    // The live /compact / /model shape: claude never opens an assistant
    // message, only echoes <local-command-stdout> and ends with result.
    // The terminal frames must NOT ride msg_id "" — the reducer dedupes
    // commits by msg_id, and a shared "" key made the second no-content
    // turn's commit vanish (dropped /compact row, phase stuck "Waiting").
    const manager = new SessionManager(
      "/tmp/tugcode-opener-id-" + Date.now(),
      crypto.randomUUID(),
    );
    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "user",
        isReplay: true,
        message: {
          role: "user",
          content: "<local-command-stdout>Compacted </local-command-stdout>",
        },
      },
      { type: "result", subtype: "success", result: "" },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const userMsg = {
      type: "user_message" as const,
      content: [{ type: "text" as const, text: "/compact" }],
    };
    const ipcMessages = await captureIpcOutput(() =>
      manager.handleUserMessage(userMsg),
    );

    const turnCompletes = ipcMessages.filter(
      (m: any) => m.type === "turn_complete",
    );
    expect(turnCompletes.length).toBe(1);
    const terminalMsgId = (turnCompletes[0] as any).msg_id as string;
    expect(terminalMsgId).toMatch(/^t-\d+$/);

    // The synthesized stdout-echo block rides the same key, so the
    // reducer's activeMsgId matches the terminal frame.
    const echoes = ipcMessages.filter((m: any) => m.type === "assistant_text");
    expect(echoes.length).toBeGreaterThan(0);
    for (const echo of echoes) {
      expect((echo as any).msg_id).toBe(terminalMsgId);
    }
    const starts = ipcMessages.filter(
      (m: any) => m.type === "content_block_start",
    );
    for (const start of starts) {
      expect((start as any).msg_id).toBe(terminalMsgId);
    }
  });

  test("a content-bearing turn keeps claude's real message id on turn_complete", async () => {
    const manager = new SessionManager(
      "/tmp/tugcode-real-id-" + Date.now(),
      crypto.randomUUID(),
    );
    const mockStdin = injectMockSubprocess(manager, [
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "msg_real_1", usage: { input_tokens: 1 } },
        },
      },
      { type: "result", subtype: "success", result: "" },
    ]);
    mockStdin.write = (_data: unknown) => {};

    const userMsg = {
      type: "user_message" as const,
      content: [{ type: "text" as const, text: "hello" }],
    };
    const ipcMessages = await captureIpcOutput(() =>
      manager.handleUserMessage(userMsg),
    );

    const turnCompletes = ipcMessages.filter(
      (m: any) => m.type === "turn_complete",
    );
    expect(turnCompletes.length).toBe(1);
    expect((turnCompletes[0] as any).msg_id).toBe("msg_real_1");
  });
});
