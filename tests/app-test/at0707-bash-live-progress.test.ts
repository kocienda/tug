/**
 * at0707-bash-live-progress.test.ts — a running Bash block shows what its
 * command says it is doing, and the engine's own clock.
 *
 * A long `just test` used to be a block with a dot and a clock and nothing
 * else for minutes. Two frames now speak for it: the engine's
 * `tool_progress` heartbeat, which the header clock reads (so it is right
 * from the first heartbeat, and marked `live`), and a `run_progress`
 * report the command posted about itself, which rides a live band between
 * the header and the body — readable while the block is collapsed, which is
 * how a shell block mounts.
 *
 * The drive: a Bash `tool_use` for `just test`, a heartbeat at 125 s, a
 * report attached to the call. The band reads the report, the clock reads
 * the engine; the call's result removes the band. A second report that no
 * call claimed lands on the JOBS placard's card-level line.
 *
 * A report that names its unit is a run panel instead of the line: a
 * `just app-test` call reports its files — one landed, one red, one in
 * flight, one to come — and the collapsed block shows the panel's track,
 * lane and red card. When the call returns red, the collapsed block is the
 * verdict strip with no error band under it, and expanding it shows the
 * finished panel: the verdict, both reds with their history, and the
 * command's output folded at the foot.
 *
 * @covers tugdeck/src/components/tugways/cards/blocks/bash-tool-block.tsx
 * @covers tugdeck/src/components/tugways/tug-run-panel.tsx
 * @covers tugdeck/src/lib/run-panel-model.ts
 * @covers tugdeck/src/lib/run-progress-store.ts
 * @covers tugdeck/src/components/tugways/blocks/block-header.tsx
 * @covers tugdeck/src/components/tugways/blocks/block-chrome.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-popovers.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;
const FEED_CODE_OUTPUT = 0x40;

const SID = "at0707-A";
const USE_ID = `${SID}-tc1`;
const BLOCK = `[data-slot="bash-tool-block"][data-tool-use-id="${USE_ID}"]`;
const RUN_ID = `${SID}-tc2`;
const RUN_BLOCK = `[data-slot="bash-tool-block"][data-tool-use-id="${RUN_ID}"]`;
const RUN_PANEL = `${RUN_BLOCK} [data-slot="tug-run-panel"]`;
const RUN_STRIP = `${RUN_BLOCK} [data-slot="bash-run-strip"]`;
const BAND = `${BLOCK} [data-slot="bash-live-band"]`;
const ELAPSED = `${BLOCK} [data-slot="tool-call-header-elapsed"]`;
const JOBS_CELL = '[data-slot="tug-status-cell"][data-priority="jobs"]';
const LIVE_RUN = '[data-slot="session-jobs-popover-live-run"]';

function frame(app: App, decoded: Record<string, unknown>): Promise<unknown> {
  return app.driveSession("A", {
    op: "ingestFrame",
    feedId: FEED_CODE_OUTPUT,
    decoded: { tug_session_id: SID, ...decoded },
  });
}

function count(app: App, selector: string): Promise<number> {
  return app.evalJS<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
}

function shown(app: App, selector: string): Promise<boolean> {
  return app.evalJS<boolean>(
    `(function () { const el = document.querySelector(${JSON.stringify(selector)}); return el !== null && getComputedStyle(el).display !== "none"; })()`,
  );
}

function text(app: App, selector: string): Promise<string | null> {
  return app.evalJS<string | null>(
    `(function () { const el = document.querySelector(${JSON.stringify(selector)}); return el === null ? null : el.textContent; })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("AT0707: live progress on a running Bash block", () => {
  test(
    "the band carries the report, the clock the engine, and the result ends both",
    async () => {
      const app = await launchTugApp({ testName: "at0707-live-progress" });
      try {
        // `awaitEngineReady` reads the deck trace, which records nothing
        // until it is enabled.
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape({ width: 900, height: 700 }), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A", { timeoutMs: 20_000 });

        await app.driveSession("A", { op: "send", text: "run the tests" });
        await frame(app, { type: "prompt_anchor", promptUuid: `${SID}-u1` });
        await frame(app, {
          type: "tool_use",
          msg_id: `${SID}-m1`,
          tool_use_id: USE_ID,
          tool_name: "Bash",
          input: { command: "just test" },
          seq: 1,
        });
        await frame(app, {
          type: "tool_progress",
          tool_use_id: USE_ID,
          tool_name: "Bash",
          elapsed_time_seconds: 125,
          parent_tool_use_id: null,
        });
        await frame(app, {
          type: "run_progress",
          tool_use_id: USE_ID,
          label: "rust",
          text: "compiling tugcast",
          done: 3,
          total: 10,
        });

        await app.waitForCondition<boolean>(
          `!!document.querySelector(${JSON.stringify(BAND)})`,
          { timeoutMs: 10_000 },
        );
        expect(
          await app.evalJS<string | null>(
            `(document.querySelector(${JSON.stringify(BLOCK)}) || { getAttribute: () => null }).getAttribute("data-block-collapsed")`,
          ),
          "a shell block mounts collapsed, and the band reads anyway",
        ).toBe("true");
        expect(await text(app, BAND)).toContain("rust · 3/10 · compiling tugcast");

        // The engine's reading, not the local clock since the replayed
        // start: 125 s at the heartbeat, carried forward.
        const elapsed = (await text(app, ELAPSED)) ?? "";
        const m = /(\d+)m (\d+)s/.exec(elapsed);
        expect(m, `elapsed reads ${JSON.stringify(elapsed)}`).not.toBeNull();
        expect(Number(m![1]) * 60 + Number(m![2])).toBeGreaterThanOrEqual(125);
        expect(
          await app.evalJS<string | null>(
            `(document.querySelector(${JSON.stringify(ELAPSED)}) || { getAttribute: () => null }).getAttribute("data-engine")`,
          ),
        ).toBe("live");

        await frame(app, {
          type: "tool_result",
          tool_use_id: USE_ID,
          is_error: false,
          output: "ok",
        });
        await app.waitForCondition<boolean>(
          `!document.querySelector(${JSON.stringify(BAND)})`,
          { timeoutMs: 10_000 },
        );

        // ── A run that names its unit: the panel, then the verdict ───────
        await frame(app, {
          type: "tool_use",
          msg_id: `${SID}-m2`,
          tool_use_id: RUN_ID,
          tool_name: "Bash",
          input: { command: "just app-test at0310 at0339 at0352 at0360" },
          seq: 2,
        });
        await frame(app, {
          type: "run_progress",
          tool_use_id: RUN_ID,
          label: "app-test",
          text: "at0339 FAIL (1/2) 14s",
          done: 2,
          total: 4,
          failures: 1,
          unit: "file",
          jobs: 2,
          units: [
            { name: "at0310-file-view-open", status: "pass", index: 0, passed: 2, total: 2, secs: 5, median: 5 },
            { name: "at0339-composer-order-census", status: "fail", index: 1, passed: 1, total: 2, secs: 14,
              median: 9, title: "composer clears after send", message: "data-empty wait timed out" },
            { name: "at0352-pane-split-restore", status: "running", index: 2, started_at_ms: Date.now() - 5_000, median: 11 },
            { name: "at0360-session-identity-menu", status: "pending", index: 3, median: 7 },
          ],
        });
        await app.waitForCondition<boolean>(`!!document.querySelector(${JSON.stringify(RUN_PANEL)})`, {
          timeoutMs: 10_000,
        });
        expect(
          await app.evalJS<string | null>(
            `(document.querySelector(${JSON.stringify(RUN_BLOCK)}) || { getAttribute: () => null }).getAttribute("data-block-collapsed")`,
          ),
          "the running panel reads while the block is collapsed",
        ).toBe("true");
        expect(await count(app, `${RUN_PANEL} .tug-run-panel-cell`), "a cell per file").toBe(4);
        expect(await count(app, `${RUN_PANEL} .tug-run-panel-cell[data-status="fail"]`)).toBe(1);
        expect(await count(app, `${RUN_PANEL} [data-slot="tug-run-panel-lane"]`), "one file in flight").toBe(1);
        expect(await text(app, `${RUN_PANEL} [data-slot="tug-run-panel-fraction"]`)).toContain("files");
        expect(await text(app, `${RUN_PANEL} [data-slot="tug-run-panel-red"]`)).toContain("composer clears after send");
        expect(await count(app, `${RUN_BLOCK} [data-slot="bash-live-band"]`), "no one-line band beside it").toBe(0);

        await frame(app, {
          type: "run_progress",
          tool_use_id: RUN_ID,
          label: "app-test",
          text: "2 passed, 1 failed, 1 wedged",
          done: 4,
          total: 4,
          failures: 2,
          unit: "file",
          jobs: 2,
          units: [
            { name: "at0310-file-view-open", status: "pass", index: 0, passed: 2, total: 2, secs: 5, median: 5 },
            { name: "at0339-composer-order-census", status: "fail", index: 1, passed: 1, total: 2, secs: 14,
              median: 9, title: "composer clears after send", message: "data-empty wait timed out",
              history: "red in the last 7 recorded runs" },
            { name: "at0352-pane-split-restore", status: "wedged", index: 2, secs: 120, median: 11,
              message: "stopped at its 120s cap" },
            { name: "at0360-session-identity-menu", status: "pass", index: 3, passed: 3, total: 3, secs: 7, median: 7 },
          ],
        });
        await frame(app, {
          type: "tool_result",
          tool_use_id: RUN_ID,
          is_error: true,
          output: "Exit code 1\nVERDICT: FAIL  (2/4 files green)",
        });
        await app.waitForCondition<boolean>(`!!document.querySelector(${JSON.stringify(RUN_STRIP)})`, {
          timeoutMs: 10_000,
        });
        expect(await shown(app, RUN_STRIP), "collapsed, the settled run is its strip").toBe(true);
        expect(await text(app, RUN_STRIP)).toContain("RED");
        expect(await count(app, `${RUN_BLOCK} [data-slot="tool-block-notice"]`), "the strip, not the error band").toBe(0);

        await app.click(`${RUN_BLOCK} [data-slot="tool-call-header-disclosure"]`);
        await app.waitForCondition<boolean>(
          `!!document.querySelector(${JSON.stringify(`${RUN_PANEL}[data-state="finished"]`)})`,
          { timeoutMs: 10_000 },
        );
        expect(await text(app, `${RUN_PANEL} [data-slot="tug-run-panel-verdict"]`)).toContain(
          "1 of 4 files failed, 1 wedged",
        );
        expect(await count(app, `${RUN_PANEL} [data-slot="tug-run-panel-red"]`), "both reds stay open").toBe(2);
        expect(await text(app, `${RUN_PANEL} [data-slot="tug-run-panel-red"]`)).toContain("red in the last 7 recorded runs");
        expect(await text(app, `${RUN_PANEL} .tug-run-panel-folds`), "the output is a fold at the foot").toContain("Output");
        expect(await shown(app, RUN_STRIP), "expanded, the panel says what the strip did").toBe(false);

        // A report no call claimed: the card's line, on the JOBS placard.
        await frame(app, {
          type: "run_progress",
          tool_use_id: null,
          label: "app-test",
          text: "at0603 PASS",
          done: 7,
          total: 20,
        });
        await app.evalJS<boolean>(
          `(function () { const c = document.querySelector(${JSON.stringify(JOBS_CELL)}); if (c === null) return false; c.click(); return true; })()`,
        );
        await app.waitForCondition<boolean>(
          `!!document.querySelector(${JSON.stringify(LIVE_RUN)})`,
          { timeoutMs: 10_000 },
        );
        expect(await text(app, LIVE_RUN)).toBe("app-test · 7/20 · at0603 PASS");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
