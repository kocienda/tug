/**
 * at0849-chart-report-kinds.test.ts — a set of files, of links or of commands
 * opens a report whose rows are each kind's own.
 *
 * A ` ```tugchart ` fence in a streamed turn draws three bars, and each
 * bar's ref is a two-member set: two files (one tracked in this checkout,
 * one written to a temp directory), two links, and two commands. The card
 * is bound to this checkout, so there is somebody to ask. The fence names
 * no source, so each report is the set's members described. Then:
 *
 *  - Pressing a bar opens a panel of two report rows of the set's kind, and
 *    no row is the fallback list's pill.
 *  - A file's row is its path with a fold; a link's is its host and path,
 *    stamped as the link it is; a command's is its head in the code face.
 *  - Unfolding the tracked file's row mounts a nested report of the commits
 *    touching it, with History rows; unfolding the temp file's row, which no
 *    commit touches, says so. Folding a row unmounts its nested list.
 *
 * @covers tugdeck/src/components/tugways/chart-ref-report.tsx
 * @covers tugdeck/src/components/tugways/chart-ref-report.css
 * @covers tugdeck/src/lib/chart/chart-report-store.ts
 * @covers tugrust/crates/tugcast/src/chart_report.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { note } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import { SHOULD_RUN } from "./settle-frames-fixture";
import { CARD, CHART, launchWithCharts } from "./tugchart-fixture";

const TEST_NAME = "at0849-chart-report-kinds";

/** This repository: the project the report endpoint is asked about. */
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** A file this checkout tracks, named as a fence would: relative to the project. */
const TRACKED = "Justfile";
const LOOSE = "kookaburra.rs";

const URLS = ["https://www.example.com/docs/charts?tab=refs", "https://example.org"];
const COMMANDS = ["cargo build", "just never-a-recipe"];

/** How long one report may take: a describe read, or one page of a file's commits. */
const READ_MS = 8_000;

const LIST = `${CHART} .tugx-chart-set-list`;
const ROW = `${LIST} .tugx-chart-report-row`;

let dir = "";
let loosePath = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), "at0849-")));
  loosePath = join(dir, LOOSE);
  writeFileSync(loosePath, "fn kookaburra() {}\n", "utf8");
});
afterAll(() => {
  if (dir !== "" && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function spec(): unknown {
  return {
    tugchart: 1,
    form: "bar",
    title: "What each bar counted",
    categories: ["files", "links", "commands"],
    series: [{ name: "things", values: [2, 2, 2] }],
    refs: [
      [`file:${TRACKED}`, `file:${loosePath}`],
      URLS.map((url) => `url:${url}`),
      COMMANDS.map((command) => `command:${command}`),
    ],
  };
}

function click(selector: string): string {
  return `(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return false;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    return true;
  })()`;
}

interface PanelFacts {
  /** Each top-level row's kind, in order. */
  kinds: string[];
  found: string[];
  /** Each row's main cell's own text, the nested list left out. */
  texts: string[];
  /** The fallback list's pills in the panel. */
  pills: number;
  title: string;
  /** Each row's entity slot. */
  slots: string[];
  /** Each row's stamped annotation, or "". */
  annotations: string[];
  /** The code face on a row's head. */
  codes: number;
}

const PANEL_JS = `(function(){
  var list = document.querySelector(${JSON.stringify(LIST)});
  var rows = list === null ? [] : Array.from(list.querySelectorAll(".tugx-chart-report-row")).filter(function (row) {
    return row.closest(".tugx-chart-report-nested") === null;
  });
  var entity = function (row) { return row.querySelector(".tugx-chart-report-entity"); };
  return {
    kinds: rows.map(function (row) { return row.getAttribute("data-kind") || ""; }),
    found: rows.map(function (row) { return row.getAttribute("data-found") || ""; }),
    texts: rows.map(function (row) { var e = entity(row); return e === null ? "" : (e.textContent || "").trim(); }),
    pills: list === null ? 0 : list.querySelectorAll(".tugx-chart-ref").length,
    title: list === null ? "" : ((list.querySelector(".tugx-chart-report-title") || {}).textContent || ""),
    slots: rows.map(function (row) { var e = entity(row); return e === null ? "" : (e.getAttribute("data-slot") || ""); }),
    annotations: rows.map(function (row) {
      var a = row.querySelector(".tugx-chart-report-ref[data-tug-annotation]");
      return a === null ? "" : (a.getAttribute("data-tug-annotation") || "");
    }),
    codes: list === null ? 0 : list.querySelectorAll("code.tugx-chart-report-code").length
  };
})()`;

/** Press bar `row` and wait for a panel of two rows of `kind`. */
async function openSet(page: ReturnType<typeof pageOf>, row: number, kind: string): Promise<PanelFacts> {
  const mark = `${CHART} .tgh[data-row="${row}"][data-tugx-ref-set]`;
  await page.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(mark)}) !== null`, {
    timeoutMs: READ_MS,
  });
  await page.evalJS(click(mark));
  try {
    await page.waitForCondition<boolean>(
      `(function(){ var p = ${PANEL_JS}; return p.kinds.length === 2 && p.kinds[0] === ${JSON.stringify(kind)} && p.found[0] === "true"; })()`,
      { timeoutMs: READ_MS },
    );
  } catch (error) {
    const held = await page.evalJS<string>(
      `(function(){ var l = document.querySelector(${JSON.stringify(LIST)}); return l === null ? "no panel" : (l.textContent || "").slice(0, 400); })()`,
    );
    note(`at0849 panel at the miss on row ${row}: ${JSON.stringify(held)}`);
    throw error;
  }
  const facts = await page.evalJS<PanelFacts>(PANEL_JS);
  note(`at0849 row ${row}: ${JSON.stringify(facts)}`);
  return facts;
}

type Launched = Awaited<ReturnType<typeof launchWithCharts>>;
function pageOf(app: Launched["app"]) {
  return app.body(CARD);
}

/** The nested list under top-level row `n`: its History rows, its empty line, its foot. */
function nestedJs(n: number): string {
  return `(function(){
    var rows = Array.from(document.querySelectorAll(${JSON.stringify(ROW)})).filter(function (row) {
      return row.closest(".tugx-chart-report-nested") === null;
    });
    var nested = rows[${n}] === undefined ? null : rows[${n}].querySelector(".tugx-chart-report-nested");
    if (nested === null) return { mounted: false, commits: 0, empty: "", foot: "" };
    return {
      mounted: true,
      commits: nested.querySelectorAll('[data-testid="session-history-commit"]').length,
      empty: ((nested.querySelector('[data-slot="chart-report-empty"]') || {}).textContent || "").trim(),
      foot: ((nested.querySelector(".tugx-chart-report-more") || {}).textContent || "").trim()
    };
  })()`;
}

interface NestedFacts {
  mounted: boolean;
  commits: number;
  empty: string;
  foot: string;
}

/** Press the fold of top-level row `n`. */
function fold(n: number): string {
  return `(function(){
    var rows = Array.from(document.querySelectorAll(${JSON.stringify(ROW)})).filter(function (row) {
      return row.closest(".tugx-chart-report-nested") === null;
    });
    var cue = rows[${n}] === undefined ? null : rows[${n}].querySelector('[data-slot="chart-report-path-fold"]');
    if (cue === null) return false;
    var button = cue.matches("button") ? cue : (cue.querySelector("button") || cue);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    return true;
  })()`;
}

describe.skipIf(!SHOULD_RUN)("at0849 — a report's rows are each kind's own", () => {
  test(
    "files, links and commands each open two rows of their kind, and a file's row unfolds to its commits",
    async () => {
      const { app, tugbankPath } = await launchWithCharts(TEST_NAME, [spec()], "tugchart", REPO_ROOT);
      const page = pageOf(app);
      try {
        // Links: host and path, stamped as the link.
        const links = await openSet(page, 1, "url");
        expect(links.kinds).toEqual(["url", "url"]);
        expect(links.pills, "no row is the fallback list's pill").toBe(0);
        expect(links.title).toBe("2 links");
        expect(links.slots).toEqual(["chart-report-url", "chart-report-url"]);
        expect(links.annotations).toEqual(["url", "url"]);
        expect(links.texts).toEqual(["example.com/docs/charts?tab=refs", "example.org"]);

        // Commands: the head in the code face.
        const commands = await openSet(page, 2, "command");
        expect(commands.kinds).toEqual(["command", "command"]);
        expect(commands.pills).toBe(0);
        expect(commands.slots).toEqual(["chart-report-command", "chart-report-command"]);
        expect(commands.codes).toBe(2);
        expect(commands.texts[1], "a command nothing recorded is its head alone").toBe(COMMANDS[1]);
        expect(commands.texts[0].startsWith(COMMANDS[0])).toBe(true);

        // Files: the path, with a fold.
        const files = await openSet(page, 0, "file");
        expect(files.kinds).toEqual(["file", "file"]);
        expect(files.found).toEqual(["true", "true"]);
        expect(files.pills).toBe(0);
        expect(files.slots).toEqual(["chart-report-path", "chart-report-path"]);
        expect(files.annotations, "a file on disk is stamped as the file it is").toEqual(["file-path", "file-path"]);
        expect(files.texts[0]).toMatch(/^Justfile\s*\d+ commits/);

        // The tracked file unfolds to the commits touching it.
        expect(await page.evalJS<boolean>(fold(0))).toBe(true);
        await page.waitForCondition<boolean>(`(${nestedJs(0)}).commits > 0`, { timeoutMs: READ_MS });
        const tracked = await page.evalJS<NestedFacts>(nestedJs(0));
        note(`at0849 nested under ${TRACKED}: ${JSON.stringify(tracked)}`);
        expect(tracked.commits).toBeLessThanOrEqual(25);
        if (tracked.commits === 25) expect(tracked.foot).toMatch(/^25 of \d+ · show \d+ more$/);

        // The loose file is touched by no commit, and its list says so.
        expect(await page.evalJS<boolean>(fold(1))).toBe(true);
        await page.waitForCondition<boolean>(`(${nestedJs(1)}).empty !== ""`, { timeoutMs: READ_MS });
        const loose = await page.evalJS<NestedFacts>(nestedJs(1));
        expect(loose.empty).toBe("No commits");
        expect(loose.commits).toBe(0);

        // The outer panel still holds its two rows, whatever is nested in them.
        expect((await page.evalJS<PanelFacts>(PANEL_JS)).kinds).toEqual(["file", "file"]);

        // Folding unmounts the nested list.
        expect(await page.evalJS<boolean>(fold(0))).toBe(true);
        await page.waitForCondition<boolean>(`(${nestedJs(0)}).mounted === false`, { timeoutMs: 4_000 });
        expect((await page.evalJS<NestedFacts>(nestedJs(1))).mounted, "the other row's list stands").toBe(true);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    300_000,
  );
});
