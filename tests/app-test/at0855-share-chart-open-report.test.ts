/**
 * at0855-share-chart-open-report.test.ts — a shared turn shows its chart as
 * the reader left it: the pressed mark ringed, and its report beneath.
 *
 * A reader who presses a bar of a chart is reading the report under it, and
 * a share of that turn is a picture of what they were reading. The share
 * page has no connection and nobody to ask for a report's rows, so the
 * render document carries the open mark and the rows the card had read, and
 * the page seeds its own memories with them before it mounts.
 *
 * The chart is the real one, on the footing of `at0843`: this checkout's
 * built `tugtool chart commits` is run and its `TUG-CHART:` line driven as a
 * Bash tool result on a card bound to this checkout, and a day whose slot is
 * an array of 2 to 100 commits is pressed. Then the turn is rendered as a
 * PDF, and its HTML:
 *
 *  - carries the report's title, the day and its count, as the card shows it;
 *  - carries the sha of every commit row the card's report held;
 *  - carries no "Reading…" and no control that reads a further page: the
 *    page shows what it was given and asks nobody.
 *
 * A second render, after the card's report is closed, carries no report.
 *
 * @covers tugdeck/src/lib/chart/chart-share-state.ts
 * @covers tugdeck/src/lib/chart/chart-report-store.ts
 * @covers tugdeck/src/lib/chart/chart-ref-set.ts
 * @covers tugdeck/src/lib/chart/chart-open-memory.ts
 * @covers tugdeck/src/lib/chart/render-chart.ts
 * @covers tugdeck/src/lib/share-turns.ts
 * @covers tugdeck/src/share/share-main.ts
 * @covers tugdeck/src/share/share-root.tsx
 * @covers tugdeck/src/share/share-page.css
 * @covers tugdeck/src/components/tugways/chart-ref-report.tsx
 */

import { describe, expect, test } from "bun:test";
import { copyFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import { tugtoolPath } from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;
const FEED_CODE_OUTPUT = 0x40;

/** This repository — a real git repo whose commits the report reads. */
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

const SID = "at0855-A";
const USE_ID = `${SID}-tc1`;
const BLOCK = `[data-slot="bash-tool-block"][data-tool-use-id="${USE_ID}"]`;
const CHART = `${BLOCK} [data-slot="bash-tool-block-charts"] .tugx-chart`;
const LIST = `${CHART} .tugx-chart-set-list`;
/** The first page of a report. */
const PAGE = 25;
/** How long the report may take: one read of the recipe for the day. */
const RESOLVE_MS = 30_000;

interface Picked {
  line: string;
  days: number;
  row: number;
  label: string;
  count: number;
}

/** The recipe's chart line, and its newest day whose slot is an array of commits. */
function pickChart(): Picked {
  const bin = tugtoolPath(REPO_ROOT);
  for (const days of [7, 30, 90, 365]) {
    const out = Bun.spawnSync([bin, "chart", "commits", "--days", String(days)], { cwd: REPO_ROOT })
      .stdout.toString();
    const line = out.split("\n").find((l) => l.startsWith("TUG-CHART: "));
    if (line === undefined) continue;
    const spec = JSON.parse(line.slice("TUG-CHART: ".length)) as { refs?: unknown[]; categories?: string[] };
    const refs = spec.refs ?? [];
    for (let row = refs.length - 1; row >= 0; row -= 1) {
      const slot = refs[row];
      if (Array.isArray(slot)) {
        return { line, days, row, label: spec.categories?.[row] ?? "", count: slot.length };
      }
    }
  }
  throw new Error("no day in a year of this checkout's commits holds 2 to 100 commits");
}

function frame(app: App, decoded: Record<string, unknown>): Promise<unknown> {
  return app.driveSession("A", {
    op: "ingestFrame",
    feedId: FEED_CODE_OUTPUT,
    decoded: { tug_session_id: SID, ...decoded },
  });
}

function click(selector: string): string {
  return `(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return false;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    return true;
  })()`;
}

const LIST_JS = `(function(){
  var list = document.querySelector(${JSON.stringify(LIST)});
  if (list === null) return { title: "", shas: [] };
  return {
    title: (list.querySelector(".tugx-chart-report-title") || {}).textContent || "",
    shas: Array.from(list.querySelectorAll('[data-testid="session-history-commit"]')).map(function (a) {
      return a.getAttribute("data-sha") || "";
    })
  };
})()`;

interface ListFacts {
  title: string;
  shas: string[];
}

interface Rendered {
  result: "ok" | "failed";
  path: string;
  height: number;
  pages: number;
  html: string;
}

/** Render the card's turns and await the host's answer. */
async function render(app: App, format: "png" | "pdf"): Promise<Rendered> {
  const card = app.body("A");
  // `evalJS` cannot return a promise: start the render, park its answer, poll.
  await card.evalJS<null>(
    `(window.__at0855 = undefined,
      window.__tug.shareRender("A", ${JSON.stringify(format)}, "summaries").then(function (r) {
        window.__at0855 = JSON.stringify(r);
      }),
      null)`,
  );
  await card.waitForCondition<boolean>("window.__at0855 !== undefined", { timeoutMs: 20_000 });
  return JSON.parse(await card.evalJS<string>("window.__at0855")) as Rendered;
}

describe.skipIf(!SHOULD_RUN)("AT0855: a shared chart shows its open mark and the report under it", () => {
  test(
    "the share page draws the report the card had open, from the rows it had read",
    async () => {
      const picked = pickChart();
      note(`at0855 driving --days ${picked.days}, row ${picked.row} with ${picked.count} commits`);
      const app = await launchTugApp({ testName: "at0855-share-chart-open-report" });
      try {
        await app.seedDeckState({ state: sessionCardShape({ width: 900, height: 700 }), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // The binding is what gives the annotator a commit root: this repository.
        await app.bindSession("A", { tugSessionId: SID, projectDir: REPO_ROOT });
        const card = app.body("A");

        await app.driveSession("A", { op: "send", text: "chart the commits" });
        await frame(app, { type: "prompt_anchor", promptUuid: `${SID}-u1` });
        await frame(app, {
          type: "tool_use",
          msg_id: `${SID}-m1`,
          tool_use_id: USE_ID,
          tool_name: "Bash",
          input: { command: `tugtool chart commits --days ${picked.days}` },
          seq: 1,
        });
        await frame(app, { type: "tool_result", tool_use_id: USE_ID, is_error: false, output: `${picked.line}\n` });
        await frame(app, { type: "turn_complete", seq: 0, msg_id: `${SID}-m1`, result: "success" });

        const BAR = `${CHART} .tgh[data-row="${picked.row}"]`;
        await card.waitForCondition<boolean>(
          `(function(){ var c = document.querySelector(${JSON.stringify(CHART)}); return c !== null && c.getAttribute("data-tugx-chart-state") === "rendered" && document.querySelector(${JSON.stringify(BAR)}) !== null; })()`,
          { timeoutMs: 20_000 },
        );

        // Press the day's bar and let its first page land.
        const rows = Math.min(picked.count, PAGE);
        await card.evalJS(click(BAR));
        await card.waitForCondition<boolean>(`(${LIST_JS}).shas.length === ${rows}`, { timeoutMs: RESOLVE_MS });
        const opened = await card.evalJS<ListFacts>(LIST_JS);
        note(`at0855 card report: ${JSON.stringify(opened.title)}, ${opened.shas.length} rows`);
        expect(opened.title).toBe(`${picked.label} · ${picked.count} commits`);

        // ── The share carries the report ──────────────────────────────────
        const pdf = await render(app, "pdf");
        note(`at0855 pdf: ${JSON.stringify({ ...pdf, html: pdf.html.length })}`);
        expect(pdf.result, "the render answers ok").toBe("ok");
        expect(pdf.html, "the report's title is on the page").toContain(opened.title);
        for (const sha of opened.shas) {
          expect(pdf.html, `the report's row for ${sha.slice(0, 8)} is on the page`).toContain(sha.slice(0, 8));
        }
        expect(pdf.html, "the report is not still being read").not.toContain("Reading…");
        expect(pdf.html, "the page offers no further page to read").not.toMatch(/show \d+ more/);
        rmSync(pdf.path, { force: true });

        if (process.env.AT0855_KEEP !== undefined) {
          const image = await render(app, "png");
          copyFileSync(image.path, process.env.AT0855_KEEP);
          rmSync(image.path, { force: true });
        }

        // ── A closed report is not carried ────────────────────────────────
        await card.evalJS(click(BAR));
        await card.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(LIST)}) === null`, {
          timeoutMs: 6_000,
        });
        const closed = await render(app, "pdf");
        expect(closed.result).toBe("ok");
        expect(closed.html, "a chart with no open mark is shared with no report").not.toContain(opened.title);
        expect(closed.height, "and the page is shorter by the report").toBeLessThan(pdf.height);
        rmSync(closed.path, { force: true });
      } catch (err) {
        const lines = app
          .tugappLog()
          .split("\n")
          .filter((line) => /share|pageFault|fault/i.test(line));
        note(`at0855 tugapp.log share lines:\n${lines.slice(-40).join("\n")}`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
