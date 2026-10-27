/**
 * Moved-call fixture-replay test — a foreground Bash call that outlives
 * its `timeout` is moved to the background, and it is a job.
 *
 * Drives the REAL `CodeSessionStore` with the frames the 2.1.311 wire
 * carries for a moved call, in the order the capture pinned them
 * (`tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.311/`
 * `test-48-bash-timeout-move.jsonl`): the call's `tool_use`, then
 * `task_started` naming the call's own `tool_use_id` *before* its
 * `tool_result`, then the `tool_result` whose text is the command's
 * output so far followed by the move sentence, then `turn_complete`, and
 * — after the turn — `task_updated{completed}` and the `wake_started`
 * the notification wakes claude with. The golden normalizes every
 * result's text to its length, so the sentence here is the one read
 * verbatim off the raw wire; the Rust reader in `tugcore::moved_call` is
 * pinned to the same text, and the drift regression hands it the live
 * capture's sentence so a wording change surfaces as drift.
 *
 * What is asserted is the deck's half of the facility: the JOBS row
 * opens on the first edge at the call's own open, the second edge fills
 * its output file in without a second row, the call's reports keep
 * attaching after its result closed the call, and the row — and the
 * run its block shows — end when the job does.
 */

import { describe, it, expect } from "bun:test";

import { CodeSessionStore } from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FeedId } from "@/protocol";

const TUG = "tug-moved-call-fixture";
const IPC_VERSION = 2;

/** The captured call: `test-48-bash-timeout-move`'s input, verbatim. */
const TOOL_USE_ID = "toolu_01MoveProbe";
const TASK_ID = "bbr5s08js";
const OUTPUT_FILE = "/private/tmp/claude-501/-private-tmp/6204b0e4/tasks/bbr5s08js.output";
const DESCRIPTION = "Run the bash-timeout-move probe";
const INPUT = {
  command: "echo MOVE_START && sleep 15 && echo MOVED_OK",
  description: DESCRIPTION,
  timeout: 3000,
};

/** The move sentence as the raw wire carried it, past the output so far. */
const MOVE_RESULT =
  "MOVE_START\nCommand did not complete within its 3s timeout and was moved to" +
  " the background (ID: bbr5s08js). Output is being written to:" +
  " /private/tmp/claude-501/-private-tmp/6204b0e4/tasks/bbr5s08js.output. You" +
  " will be notified when it completes. If it is still running after 10m in" +
  " the background, it will be stopped and you will be notified. It is" +
  " running now: do not start a second copy while it runs. If it is no" +
  " longer needed, stop it with TaskStop. To check interim output, use Read" +
  " on that file path.";

const END_TIME = 1_793_069_198_849;

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

const MSG = "msg-move";

/** Open the turn and the call, as the capture does, and leave it pending. */
function openCall(store: CodeSessionStore, conn: TestFrameChannel): void {
  store.send("run the probe", []);
  emit(conn, {
    type: "content_block_start",
    msg_id: MSG,
    block_index: 0,
    kind: "tool_use",
    tool_use_id: TOOL_USE_ID,
    tool_name: "Bash",
    ipc_version: IPC_VERSION,
  });
  emit(conn, {
    type: "tool_use",
    seq: 0,
    msg_id: MSG,
    tool_use_id: TOOL_USE_ID,
    tool_name: "Bash",
    input: INPUT,
    ipc_version: IPC_VERSION,
  });
}

/** The move's first edge: `task_started` naming the live foreground call. */
function taskStarted(conn: TestFrameChannel): void {
  emit(conn, {
    type: "task_started",
    session_id: "claude-sess",
    task_id: TASK_ID,
    tool_use_id: TOOL_USE_ID,
    description: DESCRIPTION,
    task_type: "local_bash",
    ipc_version: IPC_VERSION,
  });
}

/** The move's second edge: the call's result carries the sentence. */
function movedResult(conn: TestFrameChannel): void {
  emit(conn, {
    type: "tool_result",
    is_error: false,
    tool_use_id: TOOL_USE_ID,
    output: MOVE_RESULT,
    ipc_version: IPC_VERSION,
  });
}

function turnComplete(conn: TestFrameChannel): void {
  emit(conn, {
    type: "turn_complete",
    seq: 1,
    msg_id: MSG,
    result: "success",
    ipc_version: IPC_VERSION,
  });
}

/** A unit report from the still-running command, addressed to the call. */
function report(conn: TestFrameChannel, done: number): void {
  emit(conn, {
    type: "report",
    tool_use_id: TOOL_USE_ID,
    label: "checks",
    unit: "file",
    text: `${done}/3 checks`,
    done,
    total: 3,
    ipc_version: IPC_VERSION,
  });
}

function taskUpdatedCompleted(conn: TestFrameChannel): void {
  emit(conn, {
    type: "task_updated",
    session_id: "claude-sess",
    task_id: TASK_ID,
    status: "completed",
    end_time: END_TIME,
    ipc_version: IPC_VERSION,
  });
}

function wakeStarted(conn: TestFrameChannel): void {
  emit(conn, {
    type: "wake_started",
    session_id: "claude-sess",
    wake_trigger: {
      task_id: TASK_ID,
      tool_use_id: TOOL_USE_ID,
      status: "completed",
      summary: `Background command "${DESCRIPTION}" completed (exit code 0)`,
      output_file: OUTPUT_FILE,
    },
    ipc_version: IPC_VERSION,
  });
}

describe("a moved Bash call is a job", () => {
  it("opens the JOBS row on task_started, at the call's own open, before the result lands", () => {
    const { store, conn } = makeStore();
    const before = Date.now();
    openCall(store, conn);
    taskStarted(conn);

    const ledger = store.getSnapshot().jobs;
    expect(ledger).toHaveLength(1);
    const row = ledger[0];
    expect(row.jobId).toBe(TASK_ID);
    expect(row.toolUseId).toBe(TOOL_USE_ID);
    expect(row.kind).toBe("bash");
    expect(row.status).toBe("running");
    expect(row.description).toBe(DESCRIPTION);
    // The command has been running since the call opened, not since the
    // harness said so.
    expect(row.startedAtMs).toBeGreaterThanOrEqual(before);
    expect(row.startedAtMs).toBeLessThanOrEqual(Date.now());
    // The first edge carries no output file; the sentence does.
    expect(row.outputFile).toBeUndefined();
  });

  it("the result's sentence fills the same row in, and the call reads done", () => {
    const { store, conn } = makeStore();
    openCall(store, conn);
    taskStarted(conn);
    const opened = store.getSnapshot().jobs[0].startedAtMs;
    movedResult(conn);
    turnComplete(conn);

    const ledger = store.getSnapshot().jobs;
    expect(ledger).toHaveLength(1);
    expect(ledger[0].jobId).toBe(TASK_ID);
    expect(ledger[0].status).toBe("running");
    expect(ledger[0].outputFile).toBe(OUTPUT_FILE);
    expect(ledger[0].startedAtMs).toBe(opened);

    // The call itself returned — its block shows the sentence — and the
    // turn ended with the job still running.
    const transcript = store.getSnapshot().transcript;
    const turn = transcript[transcript.length - 1];
    const call = turn?.messages.find(
      (m) => m.kind === "tool_use" && m.toolUseId === TOOL_USE_ID,
    );
    expect(call?.kind).toBe("tool_use");
    expect(call?.kind === "tool_use" ? call.status : undefined).toBe("done");
  });

  it("the sentence alone opens the row when its task_started was not seen", () => {
    const { store, conn } = makeStore();
    openCall(store, conn);
    movedResult(conn);

    const ledger = store.getSnapshot().jobs;
    expect(ledger).toHaveLength(1);
    expect(ledger[0].jobId).toBe(TASK_ID);
    expect(ledger[0].outputFile).toBe(OUTPUT_FILE);
    expect(ledger[0].description).toBe(DESCRIPTION);

    // A late task_started for the now-returned call changes nothing.
    taskStarted(conn);
    expect(store.getSnapshot().jobs).toHaveLength(1);
    expect(store.getSnapshot().jobs[0]).toBe(ledger[0]);
  });

  it("an ordinary Bash result opens no row, and neither does its task_started afterwards", () => {
    const { store, conn } = makeStore();
    openCall(store, conn);
    emit(conn, {
      type: "tool_result",
      is_error: false,
      tool_use_id: TOOL_USE_ID,
      output: "MOVE_START\nMOVED_OK",
      ipc_version: IPC_VERSION,
    });
    expect(store.getSnapshot().jobs).toHaveLength(0);
    taskStarted(conn);
    expect(store.getSnapshot().jobs).toHaveLength(0);
  });

  it("the call's reports keep attaching after the move, and settle when the job ends", () => {
    const { store, conn } = makeStore();
    openCall(store, conn);
    report(conn, 1);
    expect(store.reports.get(TOOL_USE_ID)?.done).toBe(1);
    taskStarted(conn);
    movedResult(conn);
    turnComplete(conn);

    // The result did not close the call — the command is still running —
    // so the run its block shows is still the live one, not a settled one.
    expect(store.reports.get(TOOL_USE_ID)?.done).toBe(1);
    expect(store.reports.getSettled(TOOL_USE_ID)).toBeNull();

    // Its next reports land on the same live entry.
    report(conn, 2);
    expect(store.reports.get(TOOL_USE_ID)?.done).toBe(2);
    report(conn, 3);
    expect(store.reports.get(TOOL_USE_ID)?.done).toBe(3);

    // The job's end flips the row and settles the run on its last report.
    taskUpdatedCompleted(conn);
    const row = store.getSnapshot().jobs[0];
    expect(row.status).toBe("completed");
    expect(row.endedAtMs).toBe(END_TIME);
    expect(store.reports.get(TOOL_USE_ID)).toBeNull();
    expect(store.reports.getSettled(TOOL_USE_ID)?.done).toBe(3);

    // The wake that follows carries the same outcome; nothing moves twice.
    wakeStarted(conn);
    expect(store.getSnapshot().jobs).toHaveLength(1);
    expect(store.getSnapshot().jobs[0].status).toBe("completed");
    expect(store.getSnapshot().jobs[0].endedAtMs).toBe(END_TIME);
    // A report after the end is a late frame for a closed call.
    report(conn, 4);
    expect(store.reports.get(TOOL_USE_ID)).toBeNull();
    expect(store.reports.getSettled(TOOL_USE_ID)?.done).toBe(3);
  });

  it("the wake alone ends the row when task_updated was missed", () => {
    const { store, conn } = makeStore();
    openCall(store, conn);
    taskStarted(conn);
    movedResult(conn);
    turnComplete(conn);
    wakeStarted(conn);
    const row = store.getSnapshot().jobs[0];
    expect(row.status).toBe("completed");
    expect(row.endedAtMs).not.toBeNull();
  });
});
