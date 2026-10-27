/**
 * at0754-bash-moved-call-is-a-job.test.ts — a foreground Bash call the
 * harness moves to the background at its `timeout` is a job: JOBS lists
 * it, and its block keeps reporting until the job ends.
 *
 * Claude Code does not kill a foreground Bash call that outlives its
 * `timeout`; it moves the call to a background task and answers the call
 * at once with the output so far and a sentence naming the task and its
 * output file. On the wire (2.1.311, `test-48-bash-timeout-move`) the move
 * is two edges: a `task_started` naming the call's own `tool_use_id`, then
 * the call's `tool_result` carrying the sentence; the job ends on a
 * `task_updated` after the turn. Before this, the deck read the result as
 * a finished call — the block went quiet at the move, and nothing listed
 * the command that was still running.
 *
 * The drive: a short-timeout Bash call that reports its units, the
 * `task_started` of the move, the `tool_result` with the sentence verbatim
 * off the wire, `turn_complete`, two more reports from the still-running
 * command, and the terminal `task_updated`. Asserted: the JOBS cell reads
 * a running job and its popover lists the row with the call's description;
 * after the move the block's header says `in background`, its dot is in
 * flight, and its live panel takes the later reports; at the job's end the
 * row reads completed, the header says so, and the block settles on the
 * run's last report rather than the one it held when the call returned.
 *
 * @covers tugdeck/src/lib/code-session-store/select-jobs.ts
 * @covers tugdeck/src/lib/code-session-store/reducer.ts
 * @covers tugdeck/src/lib/code-session-store/session-engine.ts
 * @covers tugdeck/src/components/tugways/cards/blocks/bash-tool-block.tsx
 * @covers tugdeck/src/lib/code-session-store/hooks/use-job-for-tool-use.ts
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-popovers.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, type App, type BodyApp } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;
const FEED_CODE_OUTPUT = 0x40;

const SID = "at0754-A";
const USE_ID = `${SID}-tc1`;
const TASK_ID = "bbr5s08js";
const DESCRIPTION = "Run the checks across the move";
const BLOCK = `[data-slot="bash-tool-block"][data-tool-use-id="${USE_ID}"]`;
const PANEL = `${BLOCK} [data-slot="tug-report-panel"]`;
const STRIP = `${BLOCK} [data-slot="bash-report-strip"]`;
const SUMMARY = `${BLOCK} [data-slot="tool-call-header-summary"]`;
const JOBS_CELL = '[data-slot="tug-status-cell"][data-priority="jobs"]';
const JOB_ROW = '[data-slot="session-jobs-popover-row"]';

/** The move sentence verbatim off the 2.1.311 wire, past the output so far. */
const MOVE_RESULT =
  "CHECKS_START\nCommand did not complete within its 3s timeout and was moved to" +
  " the background (ID: bbr5s08js). Output is being written to:" +
  " /private/tmp/claude-501/-private-tmp/6204b0e4/tasks/bbr5s08js.output. You" +
  " will be notified when it completes. If it is still running after 10m in" +
  " the background, it will be stopped and you will be notified. It is" +
  " running now: do not start a second copy while it runs. If it is no" +
  " longer needed, stop it with TaskStop. To check interim output, use Read" +
  " on that file path.";

function frame(app: App, decoded: Record<string, unknown>): Promise<unknown> {
  return app.driveSession("A", {
    op: "ingestFrame",
    feedId: FEED_CODE_OUTPUT,
    decoded: { tug_session_id: SID, ...decoded },
  });
}

function count(card: BodyApp, selector: string): Promise<number> {
  return card.evalJS<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
}

function text(card: BodyApp, selector: string): Promise<string | null> {
  return card.evalJS<string | null>(
    `(function () { const el = document.querySelector(${JSON.stringify(selector)}); return el === null ? null : el.textContent; })()`,
  );
}

function attr(card: BodyApp, selector: string, name: string): Promise<string | null> {
  return card.evalJS<string | null>(
    `(function () { const el = document.querySelector(${JSON.stringify(selector)}); return el === null ? null : el.getAttribute(${JSON.stringify(name)}); })()`,
  );
}

/** A unit report from the command, `done` of three checks landed. */
function checksReport(app: App, done: number): Promise<unknown> {
  const names = ["lint", "unit", "app-test"];
  return frame(app, {
    type: "report",
    tool_use_id: USE_ID,
    label: "checks",
    text: `${names[Math.min(done, 2)]} ${done}/3`,
    done,
    total: 3,
    unit: "check",
    units: names.map((name, index) => ({
      name,
      index,
      status: index < done ? "pass" : index === done ? "running" : "pending",
      ...(index < done ? { secs: 4 } : {}),
      ...(index === done ? { started_at_ms: Date.now() - 2_000 } : {}),
      median: 4,
    })),
  });
}

describe.skipIf(!SHOULD_RUN)("AT0754: a moved Bash call is a job", () => {
  test(
    "JOBS lists the moved call, and its block keeps reporting until the job ends",
    async () => {
      const app = await launchTugApp({ testName: "at0754-moved-call" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape({ width: 900, height: 700 }), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A", { timeoutMs: 20_000 });
        const card = app.body("A");

        // A foreground call with a short timeout, reporting its checks.
        await app.driveSession("A", { op: "send", text: "run the checks" });
        await frame(app, { type: "prompt_anchor", promptUuid: `${SID}-u1` });
        await frame(app, {
          type: "tool_use",
          msg_id: `${SID}-m1`,
          tool_use_id: USE_ID,
          tool_name: "Bash",
          input: { command: "echo CHECKS_START && ./run-checks", description: DESCRIPTION, timeout: 3000 },
          seq: 1,
        });
        await checksReport(app, 1);
        await card.waitForCondition<boolean>(`!!document.querySelector(${JSON.stringify(PANEL)})`, {
          timeoutMs: 10_000,
        });
        expect(await count(card, `${PANEL} .tug-report-panel-cell[data-status="pass"]`), "one check landed").toBe(1);
        expect(await count(card, JOB_ROW), "no job before the move").toBe(0);

        // ── The move: task_started first, then the result's sentence ─────
        await frame(app, {
          type: "task_started",
          session_id: "claude-sess",
          task_id: TASK_ID,
          tool_use_id: USE_ID,
          description: DESCRIPTION,
          task_type: "local_bash",
        });
        await frame(app, { type: "tool_result", tool_use_id: USE_ID, is_error: false, output: MOVE_RESULT });
        await frame(app, { type: "turn_complete", msg_id: `${SID}-m1`, result: "success", seq: 2 });

        // The block says what it is now: a call in the background, still in
        // flight, its panel still the running one.
        await card.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(SUMMARY)}) || { textContent: "" }).textContent.includes("in background")`,
          { timeoutMs: 10_000 },
        );
        expect(await count(card, `${PANEL}[data-state="running"]`), "the running panel stays up across the move").toBe(1);
        expect(await count(card, STRIP), "no settled strip while the job runs").toBe(0);

        // JOBS lists the moved call as a running job.
        await card.evalJS<boolean>(
          `(function () { const c = document.querySelector(${JSON.stringify(JOBS_CELL)}); if (c === null) return false; c.click(); return true; })()`,
        );
        await card.waitForCondition<boolean>(`!!document.querySelector(${JSON.stringify(JOB_ROW)})`, {
          timeoutMs: 10_000,
        });
        expect(await count(card, JOB_ROW), "one row, keyed by the task the sentence named").toBe(1);
        expect(await attr(card, JOB_ROW, "data-status")).toBe("running");
        expect(await text(card, JOB_ROW)).toContain(DESCRIPTION);

        // The command keeps reporting after the call returned, and the
        // block's panel takes every report.
        await checksReport(app, 2);
        await card.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(`${PANEL} .tug-report-panel-cell[data-status="pass"]`)}).length === 2`,
          { timeoutMs: 10_000 },
        );
        await checksReport(app, 3);
        await card.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(`${PANEL} .tug-report-panel-cell[data-status="pass"]`)}).length === 3`,
          { timeoutMs: 10_000 },
        );

        // ── The job ends ─────────────────────────────────────────────────
        await frame(app, {
          type: "task_updated",
          session_id: "claude-sess",
          task_id: TASK_ID,
          status: "completed",
          end_time: Date.now(),
        });
        await card.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(JOB_ROW)}) || { getAttribute: () => null }).getAttribute("data-status") === "completed"`,
          { timeoutMs: 10_000 },
        );
        await card.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(SUMMARY)}) || { textContent: "" }).textContent.includes("completed in background")`,
          { timeoutMs: 10_000 },
        );
        // The run settled on the job's last report — all three checks — not
        // on the one the call held when it was moved.
        await card.waitForCondition<boolean>(`!!document.querySelector(${JSON.stringify(STRIP)})`, {
          timeoutMs: 10_000,
        });
        expect(await count(card, `${STRIP} .tug-report-panel-cell[data-status="pass"]`), "the strip carries the whole run").toBe(3);
        expect(await count(card, `${PANEL}[data-state="running"]`), "nothing still runs").toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
