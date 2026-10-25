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
 * one turn that does what a working turn does, in order: it writes three
 * tasks and takes the first, streams prose while its usage climbs, starts a
 * shell command in the background, finishes the first task and takes the
 * second, streams on, sees the job end, and ends. On the row that is STATE
 * going from Streaming to Idle, TIME counting while it does, CONTEXT
 * climbing with each usage frame, TASKS filling in, and JOBS taking one job
 * and letting it go. The capture is cropped to the status row.
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
import { rectIn } from "../one-view-fixture";
import { RUNS, burstTo, contentSize, cropAround, launchForMode, outDirFor } from "./_site-clips";

const TEST_TIMEOUT_MS = 110_000;
const CARD = "sc-status";
const IPC_VERSION = 2;
/** The transcript's pace, a word at a time. */
const PACE_MS = 35;
/** The burst: the turn from its first frame past its end. */
const BURST_MS = 9_800;
const STATUS_BAR = '[data-slot="session-card-status-bar"]';
const PROJECT_NAME = "tug-site";
const BOUND_MS = 30_000;
const STREAMING_MS = 15_000;

const TASKS = [
  "Read the jobs reducer and its tests",
  "Fix the stopped-job count",
  "Run the tugdeck suite",
];

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

/** The turn's outputs, in the order above. */
function outputs(tugSessionId: string): unknown[] {
  const out: unknown[] = [];
  let seq = 0;
  let calls = 0;
  const call = (toolName: string, input: Record<string, unknown>, result: string): string => {
    const id = `toolu_sc_status_${++calls}`;
    out.push({ type: "tool_use", msg_id: `stub-sc-status-m${seq}`, seq: seq++, tool_name: toolName, tool_use_id: id, input, ipc_version: IPC_VERSION });
    out.push({ type: "tool_result", tool_use_id: id, output: result, is_error: false, ipc_version: IPC_VERSION });
    return id;
  };
  const prose = (msgId: string, text: string, from: number, to: number): void => {
    out.push({ type: "content_block_start", msg_id: msgId, block_index: 0, kind: "text", ipc_version: IPC_VERSION });
    const deltas = text.match(/\S+\s*|\s+/g) ?? [text];
    const every = Math.max(1, Math.floor(deltas.length / 8));
    let rev = 0;
    deltas.forEach((delta, i) => {
      out.push({ type: "assistant_text", msg_id: msgId, block_index: 0, seq, rev: rev++, text: delta, is_partial: true, status: "partial", ipc_version: IPC_VERSION });
      if (i % every === every - 1) {
        const tokens = Math.round(from + ((to - from) * (i + 1)) / deltas.length);
        out.push({ type: "streaming_usage", msg_id: msgId, usage: usage(tokens), ipc_version: IPC_VERSION });
      }
    });
    out.push({ type: "assistant_text", msg_id: msgId, block_index: 0, seq: seq++, rev, text, is_partial: false, status: "complete", ipc_version: IPC_VERSION });
  };

  TASKS.forEach((subject, i) => call("TaskCreate", { subject, description: subject, activeForm: subject }, `Task #${i + 1} created successfully: ${subject}`));
  // The window as the turn opens, so the context cell reads a session's
  // standing figure from the first frame rather than a zero.
  out.push({ type: "streaming_usage", msg_id: "stub-sc-status-a", usage: usage(42_300), ipc_version: IPC_VERSION });
  call("TaskUpdate", { taskId: "1", status: "in_progress" }, "Updated task #1 status");
  prose(
    "stub-sc-status-a",
    "The jobs reducer keys every row by the task id the launch echoed, and a stopped job keeps its row with a terminal status. " +
      "The count the cell shows is the running rows alone, so the fix is one predicate: a stopped row is terminal, not running.",
    42_300,
    58_900,
  );
  const job = call("Bash", { command: "bun test src/lib 2>&1 | tail -3", run_in_background: true, description: "Run the tugdeck suite" }, "Command running in background with ID: b1.");
  out.push({ type: "task_started", session_id: tugSessionId, task_id: "b1", tool_use_id: job, description: "Run the tugdeck suite", task_type: "local_bash", ipc_version: IPC_VERSION });
  call("TaskUpdate", { taskId: "1", status: "completed" }, "Updated task #1 status");
  call("TaskUpdate", { taskId: "2", status: "in_progress" }, "Updated task #2 status");
  prose(
    "stub-sc-status-b",
    "With the predicate moved, the running count drops the moment a job is stopped, and the finished fraction picks it up. " +
      "The suite is running in the background; its tail will say whether the one assertion that counted the stopped row still holds. " +
      "Nothing else reads the predicate, so the change is one line and one test, and the popover's Clear keeps its meaning: a stopped row is cleared with the finished ones.",
    58_900,
    71_400,
  );
  out.push({ type: "task_updated", session_id: tugSessionId, task_id: "b1", status: "completed", end_time: Date.now(), ipc_version: IPC_VERSION });
  call("TaskUpdate", { taskId: "2", status: "completed" }, "Updated task #2 status");
  call("TaskUpdate", { taskId: "3", status: "in_progress" }, "Updated task #3 status");
  prose(
    "stub-sc-status-c",
    "The suite is green: 212 of 212, with the stopped-job assertion among them. The fix is in, the count reads as it should, and the row the cell shows for the job is the finished one.",
    71_400,
    74_100,
  );
  call("TaskUpdate", { taskId: "3", status: "completed" }, "Updated task #3 status");
  // The terminal usage, which the context cell settles on when the turn ends.
  out.push({ type: "cost_update", total_cost_usd: 0.41, num_turns: 1, duration_ms: 8_200, duration_api_ms: 7_900, usage: usage(74_100), modelUsage: {}, ipc_version: IPC_VERSION });
  out.push({ type: "turn_complete", msg_id: "stub-sc-status-c", seq: seq++, result: "success", ipc_version: IPC_VERSION });
  return out;
}

function transcript(tugSessionId: string): unknown {
  return {
    schemaVersion: TUGCODE_TRANSCRIPT_SCHEMA_VERSION,
    tugcodeVersion: "stub",
    paceMs: PACE_MS,
    turns: [{ index: 0, description: "a working turn", outputs: outputs(tugSessionId) }],
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

        const view = (await app.bodies()).find((b) => b.cardId === CARD)!.frame;
        const body = app.body(CARD);
        const bar = await rectIn(body, STATUS_BAR);
        expect(bar, "the status bar is mounted").not.toBeNull();
        const crop = cropAround([{ x: view.x + bar!.x, y: view.y + bar!.y, width: bar!.width, height: bar!.height }], 4, await contentSize(app));

        const reading = await burstTo(app, crop, BURST_MS, outDirFor("status-row"), async () => {
          await body.driveSession({ op: "send", text: "Fix the stopped-job count and run the suite." });
          await pollFor(
            () =>
              body
                .evalJS<boolean>(
                  `(function(){ var e = document.querySelector('[data-slot="tug-prompt-entry"]'); return e !== null && e.getAttribute("data-phase") === "streaming"; })()`,
                )
                .catch(() => false),
            (v) => v,
            STREAMING_MS,
          );
        });
        expect(reading.frames, "frames were recorded").toBeGreaterThan(60);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
