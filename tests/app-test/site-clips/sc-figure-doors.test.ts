/**
 * sc-figure-doors.test.ts — the site's stills of what a figure opens: a chart
 * bar's report, a keyed table's file, and the two sheets that list what can
 * be drawn.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that the stills were written. Run by path in one mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both
 * site variables are set.
 *
 * The scene: one Session card bound to a stub on this checkout. The stub's
 * one turn carries the real `commits` recipe, read from `tugtool chart` when
 * the driver runs, and a diagram: the first `tugdiagram` fence of the session
 * named by `TUG_SITE_STORY_SESSION`, read through `tugtool session show` and
 * never continued. The stills, each under `$TUG_SITE_CLIPS_OUT/figure-doors/`:
 * the chart with a day's bar pressed and its commits listed, the window after
 * a keyed table's location is pressed, and the Visualize Data and Explain
 * Code sheets.
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
import { sessionDeck } from "./_components";
import { RUNS, launchForMode, outDirFor, stillTo } from "./_site-clips";

const TEST_TIMEOUT_MS = 240_000;
const CARD = "sc-figure-doors";
const IPC_VERSION = 2;
const REPO = resolve(import.meta.dir, "../../..");
const SESSION = process.env.TUG_SITE_STORY_SESSION;
/** The project the card is bound to: a copy of this checkout at a path fit to show, when one is named. */
const PROJECT = process.env.TUG_SITE_DOORS_PROJECT ?? REPO;
const CONTENT_SIZE = { width: Number(process.env.TUG_SITE_DOORS_WIDTH ?? 1120), height: 1240 };
const PROMPT = "Chart the recent commits, and explain the architecture.";
const BOUND = `document.querySelector('[data-testid="session-card-transcript"]') !== null && document.querySelector(".session-card-picker-form") === null`;

const FIGURE = ".tugx-chart";
const LIST = `${FIGURE} .tugx-chart-set-list`;
const COMMIT_ROW = `${LIST} [data-testid="session-history-commit"]`;
const WHERE = ".tugx-diagram-where [data-tug-annotation]";
const SHEET = '[data-slot="tug-sheet"]';
const OUT = "figure-doors";
/** The most commits a pressed day may list and still fit the still. */
const MOST = 9;

interface ChartSpec {
  refs?: unknown[];
  categories?: string[];
}

/** The recipe's spec, and the newest day whose bar lists 2 to {@link MOST} commits. */
function commitsChart(): { message: string; row: number } {
  const run = Bun.spawnSync(["tugtool", "chart", "commits", "--days", "14", "--json"], { cwd: REPO });
  if (run.exitCode !== 0) throw new Error(`tugtool chart commits: ${run.stderr.toString()}`);
  const { data } = JSON.parse(run.stdout.toString()) as { data: { summary: string; spec: ChartSpec } };
  const refs = data.spec.refs ?? [];
  let row = -1;
  for (let i = refs.length - 1; i >= 0; i -= 1) {
    const slot = refs[i];
    if (Array.isArray(slot) && slot.length >= 2 && slot.length <= MOST) {
      row = i;
      break;
    }
  }
  if (row < 0) throw new Error("no day in the window lists few enough commits");
  return { message: [data.summary, "", "```tugchart", JSON.stringify(data.spec), "```", ""].join("\n"), row };
}

/** The first diagram of the named session's first turn, as one message. */
function diagramMessage(): string {
  const run = Bun.spawnSync(["tugtool", "session", "show", SESSION!, "--turn", "1"], { cwd: REPO });
  if (run.exitCode !== 0) throw new Error(`tugtool session show: ${run.stderr.toString()}`);
  const fence = /```tugdiagram\n([\s\S]*?)\n```/.exec(run.stdout.toString());
  if (fence === null) throw new Error("the session's first turn holds no diagram");
  return ["```tugdiagram", fence[1], "```", ""].join("\n");
}

/** One turn of messages, each landing whole. */
function turn(messages: readonly string[]): unknown {
  const outputs: unknown[] = [];
  messages.forEach((text, seq) => {
    const msg_id = `stub-sc-doors-${seq}`;
    outputs.push({ type: "content_block_start", msg_id, block_index: 0, kind: "text", ipc_version: IPC_VERSION });
    outputs.push({ type: "assistant_text", msg_id, block_index: 0, seq, rev: 0, text, is_partial: false, status: "complete", ipc_version: IPC_VERSION });
  });
  outputs.push({ type: "turn_complete", msg_id: `stub-sc-doors-${messages.length - 1}`, seq: messages.length, result: "success", ipc_version: IPC_VERSION });
  return { schemaVersion: TUGCODE_TRANSCRIPT_SCHEMA_VERSION, tugcodeVersion: "stub", paceMs: 25, turns: [{ index: 0, description: "a chart and a diagram", outputs }] };
}

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

describe.skipIf(!RUNS || SESSION === undefined)("site still: what a figure opens", () => {
  test(
    "captures a bar's report, a keyed location's file, and the two sheets",
    async () => {
      const chart = commitsChart();
      const stubDir = stubDirectory();
      const tugSessionId = randomUUID();
      writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(turn([chart.message, diagramMessage()])));
      const app = await launchForMode("sc-figure-doors", sessionDeck(CARD, { width: 760, height: 1180 }), stubDir, { contentSize: CONTENT_SIZE });
      try {
        await sizeWindow(app, CONTENT_SIZE);
        await app.spawnSessionNew(CARD, { tugSessionId, projectDir: PROJECT });
        const body = await waitForBodyReady(app, CARD);
        await pollFor(() => body.evalJS<boolean>(BOUND).catch(() => false), (bound) => bound, 30_000);

        await body.driveSession({ op: "send", text: PROMPT });
        await body.waitForCondition<boolean>(
          `(function(){
            var figures = document.querySelectorAll(${JSON.stringify(FIGURE)});
            return figures.length === 2 && Array.from(figures).every(function (c) { return c.getAttribute("data-tugx-chart-state") === "rendered"; });
          })()`,
          { timeoutMs: 45_000 },
        );
        await Bun.sleep(2_000);
        const outDir = outDirFor(OUT);

        // A day's bar, pressed: the commits behind it, listed under the figure.
        await body.evalJS<null>(`(function(){
          var figure = document.querySelectorAll(${JSON.stringify(FIGURE)})[0];
          figure.setAttribute("data-sc-figure", "chart");
          figure.scrollIntoView({ block: "start" });
          figure.querySelector('.tgh[data-row="${chart.row}"]').dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
          return null;
        })()`);
        await body.waitForCondition<boolean>(`document.querySelectorAll(${JSON.stringify(COMMIT_ROW)}).length >= 2`, { timeoutMs: 30_000 });
        await body.evalJS<null>(`(document.querySelector('[data-sc-figure="chart"]').scrollIntoView({ block: "start" }), null)`);
        await Bun.sleep(1_500);
        const figure = await app.elementRect(CARD, '[data-sc-figure="chart"]');
        expect(figure, "the chart is mounted").not.toBeNull();
        expect((await stillTo(app, figure!, join(outDir, "chart-report.png"))).scale).toBeGreaterThan(0);

        // The two sheets, each opened on its chord over the card.
        for (const [key, name, row] of [
          ["v", "visualize-data-sheet", "[data-tugx-recipe]"],
          ["x", "explain-code-sheet", "[data-tugx-explain-form]"],
        ] as const) {
          await app.nativeKey(key, ["ctrl", "cmd"]);
          await body.waitForCondition<boolean>(
            `(function(){
              var rows = Array.from(document.querySelectorAll(${JSON.stringify(`${SHEET} ${row}`)}));
              return rows.length > 1 && rows.every(function (r) {
                var f = r.querySelector(${JSON.stringify(FIGURE)});
                return r.getAttribute("data-tugx-recipe-state") !== "pending" && (f === null ? r.getAttribute("data-tugx-explain-form") === "" : f.getAttribute("data-tugx-chart-state") === "rendered");
              });
            })()`,
            { timeoutMs: 45_000 },
          );
          await Bun.sleep(1_500);
          const panel = await app.elementRect(CARD, SHEET);
          expect(panel, `${name} is mounted`).not.toBeNull();
          expect((await stillTo(app, panel!, join(outDir, `${name}.png`))).scale).toBeGreaterThan(0);

          // The whole sheet, in slices a stitcher joins: its head, its scrolled body a pane at a time, its foot.
          const SCROLLER = `${SHEET} .tug-sheet-scaffold-body`;
          // A slice carries no scroll thumb: the joined picture is the sheet's content, not one moment of scrolling.
          await body.evalJS<null>(`(function(){ var s = document.createElement("style"); s.textContent = ".tug-sheet-scaffold-body::-webkit-scrollbar { display: none; }"; document.head.appendChild(s); return null; })()`);
          await Bun.sleep(300);
          const pane = await app.elementRect(CARD, SCROLLER);
          expect(pane, `${name} has a body`).not.toBeNull();
          const total = await body.evalJS<number>(`document.querySelector(${JSON.stringify(SCROLLER)}).scrollHeight`);
          const paneTop = Math.round(pane!.y);
          const paneHeight = Math.floor(pane!.y + pane!.height) - paneTop;
          const across = { x: panel!.x, width: panel!.width };
          await stillTo(app, { ...across, y: panel!.y, height: paneTop - panel!.y }, join(outDir, `${name}-part-00.png`));
          let part = 1;
          for (let want = 0; want < total; want += paneHeight, part += 1) {
            const at = await body.evalJS<number>(`(function(){ var s = document.querySelector(${JSON.stringify(SCROLLER)}); s.scrollTop = ${want}; return s.scrollTop; })()`);
            await Bun.sleep(700);
            const skip = want - Math.round(at);
            await stillTo(app, { ...across, y: paneTop + skip, height: Math.min(paneHeight - skip, total - want) }, join(outDir, `${name}-part-${String(part).padStart(2, "0")}.png`));
          }
          const footTop = paneTop + paneHeight;
          await stillTo(app, { ...across, y: footTop, height: panel!.y + panel!.height - footTop }, join(outDir, `${name}-part-99.png`));
          await app.nativeKey(key, ["ctrl", "cmd"]);
          await body.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(SHEET)}) === null`, { timeoutMs: 6_000 });
        }

        // A keyed table's location, pressed: the whole window, with whatever it opened.
        await body.evalJS<null>(`(function(){
          var where = document.querySelector(${JSON.stringify(WHERE)});
          where.setAttribute("data-sc-target", "");
          where.scrollIntoView({ block: "center" });
          return null;
        })()`);
        await Bun.sleep(800);
        expect((await stillTo(app, undefined, join(outDir, "diagram-before.png"))).scale).toBeGreaterThan(0);
        await body.nativeClickAtElement("[data-sc-target]");
        await Bun.sleep(4_000);
        expect((await stillTo(app, undefined, join(outDir, "diagram-open.png"))).scale).toBeGreaterThan(0);
        const cards = await app.evalJS<string>(`JSON.stringify(window.tugdeck.diag.getDeckState().cards.map(function (c) { return [c.id, c.componentId]; }))`);
        console.log(`sc-figure-doors cards after the press: ${cards}`);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
