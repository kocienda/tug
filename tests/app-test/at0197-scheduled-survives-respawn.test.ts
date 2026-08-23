/**
 * at0197-scheduled-survives-respawn.test.ts — a scheduled JOBS row
 * (pending `ScheduleWakeup`) survives a claude respawn un-stale-marked.
 *
 * ## Why this exists
 *
 * Every tugcode respawn path (model/effort change, Maker ▸ Reload,
 * app restart) resumes with `--resume`, and on claude ≥ 2.1.204 the
 * harness scheduler re-fires a pending wakeup/cron in the resumed
 * process (probe-verified: `tugcode/probes/goal-loop/FINDINGS.md#q02-loop`).
 * The reducer's `session_init` stale-marking therefore flips only
 * `running` rows; a `scheduled` row falsely marked `stopped` would
 * contradict the wake that then actually fires. The pure rule is
 * unit-tested in `select-jobs.test.ts`; this drives the live surface:
 * register a wakeup through the store's real `frameToEvent → dispatch`
 * path, inject the respawn's `session_init`, and assert the JOBS cell
 * still reports the row as scheduled (a false flip would report it
 * finished).
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/code-session-store/
 * @covers tugdeck/src/lib/session-restore.ts
 * @covers tugcode/
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const SID = "test-session-A"; // bindSession default
const JOBS_CELL = '[data-slot="tug-status-cell"][data-priority="jobs"]';

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0197-respawn-"));
});
afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 820, height: 620 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

describe.skipIf(!SHOULD_RUN)(
  "AT0197: scheduled work survives a respawn's session_init",
  () => {
    test(
      "a pending wakeup row is not stale-marked by session_init",
      async () => {
        const app = await launchTugApp({
          testName: "at0197-scheduled-survives-respawn",
        });
        const ingest = (decoded: unknown) =>
          app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded,
          });
        const jobsCellText = async (): Promise<string> =>
          app.evalJS<string>(
            `(document.querySelector(${JSON.stringify(JOBS_CELL)})||{}).textContent || ""`,
          );
        // The cell's composed summary, carried as the indicator's
        // `aria-label` — it names which bucket the count came from.
        const jobsCellSummary = async (): Promise<string> =>
          app.evalJS<string>(
            `(() => {
              const el = document.querySelector(${JSON.stringify(JOBS_CELL)} + " [aria-label]");
              return el === null ? "" : el.getAttribute("aria-label");
            })()`,
          );
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", { projectDir });
          await app.awaitEngineReady("A", { timeoutMs: 30_000 });

          // A turn in which claude schedules a wakeup (the loop-pacing
          // shape: ScheduleWakeup tool call + its result echo).
          await app.driveSession("A", {
            op: "send",
            text: "loop please",
            atoms: [],
          });
          await ingest({
            type: "tool_use",
            tug_session_id: SID,
            msg_id: "m1",
            tool_use_id: "m1-wake",
            tool_name: "ScheduleWakeup",
            input: { delaySeconds: 3600, reason: "loop pacing", prompt: "tick" },
            seq: 1,
          });
          await ingest({
            type: "tool_result",
            tug_session_id: SID,
            tool_use_id: "m1-wake",
            output: "Wakeup scheduled in 3600s.",
            is_error: false,
          });
          await ingest({
            type: "turn_complete",
            tug_session_id: SID,
            msg_id: "m1",
            result: "success",
          });

          // The scheduled row lands: the JOBS cell counts it.
          await app.waitForCondition<boolean>(
            `((document.querySelector(${JSON.stringify(JOBS_CELL)})||{}).textContent || "").includes("1")`,
            { timeoutMs: 6000 },
          );
          // The count alone cannot tell the two outcomes apart — a
          // flipped row would linger for five minutes and still read
          // "1". The cell's summary names the bucket, so that is the
          // discriminator: "1 scheduled" survives, "1 finished" is the
          // false flip.
          expect(await jobsCellSummary()).toBe("1 scheduled");

          // The respawn signal.
          await ingest({
            type: "session_init",
            tug_session_id: SID,
            session_id: SID,
          });
          // The flip (if any) is synchronous on dispatch; re-read after
          // a beat rather than racing the render.
          await app.waitForCondition<boolean>(
            `((document.querySelector(${JSON.stringify(JOBS_CELL)})||{}).textContent || "").length > 0`,
            { timeoutMs: 3000 },
          );
          expect(await jobsCellSummary()).toBe("1 scheduled");
          expect((await jobsCellText()).includes("1")).toBe(true);

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0197] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
