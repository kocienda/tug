/**
 * at0707-bash-live-progress.test.ts — a running Bash block shows what its
 * command says it is doing, and the engine's own clock.
 *
 * A long `just test` used to be a block with a dot and a clock and nothing
 * else for minutes. Two frames now speak for it: the engine's
 * `tool_progress` heartbeat, which the header clock reads (so it is right
 * from the first heartbeat, and marked `live`), and a `report` frame, the
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
 * A run that ends green folds: its collapsed strip is the masthead's one
 * line, with no track and no reds. The card-level report wears its
 * "unattached" tag, the reason in the tag's title on a test build, and the
 * JOBS placard lists the session's dark calls from tugcast's gaps record.
 *
 * @covers tugdeck/src/components/tugways/cards/blocks/bash-tool-block.tsx
 * @covers tugdeck/src/components/tugways/tug-report-panel.tsx
 * @covers tugdeck/src/lib/report-panel-model.ts
 * @covers tugdeck/src/lib/report-store.ts
 * @covers tugdeck/src/components/tugways/blocks/block-header.tsx
 * @covers tugdeck/src/components/tugways/blocks/block-chrome.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-popovers.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.tsx
 * @covers tugdeck/src/lib/report-gaps-store.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, type App, type BodyApp } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;
const FEED_CODE_OUTPUT = 0x40;

const SID = "at0707-A";
const USE_ID = `${SID}-tc1`;
const BLOCK = `[data-slot="bash-tool-block"][data-tool-use-id="${USE_ID}"]`;
const RUN_ID = `${SID}-tc2`;
const RUN_BLOCK = `[data-slot="bash-tool-block"][data-tool-use-id="${RUN_ID}"]`;
const RUN_PANEL = `${RUN_BLOCK} [data-slot="tug-report-panel"]`;
const RUN_STRIP = `${RUN_BLOCK} [data-slot="bash-report-strip"]`;
const BAND = `${BLOCK} [data-slot="bash-live-band"]`;
const ELAPSED = `${BLOCK} [data-slot="tool-call-header-elapsed"]`;
const JOBS_CELL = '[data-slot="tug-status-cell"][data-priority="jobs"]';
const LIVE_RUN = '[data-slot="session-jobs-popover-live-run"]';
const GREEN_ID = `${SID}-tc3`;
const GREEN_STRIP = `[data-slot="bash-tool-block"][data-tool-use-id="${GREEN_ID}"] [data-slot="bash-report-strip"]`;
const UNATTACHED = '[data-slot="session-jobs-popover-unattached"]';
const DARK_CALL = '[data-slot="session-jobs-popover-dark-call"]';

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

function shown(card: BodyApp, selector: string): Promise<boolean> {
  return card.evalJS<boolean>(
    `(function () { const el = document.querySelector(${JSON.stringify(selector)}); return el !== null && getComputedStyle(el).display !== "none"; })()`,
  );
}

function text(card: BodyApp, selector: string): Promise<string | null> {
  return card.evalJS<string | null>(
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
        // The Session card is a body: its DOM lives in the card's own page,
        // so every read, wait and click below goes there.
        const card = app.body("A");

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
          type: "report",
          tool_use_id: USE_ID,
          label: "rust",
          text: "compiling tugcast",
          done: 3,
          total: 10,
        });

        await card.waitForCondition<boolean>(
          `!!document.querySelector(${JSON.stringify(BAND)})`,
          { timeoutMs: 10_000 },
        );
        expect(
          await card.evalJS<string | null>(
            `(document.querySelector(${JSON.stringify(BLOCK)}) || { getAttribute: () => null }).getAttribute("data-block-collapsed")`,
          ),
          "a shell block mounts collapsed, and the band reads anyway",
        ).toBe("true");
        expect(await text(card, BAND)).toContain("rust · 3/10 · compiling tugcast");

        // The engine's reading, not the local clock since the replayed
        // start: 125 s at the heartbeat, carried forward.
        const elapsed = (await text(card, ELAPSED)) ?? "";
        const m = /(\d+)m (\d+)s/.exec(elapsed);
        expect(m, `elapsed reads ${JSON.stringify(elapsed)}`).not.toBeNull();
        expect(Number(m![1]) * 60 + Number(m![2])).toBeGreaterThanOrEqual(125);
        expect(
          await card.evalJS<string | null>(
            `(document.querySelector(${JSON.stringify(ELAPSED)}) || { getAttribute: () => null }).getAttribute("data-engine")`,
          ),
        ).toBe("live");

        await frame(app, {
          type: "tool_result",
          tool_use_id: USE_ID,
          is_error: false,
          output: "ok",
        });
        await card.waitForCondition<boolean>(
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
          type: "report",
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
        await card.waitForCondition<boolean>(`!!document.querySelector(${JSON.stringify(RUN_PANEL)})`, {
          timeoutMs: 10_000,
        });
        expect(
          await card.evalJS<string | null>(
            `(document.querySelector(${JSON.stringify(RUN_BLOCK)}) || { getAttribute: () => null }).getAttribute("data-block-collapsed")`,
          ),
          "the running panel reads while the block is collapsed",
        ).toBe("true");
        expect(await count(card, `${RUN_PANEL} .tug-report-panel-cell`), "a cell per file").toBe(4);
        expect(await count(card, `${RUN_PANEL} .tug-report-panel-cell[data-status="fail"]`)).toBe(1);
        expect(await count(card, `${RUN_PANEL} [data-slot="tug-report-panel-lane"]`), "one file in flight").toBe(1);
        // The build reported its phases under its own label on the same call:
        // they ride above the files as one panel, the phase band first, and
        // the phase still marked running has landed now the files run.
        await frame(app, {
          type: "report",
          tool_use_id: RUN_ID,
          label: "build-app",
          text: "sign",
          done: 1,
          total: 2,
          unit: "phase",
          units: [
            { name: "Xcode build", status: "pass", index: 0, secs: 48 },
            { name: "sign", status: "running", index: 1, started_at_ms: Date.now() - 30_000 },
          ],
        });
        const PHASES = `${RUN_PANEL} [data-slot="tug-report-panel-phases"]`;
        await card.waitForCondition<boolean>(`!!document.querySelector(${JSON.stringify(PHASES)})`, {
          timeoutMs: 10_000,
        });
        expect(await text(card, PHASES)).toContain("Xcode build");
        expect(
          await card.evalJS<boolean>(
            `(function () { const p = document.querySelector(${JSON.stringify(PHASES)}); const t = document.querySelector(${JSON.stringify(`${RUN_PANEL} [data-slot="tug-report-panel-track"]`)}); return !!p && !!t && !!(p.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING); })()`,
          ),
          "the phase band comes before the files' track",
        ).toBe(true);
        expect(await count(card, `${RUN_PANEL} .tug-report-panel-cell`), "still a cell per file").toBe(4);
        // The bar carries no pace mark: a tick marching across it read as a stray cursor.
        expect(await count(card, `${RUN_PANEL} [data-slot="tug-report-panel-pace"]`), "no pace mark").toBe(0);
        // The projection is an elapsed reading: with no new report it still
        // counts down, because the running panel reads the shared 1 Hz tick.
        const PROJECTION = `${RUN_PANEL} .tug-report-panel-projection`;
        const projected = await text(card, PROJECTION);
        expect(projected, "a projection from the recorded medians").toContain("left");
        await card.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(PROJECTION)}) || { textContent: "" }).textContent !== ${JSON.stringify(projected)}`,
          { timeoutMs: 5_000 },
        );
        // Between units the panel holds still: the file that just landed
        // keeps its row, wearing its mark, until another file takes it, and
        // the panel is the height it was.
        const panelHeight = (): Promise<number> =>
          card.evalJS<number>(
            `document.querySelector(${JSON.stringify(RUN_PANEL)}).getBoundingClientRect().height`,
          );
        const heightBefore = await panelHeight();
        await frame(app, {
          type: "report",
          tool_use_id: RUN_ID,
          label: "app-test",
          text: "at0352 PASS 9s",
          done: 3,
          total: 4,
          failures: 1,
          unit: "file",
          jobs: 2,
          units: [
            { name: "at0310-file-view-open", status: "pass", index: 0, passed: 2, total: 2, secs: 5, median: 5 },
            { name: "at0339-composer-order-census", status: "fail", index: 1, passed: 1, total: 2, secs: 14,
              median: 9, title: "composer clears after send", message: "data-empty wait timed out" },
            { name: "at0352-pane-split-restore", status: "pass", index: 2, secs: 9, median: 11 },
            { name: "at0360-session-identity-menu", status: "pending", index: 3, median: 7 },
          ],
        });
        await card.waitForCondition<boolean>(
          `!!document.querySelector(${JSON.stringify(`${RUN_PANEL} [data-slot="tug-report-panel-lane"][data-status="pass"]`)})`,
          { timeoutMs: 10_000 },
        );
        expect(await count(card, `${RUN_PANEL} [data-slot="tug-report-panel-lane"]`), "the row stands between files").toBe(1);
        expect(await text(card, `${RUN_PANEL} [data-slot="tug-report-panel-lane"]`)).toContain("at0352-pane-split-restore");
        expect(await panelHeight(), "nothing in the panel moved").toBe(heightBefore);
        expect(await text(card, `${RUN_PANEL} [data-slot="tug-report-panel-fraction"]`)).toContain("files");
        expect(await text(card, `${RUN_PANEL} [data-slot="tug-report-panel-red"]`)).toContain("composer clears after send");
        expect(await count(card, `${RUN_BLOCK} [data-slot="bash-live-band"]`), "no one-line band beside it").toBe(0);

        // A file the recipe stopped at its cap lands `stalled`, a red of its
        // own kind, and the panel says STALLED.
        await frame(app, {
          type: "report",
          tool_use_id: RUN_ID,
          label: "app-test",
          text: "at0352 STALLED",
          done: 3,
          total: 4,
          failures: 2,
          unit: "file",
          jobs: 2,
          units: [
            { name: "at0310-file-view-open", status: "pass", index: 0, passed: 2, total: 2, secs: 5, median: 5 },
            { name: "at0339-composer-order-census", status: "fail", index: 1, passed: 1, total: 2, secs: 14,
              median: 9, title: "composer clears after send", message: "data-empty wait timed out" },
            { name: "at0352-pane-split-restore", status: "stalled", index: 2, secs: 120, median: 11 },
            { name: "at0360-session-identity-menu", status: "pending", index: 3, median: 7 },
          ],
        });
        const STALLED_RED = `${RUN_PANEL} [data-slot="tug-report-panel-red"][data-status="stalled"]`;
        await card.waitForCondition<boolean>(`!!document.querySelector(${JSON.stringify(STALLED_RED)})`, {
          timeoutMs: 10_000,
        });
        expect(await text(card, STALLED_RED), "a stalled file is a red with its own word").toContain("STALLED");
        expect(await count(card, `${RUN_PANEL} .tug-report-panel-cell[data-status="stalled"]`)).toBe(1);

        await frame(app, {
          type: "report",
          tool_use_id: RUN_ID,
          label: "app-test",
          text: "2 passed, 1 failed, 1 stalled",
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
            { name: "at0352-pane-split-restore", status: "stalled", index: 2, secs: 120, median: 11,
              message: "stopped at its 120s cap" },
            { name: "at0360-session-identity-menu", status: "pass", index: 3, passed: 3, total: 3, secs: 7, median: 7,
              history: "red in the last 2 recorded runs" },
          ],
        });
        await frame(app, {
          type: "tool_result",
          tool_use_id: RUN_ID,
          is_error: true,
          output: "Exit code 1\nVERDICT: FAIL  (2/4 files green)",
        });
        await card.waitForCondition<boolean>(`!!document.querySelector(${JSON.stringify(RUN_STRIP)})`, {
          timeoutMs: 10_000,
        });
        expect(await shown(card, RUN_STRIP), "collapsed, the settled run is its strip").toBe(true);
        expect(await text(card, RUN_STRIP)).toContain("FAIL");
        expect(
          await count(card, `${RUN_STRIP} .tug-report-panel-cell`),
          "the strip opens on the panel's own track, a cell per file",
        ).toBe(4);
        // A red run's strip carries the failure detail: the most recent red
        // open, the earlier one folded under it.
        expect(await count(card, `${RUN_STRIP} [data-slot="tug-report-panel-red"]`), "the latest red, open").toBe(1);
        expect(await text(card, `${RUN_STRIP} [data-slot="tug-report-panel-red"]`)).toContain("stopped at its 120s cap");
        expect(await text(card, `${RUN_STRIP} .tug-report-panel-earlier-reds`)).toContain("Earlier failures1");
        expect(await count(card, `${RUN_BLOCK} [data-slot="tool-block-notice"]`), "the strip, not the error band").toBe(0);

        await card.click(`${RUN_BLOCK} [data-slot="tool-call-header-disclosure"]`);
        await card.waitForCondition<boolean>(
          `!!document.querySelector(${JSON.stringify(`${RUN_PANEL}[data-state="finished"]`)})`,
          { timeoutMs: 10_000 },
        );
        expect(await text(card, `${RUN_PANEL} [data-slot="tug-report-panel-verdict"]`)).toContain(
          "1 of 4 files failed, 1 stalled · 1 recovered",
        );
        // A red verdict names where the reds are, so nobody re-runs to see them.
        expect(await text(card, `${RUN_PANEL} [data-slot="tug-report-panel-next"]`)).toBe("see the Failures section");
        // A green file the record had red stands open as a recovery, with its history.
        const RECOVERED = `${RUN_PANEL} [data-slot="tug-report-panel-recovered"]`;
        expect(await text(card, RECOVERED)).toContain("at0360-session-identity-menu");
        expect(await text(card, RECOVERED)).toContain("recovered");
        expect(await text(card, RECOVERED)).toContain("red in the last 2 recorded runs");
        // Only the most recent red stands open; the earlier one is folded
        // under it, a tap away.
        expect(await count(card, `${RUN_PANEL} [data-slot="tug-report-panel-red"]`), "one red open").toBe(1);
        expect(await text(card, `${RUN_PANEL} [data-slot="tug-report-panel-red"]`)).toContain("at0352-pane-split-restore");
        const EARLIER = `${RUN_PANEL} .tug-report-panel-earlier-reds`;
        expect(await text(card, EARLIER)).toContain("Earlier failures1");
        await card.click(`${EARLIER} .tug-accordion-trigger`);
        await card.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(`${RUN_PANEL} [data-slot="tug-report-panel-red"]`)}).length === 2`,
          { timeoutMs: 5_000 },
        );
        expect(await text(card, `${EARLIER} [data-slot="tug-report-panel-red"]`)).toContain("red in the last 7 recorded runs");
        expect(await text(card, `${RUN_PANEL} .tug-report-panel-folds:not(.tug-report-panel-earlier-reds)`), "the output is a fold at the foot").toContain("Output");
        expect(await shown(card, RUN_STRIP), "expanded, the panel says what the strip did").toBe(false);

        // A run that ends green folds to one line: the masthead, count and
        // time, with no track and no reds under it.
        await frame(app, {
          type: "tool_use",
          msg_id: `${SID}-m3`,
          tool_use_id: GREEN_ID,
          tool_name: "Bash",
          input: { command: "just app-test at0310 at0360" },
          seq: 3,
        });
        await frame(app, {
          type: "report",
          tool_use_id: GREEN_ID,
          label: "app-test",
          text: "2 passed",
          done: 2,
          total: 2,
          unit: "file",
          units: [
            { name: "at0310-file-view-open", status: "pass", index: 0, passed: 2, total: 2, secs: 5, median: 5 },
            { name: "at0360-session-identity-menu", status: "pass", index: 1, passed: 3, total: 3, secs: 7, median: 7 },
          ],
        });
        await frame(app, { type: "tool_result", tool_use_id: GREEN_ID, is_error: false, output: "VERDICT: PASS" });
        await card.waitForCondition<boolean>(`!!document.querySelector(${JSON.stringify(GREEN_STRIP)})`, {
          timeoutMs: 10_000,
        });
        expect(await text(card, GREEN_STRIP)).toContain("PASS");
        expect(await count(card, `${GREEN_STRIP} .tug-report-panel-cell`), "a green strip keeps its completed track").toBe(2);
        expect(await count(card, `${GREEN_STRIP} [data-slot="tug-report-panel-red"]`)).toBe(0);

        // The gaps record answers through tugcast's own route.
        await card.evalJS<boolean>(
          `(function () {
            window.__at0707Route = null;
            fetch("/api/report-gaps?session=${SID}")
              .then((r) => r.json())
              .then((b) => { window.__at0707Route = b.status + ":" + Array.isArray(b.gaps); },
                    (e) => { window.__at0707Route = "error:" + e; });
            return true;
          })()`,
        );
        await card.waitForCondition<boolean>("window.__at0707Route !== null", { timeoutMs: 10_000 });
        expect(await card.evalJS<string>("window.__at0707Route"), "the route reads the record").toBe("ok:true");
        // This harness made no long call, so the record is empty: the page's
        // read of the route is answered with one dark call, to draw its row.
        await card.evalJS<boolean>(
          `(function () {
            const real = window.fetch;
            window.fetch = function (input, init) {
              const url = typeof input === "string" ? input : input.url;
              if (url.startsWith("/api/report-gaps")) {
                const body = { status: "ok", gaps: [{ head: "cargo nextest", wallMs: 95000, endedAtMs: Date.now() }] };
                return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
              }
              return real.call(this, input, init);
            };
            return true;
          })()`,
        );

        // A report no call claimed: the card's line, on the JOBS placard.
        await frame(app, {
          type: "report",
          tool_use_id: null,
          label: "app-test",
          text: "at0603 PASS",
          done: 7,
          total: 20,
          unattached: "no open run",
        });
        await card.evalJS<boolean>(
          `(function () { const c = document.querySelector(${JSON.stringify(JOBS_CELL)}); if (c === null) return false; c.click(); return true; })()`,
        );
        await card.waitForCondition<boolean>(
          `!!document.querySelector(${JSON.stringify(LIVE_RUN)})`,
          { timeoutMs: 10_000 },
        );
        expect(await text(card, `${LIVE_RUN} [data-slot="session-jobs-popover-live-run-line"]`)).toBe(
          "app-test · 7/20 · at0603 PASS",
        );
        expect(await text(card, UNATTACHED), "a card-level report says it missed its block").toBe("unattached");
        expect(
          await card.evalJS<string | null>(`document.querySelector(${JSON.stringify(UNATTACHED)}).getAttribute("title")`),
          "on a test build the tag says why",
        ).toBe("no open run");
        await card.waitForCondition<boolean>(`!!document.querySelector(${JSON.stringify(DARK_CALL)})`, {
          timeoutMs: 10_000,
        });
        expect(await text(card, DARK_CALL)).toContain("cargo nextest");
        expect(await text(card, DARK_CALL)).toContain("no report");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
