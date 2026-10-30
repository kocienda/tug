/**
 * at0771-data-visualization-sheet.test.ts — the Data Visualization sheet, from
 * its door to the composer.
 *
 * A scratch repository holds three commits made now and one uncommitted edit, and
 * a session card is bound to it. The sheet is opened from the real Session menu
 * row and this holds:
 *
 *  - The git recipes draw live, with no sample mark.
 *  - A recipe with nothing to draw over this repository shows its sample, marked,
 *    beside its summary.
 *  - A recipe whose read fails shows its sample, marked, beside the failure. The
 *    route is the one thing faked: the page's `fetch` answers one recipe with a
 *    body that does not parse, since no project makes one recipe fail on demand.
 *  - ⌃⌘V closes the sheet, and re-opening it keeps the results it held.
 *  - Draw closes the sheet and leaves `/tugplug:viz <recipe>` in the composer, with
 *    the caret there, unsent.
 *  - Every figure is drawn at its laid-out size beside its text at `xl`. In a slim
 *    card, where both do not fit, the row stacks: the text keeps a readable width
 *    and no figure runs past the sheet.
 *
 * @covers tugdeck/src/components/tugways/cards/data-visualization-sheet.tsx
 * @covers tugdeck/src/components/tugways/cards/data-visualization-sheet.css
 * @covers tugdeck/src/components/tugways/command-registry.ts
 * @covers tugdeck/src/lib/chart-recipes-store.ts
 * @covers tugapp/Sources/MenuBarBuilder.swift
 */

import { describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { launchTugApp, note } from "./_harness";
import { waitForBodyReady } from "./_harness/card-reach";
import { sessionCardShape } from "./_harness/shapes";
import { testTmpDir } from "./_harness/test-cleanup";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const SHEET = '[data-slot="tug-sheet"]';
const SHEET_TITLE = `${SHEET} .tug-sheet-title`;
const ROW = `${SHEET} [data-tugx-recipe]`;
const EDITOR = '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';
const SAMPLE_MARK = ".data-visualization-sheet-sample-mark";
const LINE = ".data-visualization-sheet-line";

const LIVE_RECIPE = "commits";
const FAILED_RECIPE = "commit-hours";

function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync(["git", "-c", "user.name=at0771", "-c", "user.email=at0771@example.com", ...args], { cwd });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

function scratchRepository(): string {
  const dir = realpathSync(testTmpDir("at0771-repo-"));
  git(dir, "init", "-q");
  const file = join(dir, "notes.txt");
  for (const line of ["one", "two", "three"]) {
    writeFileSync(file, `${line}\n`);
    git(dir, "add", "notes.txt");
    git(dir, "commit", "-q", "-m", `docs(notes): write ${line}`);
  }
  writeFileSync(file, "three\nfour\n");
  return dir;
}

/** The one faked answer: a body `response.json()` cannot parse. */
const FAIL_ONE_RECIPE = `(function(){
  var real = window.fetch;
  window.fetch = function (input, init) {
    if (String(input).indexOf(${JSON.stringify(`/api/chart/${FAILED_RECIPE}?`)}) === 0) {
      return Promise.resolve(new Response("not json", { status: 500 }));
    }
    return real.call(window, input, init);
  };
  return null;
})()`;

const SHEET_IS_UP = `(function(){ var e = document.querySelector(${JSON.stringify(SHEET_TITLE)}); return e !== null && e.textContent === "Data Visualization"; })()`;
const SHEET_IS_GONE = `document.querySelector(${JSON.stringify(SHEET)}) === null`;

const READ_ROWS = `Array.from(document.querySelectorAll(${JSON.stringify(ROW)})).map(function (row) {
  var line = row.querySelector(${JSON.stringify(LINE)});
  var figure = row.querySelector(".tugx-chart");
  return {
    name: row.getAttribute("data-tugx-recipe"),
    state: row.getAttribute("data-tugx-recipe-state"),
    sampled: row.querySelector(${JSON.stringify(SAMPLE_MARK)}) !== null,
    line: line === null ? "" : line.textContent,
    figure: figure === null ? null : figure.getAttribute("data-tugx-chart-state"),
  };
})`;

interface RowFacts {
  name: string;
  state: string;
  sampled: boolean;
  line: string;
  figure: string | null;
}

/** Every row has its answer and every figure has drawn. */
const ROWS_SETTLED = `(function(){
  var rows = ${READ_ROWS};
  return rows.length > 0 && rows.every(function (r) { return r.state !== "pending" && r.figure === "rendered"; });
})()`;

describe.skipIf(!SHOULD_RUN)("at0771 — the Data Visualization sheet", () => {
  test(
    "opens from the menu, draws live, sample and failed rows, closes on the chord, and Draw fills the composer",
    async () => {
      const repo = scratchRepository();
      const app = await launchTugApp({ testName: "at0771-data-visualization-sheet" });
      try {
        await app.seedDeckState({ state: sessionCardShape({ width: 1200, height: 800 }), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: "at0771-session", projectDir: repo });
        await app.awaitEngineReady("A");
        const body = await waitForBodyReady(app, "A");
        await body.evalJS<null>(FAIL_ONE_RECIPE);

        const performed = await app.performMenuItem("session.dataVisualization");
        expect(performed.found && performed.performed, "the Session menu row performs").toBe(true);
        await body.waitForCondition<boolean>(SHEET_IS_UP, { timeoutMs: 6000 });
        await body.waitForCondition<boolean>(ROWS_SETTLED, { timeoutMs: 12_000 });

        const rows = await body.evalJS<RowFacts[]>(READ_ROWS);
        note(`at0771 rows: ${JSON.stringify(rows.map((r) => [r.name, r.state, r.figure]))}`);
        const byName = new Map(rows.map((r) => [r.name, r]));

        const live = byName.get(LIVE_RECIPE);
        expect(live?.state).toBe("live");
        expect(live?.sampled).toBe(false);

        // At `xl` a figure is drawn at the size it was laid out at, not scaled.
        const scaled = await body.evalJS<string[]>(
          `Array.from(document.querySelectorAll(${JSON.stringify(`${ROW} .tugx-chart-svg`)})).filter(function (svg) {
            return Math.abs(svg.getBoundingClientRect().width - Number(svg.getAttribute("width"))) > 0.5;
          }).map(function (svg) { return svg.closest("[data-tugx-recipe]").getAttribute("data-tugx-recipe"); })`,
        );
        expect(scaled).toEqual([]);

        const failed = byName.get(FAILED_RECIPE);
        expect(failed?.state).toBe("failed");
        expect(failed?.sampled).toBe(true);
        expect(failed?.line).not.toBe("");

        const empty = rows.filter((r) => r.state === "no-data");
        expect(empty.length).toBeGreaterThan(0);
        for (const row of empty) {
          expect(row.sampled, `${row.name} is marked`).toBe(true);
          expect(row.line, `${row.name} says why`).not.toBe("");
        }

        // The chord puts it away, and re-opening keeps what it held while it re-reads.
        await app.nativeKey("v", ["ctrl", "cmd"]);
        await body.waitForCondition<boolean>(SHEET_IS_GONE, { timeoutMs: 6000 });
        await app.nativeKey("v", ["ctrl", "cmd"]);
        await body.waitForCondition<boolean>(SHEET_IS_UP, { timeoutMs: 6000 });
        const held = await body.evalJS<RowFacts[]>(READ_ROWS);
        expect(held.find((r) => r.name === LIVE_RECIPE)?.state).toBe("live");

        // Draw leaves the command in the composer, with the caret there, unsent.
        const draw = `${SHEET} [data-testid="data-visualization-draw-${LIVE_RECIPE}"]`;
        await body.evalJS<null>(`(document.querySelector(${JSON.stringify(draw)}).scrollIntoView({ block: "center" }), null)`);
        await body.nativeClickAtElement(draw);
        await body.waitForCondition<boolean>(SHEET_IS_GONE, { timeoutMs: 6000 });
        await body.waitForCondition<boolean>(
          `(function(){
            var ed = document.querySelector(${JSON.stringify(EDITOR)});
            return ed !== null && ed.querySelector("img[data-atom-label]") !== null && ed.contains(document.activeElement);
          })()`,
          { timeoutMs: 6000 },
        );
        const composer = await body.evalJS<{ label: string | null; text: string }>(
          `(function(){
            var ed = document.querySelector(${JSON.stringify(EDITOR)});
            return { label: ed.querySelector("img[data-atom-label]").getAttribute("data-atom-label"), text: ed.textContent };
          })()`,
        );
        expect(composer.label).toBe("tugplug:viz");
        expect(composer.text).toContain(LIVE_RECIPE);
      } finally {
        await app.close();
      }
    },
    120_000,
  );

  test(
    "a slim card stacks the row, so the text stays readable and no figure overflows",
    async () => {
      const repo = scratchRepository();
      const app = await launchTugApp({ testName: "at0771-data-visualization-slim" });
      try {
        await app.seedDeckState({ state: sessionCardShape({ width: 675, height: 680 }), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: "at0771-slim", projectDir: repo });
        await app.awaitEngineReady("A");
        const body = await waitForBodyReady(app, "A");

        await app.nativeKey("v", ["ctrl", "cmd"]);
        await body.waitForCondition<boolean>(SHEET_IS_UP, { timeoutMs: 6000 });
        await body.waitForCondition<boolean>(ROWS_SETTLED, { timeoutMs: 12_000 });

        const fit = await body.evalJS<{ text: number; over: number; scrolls: boolean }>(
          `(function(){
            var scroller = document.querySelector(${JSON.stringify(`${SHEET} .tug-sheet-scaffold-body`)});
            var right = scroller.getBoundingClientRect().right;
            var over = -Infinity;
            var text = Infinity;
            document.querySelectorAll(${JSON.stringify(ROW)}).forEach(function (row) {
              over = Math.max(over, row.querySelector(".data-visualization-sheet-figure").getBoundingClientRect().right - right);
              text = Math.min(text, row.querySelector(".data-visualization-sheet-text").getBoundingClientRect().width);
            });
            return { text: text, over: over, scrolls: scroller.scrollWidth > scroller.clientWidth };
          })()`,
        );
        expect(fit.text).toBeGreaterThan(300);
        expect(fit.over).toBeLessThanOrEqual(0);
        expect(fit.scrolls).toBe(false);
      } finally {
        await app.close();
      }
    },
    120_000,
  );
});
