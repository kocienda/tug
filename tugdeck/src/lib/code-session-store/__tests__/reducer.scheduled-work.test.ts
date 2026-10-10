/**
 * reducer.scheduled-work.test.ts — the harness-owned timer tools
 * (`ScheduleWakeup` / `CronCreate` / `CronDelete`) register and remove
 * `"scheduled"` rows in the jobs ledger via the `handleToolResult`
 * completion branch (the same site as the background-launch echo
 * insert). No `task_started` frame exists for these tools, so the
 * scheduling tool call is the only insert path.
 *
 * Tool-call shapes mirror the captured `v2.1.150-spike` fixtures:
 * `ScheduleWakeup` input `{delaySeconds, reason, prompt}` with a plain
 * string result; `CronCreate` input `{cron, prompt, recurring}` whose
 * result echoes the cron id.
 */

import { describe, expect, test } from "bun:test";

import {
  reduce,
  createInitialState,
  type CodeSessionState,
} from "@/lib/code-session-store/reducer";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";

function fresh(): CodeSessionState {
  return createInitialState("session", "test", "new");
}

function applyAll(
  state: CodeSessionState,
  events: ReadonlyArray<CodeSessionEvent>,
): CodeSessionState {
  let current = state;
  for (const ev of events) current = reduce(current, ev).state;
  return current;
}

function send(text: string, turnKey: string): CodeSessionEvent {
  return { type: "send", text, atoms: [], content: [{ type: "text", text }], turnKey };
}

/** Drive a turn through one tool call (`tu`) and its result. */
function toolCall(
  toolName: string,
  input: Record<string, unknown>,
  result: string,
  toolUseId = "tu1",
): CodeSessionEvent[] {
  return [
    {
      type: "content_block_start",
      msg_id: "m1",
      block_index: 0,
      kind: "tool_use",
      tool_use_id: toolUseId,
      tool_name: toolName,
    },
    { type: "tool_use", msg_id: "m1", tool_use_id: toolUseId, tool_name: toolName, input, seq: 0 },
    { type: "tool_result", tool_use_id: toolUseId, output: result, is_error: false },
  ];
}

function wakeStarted(taskId: string, turnKey: string): CodeSessionEvent {
  return {
    type: "wake_started",
    session_id: "s",
    wake_trigger: {
      task_id: taskId,
      tool_use_id: "",
      status: "completed",
      summary: "",
      output_file: "",
    },
    turnKey,
  };
}

/** Register a scheduled wakeup that is already elapsed (delaySeconds 0). */
function registerElapsedWakeup(turnKey: string, toolUseId: string): CodeSessionEvent[] {
  return [
    send("go", turnKey),
    ...toolCall(
      "ScheduleWakeup",
      { delaySeconds: 0, reason: "PROBE_SW" },
      "Next wakeup scheduled.",
      toolUseId,
    ),
    { type: "turn_complete", msg_id: "m1", result: "success", seq: 0 },
  ];
}

const WAKEUP_INPUT = { delaySeconds: 60, reason: "PROBE_SW", prompt: "wake me" };
const WAKEUP_RESULT = "Next wakeup scheduled for 20:01:00 (in 60s).";
const CRON_INPUT = { cron: "53 19 24 5 *", prompt: "Report fired", recurring: false };
const CRON_RESULT = "Scheduled one-shot task 3ea6c934 (53 19 24 5 *). Session-only.";

describe("scheduled-work registration in the reducer", () => {
  test("ScheduleWakeup inserts one scheduled wakeup row keyed by tool_use_id", () => {
    const state = applyAll(fresh(), [
      send("go", "t1"),
      ...toolCall("ScheduleWakeup", WAKEUP_INPUT, WAKEUP_RESULT, "tu_w"),
    ]);
    expect(state.jobs.length).toBe(1);
    const row = state.jobs[0];
    expect(row).toMatchObject({
      jobId: "tu_w",
      toolUseId: "tu_w",
      kind: "wakeup",
      status: "scheduled",
      description: "PROBE_SW",
    });
    expect(typeof row.firesAtMs).toBe("number");
    // firesAtMs is a future stamp (now + 60s), well above the start.
    expect(row.firesAtMs! > row.startedAtMs).toBe(true);
  });

  test("a second ScheduleWakeup adds a distinct row (no supersede)", () => {
    let state = applyAll(fresh(), [
      send("go", "t1"),
      ...toolCall("ScheduleWakeup", WAKEUP_INPUT, WAKEUP_RESULT, "tu_w1"),
    ]);
    state = applyAll(state, [
      { type: "turn_complete", msg_id: "m1", result: "success", seq: 0 },
      send("again", "t2"),
      ...toolCall("ScheduleWakeup", WAKEUP_INPUT, WAKEUP_RESULT, "tu_w2"),
    ]);
    expect(state.jobs.map((j) => j.jobId)).toEqual(["tu_w1", "tu_w2"]);
    expect(state.jobs.every((j) => j.status === "scheduled")).toBe(true);
  });

  test("CronCreate inserts a cron row whose jobId a later CronDelete stops", () => {
    let state = applyAll(fresh(), [
      send("go", "t1"),
      ...toolCall("CronCreate", CRON_INPUT, CRON_RESULT, "tu_c"),
    ]);
    expect(state.jobs[0]).toMatchObject({
      jobId: "3ea6c934",
      kind: "cron",
      status: "scheduled",
      scheduleLabel: "53 19 24 5 *",
      firesAtMs: null,
    });

    state = applyAll(state, [
      { type: "turn_complete", msg_id: "m1", result: "success", seq: 0 },
      send("cancel", "t2"),
      ...toolCall("CronDelete", { id: "3ea6c934" }, "Deleted.", "tu_d"),
    ]);
    expect(state.jobs[0].status).toBe("stopped");
  });

  test("a drifted ScheduleWakeup (no delaySeconds) inserts nothing", () => {
    const state = applyAll(fresh(), [
      send("go", "t1"),
      ...toolCall("ScheduleWakeup", { reason: "x" }, WAKEUP_RESULT, "tu_bad"),
    ]);
    expect(state.jobs.length).toBe(0);
  });
});

const RT_CREATE_INPUT = {
  action: "create",
  body: { schedule: "0 9 * * *", prompt: "Daily digest" },
};
const RT_CREATE_RESULT = '{"id":"rtn-42","enabled":true}\nNext run tomorrow at 9am';

describe("RemoteTrigger routines register as remote scheduled rows", () => {
  test("create inserts one remote scheduled row keyed by the parsed id", () => {
    const state = applyAll(fresh(), [
      send("go", "t1"),
      ...toolCall("RemoteTrigger", RT_CREATE_INPUT, RT_CREATE_RESULT, "tu_rt"),
    ]);
    expect(state.jobs.length).toBe(1);
    expect(state.jobs[0]).toMatchObject({
      jobId: "rtn-42",
      kind: "remote",
      status: "scheduled",
      description: "Daily digest",
      scheduleLabel: "0 9 * * *",
      firesAtMs: null,
    });
  });

  test("run / list / get register no row", () => {
    for (const action of ["run", "list", "get"]) {
      const state = applyAll(fresh(), [
        send("go", "t1"),
        ...toolCall(
          "RemoteTrigger",
          { action, trigger_id: "rtn-42" },
          "{}",
          `tu_${action}`,
        ),
      ]);
      expect(state.jobs.length).toBe(0);
    }
  });

  test("a second identical create does not duplicate the row", () => {
    let state = applyAll(fresh(), [
      send("go", "t1"),
      ...toolCall("RemoteTrigger", RT_CREATE_INPUT, RT_CREATE_RESULT, "tu_rt1"),
    ]);
    state = applyAll(state, [
      { type: "turn_complete", msg_id: "m1", result: "success", seq: 0 },
      send("again", "t2"),
      ...toolCall("RemoteTrigger", RT_CREATE_INPUT, RT_CREATE_RESULT, "tu_rt2"),
    ]);
    expect(state.jobs.length).toBe(1);
    expect(state.jobs[0].jobId).toBe("rtn-42");
  });

  test("update re-labels the matching row's schedule", () => {
    let state = applyAll(fresh(), [
      send("go", "t1"),
      ...toolCall("RemoteTrigger", RT_CREATE_INPUT, RT_CREATE_RESULT, "tu_rt"),
    ]);
    state = applyAll(state, [
      { type: "turn_complete", msg_id: "m1", result: "success", seq: 0 },
      send("retime", "t2"),
      ...toolCall(
        "RemoteTrigger",
        { action: "update", trigger_id: "rtn-42", body: { schedule: "0 10 * * *" } },
        '{"id":"rtn-42"}',
        "tu_up",
      ),
    ]);
    expect(state.jobs.length).toBe(1);
    expect(state.jobs[0].scheduleLabel).toBe("0 10 * * *");
  });
});

describe("scheduled-work wake reconciliation + respawn sweep", () => {
  test("an id-less wake flips the earliest elapsed scheduled row to completed", () => {
    let state = applyAll(fresh(), registerElapsedWakeup("t1", "tu_w"));
    expect(state.jobs[0].status).toBe("scheduled");
    // The harness-fired ScheduleWakeup re-init carries an empty task_id.
    state = reduce(state, wakeStarted("", "wk1")).state;
    expect(state.jobs[0]).toMatchObject({ status: "completed" });
    expect(state.jobs[0].endedAtMs).not.toBeNull();
  });

  test("a wake with a real task_id leaves scheduled rows untouched", () => {
    let state = applyAll(fresh(), registerElapsedWakeup("t1", "tu_w"));
    // A background-job completion wake (real id) must not flip a wakeup.
    state = reduce(state, wakeStarted("bg-task-123", "wk1")).state;
    expect(state.jobs[0].status).toBe("scheduled");
  });

  test("wake_started seeds the trigger summary as a scheduled system_note", () => {
    let state = fresh();
    state = reduce(state, {
      type: "wake_started",
      session_id: "s",
      wake_trigger: {
        task_id: "",
        tool_use_id: "tu_w",
        status: "completed",
        summary: "loop pacing",
        output_file: "",
      },
      turnKey: "wk1",
    } as CodeSessionEvent).state;
    const entry = state.scratch.get("wk1");
    expect(entry).toBeDefined();
    expect(entry!.messages[0]).toMatchObject({
      kind: "system_note",
      source: "scheduled",
      text: "loop pacing",
    });
    expect(entry!.systemNoteSeq).toBe(1);
  });

  test("a wake with an empty summary seeds no note", () => {
    let state = fresh();
    state = reduce(state, wakeStarted("", "wk1")).state;
    const entry = state.scratch.get("wk1");
    expect(entry).toBeDefined();
    expect(entry!.messages.length).toBe(0);
  });

  test("session_init leaves a pending scheduled row alive (respawn resumes; resume re-fires)", () => {
    // Every tugcode respawn path resumes, and on claude >= 2.1.204 the
    // harness scheduler re-fires pending wakeups/crons in the resumed
    // process (tugcode/probes/goal-loop/FINDINGS.md#q02-loop). Only
    // `running` rows are stale-marked; the surviving scheduled row
    // reconciles via the wake fold or ages out via the reaper.
    let state = applyAll(fresh(), [
      send("go", "t1"),
      ...toolCall("ScheduleWakeup", WAKEUP_INPUT, WAKEUP_RESULT, "tu_w"),
      { type: "turn_complete", msg_id: "m1", result: "success", seq: 0 },
    ]);
    expect(state.jobs[0].status).toBe("scheduled");
    state = reduce(state, { type: "session_init", session_id: "s" }).state;
    expect(state.jobs[0].status).toBe("scheduled");
  });
});
