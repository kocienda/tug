/**
 * Pure-logic tests for the background-jobs helpers in `select-jobs.ts`.
 *
 * Frame fixtures mirror the tugcode IPC layer (snake_case, `patch`
 * already flattened by `buildTaskUpdatedMessage`), whose shape is
 * pinned against the captured wire reality in
 * `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/`
 * `v2.1.173-jobs-spike/`.
 */

import { describe, test, expect } from "bun:test";

import {
  applyJobFlip,
  applyJobProgress,
  clearTerminalJobs,
  composeJobsSummary,
  countJobs,
  insertJob,
  isJobLaunch,
  isScheduledJobStatus,
  isTerminalJobStatus,
  jobsCellPose,
  jobKindForLaunch,
  jobKindFromTaskType,
  markRunningJobsStopped,
  taskStartedEvent,
  taskUpdatedEvent,
  taskProgressEvent,
  agentTokensForTurn,
  jobsOwnedByTurn,
  parseBackgroundLaunchResult,
  terminalJobStatusFromWire,
  type JobItem,
} from "../select-jobs";
import type { ToolUseMessage } from "../types";
import { decodeOutbound } from "@tugproto/outbound-decoders";
import { isDecodeError } from "@tugproto/decode";

// A frame takes the store's path: its tugproto decoder, then the camelCase
// mapping. Either one refusing it yields `undefined`, which is a dropped frame.
function startedFromWire(frame: unknown) {
  const decoded = decodeOutbound("task_started", frame);
  return isDecodeError(decoded) ? undefined : taskStartedEvent(decoded);
}
function updatedFromWire(frame: unknown) {
  const decoded = decodeOutbound("task_updated", frame);
  return isDecodeError(decoded) ? undefined : taskUpdatedEvent(decoded);
}
function progressFromWire(frame: unknown) {
  const decoded = decodeOutbound("task_progress", frame);
  return isDecodeError(decoded) ? undefined : taskProgressEvent(decoded);
}

function job(overrides: Partial<JobItem> & { jobId: string }): JobItem {
  return {
    source: "claude",
    kind: "bash",
    toolUseId: `toolu_${overrides.jobId}`,
    description: "",
    status: "running",
    startedAtMs: 1_000,
    endedAtMs: null,
    ...overrides,
  };
}

// Wire-faithful IPC frames (the tugcode forwarding layer's output).
const BASH_STARTED = {
  type: "task_started",
  session_id: "c78bbf56-1133-49e2-ab57-5b9188249033",
  task_id: "bkn113zww",
  tool_use_id: "toolu_012yovB8JX9CnEX39ngvSEEa",
  description: "Sleep 6 seconds then echo marker",
  task_type: "local_bash",
  ipc_version: 2,
  tug_session_id: "tug-1",
};

const AGENT_STARTED = {
  type: "task_started",
  session_id: "c78bbf56-1133-49e2-ab57-5b9188249033",
  task_id: "ab5660790736ebc09",
  tool_use_id: "toolu_01UfQkA3tVuCDKDrLSVCNULX",
  description: "Background bash echo probe",
  task_type: "local_agent",
  subagent_type: "general-purpose",
  ipc_version: 2,
};

const UPDATED_COMPLETED = {
  type: "task_updated",
  session_id: "c78bbf56-1133-49e2-ab57-5b9188249033",
  task_id: "bkn113zww",
  status: "completed",
  end_time: 1781226041319,
  ipc_version: 2,
};

const AGENT_PROGRESS = {
  type: "task_progress",
  session_id: "c78bbf56-1133-49e2-ab57-5b9188249033",
  task_id: "ab5660790736ebc09",
  tool_use_id: "toolu_01UfQkA3tVuCDKDrLSVCNULX",
  description: "Running Run sleep and echo command",
  subagent_type: "general-purpose",
  last_tool_name: "Bash",
  usage: { total_tokens: 7684, tool_uses: 1, duration_ms: 2303 },
  ipc_version: 2,
  tug_session_id: "tug-1",
};

describe("startedFromWire", () => {
  test("narrows a bash launch frame to camelCase", () => {
    const ev = startedFromWire(BASH_STARTED);
    expect(ev).toEqual({
      type: "task_started",
      taskId: "bkn113zww",
      toolUseId: "toolu_012yovB8JX9CnEX39ngvSEEa",
      description: "Sleep 6 seconds then echo marker",
      taskType: "local_bash",
      tug_session_id: "tug-1",
    });
  });

  test("narrows an agent frame, carrying subagentType", () => {
    const ev = startedFromWire(AGENT_STARTED);
    expect(ev?.taskType).toBe("local_agent");
    expect(ev?.subagentType).toBe("general-purpose");
  });

  test("rejects wrong type and missing required ids", () => {
    expect(startedFromWire({ type: "task_updated" })).toBeUndefined();
    expect(
      startedFromWire({ ...BASH_STARTED, task_id: undefined }),
    ).toBeUndefined();
    expect(
      startedFromWire({ ...BASH_STARTED, tool_use_id: "" }),
    ).toBeUndefined();
  });
});

describe("updatedFromWire", () => {
  test("narrows a status flip, carrying endTime", () => {
    const ev = updatedFromWire(UPDATED_COMPLETED);
    expect(ev).toEqual({
      type: "task_updated",
      taskId: "bkn113zww",
      status: "completed",
      endTime: 1781226041319,
    });
  });

  test("accepts the full observed status vocabulary", () => {
    for (const status of ["completed", "failed", "killed"]) {
      const ev = updatedFromWire({ ...UPDATED_COMPLETED, status });
      expect(ev?.status).toBe(status);
    }
  });

  test("omits endTime when absent and rejects missing required fields", () => {
    const noEnd = updatedFromWire({
      ...UPDATED_COMPLETED,
      end_time: undefined,
    });
    expect(noEnd).toBeDefined();
    expect("endTime" in noEnd!).toBe(false);
    expect(
      updatedFromWire({ ...UPDATED_COMPLETED, task_id: "" }),
    ).toBeUndefined();
    expect(
      updatedFromWire({ ...UPDATED_COMPLETED, status: undefined }),
    ).toBeUndefined();
  });
});

describe("progressFromWire", () => {
  test("narrows a progress tick, camelCasing usage detail", () => {
    const ev = progressFromWire(AGENT_PROGRESS);
    expect(ev).toEqual({
      type: "task_progress",
      taskId: "ab5660790736ebc09",
      toolUseId: "toolu_01UfQkA3tVuCDKDrLSVCNULX",
      description: "Running Run sleep and echo command",
      subagentType: "general-purpose",
      lastToolName: "Bash",
      usage: { totalTokens: 7684, toolUses: 1, durationMs: 2303 },
      tug_session_id: "tug-1",
    });
  });

  test("tolerates a usage-less / tool-less tick and rejects id-less frames", () => {
    const minimal = progressFromWire({
      type: "task_progress",
      task_id: "t1",
      tool_use_id: "toolu_x",
      description: "",
    });
    expect(minimal).toBeDefined();
    expect("usage" in minimal!).toBe(false);
    expect("lastToolName" in minimal!).toBe(false);
    expect(progressFromWire({ type: "task_updated" })).toBeUndefined();
    expect(
      progressFromWire({ ...AGENT_PROGRESS, tool_use_id: "" }),
    ).toBeUndefined();
  });
});

describe("applyJobProgress", () => {
  test("folds the latest tick onto a running agent row", () => {
    const ledger: readonly JobItem[] = [
      job({ jobId: "ab5660790736ebc09", kind: "agent" }),
    ];
    const ev = progressFromWire(AGENT_PROGRESS)!;
    const next = applyJobProgress(ledger, ev);
    expect(next).not.toBe(ledger);
    expect(next[0]!.progress).toEqual({
      lastToolName: "Bash",
      totalTokens: 7684,
      toolUses: 1,
      durationMs: 2303,
    });
  });

  test("no-ops (same reference) on unknown id, terminal row, or empty tick", () => {
    const running: readonly JobItem[] = [
      job({ jobId: "ab5660790736ebc09", kind: "agent" }),
    ];
    const ev = progressFromWire(AGENT_PROGRESS)!;
    // Unknown id — the agent was foreground, no row was inserted.
    expect(applyJobProgress(running, { ...ev, taskId: "zzz" })).toBe(running);
    // Terminal row — a late tick must not disturb the final snapshot.
    const done: readonly JobItem[] = [
      job({ jobId: "ab5660790736ebc09", kind: "agent", status: "completed" }),
    ];
    expect(applyJobProgress(done, ev)).toBe(done);
    // Empty tick — no tool, no usage — carries no new information.
    expect(
      applyJobProgress(running, {
        type: "task_progress",
        taskId: "ab5660790736ebc09",
        toolUseId: "toolu_x",
        description: "",
      }),
    ).toBe(running);
  });
});

// Captured launch echoes (v2.1.173-jobs-spike), trimmed to the parsed spans.
const BASH_ECHO =
  "Command running in background with ID: bkn113zww. Output is being written" +
  " to: /private/tmp/claude-501/x/tasks/bkn113zww.output. You will be" +
  " notified when it completes.";
const AGENT_ECHO = [
  {
    type: "text",
    text:
      "Async agent launched successfully.\nagentId: ab5660790736ebc09 " +
      "(internal ID - do not mention to user.)\nThe agent is working in " +
      "the background.\noutput_file: /private/tmp/claude-501/x/tasks/" +
      "ab5660790736ebc09.output\nDo NOT Read or tail this file.",
  },
];

describe("parseBackgroundLaunchResult", () => {
  test("parses the bash echo (id + output file)", () => {
    const echo = parseBackgroundLaunchResult(BASH_ECHO);
    expect(echo).toEqual({
      jobId: "bkn113zww",
      kind: "bash",
      outputFile: "/private/tmp/claude-501/x/tasks/bkn113zww.output",
    });
  });

  test("parses the async-agent echo (agentId + output_file)", () => {
    const echo = parseBackgroundLaunchResult(AGENT_ECHO);
    expect(echo).toEqual({
      jobId: "ab5660790736ebc09",
      kind: "agent",
      outputFile: "/private/tmp/claude-501/x/tasks/ab5660790736ebc09.output",
    });
  });

  test("returns undefined for foreground results and non-matching text", () => {
    expect(parseBackgroundLaunchResult("file1\nfile2")).toBeUndefined();
    // A FOREGROUND agent result also mentions agentId but not the
    // async-launch banner — it must not parse as a launch.
    expect(
      parseBackgroundLaunchResult([
        { type: "text", text: "JOBS_P5_FG" },
        { type: "text", text: "agentId: ac57e6163e2ab0290 (use SendMessage)" },
      ]),
    ).toBeUndefined();
    expect(parseBackgroundLaunchResult(null)).toBeUndefined();
    expect(parseBackgroundLaunchResult(42)).toBeUndefined();
  });
});

describe("status + kind mapping", () => {
  test("terminalJobStatusFromWire maps the observed vocabulary and drops unknowns", () => {
    expect(terminalJobStatusFromWire("completed")).toBe("completed");
    expect(terminalJobStatusFromWire("failed")).toBe("failed");
    expect(terminalJobStatusFromWire("killed")).toBe("stopped");
    expect(terminalJobStatusFromWire("stopped")).toBe("stopped");
    expect(terminalJobStatusFromWire("running")).toBeUndefined();
    expect(terminalJobStatusFromWire("paused")).toBeUndefined();
  });

  test("jobKindFromTaskType maps local_bash / local_agent, unknown otherwise", () => {
    expect(jobKindFromTaskType("local_bash")).toBe("bash");
    expect(jobKindFromTaskType("local_agent")).toBe("agent");
    expect(jobKindFromTaskType("remote_thing")).toBe("unknown");
  });
});

describe("ledger updates", () => {
  test("insertJob appends fresh ids in insertion order", () => {
    const a = job({ jobId: "a" });
    const b = job({ jobId: "b" });
    const ledger = insertJob(insertJob([], a), b);
    expect(ledger.map((j) => j.jobId)).toEqual(["a", "b"]);
  });

  test("insertJob enriches an existing row instead of duplicating (either arrival order)", () => {
    // task_started first (no outputFile), echo second (with outputFile).
    const fromFrame = job({ jobId: "a", description: "Sleep then echo" });
    const fromEcho = job({ jobId: "a", outputFile: "/tmp/a.out", description: "" });
    let ledger = insertJob([fromFrame], fromEcho);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].description).toBe("Sleep then echo");
    expect(ledger[0].outputFile).toBe("/tmp/a.out");
    // Identical re-insert returns the same reference.
    expect(insertJob(ledger, fromEcho)).toBe(ledger);
  });

  test("applyJobFlip flips only running rows; first terminal flip wins; unknown ids no-op", () => {
    const ledger = [job({ jobId: "a" })];
    const flipped = applyJobFlip(ledger, "a", "failed", 2_000);
    expect(flipped[0].status).toBe("failed");
    expect(flipped[0].endedAtMs).toBe(2_000);
    // Second flip (e.g. wake trigger after task_updated) is a no-op.
    expect(applyJobFlip(flipped, "a", "completed", 3_000)).toBe(flipped);
    expect(applyJobFlip(ledger, "zzz", "completed", 3_000)).toBe(ledger);
  });

  test("markRunningJobsStopped flips every running row and nothing else", () => {
    const ledger = [
      job({ jobId: "a" }),
      job({ jobId: "b", status: "completed", endedAtMs: 1_500 }),
      job({ jobId: "c" }),
    ];
    const marked = markRunningJobsStopped(ledger, 9_000);
    expect(marked.map((j) => j.status)).toEqual(["stopped", "completed", "stopped"]);
    expect(marked[1].endedAtMs).toBe(1_500);
    // No running rows → same reference.
    expect(markRunningJobsStopped(marked, 9_999)).toBe(marked);
  });

  test("clearTerminalJobs drops finished rows, keeps running, no-ops when nothing to drop", () => {
    const running = job({ jobId: "a" });
    const ledger = [
      running,
      job({ jobId: "b", status: "failed", endedAtMs: 2_000 }),
      job({ jobId: "c", status: "stopped", endedAtMs: 2_500 }),
    ];
    const cleared = clearTerminalJobs(ledger);
    expect(cleared).toEqual([running]);
    expect(clearTerminalJobs(cleared)).toBe(cleared);
  });
});

describe("display derivation", () => {
  test("countJobs buckets statuses and computes finished/total", () => {
    const counts = countJobs([
      job({ jobId: "a" }),
      job({ jobId: "b", status: "completed", endedAtMs: 1 }),
      job({ jobId: "c", status: "failed", endedAtMs: 1 }),
      job({ jobId: "d", status: "stopped", endedAtMs: 1 }),
    ]);
    expect(counts).toEqual({
      total: 4,
      running: 1,
      watching: 0,
      scheduled: 0,
      completed: 1,
      failed: 1,
      stopped: 1,
      finished: 3,
    });
  });

  test("jobsCellPose: empty→stopped, running wins, failed→aborted, else completed — no phase input", () => {
    expect(jobsCellPose([])).toBe("stopped");
    expect(jobsCellPose([job({ jobId: "a" })])).toBe("running");
    // A running row outranks a failed one (new work supersedes the
    // danger pose); failure shows once nothing is running.
    expect(
      jobsCellPose([
        job({ jobId: "a" }),
        job({ jobId: "b", status: "failed", endedAtMs: 1 }),
      ]),
    ).toBe("running");
    expect(
      jobsCellPose([
        job({ jobId: "a", status: "completed", endedAtMs: 1 }),
        job({ jobId: "b", status: "failed", endedAtMs: 1 }),
      ]),
    ).toBe("aborted");
    expect(
      jobsCellPose([
        job({ jobId: "a", status: "completed", endedAtMs: 1 }),
        job({ jobId: "b", status: "stopped", endedAtMs: 1 }),
      ]),
    ).toBe("completed");
  });

  test("composeJobsSummary drops zero buckets", () => {
    expect(composeJobsSummary(countJobs([]))).toBe("no jobs");
    expect(
      composeJobsSummary(
        countJobs([
          job({ jobId: "a" }),
          job({ jobId: "b", status: "completed", endedAtMs: 1 }),
          job({ jobId: "c", status: "completed", endedAtMs: 1 }),
          job({ jobId: "d", status: "failed", endedAtMs: 1 }),
        ]),
      ),
    ).toBe("1 running, 2 done, 1 failed");
  });
});

describe("scheduled rows", () => {
  const wakeup = (jobId: string, over: Partial<JobItem> = {}): JobItem =>
    job({ jobId, kind: "wakeup", status: "scheduled", firesAtMs: 9_000, ...over });

  test("isScheduledJobStatus / isTerminalJobStatus treat scheduled as non-terminal pending", () => {
    expect(isScheduledJobStatus("scheduled")).toBe(true);
    expect(isScheduledJobStatus("running")).toBe(false);
    expect(isTerminalJobStatus("scheduled")).toBe(false);
    expect(isTerminalJobStatus("running")).toBe(false);
    expect(isTerminalJobStatus("completed")).toBe(true);
  });

  test("countJobs reports scheduled and excludes it from the finished/total fraction", () => {
    // A lone scheduled wakeup must not read "0/1": total counts
    // non-scheduled rows only.
    const lone = countJobs([wakeup("w")]);
    expect(lone.scheduled).toBe(1);
    expect(lone.total).toBe(0);
    expect(lone.finished).toBe(0);

    const mixed = countJobs([
      wakeup("w"),
      job({ jobId: "a" }),
      job({ jobId: "b", status: "completed", endedAtMs: 1 }),
    ]);
    expect(mixed.scheduled).toBe(1);
    // Denominator excludes the wakeup: 1 running + 1 completed.
    expect(mixed.total).toBe(2);
    expect(mixed.finished).toBe(1);
  });

  test("jobsCellPose rests quiet on a scheduled-only ledger", () => {
    // A wakeup promised for a future time is not executing, so the cell
    // holds the quiet pose; the row's countdown carries "later, not now".
    expect(jobsCellPose([wakeup("w")])).toBe("stopped");
    // A past failure still nags past a scheduled row.
    expect(
      jobsCellPose([wakeup("w"), job({ jobId: "f", status: "failed", endedAtMs: 1 })]),
    ).toBe("aborted");
  });

  test("composeJobsSummary renders the scheduled bucket between watching and done", () => {
    expect(
      composeJobsSummary(
        countJobs([
          job({ jobId: "a" }),
          wakeup("w"),
          job({ jobId: "d", status: "completed", endedAtMs: 1 }),
        ]),
      ),
    ).toBe("1 running, 1 scheduled, 1 done");
    expect(composeJobsSummary(countJobs([wakeup("w")]))).toBe("1 scheduled");
  });

  test("clearTerminalJobs keeps scheduled rows like running ones", () => {
    const w = wakeup("w");
    const r = job({ jobId: "a" });
    const cleared = clearTerminalJobs([
      w,
      r,
      job({ jobId: "b", status: "completed", endedAtMs: 1 }),
    ]);
    expect(cleared).toEqual([w, r]);
  });

  test("markRunningJobsStopped leaves scheduled rows alive (resume re-fires on >= 2.1.204)", () => {
    // Every tugcode respawn path resumes, and the harness scheduler
    // re-fires pending wakeups/crons in the resumed process
    // (tugcode/probes/goal-loop/FINDINGS.md#q02-loop) — a scheduled row
    // falsely flipped to stopped would contradict the wake that then
    // actually fires.
    const marked = markRunningJobsStopped(
      [wakeup("w"), job({ jobId: "a" }), job({ jobId: "b", status: "completed", endedAtMs: 1 })],
      9_999,
    );
    expect(marked.map((j) => j.status)).toEqual(["scheduled", "stopped", "completed"]);
    expect(marked[1].endedAtMs).toBe(9_999);
  });
});

// Captured monitor launch echoes (test-monitor-lifecycle-raw.jsonl).
const MONITOR_ECHO_TIMEOUT =
  "Monitor started (task b45wg0dww, timeout 60000ms). You will be notified" +
  " on each event. Keep working — do not poll or sleep.";
const MONITOR_ECHO_PERSISTENT =
  "Monitor started (task be0zn8grq, persistent — runs until TaskStop or" +
  " session end). You will be notified on each event.";

describe("monitor launch gate and kind", () => {
  test("isJobLaunch admits backgrounded calls and Monitor, rejects the rest", () => {
    expect(isJobLaunch("Bash", { run_in_background: true })).toBe(true);
    expect(isJobLaunch("Agent", { run_in_background: true })).toBe(true);
    expect(isJobLaunch("Monitor", { command: "tail -f x", timeout_ms: 5000 })).toBe(
      true,
    );
    expect(isJobLaunch("Monitor", null)).toBe(true);
    expect(isJobLaunch("Agent", { prompt: "hi" })).toBe(false);
    expect(isJobLaunch("Bash", null)).toBe(false);
  });

  test("jobKindForLaunch: Monitor wins over the local_bash task_type ambiguity", () => {
    // A watcher's frame reports local_bash (its script is a shell
    // command) — the tool name is the only honest discriminant.
    expect(jobKindForLaunch("Monitor", "local_bash")).toBe("monitor");
    expect(jobKindForLaunch("Bash", "local_bash")).toBe("bash");
    expect(jobKindForLaunch("Agent", "local_agent")).toBe("agent");
    expect(jobKindForLaunch("Bash", "weird")).toBe("unknown");
  });
});

describe("monitor launch echo", () => {
  test("parses both captured forms (timeout and persistent), no output file", () => {
    expect(parseBackgroundLaunchResult(MONITOR_ECHO_TIMEOUT)).toEqual({
      jobId: "b45wg0dww",
      kind: "monitor",
    });
    expect(parseBackgroundLaunchResult(MONITOR_ECHO_PERSISTENT)).toEqual({
      jobId: "be0zn8grq",
      kind: "monitor",
    });
  });

  test("bash and agent echoes still parse unchanged", () => {
    expect(parseBackgroundLaunchResult(BASH_ECHO)?.kind).toBe("bash");
    expect(parseBackgroundLaunchResult(AGENT_ECHO)?.kind).toBe("agent");
  });
});

describe("watching bucket", () => {
  test("countJobs separates live watchers; finished/pose semantics unchanged", () => {
    const ledger = [
      job({ jobId: "a" }),
      job({ jobId: "m", kind: "monitor" }),
      job({ jobId: "b", status: "completed", endedAtMs: 1 }),
    ];
    const counts = countJobs(ledger);
    expect(counts.running).toBe(2);
    expect(counts.watching).toBe(1);
    expect(counts.finished).toBe(1);
    expect(jobsCellPose(ledger)).toBe("running");
  });

  test("composeJobsSummary splits watching out of running with zero-drop", () => {
    expect(
      composeJobsSummary(
        countJobs([
          job({ jobId: "a" }),
          job({ jobId: "m", kind: "monitor" }),
          job({ jobId: "b", status: "completed", endedAtMs: 1 }),
        ]),
      ),
    ).toBe("1 running, 1 watching, 1 done");
    // Watchers only — no vestigial "0 running".
    expect(
      composeJobsSummary(countJobs([job({ jobId: "m", kind: "monitor" })])),
    ).toBe("1 watching");
    // A finished watcher counts as done, not watching.
    expect(
      composeJobsSummary(
        countJobs([
          job({ jobId: "m", kind: "monitor", status: "completed", endedAtMs: 1 }),
        ]),
      ),
    ).toBe("1 done");
  });
});

// ---------------------------------------------------------------------------
// jobsOwnedByTurn / agentTokensForTurn
// ---------------------------------------------------------------------------

function agentCall(
  toolUseId: string,
  structuredResult: unknown = null,
): ToolUseMessage {
  return {
    kind: "tool_use",
    messageKey: `fixture-${toolUseId}`,
    createdAt: 0,
    toolUseId,
    toolName: "Agent",
    input: {},
    status: "done",
    result: null,
    structuredResult,
    toolWallMs: null,
  };
}

describe("jobsOwnedByTurn", () => {
  test("selects only the jobs whose launching call is in the turn", () => {
    const jobs = [
      job({ jobId: "a", toolUseId: "toolu_mine" }),
      job({ jobId: "b", toolUseId: "toolu_other_turn" }),
    ];
    const owned = jobsOwnedByTurn([agentCall("toolu_mine")], jobs);
    expect(owned.map((j) => j.jobId)).toEqual(["a"]);
  });

  test("empty for a turn with no tool calls or an empty ledger", () => {
    expect(jobsOwnedByTurn([], [job({ jobId: "a" })])).toEqual([]);
    expect(jobsOwnedByTurn([agentCall("toolu_x")], [])).toEqual([]);
  });
});

describe("agentTokensForTurn", () => {
  test("prefers the job's composed result, then progress, then the turn structuredResult", () => {
    const messages = [
      agentCall("toolu_composed"),
      agentCall("toolu_ticking"),
      agentCall("toolu_reload", { totalTokens: 500 }),
    ];
    const jobs = [
      job({
        jobId: "c",
        kind: "agent",
        toolUseId: "toolu_composed",
        agentStructuredResult: { status: "completed", totalTokens: 1_000 },
        progress: { totalTokens: 900 },
      }),
      job({
        jobId: "t",
        kind: "agent",
        toolUseId: "toolu_ticking",
        progress: { totalTokens: 250 },
      }),
    ];
    expect(agentTokensForTurn(messages, jobs)).toBe(1_750);
  });

  test("a mid-run launch echo with no job contributes nothing", () => {
    // The async echo carries no totalTokens; before the first tick the
    // honest figure is zero, not a fabrication.
    expect(
      agentTokensForTurn(
        [agentCall("toolu_launch", { status: "async_launched" })],
        [],
      ),
    ).toBe(0);
  });

  test("non-agent calls are ignored", () => {
    const bash: ToolUseMessage = {
      ...agentCall("toolu_bash"),
      toolName: "Bash",
      structuredResult: { totalTokens: 999 },
    };
    expect(agentTokensForTurn([bash], [])).toBe(0);
  });
});
