/**
 * The outbound decoder table: each decoder accepts the frame tugcode builds
 * for its tag, with and without the envelope, and rejects a drifted field
 * with a path that names it. Acceptance across real captured frames is the
 * deck's catalog test; these are the shapes worth stating by hand.
 */

import { describe, expect, test } from "bun:test";
import { isDecodeError } from "../decode";
import { decodeOutbound, decodeTagged, hasDecoder, OUTBOUND_DECODERS } from "../outbound-decoders";
import { OUTBOUND_TAGS } from "../outbound";

const STARTED = {
  type: "task_started" as const,
  session_id: "s",
  task_id: "t1",
  tool_use_id: "tu1",
  description: "Run sleep",
  task_type: "local_bash",
  ipc_version: 2,
};

describe("table", () => {
  test("every key is a tugcode wire tag, or one of tugcast's own frames", () => {
    const tags = new Set<string>(OUTBOUND_TAGS);
    const foreign = Object.keys(OUTBOUND_DECODERS).filter((key) => !tags.has(key));
    expect(foreign.sort()).toEqual(["report", "tug_notice"]);
  });

  test("hasDecoder reads own keys only", () => {
    expect(hasDecoder("task_started")).toBe(true);
    expect(hasDecoder("toString")).toBe(false);
    expect(hasDecoder("not_a_tag")).toBe(false);
  });

  test("decodeTagged decodes by the frame's own type, and has nothing to say about an unknown one", () => {
    expect(decodeTagged(STARTED)).toBe(STARTED);
    const drifted = decodeTagged({ ...STARTED, task_id: 7 });
    expect(isDecodeError(drifted) && drifted.tag === "task_started" && drifted.path).toBe("$.task_id");
    expect(decodeTagged({ type: "not_a_tag" })).toBeNull();
    expect(decodeTagged({ type: 7 })).toBeNull();
    expect(decodeTagged("task_started")).toBeNull();
    expect(decodeTagged(null)).toBeNull();
  });
});

describe("task_started", () => {
  test("accepts tugcode's frame, returned as received", () => {
    const frame = { ...STARTED, subagent_type: "Explore", tug_session_id: "tug" };
    expect(decodeOutbound("task_started", frame)).toBe(frame);
  });

  test("accepts a frame without the envelope", () => {
    const { session_id: _s, ipc_version: _v, ...bare } = STARTED;
    expect(isDecodeError(decodeOutbound("task_started", bare))).toBe(false);
  });

  test("rejects a drifted field, naming it", () => {
    const r = decodeOutbound("task_started", { ...STARTED, tool_use_id: 7 });
    expect(isDecodeError(r) && { ...r }).toEqual({
      tag: "task_started",
      path: "$.tool_use_id",
      expected: "string",
      got: "number 7",
    });
  });

  test("rejects a wrong envelope when present", () => {
    const r = decodeOutbound("task_started", { ...STARTED, ipc_version: "2" });
    expect(isDecodeError(r) && r.path).toBe("$.ipc_version");
  });

  test("rejects a frame of another tag", () => {
    const r = decodeOutbound("task_started", { ...STARTED, type: "task_updated" });
    expect(isDecodeError(r) && r.path).toBe("$.type");
  });
});

describe("task_updated", () => {
  const frame = { type: "task_updated", task_id: "t1", status: "completed", ipc_version: 2 };

  test("accepts with and without end_time", () => {
    expect(isDecodeError(decodeOutbound("task_updated", frame))).toBe(false);
    expect(isDecodeError(decodeOutbound("task_updated", { ...frame, end_time: 5 }))).toBe(false);
  });

  test("rejects a missing status", () => {
    const { status: _, ...rest } = frame;
    const r = decodeOutbound("task_updated", rest);
    expect(isDecodeError(r) && `${r.path} ${r.got}`).toBe("$.status undefined");
  });
});

describe("task_progress", () => {
  const frame = {
    type: "task_progress",
    task_id: "t1",
    tool_use_id: "tu1",
    description: "Running ls",
    last_tool_name: "Bash",
    usage: { total_tokens: 10, tool_uses: 1, duration_ms: 0 },
  };

  test("accepts with and without usage", () => {
    expect(isDecodeError(decodeOutbound("task_progress", frame))).toBe(false);
    const { usage: _, ...bare } = frame;
    expect(isDecodeError(decodeOutbound("task_progress", bare))).toBe(false);
  });

  test("a drifted usage field reports its nested path", () => {
    const r = decodeOutbound("task_progress", { ...frame, usage: { tool_uses: "1" } });
    expect(isDecodeError(r) && r.path).toBe("$.usage.tool_uses");
  });
});

/** The decode error's `path`, or null when the frame decoded. */
function failPath(tag: Parameters<typeof decodeOutbound>[0], frame: unknown): string | null {
  const r = decodeOutbound(tag, frame);
  return isDecodeError(r) ? r.path : null;
}

describe("turn content", () => {
  test("content_block_start: tool_use blocks need their tool fields, text blocks do not", () => {
    const text = { type: "content_block_start", msg_id: "m", block_index: 0, kind: "text" };
    expect(failPath("content_block_start", text)).toBeNull();
    expect(failPath("content_block_start", { ...text, kind: "thinking" })).toBeNull();
    const tool = { ...text, kind: "tool_use", tool_use_id: "tu", tool_name: "Read" };
    expect(failPath("content_block_start", tool)).toBeNull();
    const { tool_name: _, ...nameless } = tool;
    expect(failPath("content_block_start", nameless)).toBe("$.tool_name");
    expect(failPath("content_block_start", { ...text, kind: "image" })).toBe("$.kind");
  });

  test("assistant_text admits a frame from before block_index", () => {
    const frame = {
      type: "assistant_text", msg_id: "m", seq: 0, rev: 0, text: "hi", is_partial: true, status: "partial",
    };
    expect(failPath("assistant_text", frame)).toBeNull();
    expect(failPath("assistant_text", { ...frame, block_index: "0" })).toBe("$.block_index");
    expect(failPath("assistant_text", { ...frame, is_partial: "true" })).toBe("$.is_partial");
  });

  test("tool_use_structured carries an object or a string", () => {
    const frame = { type: "tool_use_structured", tool_use_id: "tu", tool_name: "" };
    expect(failPath("tool_use_structured", { ...frame, structured_result: { stdout: "" } })).toBeNull();
    expect(failPath("tool_use_structured", { ...frame, structured_result: "Error: no such file" })).toBeNull();
    expect(failPath("tool_use_structured", { ...frame, structured_result: [] })).toBe("$.structured_result");
  });

  test("turn_complete checks its telemetry when present", () => {
    const frame = { type: "turn_complete", msg_id: "m", seq: 1, result: "success" };
    expect(failPath("turn_complete", frame)).toBeNull();
    const telemetry = {
      cost: {
        inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0.01,
      },
      wallClockMs: 10, awaitingApprovalMs: 0, transportDowntimeMs: 0, activeMs: 10,
      ttftMs: null, ttftcMs: 5, reconnectCount: 0, maxStreamGapMs: 0, sessionInitTokens: null,
    };
    expect(failPath("turn_complete", { ...frame, telemetry })).toBeNull();
    const drifted = { ...telemetry, cost: { ...telemetry.cost, totalCostUsd: "0.01" } };
    expect(failPath("turn_complete", { ...frame, telemetry: drifted })).toBe("$.telemetry.cost.totalCostUsd");
  });

  test("turn_complete's result is one of the three tugcode writes", () => {
    const frame = { type: "turn_complete", msg_id: "m", seq: 1, result: "success" };
    for (const result of ["success", "error", "interrupted"]) {
      expect(failPath("turn_complete", { ...frame, result })).toBeNull();
    }
    expect(failPath("turn_complete", { ...frame, result: "" })).toBe("$.result");
  });
});

describe("decoders the catalog has not captured", () => {
  test("turn_cancelled", () => {
    const frame = { type: "turn_cancelled", msg_id: "m", seq: 4, partial_result: "so far", ipc_version: 2 };
    expect(failPath("turn_cancelled", frame)).toBeNull();
    expect(failPath("turn_cancelled", { ...frame, is_recovery: true })).toBeNull();
    expect(failPath("turn_cancelled", { ...frame, partial_result: null })).toBe("$.partial_result");
  });

  test("interrupt_noop", () => {
    const frame = { type: "interrupt_noop", tug_session_id: "tug", reason: "no_turn", ipc_version: 2 };
    expect(failPath("interrupt_noop", frame)).toBeNull();
    expect(failPath("interrupt_noop", { ...frame, reason: "busy" })).toBe("$.reason");
    const { tug_session_id: _, ...unaddressed } = frame;
    expect(failPath("interrupt_noop", unaddressed)).toBe("$.tug_session_id");
  });

  test("stop_all_work_done", () => {
    expect(failPath("stop_all_work_done", { type: "stop_all_work_done", tug_session_id: "tug" })).toBeNull();
    expect(failPath("stop_all_work_done", { type: "stop_all_work_done" })).toBe("$.tug_session_id");
  });

  test("add_user_message: text and base64 image blocks", () => {
    const frame = {
      type: "add_user_message",
      content: [
        { type: "text", text: "look" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ],
      timestamp: 1,
      promptUuid: "p",
      origin: "wheel",
      ipc_version: 2,
    };
    expect(failPath("add_user_message", frame)).toBeNull();
    expect(failPath("add_user_message", { ...frame, content: [] })).toBeNull();
    expect(failPath("add_user_message", { ...frame, content: "look" })).toBe("$.content");
    expect(failPath("add_user_message", { ...frame, origin: "agent" })).toBe("$.origin");
    const badImage = { type: "image", source: { type: "url", url: "x" } };
    expect(failPath("add_user_message", { ...frame, content: [badImage] })).toBe("$.content[0].source.type");
  });

  test("assistant_opener", () => {
    expect(failPath("assistant_opener", { type: "assistant_opener", ipc_version: 2 })).toBeNull();
    expect(failPath("assistant_opener", { type: "assistant_opener", timestamp: "t" })).toBe("$.timestamp");
  });

  test("tug_notice: tugcast's opener and bulletin", () => {
    const opener = { tug_session_id: "tug", type: "tug_notice", origin: "base-motion", text: "base moved" };
    expect(failPath("tug_notice", opener)).toBeNull();
    expect(failPath("tug_notice", { ...opener, standalone: true })).toBeNull();
    expect(failPath("tug_notice", { ...opener, standalone: "yes" })).toBe("$.standalone");
  });
});

describe("telemetry and display", () => {
  test("system_metadata needs only cwd; its lists are checked as arrays", () => {
    expect(failPath("system_metadata", { type: "system_metadata", cwd: "/p" })).toBeNull();
    const full = { type: "system_metadata", cwd: "/p", session_id: "s", tools: ["Read"], model: "m", mcp_servers: [] };
    expect(failPath("system_metadata", full)).toBeNull();
    expect(failPath("system_metadata", { ...full, tools: "Read" })).toBe("$.tools");
    expect(failPath("system_metadata", { type: "system_metadata" })).toBe("$.cwd");
  });

  test("context_breakdown checks each category's id", () => {
    const frame = {
      type: "context_breakdown",
      tug_session_id: "tug",
      context_max: 200000,
      categories: [{ id: "skills", label: "Skills", tokens: 12 }],
    };
    expect(failPath("context_breakdown", frame)).toBeNull();
    const drifted = { ...frame, categories: [...frame.categories, { id: "plugins", label: "Plugins", tokens: 1 }] };
    expect(failPath("context_breakdown", drifted)).toBe("$.categories[1].id");
  });

  test("api_retry: error_status is a number or null", () => {
    const frame = { type: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 529, error: "overloaded" };
    expect(failPath("api_retry", frame)).toBeNull();
    expect(failPath("api_retry", { ...frame, error_status: null })).toBeNull();
    expect(failPath("api_retry", { ...frame, error_status: "529" })).toBe("$.error_status");
  });

  test("model_refusal_fallback", () => {
    const frame = {
      type: "model_refusal_fallback", original_model: "a", fallback_model: "b", trigger: "refusal", direction: "down",
    };
    expect(failPath("model_refusal_fallback", frame)).toBeNull();
    const { direction: _, ...rest } = frame;
    expect(failPath("model_refusal_fallback", rest)).toBe("$.direction");
  });

  test("output_truncated and goal_feedback", () => {
    expect(failPath("output_truncated", { type: "output_truncated", ipc_version: 2 })).toBeNull();
    expect(failPath("goal_feedback", { type: "goal_feedback", condition: "c", reason: "r" })).toBeNull();
    expect(failPath("goal_feedback", { type: "goal_feedback", condition: "c" })).toBe("$.reason");
  });

  test("unknown_event", () => {
    const frame = { type: "unknown_event", original_type: "system/new_thing", payload_hex_preview: "7b22" };
    expect(failPath("unknown_event", frame)).toBeNull();
    expect(failPath("unknown_event", { ...frame, original_type: 3 })).toBe("$.original_type");
  });

  test("error: site is one of tugcode's", () => {
    const frame = { type: "error", message: "boom", recoverable: false, site: "send_after_eof", ipc_version: 2 };
    expect(failPath("error", frame)).toBeNull();
    expect(failPath("error", { ...frame, site: "elsewhere" })).toBe("$.site");
    expect(failPath("error", { ...frame, recoverable: "no" })).toBe("$.recoverable");
    // Legacy-optional: an error frame without either still decodes.
    expect(failPath("error", { type: "error", message: "boom" })).toBeNull();
  });

  test("resume_failed", () => {
    const frame = { type: "resume_failed", reason: "missing", stale_session_id: "old" };
    expect(failPath("resume_failed", frame)).toBeNull();
    expect(failPath("resume_failed", { ...frame, stale_session_id: null })).toBe("$.stale_session_id");
  });
});

describe("replay, lineage and rewind", () => {
  test("compact_boundary: every field but the tag is optional", () => {
    expect(failPath("compact_boundary", { type: "compact_boundary" })).toBeNull();
    const full = { type: "compact_boundary", trigger: "auto", pre_tokens: 140000, post_tokens: 9000, timestamp: 1 };
    expect(failPath("compact_boundary", full)).toBeNull();
    expect(failPath("compact_boundary", { ...full, pre_tokens: "140000" })).toBe("$.pre_tokens");
  });

  test("compact_summary", () => {
    expect(failPath("compact_summary", { type: "compact_summary", summary: "recap" })).toBeNull();
    expect(failPath("compact_summary", { type: "compact_summary" })).toBe("$.summary");
  });

  test("session_segment: kind is one of the lineage kinds", () => {
    const frame = { type: "session_segment", parentSessionId: "p", newSessionId: "n", kind: "rotation", stage: "review" };
    expect(failPath("session_segment", frame)).toBeNull();
    expect(failPath("session_segment", { ...frame, kind: "rewind", forkPoint: "u" })).toBeNull();
    expect(failPath("session_segment", { ...frame, kind: "split" })).toBe("$.kind");
    const { parentSessionId: _, ...orphan } = frame;
    expect(failPath("session_segment", orphan)).toBe("$.parentSessionId");
  });

  test("replay_stage and replay_relocation", () => {
    const stage = { type: "replay_stage", stage: "implement", model: "", document: "", arc: "a" };
    expect(failPath("replay_stage", stage)).toBeNull();
    expect(failPath("replay_stage", { ...stage, model: undefined })).toBe("$.model");
    const reloc = { type: "replay_relocation", from_dir: "/a", to_dir: "/b" };
    expect(failPath("replay_relocation", reloc)).toBeNull();
    expect(failPath("replay_relocation", { ...reloc, to_dir: 1 })).toBe("$.to_dir");
  });

  test("request_replay_dropped", () => {
    const frame = { type: "request_replay_dropped", ask_id: "ask-1", ipc_version: 2 };
    expect(failPath("request_replay_dropped", frame)).toBeNull();
    expect(failPath("request_replay_dropped", { ...frame, ask_id: undefined })).toBe("$.ask_id");
  });

  test("replay_started and replay_complete, including tugcast's synthetic close", () => {
    expect(failPath("replay_started", { type: "replay_started" })).toBeNull();
    const complete = {
      type: "replay_complete", count: 4, firstLoadedTurnIndex: 0, totalTurns: 4, hasOlder: false, ipc_version: 2,
    };
    expect(failPath("replay_complete", complete)).toBeNull();
    // `synthetic_replay_complete` in tugcast's agent_bridge.rs: no ipc_version.
    const synthetic = { type: "replay_complete", count: 0, error: { kind: "replay_timeout", message: "watchdog" } };
    expect(failPath("replay_complete", synthetic)).toBeNull();
    const drifted = { ...synthetic, error: { kind: "timeout", message: "watchdog" } };
    expect(failPath("replay_complete", drifted)).toBe("$.error.kind");
  });

  test("prompt_anchor", () => {
    expect(failPath("prompt_anchor", { type: "prompt_anchor", promptUuid: "u" })).toBeNull();
    expect(failPath("prompt_anchor", { type: "prompt_anchor" })).toBe("$.promptUuid");
  });

  test("rewind_preview_result and rewind_result", () => {
    const preview = { type: "rewind_preview_result", promptUuid: "u", canRewind: true, filesChanged: ["a.ts"] };
    expect(failPath("rewind_preview_result", preview)).toBeNull();
    expect(failPath("rewind_preview_result", { ...preview, filesChanged: ["a.ts", 2] })).toBe("$.filesChanged[1]");
    const result = { type: "rewind_result", promptUuid: "u", scope: "both", canRewind: true, newSessionId: "n" };
    expect(failPath("rewind_result", result)).toBeNull();
    expect(failPath("rewind_result", { ...result, scope: "all" })).toBe("$.scope");
  });
});

describe("unwrapped before admission", () => {
  test("replay_batch admits any frames; each inner frame answers to its own decoder", () => {
    const batch = {
      type: "replay_batch",
      frames: [{ type: "compact_boundary", trigger: "auto", pre_tokens: 140000 }, { type: "prompt_anchor" }],
      ipc_version: 2,
    };
    expect(failPath("replay_batch", batch)).toBeNull();
    expect(failPath("replay_batch", { ...batch, frames: {} })).toBe("$.frames");
  });

  test("tool_progress: parent_tool_use_id is a string or null", () => {
    const frame = {
      type: "tool_progress", tool_use_id: "tu", tool_name: "Bash", elapsed_time_seconds: 3, parent_tool_use_id: null,
    };
    expect(failPath("tool_progress", frame)).toBeNull();
    expect(failPath("tool_progress", { ...frame, parent_tool_use_id: "p" })).toBeNull();
    expect(failPath("tool_progress", { ...frame, elapsed_time_seconds: "3" })).toBe("$.elapsed_time_seconds");
  });

  test("report: tugcast's payload, attached or not", () => {
    const frame = { type: "report", tool_use_id: null, label: "rust", text: "compiling", done: 3, total: 9, at_ms: 1 };
    expect(failPath("report", frame)).toBeNull();
    expect(failPath("report", { ...frame, tool_use_id: "tu" })).toBeNull();
    const { tool_use_id: _, ...unattached } = frame;
    expect(failPath("report", unattached)).toBe("$.tool_use_id");
  });

  test("report: a unit frame round-trips with its jobs and its rows as the reporter wrote them", () => {
    const frame = {
      type: "report",
      tool_use_id: "tu",
      label: "app-test",
      text: "at0339 FAIL",
      done: 4,
      total: 25,
      failures: 1,
      unit: "file",
      jobs: 4,
      units: [
        { name: "at0339-composer-order-census", status: "fail", index: 3, passed: 1, total: 2, secs: 14, median: 9,
          title: "composer clears after send", message: "timed out" },
        { name: "at0352-pane-split-restore", status: "running", index: 5, started_at_ms: 1_760_000_000_000, median: 11 },
      ],
      at_ms: 1,
      tug_session_id: "s",
    };
    expect(decodeOutbound("report", frame)).toEqual(frame);
    expect(decodeOutbound("report", { ...frame, nests: true })).toEqual({ ...frame, nests: true });
    expect(failPath("report", { ...frame, nests: "yes" })).toBe("$.nests");
    expect(failPath("report", { ...frame, unit: 7 })).toBe("$.unit");
    expect(failPath("report", { ...frame, jobs: "4" })).toBe("$.jobs");
    expect(failPath("report", { ...frame, units: "rows" })).toBe("$.units");
  });
});
