/**
 * sc-status-row.test.ts — the site's status-row clip: a Session card's
 * status row through one turn, every cell moving for its own reason.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. Run by path, once per mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both
 * site variables are set.
 *
 * The scene: one Session card in a one-up, bound to a stub transcript of
 * two turns. The first, played before the burst, writes three tasks, so the
 * row starts the clip reading 0 of 3. The second is the one recorded, and
 * it does what a working turn does, in order: it takes the first task,
 * streams prose while its usage climbs, starts a shell command in the
 * background, finishes the first task and takes the second, streams on,
 * sees the job end, finishes the rest, and ends. On the row that is STATE
 * going from Streaming to Idle, TIME counting while it does, CONTEXT
 * climbing with each usage frame, TASKS filling in, and JOBS taking one job
 * and letting it go.
 *
 * Every tool call in the recorded turn is held open for a moment
 * ({@link HOLD_BEATS} heartbeats) before its result: a call that opens and
 * returns within one frame flips the state cell for that frame alone, and a
 * run of them at the turn's start read as a flicker. Held, each is a
 * legible beat of Working between stretches of Streaming, which is what a
 * real turn's calls are. The capture is cropped to the status row.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TUGCODE_TRANSCRIPT_SCHEMA_VERSION, type App } from "../_harness";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { pollFor } from "../body-grounding/_frames";
import { stubDirectory } from "../streaming-stub-fixture";
import { RUNS, contentSize, cropAround, expectRecorded, launchForMode, outDirFor, scene } from "./_site-clips";

const TEST_TIMEOUT_MS = 110_000;
const CARD = "sc-status";
const IPC_VERSION = 2;
/** The transcript's pace, a word at a time. */
const PACE_MS = 35;
/** Heartbeats a tool call stays open before its result: about half a second. */
const HOLD_BEATS = 14;
/** The loop: the turn from its first streaming frame past its end. */
const LOOP_MS = 9_000;
const STATUS_BAR = '[data-slot="session-card-status-bar"]';
const PROMPT_PHASE = `(function(){ var e = document.querySelector('[data-slot="tug-prompt-entry"]'); return e === null ? null : e.getAttribute("data-phase"); })()`;
const PROJECT_NAME = "tug-site";
const BOUND_MS = 30_000;
const STREAMING_MS = 15_000;

const TASKS = ["Read the jobs reducer and its tests", "Fix the stopped-job count", "Run the tugdeck suite"];

/** The usage frame the context cell reads: the window at `tokens`. */
function usage(tokens: number): Record<string, number> {
  return { input_tokens: 2_400, output_tokens: 1_800, cache_creation_input_tokens: 6_200, cache_read_input_tokens: tokens - 10_400 };
}

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: CARD, componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: `${CARD}-pane`,
        position: { x: 40, y: 40 },
        size: { width: 720, height: 560 },
        cardIds: [CARD],
        activeCardId: CARD,
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: `${CARD}-pane`,
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** A builder for one turn's outputs. */
function turn(tugSessionId: string, index: number) {
  const out: unknown[] = [];
  let seq = 0;
  let calls = 0;
  const msg = (k: string) => `stub-sc-status-t${index}-${k}`;
  const call = (toolName: string, input: Record<string, unknown>, result: string, hold = HOLD_BEATS): string => {
    const id = `toolu_sc_status_${index}_${++calls}`;
    out.push({ type: "tool_use", msg_id: msg(`c${calls}`), seq: seq++, tool_name: toolName, tool_use_id: id, input, ipc_version: IPC_VERSION });
    for (let b = 1; b <= hold; b++) {
      out.push({ type: "tool_progress", tool_use_id: id, tool_name: toolName, elapsed_time_seconds: 0, parent_tool_use_id: null, ipc_version: IPC_VERSION });
    }
    out.push({ type: "tool_result", tool_use_id: id, output: result, is_error: false, ipc_version: IPC_VERSION });
    return id;
  };
  const prose = (k: string, text: string, from: number, to: number): void => {
    const id = msg(k);
    out.push({ type: "content_block_start", msg_id: id, block_index: 0, kind: "text", ipc_version: IPC_VERSION });
    const deltas = text.match(/\S+\s*|\s+/g) ?? [text];
    const every = Math.max(1, Math.floor(deltas.length / 8));
    let rev = 0;
    deltas.forEach((delta, i) => {
      out.push({ type: "assistant_text", msg_id: id, block_index: 0, seq, rev: rev++, text: delta, is_partial: true, status: "partial", ipc_version: IPC_VERSION });
      if (i % every === every - 1) {
        const tokens = Math.round(from + ((to - from) * (i + 1)) / deltas.length);
        out.push({ type: "streaming_usage", msg_id: id, usage: usage(tokens), ipc_version: IPC_VERSION });
      }
    });
    out.push({ type: "assistant_text", msg_id: id, block_index: 0, seq: seq++, rev, text, is_partial: false, status: "complete", ipc_version: IPC_VERSION });
  };
  const complete = (k: string, cost?: number): void => {
    if (cost !== undefined) {
      out.push({ type: "cost_update", total_cost_usd: 0.41, num_turns: index + 1, duration_ms: 8_200, duration_api_ms: 7_900, usage: usage(cost), modelUsage: {}, ipc_version: IPC_VERSION });
    }
    out.push({ type: "turn_complete", msg_id: msg(k), seq: seq++, result: "success", ipc_version: IPC_VERSION });
  };
  const job = (id: string, status: "started" | "completed"): void => {
    if (status === "started") {
      out.push({ type: "task_started", session_id: tugSessionId, task_id: "b1", tool_use_id: id, description: "Run the tugdeck suite", task_type: "local_bash", ipc_version: IPC_VERSION });
    } else {
      out.push({ type: "task_updated", session_id: tugSessionId, task_id: "b1", status: "completed", end_time: Date.now(), ipc_version: IPC_VERSION });
    }
  };
  return { out, call, prose, complete, job };
}

/** The turn played before the burst: the three tasks, written. */
function planning(tugSessionId: string): unknown[] {
  const t = turn(tugSessionId, 0);
  TASKS.forEach((subject, i) => t.call("TaskCreate", { subject, description: subject, activeForm: subject }, `Task #${i + 1} created successfully: ${subject}`, 0));
  t.complete("end", 42_300);
  return t.out;
}

/** The turn recorded. */
function working(tugSessionId: string): unknown[] {
  const t = turn(tugSessionId, 1);
  t.out.push({ type: "streaming_usage", msg_id: "stub-sc-status-t1-a", usage: usage(42_300), ipc_version: IPC_VERSION });
  t.call("TaskUpdate", { taskId: "1", status: "in_progress" }, "Updated task #1 status");
  t.prose(
    "a",
    "The jobs reducer keys every row by the task id the launch echoed, and a stopped job keeps its row with a terminal status. " +
      "The count the cell shows is the running rows alone, so the fix is one predicate: a stopped row is terminal, not running.",
    42_300,
    58_900,
  );
  const job = t.call("Bash", { command: "bun test src/lib 2>&1 | tail -3", run_in_background: true, description: "Run the tugdeck suite" }, "Command running in background with ID: b1.");
  t.job(job, "started");
  t.call("TaskUpdate", { taskId: "1", status: "completed" }, "Updated task #1 status");
  t.call("TaskUpdate", { taskId: "2", status: "in_progress" }, "Updated task #2 status", 0);
  t.prose(
    "b",
    "With the predicate moved, the running count drops the moment a job is stopped, and the finished fraction picks it up. " +
      "Nothing else reads the predicate, so the change is one line and one test, and the popover's Clear keeps its meaning: a stopped row is cleared with the finished ones.",
    58_900,
    71_400,
  );
  t.job(job, "completed");
  t.call("TaskUpdate", { taskId: "2", status: "completed" }, "Updated task #2 status");
  t.call("TaskUpdate", { taskId: "3", status: "in_progress" }, "Updated task #3 status", 0);
  t.prose("c", "The suite is green: 212 of 212, with the stopped-job assertion among them. The fix is in, and the count reads as it should.", 71_400, 74_100);
  t.call("TaskUpdate", { taskId: "3", status: "completed" }, "Updated task #3 status");
  t.complete("c", 74_100);
  return t.out;
}

function transcript(tugSessionId: string): unknown {
  return {
    schemaVersion: TUGCODE_TRANSCRIPT_SCHEMA_VERSION,
    tugcodeVersion: "stub",
    paceMs: PACE_MS,
    turns: [
      { index: 0, description: "the tasks, planned", outputs: planning(tugSessionId) },
      { index: 1, description: "a working turn", outputs: working(tugSessionId) },
    ],
  };
}

async function bindStub(app: App, stubDir: string): Promise<string> {
  const tugSessionId = randomUUID();
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "sc-status-")));
  onTestRunEnd(() => rmSync(scratch, { recursive: true, force: true }));
  const projectDir = join(scratch, PROJECT_NAME);
  mkdirSync(projectDir);
  writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(transcript(tugSessionId)));
  await app.spawnSessionNew(CARD, { tugSessionId, projectDir });
  await pollFor(
    () =>
      app
        .body(CARD)
        .evalJS<boolean>(
          `document.querySelector('[data-testid="session-card-transcript"]') !== null && document.querySelector('.session-card-picker-form') === null`,
        )
        .catch(() => false),
    (bound) => bound,
    BOUND_MS,
  );
  return tugSessionId;
}

describe.skipIf(!RUNS)("site clip: status row", () => {
  test(
    "records the status row through one turn",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchForMode("sc-status-row", deck(), stubDir);
      try {
        await bindStub(app, stubDir);
        await Bun.sleep(800);
        const body = app.body(CARD);
        const phase = () => body.evalJS<string | null>(PROMPT_PHASE).catch(() => null);

        // The planning turn, and its end: the row reads 0 of 3 before a frame is taken.
        await body.driveSession({ op: "send", text: "Plan the stopped-job fix." });
        await pollFor(phase, (p) => p === "streaming", STREAMING_MS);
        await pollFor(phase, (p) => p !== null && p !== "streaming", STREAMING_MS);
        await Bun.sleep(1_500);

        const bar = await app.elementRect(CARD, STATUS_BAR);
        expect(bar, "the status bar is mounted").not.toBeNull();
        const crop = cropAround([bar!], 4, await contentSize(app));

        const s = scene()
          .at(0, async () => {
            await body.driveSession({ op: "send", text: "Fix the stopped-job count and run the suite." });
            await pollFor(phase, (p) => p === "streaming", STREAMING_MS);
          })
          .mark("loop-start")
          .mark("loop-end", LOOP_MS);
        expectRecorded(await s.record(app, { outDir: outDirFor("status-row"), crop }));
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
