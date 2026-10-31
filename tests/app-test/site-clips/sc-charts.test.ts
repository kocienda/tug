/**
 * sc-charts.test.ts — the site's data-visualization stills: charts in a Session
 * transcript, one mark under the pointer, and the Data Visualization sheet.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and its
 * one assertion is that the stills were written. Run by path, once per mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both site
 * variables are set.
 *
 * The scene: one Session card bound to a stub on this checkout, so the sheet's
 * recipes read this project. The stub's one turn carries the real output of
 * two recipes, read from `tugtool chart` when the driver runs: each message
 * is the recipe's summary line and its spec in a `tugchart` fence. The first
 * still is the transcript with a bar under the pointer; the second is the sheet,
 * opened on its chord, with every row settled.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { TUGCODE_TRANSCRIPT_SCHEMA_VERSION, type App } from "../_harness";
import { waitForBodyReady } from "../_harness/card-reach";
import { pollFor } from "../body-grounding/_frames";
import { stubDirectory } from "../streaming-stub-fixture";
import { elementRects, sessionDeck } from "./_components";
import { RUNS, launchForMode, outDirFor, stillTo } from "./_site-clips";

const TEST_TIMEOUT_MS = 180_000;
const CARD = "sc-charts";
const IPC_VERSION = 2;
const REPO = resolve(import.meta.dir, "../../..");
const CONTENT_SIZE = { width: 1120, height: 1420 };
const PROMPT = "How has work on Tug gone this month?";
const BOUND = `document.querySelector('[data-testid="session-card-transcript"]') !== null && document.querySelector(".session-card-picker-form") === null`;

const CHART = ".tugx-chart";
const TRANSCRIPT = '[data-testid="session-card-transcript"]';
const CHART_FOOT = 14;
const TIP = ".tug-tooltip-content.tugx-chart-tip";
const SHEET = '[data-slot="tug-sheet"]';
const ROW = `${SHEET} [data-tugx-recipe]`;
/** The bar the pointer rests on, in the last chart. */
const HOVER_ROW = 6;

/** The recipes the turn draws, oldest message first, so the last is the one the transcript ends on. */
const RECIPES: readonly (readonly string[])[] = [
  ["hotspots", "--days", "30", "--depth", "2", "--limit", "5"],
  ["commits", "--days", "14"],
];

/** One recipe's real answer: `tugtool chart <recipe> --json`, as one message of prose and a fence. */
function recipeMessage(args: readonly string[]): string {
  const run = Bun.spawnSync(["tugtool", "chart", ...args, "--json"], { cwd: REPO });
  if (run.exitCode !== 0) throw new Error(`tugtool chart ${args.join(" ")}: ${run.stderr.toString()}`);
  const { data } = JSON.parse(run.stdout.toString()) as { data: { summary: string; spec: unknown } };
  return [data.summary, "", "```tugchart", JSON.stringify(data.spec), "```", ""].join("\n");
}

/** One turn of messages, each landing whole. */
function chartTurn(messages: readonly string[]): unknown {
  const outputs: unknown[] = [];
  messages.forEach((text, seq) => {
    const msg_id = `stub-sc-chart-${seq}`;
    outputs.push({ type: "content_block_start", msg_id, block_index: 0, kind: "text", ipc_version: IPC_VERSION });
    outputs.push({ type: "assistant_text", msg_id, block_index: 0, seq, rev: 0, text, is_partial: false, status: "complete", ipc_version: IPC_VERSION });
  });
  outputs.push({ type: "turn_complete", msg_id: `stub-sc-chart-${messages.length - 1}`, seq: messages.length, result: "success", ipc_version: IPC_VERSION });
  return { schemaVersion: TUGCODE_TRANSCRIPT_SCHEMA_VERSION, tugcodeVersion: "stub", paceMs: 25, turns: [{ index: 0, description: "two recipes over this project", outputs }] };
}

/** Size the window and hold until the page stands at that height, so both modes are cut alike. */
async function sizeWindow(app: App, size: { width: number; height: number }): Promise<void> {
  await pollFor(
    async () => {
      await app.setWindowContentSize(size);
      await Bun.sleep(300);
      return app.evalJS<number>(`window.innerHeight`);
    },
    (height) => height === size.height,
    15_000,
  );
  await Bun.sleep(700);
}

describe.skipIf(!RUNS)("site still: data visualizations", () => {
  test(
    "captures charts in the transcript and the Data Visualization sheet",
    async () => {
      const stubDir = stubDirectory();
      const tugSessionId = randomUUID();
      writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(chartTurn(RECIPES.map(recipeMessage))));
      const app = await launchForMode("sc-charts", sessionDeck(CARD, { width: 760, height: 1360 }), stubDir, { contentSize: CONTENT_SIZE });
      try {
        await sizeWindow(app, CONTENT_SIZE);
        await app.spawnSessionNew(CARD, { tugSessionId, projectDir: REPO });
        const body = await waitForBodyReady(app, CARD);
        await pollFor(() => body.evalJS<boolean>(BOUND).catch(() => false), (bound) => bound, 30_000);

        await body.driveSession({ op: "send", text: PROMPT });
        await body.waitForCondition<boolean>(
          `(function(){
            var charts = document.querySelectorAll(${JSON.stringify(CHART)});
            return charts.length === ${RECIPES.length} && Array.from(charts).every(function (c) { return c.getAttribute("data-tugx-chart-state") === "rendered"; });
          })()`,
          { timeoutMs: 45_000 },
        );
        await Bun.sleep(2_000);

        await body.evalJS<null>(`(function(){
          var charts = document.querySelectorAll(${JSON.stringify(CHART)});
          var hit = charts[charts.length - 1].querySelector('.tgh[data-row="${HOVER_ROW}"]');
          var rect = hit.getBoundingClientRect();
          hit.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
          return null;
        })()`);
        await body.waitForCondition<boolean>(`document.querySelectorAll(${JSON.stringify(TIP)}).length === 1`, { timeoutMs: 5_000 });
        await Bun.sleep(400);

        const column = await app.elementRect(CARD, TRANSCRIPT);
        expect(column, "the transcript is mounted").not.toBeNull();
        // The crop ends under the last chart, above the stub's turn footer.
        const last = (await elementRects(app, CARD, CHART)).at(-1)!;
        const crop = { ...column!, height: last.y + last.height + CHART_FOOT - column!.y };
        const transcript = await stillTo(app, crop, join(outDirFor("chart-transcript"), "still.png"));
        expect(transcript.scale, "the transcript still was taken").toBeGreaterThan(0);

        await body.evalJS<null>(`(function(){
          document.querySelectorAll(${JSON.stringify(`${CHART} .tugx-chart-body`)}).forEach(function (b) { b.dispatchEvent(new PointerEvent("pointerleave", { bubbles: false })); });
          return null;
        })()`);
        await app.nativeKey("v", ["ctrl", "cmd"]);
        await body.waitForCondition<boolean>(
          `(function(){
            var rows = Array.from(document.querySelectorAll(${JSON.stringify(ROW)}));
            return rows.length > 0 && rows.every(function (r) {
              var f = r.querySelector(${JSON.stringify(CHART)});
              return r.getAttribute("data-tugx-recipe-state") !== "pending" && f !== null && f.getAttribute("data-tugx-chart-state") === "rendered";
            });
          })()`,
          { timeoutMs: 45_000 },
        );
        await Bun.sleep(1_500);
        const panel = await app.elementRect(CARD, SHEET);
        expect(panel, "the sheet is mounted").not.toBeNull();
        // Cut to the transcript's proportions, so the two figures stand level on the page.
        const sheet = await stillTo(app, { ...panel!, height: Math.round((panel!.width * crop.height) / crop.width) }, join(outDirFor("chart-sheet"), "still.png"));
        expect(sheet.scale, "the sheet still was taken").toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
