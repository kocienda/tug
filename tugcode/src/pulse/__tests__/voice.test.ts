/**
 * PulseVoice — the machine-thinking-out-loud mirror against a fake
 * clock. Text fixtures are real interstitial narration drawn from
 * actual session histories, per the real-content fixture rule.
 */

import { describe, expect, test } from "bun:test";

import {
  PulseVoice,
  VOICE_THROTTLE_MS,
  SCOPE_IDLE_SWEEP_MS,
  extractDisplay,
  parseWireLine,
} from "../voice";
import type { OutboundMessage } from "../../types";

function assistantText(
  text: string,
  opts: { msgId?: string; blockIndex?: number; isPartial?: boolean } = {},
): OutboundMessage {
  return {
    type: "assistant_text",
    msg_id: opts.msgId ?? "m1",
    block_index: opts.blockIndex ?? 0,
    seq: 1,
    rev: 1,
    text,
    is_partial: opts.isPartial ?? true,
    status: opts.isPartial === false ? "complete" : "partial",
    ipc_version: 2,
  };
}

function turnComplete(): OutboundMessage {
  return { type: "turn_complete", msg_id: "m1", seq: 9, result: "done", ipc_version: 2 };
}

function turnCancelled(): OutboundMessage {
  return { type: "turn_cancelled", msg_id: "m1", seq: 9, ipc_version: 2 } as OutboundMessage;
}

/**
 * A permission request on its way to the user — the frame that opens a
 * narrated wait ([P09].1). `toolUseId` is deliberately optional and
 * deliberately spelled at each call site: a forward that names no call is the
 * QUESTION case, and which of the two a fixture is exercising is the whole
 * subject of half these tests.
 */
function permissionForward(opts: {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string | undefined;
  isQuestion?: boolean;
}): OutboundMessage {
  const toolUseId = "toolUseId" in opts ? opts.toolUseId : "toolu_x";
  return {
    type: "control_request_forward",
    request_id: "req_1",
    tool_name: opts.toolName,
    input: opts.input,
    is_question: opts.isQuestion ?? false,
    ipc_version: 2,
    ...(toolUseId !== undefined ? { tool_use_id: toolUseId } : {}),
  } as OutboundMessage;
}

/** The request withdrawn — one of the two ways a wait ends. */
function controlRequestCancel(): OutboundMessage {
  return { type: "control_request_cancel", request_id: "req_1", ipc_version: 2 };
}

/** The other way: the call ran (or was denied) and reported. */
function toolResult(toolUseId: string): OutboundMessage {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    output: "ok",
    is_error: false,
    ipc_version: 2,
  };
}

function toolUse(
  toolName: string,
  input: Record<string, unknown>,
  opts: { id?: string; parent?: string } = {},
): OutboundMessage {
  return {
    type: "tool_use",
    msg_id: "m1",
    seq: 1,
    tool_name: toolName,
    tool_use_id: opts.id ?? "toolu_x",
    input,
    ipc_version: 2,
    ...(opts.parent !== undefined ? { parent_tool_use_id: opts.parent } : {}),
  } as OutboundMessage;
}

/** The session's working directory — what its file beats read relative to. */
const ROOT = "/u/src/tugtool";

/**
 * The spawn-time `cwd`-only metadata frame. A real session always sends one
 * before its first turn, so every fixture below that narrates a file seeds its
 * scope with this first — a voice that has never seen one is the separate
 * no-root case, and has its own test.
 */
function systemMetadata(cwd: string = ROOT): OutboundMessage {
  return { type: "system_metadata", cwd, ipc_version: 2 };
}

/**
 * A voice whose `s1` scope has been told where it is working — the state every
 * real session reaches before its first turn, and the one the file beats below
 * are written against. The unrooted voice is a case of its own, not a default.
 */
function rootedVoice(): PulseVoice {
  const voice = new PulseVoice();
  voice.onFrame("s1", systemMetadata(), 0);
  return voice;
}

function toolProgress(
  opts: { filePath: string | null; lines: number; toolName?: string },
): OutboundMessage {
  return {
    type: "tool_input_progress",
    msg_id: "m1",
    seq: 1,
    block_index: 0,
    tool_use_id: "toolu_1",
    tool_name: opts.toolName ?? "Write",
    bytes: 100,
    content_lines: opts.lines,
    file_path: opts.filePath,
    ipc_version: 2,
  };
}

describe("extractDisplay", () => {
  test("a complete sentence shows as itself", () => {
    expect(
      extractDisplay("I'll dig into how Tug tracks and resumes sessions today."),
    ).toBe("I'll dig into how Tug tracks and resumes sessions today.");
  });

  test("the LAST complete sentence wins when the tail is trivial", () => {
    expect(
      extractDisplay(
        "There's a ~/.claude/sessions directory. Checking it now. OK",
      ),
    ).toBe("Checking it now.");
  });

  test("a long in-progress tail shows mid-stream, marked as streaming", () => {
    expect(
      extractDisplay("Quick final checks on disk format details before I summar"),
    ).toBe("Quick final checks on disk format details before I summar…");
  });

  test("a settled sentence beats a fresher mid-clause tail", () => {
    expect(
      extractDisplay(
        "That self-feeding ripple is light. When Maxwell calculated its speed, it came out to ~300,000 km",
      ),
    ).toBe("That self-feeding ripple is light.");
  });

  test("a short fragment with nothing settled shows nothing", () => {
    expect(extractDisplay("Now the")).toBeNull();
    expect(extractDisplay("   ")).toBeNull();
  });

  test("markdown passes through raw — the deck renders it", () => {
    expect(
      extractDisplay("Reading **the devise skeleton** first, then `pulse.md` gets the fix."),
    ).toBe("Reading **the devise skeleton** first, then `pulse.md` gets the fix.");
  });

  test("very long content clips at the raw budget, never inside math", () => {
    const long = `${"word ".repeat(70)}end.`;
    const display = extractDisplay(long);
    expect(display).not.toBeNull();
    expect(display!.length).toBeLessThanOrEqual(300);

    const mathy = `intro words $${"x+".repeat(150)}x$$ trailing prose continues here.`;
    const clipped = extractDisplay(mathy);
    expect(clipped).not.toBeNull();
    // The cut never lands inside the span: either the whole math
    // survives or the line ends before it opens.
    const dollars = (clipped!.match(/\$\$/g) ?? []).length;
    expect(dollars % 2).toBe(0);
  });

  test("structured math keeps its label and balanced markup", () => {
    // Real shape from a live session (the broken-line bug this rule
    // set exists to prevent).
    const maxwell = [
      "**1. Gauss's Law (electricity)**",
      "",
      "$$\\nabla \\cdot \\mathbf{E} = \\frac{\\rho}{\\varepsilon_0}$$",
      "",
      "**2. Gauss's Law for Magnetism**",
      "",
      "$$\\nabla \\cdot \\mathbf{B} = 0$$",
    ].join("\n");
    const display = extractDisplay(maxwell);
    expect(display).toBe(
      "**2. Gauss's Law for Magnetism** $$\\nabla \\cdot \\mathbf{B} = 0$$",
    );
    // Balanced emphasis and math — nothing tears mid-marker.
    expect((display!.match(/\*\*/g) ?? []).length % 2).toBe(0);
    expect((display!.match(/\$\$/g) ?? []).length % 2).toBe(0);
  });

  test("an enumerator dot never ends a sentence", () => {
    const display = extractDisplay(
      "The four equations follow. **3.** Faraday describes induction quite neatly here",
    );
    expect(display).toBe("The four equations follow.");
  });
});

describe("PulseVoice — the monologue", () => {
  test("streaming deltas surface as the latest settled thought, throttled", () => {
    const voice = rootedVoice();
    voice.onFrame("s1", assistantText("I'll map how the reducer handles "), 0);
    voice.onFrame("s1", assistantText("task transitions first. Then the edit."), 100);
    const lines = voice.flush(1_200);
    expect(lines).toEqual([{ scope: "s1", text: "Then the edit." }]);
    // Unchanged text: no re-emit.
    expect(voice.flush(2_500)).toEqual([]);
    // New text within the throttle window: held…
    voice.onFrame("s1", assistantText(" Now checking the responder chain wiring."), 1_300);
    expect(voice.flush(1_400)).toEqual([]);
    // …and released when the window opens.
    expect(voice.flush(2_600)).toEqual([
      { scope: "s1", text: "Now checking the responder chain wiring." },
    ]);
  });

  test("a new block becomes the speaker; the old thought is history", () => {
    const voice = rootedVoice();
    voice.onFrame("s1", assistantText("First thought about the reducer seam.", { msgId: "m1" }), 0);
    voice.flush(1_100);
    voice.onFrame("s1", assistantText("Second thought: the selector layer is cleaner.", { msgId: "m2" }), 1_200);
    expect(voice.flush(2_300)).toEqual([
      { scope: "s1", text: "Second thought: the selector layer is cleaner." },
    ]);
  });

  test("a complete frame replaces accumulated deltas (deck reducer rule)", () => {
    const voice = rootedVoice();
    voice.onFrame("s1", assistantText("partial del"), 0);
    voice.onFrame("s1", assistantText("The final settled text of this block.", { isPartial: false }), 100);
    expect(voice.flush(1_200)).toEqual([
      { scope: "s1", text: "The final settled text of this block." },
    ]);
  });

  test("turn completion says done immediately and resets the thought", () => {
    const voice = rootedVoice();
    voice.onFrame("s1", assistantText("Wrapping up the last edit now."), 0);
    voice.flush(1_100);
    const done = voice.onFrame("s1", turnComplete(), 2_000);
    expect(done).toEqual({ scope: "s1", text: "Done" });
    // Nothing left to flush from the finished turn.
    expect(voice.flush(5_000)).toEqual([]);
  });

  test("cancellation says stopped", () => {
    const voice = rootedVoice();
    const stopped = voice.onFrame(
      "s1",
      { type: "turn_cancelled", msg_id: "m", seq: 2, partial_result: "", ipc_version: 2 },
      1_000,
    );
    expect(stopped).toEqual({ scope: "s1", text: "Stopped" });
  });

  test("scopes speak independently", () => {
    const voice = rootedVoice();
    voice.onFrame("s1", assistantText("Working through the reducer tests."), 0);
    voice.onFrame("s2", assistantText("Drafting the probe harness adaptation."), 0);
    const lines = voice.flush(1_200);
    expect(lines).toContainEqual({ scope: "s1", text: "Working through the reducer tests." });
    expect(lines).toContainEqual({ scope: "s2", text: "Drafting the probe harness adaptation." });
  });

  test("idle scopes are swept", () => {
    // Named scopes only — this test counts what the sweep returns, and a
    // seeded `s1` would be one more idle scope in the answer.
    const voice = new PulseVoice();
    voice.onFrame("s-idle", turnComplete(), 0);
    voice.onFrame("s-busy", turnComplete(), SCOPE_IDLE_SWEEP_MS - 1);
    expect(voice.sweepInactive(SCOPE_IDLE_SWEEP_MS + 1)).toEqual(["s-idle"]);
  });

  test("throttle constant sanity", () => {
    expect(VOICE_THROTTLE_MS).toBeGreaterThan(0);
  });

  test("a long write narrates progress instead of freezing", () => {
    const voice = rootedVoice();
    // The assistant says what it's about to do, then falls silent while the
    // Write streams — the monologue alone would freeze on this line.
    voice.onFrame("s1", assistantText("I'll write the poem file now."), 0);
    expect(voice.flush(1_100)).toEqual([
      { scope: "s1", text: "I'll write the poem file now." },
    ]);

    // Tool-input progress takes over and keeps the strip alive — with the
    // superseded thought riding along as the intent.
    voice.onFrame("s1", toolProgress({ filePath: `${ROOT}/docs/poem.txt`, lines: 12 }), 2_200);
    expect(voice.flush(2_300)).toEqual([
      {
        scope: "s1",
        text: "Writing docs/poem.txt — 12 lines",
        intent: "I'll write the poem file now.",
      },
    ]);

    // It climbs as more content streams.
    voice.onFrame("s1", toolProgress({ filePath: `${ROOT}/docs/poem.txt`, lines: 30 }), 3_400);
    expect(voice.flush(3_500)).toEqual([
      {
        scope: "s1",
        text: "Writing docs/poem.txt — 30 lines",
        intent: "I'll write the poem file now.",
      },
    ]);
  });

  test("the assistant resuming speech supersedes the tool-progress line", () => {
    const voice = rootedVoice();
    voice.onFrame("s1", toolProgress({ filePath: `${ROOT}/tugcode/src/pulse/voice.ts`, lines: 5 }), 0);
    expect(voice.flush(1_100)).toEqual([
      { scope: "s1", text: "Writing tugcode/src/pulse/voice.ts — 5 lines" },
    ]);
    // Once the assistant narrates again, the monologue wins back the strip.
    voice.onFrame("s1", assistantText("Now running the test suite to confirm."), 1_200);
    expect(voice.flush(2_300)).toEqual([
      { scope: "s1", text: "Now running the test suite to confirm." },
    ]);
  });

  test("a file beat names the whole path the session would say", () => {
    const voice = rootedVoice();
    // A path deep enough that its file name alone says nothing — the case the
    // beat exists to answer. The whole string crosses the wire; how much of it
    // fits is the deck's to decide at the width the surface has.
    voice.onFrame(
      "s1",
      toolProgress({
        filePath: `${ROOT}/tugdeck/src/lib/code-session-store/__tests__/code-session-store.transport-state.test.ts`,
        lines: 0,
        toolName: "Read",
      }),
      0,
    );
    expect(voice.flush(1_100)).toEqual([
      {
        scope: "s1",
        text: "Read tugdeck/src/lib/code-session-store/__tests__/code-session-store.transport-state.test.ts…",
      },
    ]);
  });

  test("a path outside the session's root keeps every segment it has", () => {
    const voice = rootedVoice();
    voice.onFrame(
      "s1",
      toolProgress({ filePath: "/etc/hosts", lines: 0, toolName: "Read" }),
      0,
    );
    expect(voice.flush(1_100)).toEqual([
      { scope: "s1", text: "Read /etc/hosts…" },
    ]);
  });

  test("a scope that has not been told where it is says the whole path", () => {
    // No `system_metadata` yet. The absolute path is long, but it is the
    // truth, and the deck can still cut it — inventing a shorter one here
    // would throw away what it needs to cut well.
    const voice = new PulseVoice();
    voice.onFrame(
      "s1",
      toolProgress({ filePath: `${ROOT}/tugcode/src/pulse/voice.ts`, lines: 5 }),
      0,
    );
    expect(voice.flush(1_100)).toEqual([
      {
        scope: "s1",
        text: `Writing ${ROOT}/tugcode/src/pulse/voice.ts — 5 lines`,
      },
    ]);
  });

  test("task-list lifecycle surfaces as pulse beats", () => {
    const voice = rootedVoice();
    // The empty-input content_block_start frame yields nothing...
    voice.onFrame("s1", toolUse("TaskCreate", {}), 0);
    expect(voice.flush(1_100)).toEqual([]);
    // ...the filled frame speaks the new task.
    voice.onFrame("s1", toolUse("TaskCreate", { subject: "Write the Makefile" }), 1_200);
    expect(voice.flush(2_300)).toEqual([
      { scope: "s1", text: "Created: Write the Makefile" },
    ]);
    voice.onFrame("s1", toolUse("TaskUpdate", { taskId: "1", status: "in_progress" }), 3_400);
    expect(voice.flush(3_500)).toEqual([{ scope: "s1", text: "Started task 1" }]);
    voice.onFrame("s1", toolUse("TaskUpdate", { taskId: "1", status: "completed" }), 4_600);
    expect(voice.flush(4_700)).toEqual([{ scope: "s1", text: "Completed task 1" }]);
  });

  test("lifecycle + recovery frames surface as pulse beats", () => {
    const voice = rootedVoice();
    const beat = (frame: OutboundMessage, at: number): string | undefined => {
      voice.onFrame("s1", frame, at);
      return voice.flush(at + VOICE_THROTTLE_MS + 100)[0]?.text;
    };
    expect(
      beat(
        { type: "task_updated", session_id: "x", task_id: "j1", status: "completed", ipc_version: 2 },
        0,
      ),
    ).toBe("Background job finished");
    expect(
      beat(
        { type: "task_updated", session_id: "x", task_id: "j2", status: "failed", ipc_version: 2 },
        5_000,
      ),
    ).toBe("Background job failed");
    expect(
      beat(
        {
          type: "wake_started",
          session_id: "x",
          wake_trigger: { task_id: "j1", tool_use_id: "t", status: "completed", summary: "", output_file: "" },
          ipc_version: 2,
        },
        10_000,
      ),
    ).toBe("Resumed");
    expect(
      beat(
        { type: "api_retry", attempt: 2, max_retries: 10, retry_delay_ms: 0, error_status: 529, error: "overloaded", ipc_version: 2 },
        15_000,
      ),
    ).toBe("Retrying (attempt 2)…");
    expect(
      beat(
        { type: "model_refusal_fallback", original_model: "opus", fallback_model: "sonnet", trigger: "", direction: "", ipc_version: 2 },
        20_000,
      ),
    ).toBe("Switched to sonnet");
    expect(beat({ type: "output_truncated", ipc_version: 2 }, 25_000)).toBe(
      "Response truncated",
    );
  });

  test("a compaction boundary speaks immediately, ahead of the flush", () => {
    const voice = rootedVoice();
    voice.onFrame("s1", assistantText("Reading through the reducer."), 0);
    // Not a flush emission — the boundary line comes straight back.
    expect(
      voice.onFrame(
        "s1",
        { type: "compact_boundary", trigger: "manual", pre_tokens: 172_400, ipc_version: 2 },
        1_000,
      ),
    ).toEqual({ scope: "s1", text: "Compacted context (was 172k)" });
    // The pre-compaction thought went with the context it described.
    expect(voice.flush(3_000)).toEqual([]);
  });

  test("an auto-compaction names itself; a boundary without metadata stays plain", () => {
    const voice = rootedVoice();
    expect(
      voice.onFrame("s1", { type: "compact_boundary", trigger: "auto", pre_tokens: 168_000, ipc_version: 2 }, 0),
    ).toEqual({ scope: "s1", text: "Auto-compacted context (was 168k)" });
    expect(
      voice.onFrame("s2", { type: "compact_boundary", ipc_version: 2 }, 0),
    ).toEqual({ scope: "s2", text: "Compacted context" });
  });

  test("a backgrounded agent's task_progress keeps the pulse alive", () => {
    const voice = rootedVoice();
    // Launch sets the agent label.
    voice.onFrame(
      "s1",
      toolUse("Agent", { subagent_type: "Explore", description: "map deps" }, { id: "toolu_ag" }),
      0,
    );
    voice.flush(1_100);
    // A progress tick narrates the agent's latest tool — the only per-step
    // signal a background agent streams to the parent.
    voice.onFrame(
      "s1",
      {
        type: "task_progress",
        session_id: "s",
        task_id: "toolu_ag",
        tool_use_id: "toolu_ag",
        description: "map deps",
        subagent_type: "Explore",
        last_tool_name: "Grep",
        ipc_version: 2,
      } as OutboundMessage,
      2_000,
    );
    expect(voice.flush(3_200)[0]?.text).toBe("Explore · Grep");
  });

  test("subagent work surfaces through the agent's tool calls", () => {
    const voice = rootedVoice();
    // Launching the agent is announced...
    voice.onFrame(
      "s1",
      toolUse("Agent", { subagent_type: "Explore", description: "find x" }, { id: "toolu_agent" }),
      0,
    );
    expect(voice.flush(1_100)).toEqual([
      { scope: "s1", text: "Launching Explore…" },
    ]);
    // ...then the subagent's own tool calls (tagged with parent_tool_use_id —
    // the only thing a subagent streams to the parent) narrate, prefixed.
    voice.onFrame(
      "s1",
      toolUse("Read", { file_path: `${ROOT}/tugcode/src/session.ts` }, { id: "toolu_1", parent: "toolu_agent" }),
      1_200,
    );
    expect(voice.flush(2_300)).toEqual([
      { scope: "s1", text: "Explore · Reading tugcode/src/session.ts" },
    ]);
    voice.onFrame(
      "s1",
      toolUse("Bash", { command: "grep -rn foo src" }, { id: "toolu_2", parent: "toolu_agent" }),
      3_400,
    );
    expect(voice.flush(3_500)).toEqual([
      { scope: "s1", text: "Explore · Running grep -rn foo src" },
    ]);
  });

  test("a long command reaches the deck whole — the daemon budgets no widths", () => {
    // How much of a command fits is the deck's to decide, at the width the
    // surface actually has, and its activity run truncates in the MIDDLE —
    // which needs the tail. A budget applied here would throw that tail away
    // before any surface saw it, and would do it at one width for all of them.
    const voice = rootedVoice();
    const command =
      "cd /Users/someone/src/project && for f in $(git diff --name-only main); do npx tsc --noEmit $f; done";
    voice.onFrame(
      "s1",
      toolUse("Agent", { subagent_type: "Explore" }, { id: "toolu_agent" }),
      0,
    );
    voice.flush(1_100);
    voice.onFrame(
      "s1",
      toolUse("Bash", { command }, { id: "toolu_1", parent: "toolu_agent" }),
      2_200,
    );
    expect(voice.flush(2_300)).toEqual([
      { scope: "s1", text: `Explore · Running ${command}` },
    ]);
  });

  test("a slug agent type shows a clean display label, never a raw slug", () => {
    const voice = rootedVoice();
    voice.onFrame(
      "s1",
      toolUse(
        "Agent",
        { subagent_type: "general-purpose", description: "dig" },
        { id: "toolu_gp" },
      ),
      0,
    );
    // "general-purpose" → "General" (it would otherwise clip to
    // "general-p…" on the strip).
    expect(voice.flush(1_100)).toEqual([
      { scope: "s1", text: "Launching General…" },
    ]);
    voice.onFrame(
      "s1",
      toolUse("Read", { file_path: `${ROOT}/tugcode/src/types.ts` }, { id: "toolu_r", parent: "toolu_gp" }),
      1_200,
    );
    expect(voice.flush(2_300)).toEqual([
      { scope: "s1", text: "General · Reading tugcode/src/types.ts" },
    ]);
  });

  test("a non-task tool call produces no beat", () => {
    const voice = rootedVoice();
    voice.onFrame("s1", assistantText("Running the build now."), 0);
    voice.flush(1_100);
    voice.onFrame("s1", toolUse("Bash", { command: "make" }), 1_200);
    // The monologue still owns the strip; no spurious tool beat.
    expect(voice.flush(2_300)).toEqual([]);
  });
});

describe("PulseVoice — intent riding a tool chain", () => {
  test("a substantive thought pins as intent across subagent beats", () => {
    const voice = rootedVoice();
    voice.onFrame(
      "s1",
      assistantText("I'll map the reducer seam before touching the renderer."),
      0,
    );
    voice.onFrame(
      "s1",
      toolUse("Agent", { subagent_type: "Explore", description: "map it" }, { id: "toolu_a" }),
      100,
    );
    expect(voice.flush(1_100)).toEqual([
      {
        scope: "s1",
        text: "Launching Explore…",
        intent: "I'll map the reducer seam before touching the renderer.",
      },
    ]);
    // Later beats keep carrying the same intent.
    voice.onFrame(
      "s1",
      toolUse("Read", { file_path: `${ROOT}/tugdeck/src/lib/pulse-store.ts` }, { id: "toolu_1", parent: "toolu_a" }),
      1_200,
    );
    expect(voice.flush(2_300)).toEqual([
      {
        scope: "s1",
        text: "Explore · Reading tugdeck/src/lib/pulse-store.ts",
        intent: "I'll map the reducer seam before touching the renderer.",
      },
    ]);
  });

  test("a trivially short thought keeps the previous intent (substance gate)", () => {
    const voice = rootedVoice();
    voice.onFrame(
      "s1",
      assistantText("Now I'll rewire the whole responder chain carefully.", { msgId: "m1" }),
      0,
    );
    voice.onFrame("s1", toolProgress({ filePath: `${ROOT}/tugdeck/src/deck-manager.ts`, lines: 3 }), 100);
    voice.flush(1_100);
    // A new, too-thin thought ("Now the tests." — under both gates)...
    voice.onFrame("s1", assistantText("Now the tests.", { msgId: "m2" }), 1_200);
    voice.onFrame("s1", toolProgress({ filePath: `${ROOT}/tugdeck/src/lib/__tests__/layout-imposer.test.ts`, lines: 9 }), 1_300);
    // ...does not evict the substantive intent.
    expect(voice.flush(2_400)).toEqual([
      {
        scope: "s1",
        text: "Writing tugdeck/src/lib/__tests__/layout-imposer.test.ts — 9 lines",
        intent: "Now I'll rewire the whole responder chain carefully.",
      },
    ]);
  });

  test("no monologue yet means no intent on a beat", () => {
    const voice = rootedVoice();
    voice.onFrame("s1", toolProgress({ filePath: `${ROOT}/tugdeck/src/main.tsx`, lines: 2 }), 0);
    expect(voice.flush(1_100)).toEqual([
      { scope: "s1", text: "Writing tugdeck/src/main.tsx — 2 lines" },
    ]);
  });

  test("turn completion clears the retained intent", () => {
    const voice = rootedVoice();
    voice.onFrame(
      "s1",
      assistantText("Finishing the ledger migration and running the tests."),
      0,
    );
    voice.onFrame("s1", toolProgress({ filePath: `${ROOT}/tugrust/crates/tugcast/src/main.rs`, lines: 4 }), 100);
    voice.flush(1_100);
    voice.onFrame("s1", turnComplete(), 2_000);
    // The next turn's first beat starts with a clean slate.
    voice.onFrame("s1", toolProgress({ filePath: `${ROOT}/tugrust/crates/tugcast/src/scribe.rs`, lines: 1 }), 3_500);
    expect(voice.flush(4_600)).toEqual([
      { scope: "s1", text: "Writing tugrust/crates/tugcast/src/scribe.rs — 1 line" },
    ]);
  });
});

describe("extractDisplay — dangling labels", () => {
  test("a heading label that introduces a table is skipped for real prose", () => {
    const raw =
      "I finished the calculator and it builds clean.\n\n" +
      "Verified behavior:\n\n" +
      "| expr | result |";
    expect(extractDisplay(raw)).toBe(
      "I finished the calculator and it builds clean.",
    );
  });

  test("a bold heading label is skipped too", () => {
    const raw =
      "The parser handles precedence correctly now.\n\n" +
      "**What's next:**\n\n" +
      "- add modulo";
    expect(extractDisplay(raw)).toBe(
      "The parser handles precedence correctly now.",
    );
  });
});

describe("parseWireLine", () => {
  test("parses spliced frames; rejects malformed/unspliced", () => {
    const ok = parseWireLine(
      JSON.stringify({ tug_session_id: "s1", type: "turn_complete", msg_id: "m", seq: 1, result: "", ipc_version: 2 }),
    );
    expect(ok?.scope).toBe("s1");
    expect(parseWireLine("not json")).toBeNull();
    expect(parseWireLine(JSON.stringify({ type: "turn_complete" }))).toBeNull();
  });
});

describe("PulseVoice — the narrated wait", () => {
  test("a permission forward says what is being waited on", () => {
    const voice = rootedVoice();
    voice.onFrame("s1", toolProgress({ filePath: `${ROOT}/tugdeck/src/deck-manager.ts`, lines: 12 }), 0);
    expect(voice.flush(1_100)).toEqual([
      { scope: "s1", text: "Writing tugdeck/src/deck-manager.ts — 12 lines" },
    ]);
    voice.onFrame("s1", permissionForward({ toolName: "Bash", input: { command: "cargo nextest run" } }), 1_200);
    expect(voice.flush(2_300)).toEqual([
      { scope: "s1", text: "Waiting for permission: Running cargo nextest run" },
    ]);
  });

  test("a forwarded QUESTION borrows the first question's header", () => {
    const voice = rootedVoice();
    voice.onFrame(
      "s1",
      permissionForward({
        toolName: "AskUserQuestion",
        isQuestion: true,
        toolUseId: undefined,
        input: { questions: [{ header: "Auth method" }] },
      }),
      0,
    );
    expect(voice.flush(1_100)).toEqual([
      { scope: "s1", text: "Waiting on: Auth method" },
    ]);
  });

  test("a cancel puts the superseded line back", () => {
    const voice = rootedVoice();
    voice.onFrame("s1", toolProgress({ filePath: `${ROOT}/tugdeck/src/deck-manager.ts`, lines: 12 }), 0);
    voice.flush(1_100);
    voice.onFrame("s1", permissionForward({ toolName: "Bash", input: { command: "rm -rf build" } }), 1_200);
    voice.flush(2_300);
    voice.onFrame("s1", controlRequestCancel(), 2_400);
    expect(voice.flush(3_500)).toEqual([
      { scope: "s1", text: "Writing tugdeck/src/deck-manager.ts — 12 lines" },
    ]);
  });

  // The case the whole of [P09].1 turns on. Nothing outbound announces an
  // ALLOW — `tool_approval` is inbound-only — so if the wait did not end on
  // the approved call's own result, an approved permission would leave the
  // wall saying "waiting" for the rest of the turn, which is the wall lying
  // about the one thing it exists to report.
  test("the approved call's own tool_result ends the wait", () => {
    const voice = rootedVoice();
    voice.onFrame("s1", toolProgress({ filePath: `${ROOT}/tugdeck/src/deck-manager.ts`, lines: 12 }), 0);
    voice.flush(1_100);
    voice.onFrame("s1", permissionForward({ toolName: "Bash", input: { command: "cargo nextest run" }, toolUseId: "toolu_9" }), 1_200);
    voice.flush(2_300);
    // A result for a DIFFERENT call in flight leaves the wait standing.
    voice.onFrame("s1", toolResult("toolu_other"), 2_400);
    expect(voice.flush(3_500)).toEqual([]);
    voice.onFrame("s1", toolResult("toolu_9"), 3_600);
    expect(voice.flush(4_700)).toEqual([
      { scope: "s1", text: "Writing tugdeck/src/deck-manager.ts — 12 lines" },
    ]);
  });

  test("a question's wait, which names no call, ends on any tool_result", () => {
    const voice = rootedVoice();
    voice.onFrame("s1", toolProgress({ filePath: `${ROOT}/tugdeck/src/main.tsx`, lines: 3 }), 0);
    voice.flush(1_100);
    voice.onFrame(
      "s1",
      permissionForward({
        toolName: "AskUserQuestion",
        isQuestion: true,
        toolUseId: undefined,
        input: { questions: [{ header: "Auth method" }] },
      }),
      1_200,
    );
    voice.flush(2_300);
    voice.onFrame("s1", toolResult("toolu_whatever"), 2_400);
    expect(voice.flush(3_500)).toEqual([
      { scope: "s1", text: "Writing tugdeck/src/main.tsx — 3 lines" },
    ]);
  });

  test("a turn's end carries the intent it was working toward", () => {
    const voice = rootedVoice();
    voice.onFrame(
      "s1",
      assistantText("I'll fold the transcript and the composer on the settle's own clock."),
      0,
    );
    voice.onFrame("s1", toolProgress({ filePath: `${ROOT}/tugdeck/src/lib/layout-imposer.ts`, lines: 6 }), 100);
    voice.flush(1_100);
    expect(voice.onFrame("s1", turnComplete(), 2_000)).toEqual({
      scope: "s1",
      text: "Done",
      intent: "I'll fold the transcript and the composer on the settle's own clock.",
    });
  });

  test("a cancelled turn carries it too — the deck decides which marker rests", () => {
    const voice = rootedVoice();
    voice.onFrame(
      "s1",
      assistantText("I'll fold the transcript and the composer on the settle's own clock."),
      0,
    );
    voice.onFrame("s1", toolProgress({ filePath: `${ROOT}/tugdeck/src/lib/layout-imposer.ts`, lines: 6 }), 100);
    voice.flush(1_100);
    expect(voice.onFrame("s1", turnCancelled(), 2_000)).toEqual({
      scope: "s1",
      text: "Stopped",
      intent: "I'll fold the transcript and the composer on the settle's own clock.",
    });
  });

  test("a turn with no substantive thought behind it ends bare", () => {
    const voice = rootedVoice();
    voice.onFrame("s1", toolProgress({ filePath: `${ROOT}/tugdeck/src/main.tsx`, lines: 1 }), 0);
    voice.flush(1_100);
    expect(voice.onFrame("s1", turnComplete(), 2_000)).toEqual({
      scope: "s1",
      text: "Done",
    });
  });
});
