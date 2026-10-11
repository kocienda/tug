/**
 * Jobs-ledger fixture-replay test.
 *
 * Drives the REAL `CodeSessionStore` with frames synthesized from the
 * captured background-job lifecycle fixture
 * (`tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/`
 * `v2.1.173-jobs-spike/test-jobs-lifecycle-raw.jsonl`) — the launch
 * tool calls, their `tool_result` echoes, and the `task_started` /
 * `task_updated` / `task_notification` payloads are all lifted
 * verbatim from the capture, then wrapped in the tugcode IPC envelope
 * exactly as `buildTaskStartedMessage` / `buildTaskUpdatedMessage`
 * produce it. A claude-side shape drift therefore surfaces here as a
 * broken ledger, not as a silently dead JOBS cell.
 *
 * Why fixture-grounded: same rationale as
 * `session-wake-fixture-replay.test.ts` — pins empirical wire reality,
 * not a hand-imagined shape.
 */

import { describe, it, expect, beforeAll } from "bun:test";

import { CodeSessionStore } from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FeedId } from "@/protocol";

const TUG = "tug-jobs-fixture";
const IPC_VERSION = 2;

// -----------------------------------------------------------------------------
// Fixture loading — per-phase artifact extraction
// -----------------------------------------------------------------------------

/** Everything the store needs to relive one captured job's lifecycle. */
interface CapturedJob {
  taskId: string;
  toolUseId: string;
  /** The launching tool call's name + input (from the assistant snapshot). */
  toolName: string;
  input: Record<string, unknown>;
  /**
   * The launch `tool_result`'s content as tugcode forwards it: a string
   * verbatim, a block array as its text blocks joined (`event-mapping.ts`).
   */
  resultContent: string;
  /** The raw task_started event. */
  started: Record<string, unknown>;
  /** The raw task_updated event (absent for the foreground agent). */
  updated?: Record<string, unknown>;
  /** The raw task_notification event. */
  notification?: Record<string, unknown>;
}

const jobs = new Map<string, CapturedJob>();

beforeAll(async () => {
  const fixtureDir = new URL(
    "../../../tugrust/crates/tugcast/tests/fixtures/" +
      "stream-json-catalog/v2.1.173-jobs-spike/",
    import.meta.url,
  ).pathname;
  const events: Array<Record<string, unknown>> = [];
  for (const name of [
    "test-jobs-lifecycle-raw.jsonl",
    "test-monitor-lifecycle-raw.jsonl",
  ]) {
    const raw = await Bun.file(fixtureDir + name).text();
    for (const l of raw.split("\n")) {
      if (l.length > 0) events.push(JSON.parse(l) as Record<string, unknown>);
    }
  }

  // Pass 1 — task_started seeds the per-job record.
  for (const ev of events) {
    if (ev.type === "system" && ev.subtype === "task_started") {
      jobs.set(String(ev.task_id), {
        taskId: String(ev.task_id),
        toolUseId: String(ev.tool_use_id),
        toolName: "",
        input: {},
        resultContent: "",
        started: ev,
      });
    }
  }
  // Pass 2 — attach lifecycle + launching-call artifacts.
  for (const ev of events) {
    if (ev.type === "system" && ev.subtype === "task_updated") {
      const job = jobs.get(String(ev.task_id));
      if (job !== undefined && job.updated === undefined) job.updated = ev;
    }
    if (ev.type === "system" && ev.subtype === "task_notification") {
      const job = jobs.get(String(ev.task_id));
      if (job !== undefined && job.notification === undefined) {
        job.notification = ev;
      }
    }
    if (ev.type === "assistant") {
      const content = (ev.message as Record<string, unknown> | undefined)
        ?.content as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type !== "tool_use") continue;
        for (const job of jobs.values()) {
          if (block.id === job.toolUseId) {
            job.toolName = String(block.name);
            job.input = (block.input as Record<string, unknown>) ?? {};
          }
        }
      }
    }
    if (ev.type === "user") {
      const content = (ev.message as Record<string, unknown> | undefined)
        ?.content as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        for (const job of jobs.values()) {
          if (block.tool_use_id === job.toolUseId) {
            job.resultContent = Array.isArray(block.content)
              ? (block.content as Array<Record<string, unknown>>)
                  .filter((b) => b.type === "text")
                  .map((b) => String(b.text))
                  .join("")
              : String(block.content ?? "");
          }
        }
      }
    }
  }
});

/** The capture's known task ids, by scenario (see the spike README). */
const ID_CLEAN = "bkn113zww"; // bg bash, completed
const ID_FAILED = "bmvgzc1fh"; // bg bash, exit 7
const ID_KILLED = "btq9s0fcy"; // bg bash, control-request stop
const ID_FG_AGENT = "ac57e6163e2ab0290"; // FOREGROUND agent control case
const ID_MON_EXIT = "b45wg0dww"; // monitor, two events then natural exit
const ID_MON_KILLED = "be0zn8grq"; // persistent monitor, control-request stop

// -----------------------------------------------------------------------------
// Store + frame helpers
// -----------------------------------------------------------------------------

function makeStore(): { store: CodeSessionStore; conn: TestFrameChannel } {
  const conn = new TestFrameChannel();
  const store = new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: TUG,
    sessionMode: "new",
  });
  return { store, conn };
}

function emit(conn: TestFrameChannel, evt: Record<string, unknown>): void {
  conn.dispatchDecoded(FeedId.CODE_OUTPUT, { ...evt, tug_session_id: TUG });
}

/** tugcode-layer `task_started` frame (what `buildTaskStartedMessage` emits). */
function taskStartedFrame(job: CapturedJob): Record<string, unknown> {
  return {
    type: "task_started",
    session_id: "claude-sess",
    task_id: job.taskId,
    tool_use_id: job.toolUseId,
    description: String(job.started.description ?? ""),
    task_type: String(job.started.task_type ?? ""),
    ...(typeof job.started.subagent_type === "string"
      ? { subagent_type: job.started.subagent_type }
      : {}),
    ipc_version: IPC_VERSION,
  };
}

/** tugcode-layer `task_updated` frame (patch flattened). */
function taskUpdatedFrame(job: CapturedJob): Record<string, unknown> {
  const patch = (job.updated?.patch ?? {}) as Record<string, unknown>;
  return {
    type: "task_updated",
    session_id: "claude-sess",
    task_id: job.taskId,
    status: String(patch.status),
    ...(typeof patch.end_time === "number" ? { end_time: patch.end_time } : {}),
    ipc_version: IPC_VERSION,
  };
}

/**
 * Walk one launch turn through the store: send → tool block open →
 * input-filled tool_use → launch-echo tool_result → turn_complete.
 * Frames carry the captured tool name / input / echo verbatim.
 */
function runLaunchTurn(
  store: CodeSessionStore,
  conn: TestFrameChannel,
  job: CapturedJob,
  opts: { taskStartedMidTurn?: boolean; completeTurn?: boolean } = {},
): void {
  const msgId = `msg-${job.taskId}`;
  store.send(`launch ${job.taskId}`, []);
  emit(conn, {
    type: "content_block_start",
    msg_id: msgId,
    block_index: 0,
    kind: "tool_use",
    tool_use_id: job.toolUseId,
    tool_name: job.toolName,
    ipc_version: IPC_VERSION,
  });
  emit(conn, {
    type: "tool_use",
    seq: 0,
    msg_id: msgId,
    tool_use_id: job.toolUseId,
    tool_name: job.toolName,
    input: job.input,
    ipc_version: IPC_VERSION,
  });
  if (opts.taskStartedMidTurn !== false) {
    emit(conn, taskStartedFrame(job));
  }
  emit(conn, {
    type: "tool_result",
    is_error: false,
    tool_use_id: job.toolUseId,
    output: job.resultContent,
    ipc_version: IPC_VERSION,
  });
  if (opts.completeTurn !== false) {
    emit(conn, {
      type: "turn_complete",
      seq: 0,
      msg_id: msgId,
      result: "success",
      ipc_version: IPC_VERSION,
    });
  }
}

// -----------------------------------------------------------------------------
// Scenarios
// -----------------------------------------------------------------------------

describe("jobs fixture replay — capture sanity", () => {
  it("the fixture carries the four scenario jobs with backgrounded inputs where expected", () => {
    const clean = jobs.get(ID_CLEAN)!;
    expect(clean.toolName).toBe("Bash");
    expect(clean.input.run_in_background).toBe(true);
    expect((jobs.get(ID_FAILED)!.updated!.patch as Record<string, unknown>).status).toBe(
      "failed",
    );
    expect((jobs.get(ID_KILLED)!.updated!.patch as Record<string, unknown>).status).toBe(
      "killed",
    );
    // The foreground agent fired task_started with NO run_in_background
    // on its launching call — the gate this suite exists to verify.
    const fg = jobs.get(ID_FG_AGENT)!;
    expect(fg.toolName).toBe("Agent");
    expect(fg.input.run_in_background).toBeUndefined();
  });
});

describe("jobs fixture replay — lifecycle through the real store", () => {
  // Regression for the JOBS-shows-None bug: at claude 2.1.197 a
  // background Agent launches with NO `run_in_background` in its input
  // (just description/prompt/subagent_type) — the async signal lives in
  // the RESULT (`Async agent launched successfully` + `agentId`, which
  // equals the task frames' `task_id`). The ledger must key off the
  // result echo, not the vanished input flag, or the whole background
  // agent goes untracked.
  it("tracks a 2.1.197 async Agent launched WITHOUT run_in_background", () => {
    const { store, conn } = makeStore();
    const MSG = "m-ag";
    const TU = "toolu_ag";
    const AGENT_ID = "a853a0bb16cf9f191";
    store.send("Explore the codebase for block-renderer deps.", []);
    emit(conn, {
      type: "content_block_start",
      msg_id: MSG,
      block_index: 0,
      kind: "tool_use",
      tool_use_id: TU,
      tool_name: "Agent",
      ipc_version: IPC_VERSION,
    });
    emit(conn, {
      type: "tool_use",
      seq: 0,
      msg_id: MSG,
      tool_use_id: TU,
      tool_name: "Agent",
      // The real 2.1.197 shape — NO run_in_background.
      input: {
        description: "Find block renderer dependencies",
        prompt: "…",
        subagent_type: "Explore",
      },
      ipc_version: IPC_VERSION,
    });
    // task_started fires (local_agent) but can't discriminate fg/bg.
    emit(conn, {
      type: "task_started",
      session_id: "s",
      task_id: AGENT_ID,
      tool_use_id: TU,
      description: "Find block renderer dependencies",
      task_type: "local_agent",
      subagent_type: "Explore",
      ipc_version: IPC_VERSION,
    });
    // The async-launch echo IS the discriminant.
    emit(conn, {
      type: "tool_result",
      is_error: false,
      tool_use_id: TU,
      output:
        "Async agent launched successfully.\nagentId: " +
        AGENT_ID +
        " (internal ID - do not mention). output_file: /tmp/" +
        AGENT_ID +
        ".output",
      ipc_version: IPC_VERSION,
    });

    let ledger = store.getSnapshot().jobs;
    expect(ledger).toHaveLength(1);
    expect(ledger[0].jobId).toBe(AGENT_ID);
    expect(ledger[0].kind).toBe("agent");
    expect(ledger[0].status).toBe("running");

    // task_progress (keyed by the same id) folds live progress on.
    emit(conn, {
      type: "task_progress",
      session_id: "s",
      task_id: AGENT_ID,
      tool_use_id: TU,
      description: "Find block renderer dependencies",
      subagent_type: "Explore",
      last_tool_name: "Grep",
      usage: { total_tokens: 500, tool_uses: 3, duration_ms: 4000 },
      ipc_version: IPC_VERSION,
    });
    expect(store.getSnapshot().jobs[0].progress?.lastToolName).toBe("Grep");

    // Terminal flip completes the row.
    emit(conn, {
      type: "task_updated",
      session_id: "s",
      task_id: AGENT_ID,
      status: "completed",
      end_time: 1_781_000_000_000,
      ipc_version: IPC_VERSION,
    });
    expect(store.getSnapshot().jobs[0].status).toBe("completed");
  });

  it("bg launch inserts one running row; the inter-turn task_updated flips it completed", () => {
    const { store, conn } = makeStore();
    const job = jobs.get(ID_CLEAN)!;
    runLaunchTurn(store, conn, job);

    let ledger = store.getSnapshot().jobs;
    expect(ledger).toHaveLength(1);
    expect(ledger[0].jobId).toBe(ID_CLEAN);
    expect(ledger[0].status).toBe("running");
    expect(ledger[0].kind).toBe("bash");
    expect(ledger[0].toolUseId).toBe(job.toolUseId);
    // The launch echo carried the output file.
    expect(ledger[0].outputFile).toContain(ID_CLEAN);

    // Inter-turn terminal flip (the captured frame arrived after the
    // turn's result — Q02).
    emit(conn, taskUpdatedFrame(job));
    ledger = store.getSnapshot().jobs;
    expect(ledger[0].status).toBe("completed");
    const patch = job.updated!.patch as Record<string, unknown>;
    expect(ledger[0].endedAtMs).toBe(patch.end_time as number);
  });

  it("a failed job flips failed; a control-request-stopped job flips stopped (killed on the wire)", () => {
    const { store, conn } = makeStore();
    const failed = jobs.get(ID_FAILED)!;
    const killed = jobs.get(ID_KILLED)!;
    runLaunchTurn(store, conn, failed);
    runLaunchTurn(store, conn, killed);
    emit(conn, taskUpdatedFrame(failed));
    emit(conn, taskUpdatedFrame(killed));

    const ledger = store.getSnapshot().jobs;
    expect(ledger).toHaveLength(2);
    expect(ledger.find((j) => j.jobId === ID_FAILED)!.status).toBe("failed");
    expect(ledger.find((j) => j.jobId === ID_KILLED)!.status).toBe("stopped");
  });

  it("a foreground agent's task_started is gated out — the ledger stays empty", () => {
    const { store, conn } = makeStore();
    runLaunchTurn(store, conn, jobs.get(ID_FG_AGENT)!);
    expect(store.getSnapshot().jobs).toHaveLength(0);
  });

  it("the wake trigger flips a running row even when task_updated was missed", () => {
    const { store, conn } = makeStore();
    const job = jobs.get(ID_CLEAN)!;
    runLaunchTurn(store, conn, job);
    expect(store.getSnapshot().jobs[0].status).toBe("running");

    // Deliver only the notification (as the wake_started frame tugcode
    // forwards), not the task_updated.
    const notif = job.notification!;
    emit(conn, {
      type: "wake_started",
      session_id: "claude-sess",
      wake_trigger: {
        task_id: String(notif.task_id),
        tool_use_id: String(notif.tool_use_id),
        status: String(notif.status),
        summary: String(notif.summary ?? ""),
        output_file: String(notif.output_file ?? ""),
      },
      ipc_version: IPC_VERSION,
    });
    expect(store.getSnapshot().jobs[0].status).toBe("completed");
  });

  it("session_init stale-marks running rows to stopped", () => {
    const { store, conn } = makeStore();
    runLaunchTurn(store, conn, jobs.get(ID_CLEAN)!);
    expect(store.getSnapshot().jobs[0].status).toBe("running");
    emit(conn, {
      type: "session_init",
      session_id: "claude-sess-2",
      ipc_version: IPC_VERSION,
    });
    expect(store.getSnapshot().jobs[0].status).toBe("stopped");
  });

  it("clearJobs drops terminal rows and preserves running ones", () => {
    const { store, conn } = makeStore();
    const done = jobs.get(ID_FAILED)!;
    const live = jobs.get(ID_CLEAN)!;
    runLaunchTurn(store, conn, done);
    runLaunchTurn(store, conn, live);
    emit(conn, taskUpdatedFrame(done));
    expect(store.getSnapshot().jobs).toHaveLength(2);

    store.clearJobs();
    const ledger = store.getSnapshot().jobs;
    expect(ledger).toHaveLength(1);
    expect(ledger[0].jobId).toBe(ID_CLEAN);
    expect(ledger[0].status).toBe("running");
  });

  it("stopJob emits a stop_task CODE_INPUT frame for the wire to confirm", () => {
    const { store, conn } = makeStore();
    store.stopJob(ID_CLEAN);
    const sent = conn.recordedFramesExcludingStateChange.filter(
      (f) => f.feedId === FeedId.CODE_INPUT,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].decoded).toMatchObject({
      type: "stop_task",
      task_id: ID_CLEAN,
      tug_session_id: TUG,
    });
    // No optimistic flip — the ledger is untouched until the wire
    // confirms (Q04: confirmation frames are guaranteed).
    expect(store.getSnapshot().jobs).toHaveLength(0);
  });
});

describe("jobs fixture replay — replay suppression", () => {
  it("a replayed bg launch inserts nothing; the ledger starts empty after a reload", () => {
    const { store, conn } = makeStore();
    const job = jobs.get(ID_CLEAN)!;
    emit(conn, { type: "replay_started", ipc_version: IPC_VERSION });
    // The replay translator's turn shape: add_user_message opens the
    // pending turn, then the tool events re-deliver.
    emit(conn, {
      type: "add_user_message",
      content: [{ type: "text", text: `launch ${job.taskId}` }],
      ipc_version: IPC_VERSION,
    });
    const msgId = "msg-replayed";
    emit(conn, {
      type: "content_block_start",
      msg_id: msgId,
      block_index: 0,
      kind: "tool_use",
      tool_use_id: job.toolUseId,
      tool_name: job.toolName,
      ipc_version: IPC_VERSION,
    });
    emit(conn, {
      type: "tool_use",
      seq: 0,
      msg_id: msgId,
      tool_use_id: job.toolUseId,
      tool_name: job.toolName,
      input: job.input,
      ipc_version: IPC_VERSION,
    });
    // Defensive: even a task_started frame during replay must not insert.
    emit(conn, taskStartedFrame(job));
    emit(conn, {
      type: "tool_result",
      is_error: false,
      tool_use_id: job.toolUseId,
      output: job.resultContent,
      ipc_version: IPC_VERSION,
    });
    emit(conn, {
      type: "turn_complete",
      seq: 0,
      msg_id: msgId,
      result: "success",
      ipc_version: IPC_VERSION,
    });
    emit(conn, { type: "replay_complete", count: 1, ipc_version: IPC_VERSION });

    expect(store.getSnapshot().jobs).toHaveLength(0);
  });
});

describe("jobs fixture replay — monitor watchers", () => {
  it("the monitor capture carries the expected scenario jobs", () => {
    const exit = jobs.get(ID_MON_EXIT)!;
    expect(exit.toolName).toBe("Monitor");
    expect(exit.input.run_in_background).toBeUndefined();
    expect((exit.updated!.patch as Record<string, unknown>).status).toBe("completed");
    expect(
      (jobs.get(ID_MON_KILLED)!.updated!.patch as Record<string, unknown>).status,
    ).toBe("killed");
  });

  it("arming a monitor inserts a running watcher row (kind from the tool name)", () => {
    const { store, conn } = makeStore();
    runLaunchTurn(store, conn, jobs.get(ID_MON_EXIT)!);
    const ledger = store.getSnapshot().jobs;
    expect(ledger).toHaveLength(1);
    expect(ledger[0].kind).toBe("monitor");
    expect(ledger[0].status).toBe("running");
  });

  it("event wakes never flip a watcher: neither the captured task-id-less re-init form nor a hypothetical per-event notification", () => {
    const { store, conn } = makeStore();
    const job = jobs.get(ID_MON_EXIT)!;
    runLaunchTurn(store, conn, job);

    // The captured mid-life event wake: a synthetic re-init wake with
    // an empty task_id (tugcode's scheduled-wake form).
    emit(conn, {
      type: "wake_started",
      session_id: "claude-sess",
      wake_trigger: {
        task_id: "",
        tool_use_id: "",
        status: "completed",
        summary: "scheduled wake",
        output_file: "",
      },
      ipc_version: IPC_VERSION,
    });
    expect(store.getSnapshot().jobs[0].status).toBe("running");

    // Defense in depth: a future per-event notification carrying the
    // REAL watcher id must not flip it either — monitor rows reach
    // terminal only via task_updated.
    emit(conn, {
      type: "wake_started",
      session_id: "claude-sess",
      wake_trigger: {
        task_id: job.taskId,
        tool_use_id: job.toolUseId,
        status: "completed",
        summary: "event",
        output_file: "",
      },
      ipc_version: IPC_VERSION,
    });
    expect(store.getSnapshot().jobs[0].status).toBe("running");

    // The genuine terminal flips exactly once.
    emit(conn, taskUpdatedFrame(job));
    expect(store.getSnapshot().jobs[0].status).toBe("completed");
  });

  it("a control-request-stopped persistent watcher flips stopped (killed on the wire)", () => {
    const { store, conn } = makeStore();
    const job = jobs.get(ID_MON_KILLED)!;
    runLaunchTurn(store, conn, job);
    expect(store.getSnapshot().jobs[0].status).toBe("running");
    emit(conn, taskUpdatedFrame(job));
    const ledger = store.getSnapshot().jobs;
    expect(ledger[0].status).toBe("stopped");
    expect(ledger[0].endedAtMs).toBe(
      (job.updated!.patch as Record<string, unknown>).end_time as number,
    );
  });
});
