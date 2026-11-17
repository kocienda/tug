/**
 * at0842-chart-refs-figure.test.ts — a chart's marks open what they name,
 * and a set opens a report.
 *
 * A ` ```tugchart ` fence in a streamed turn names, beside its three rows,
 * a file written to a temp directory, a sibling never written, and a
 * two-member set of this checkout's last two commits. The card is bound to
 * this checkout, so the card's git feed can confirm the shas. Then:
 *
 *  - The existing file's mark (its `.tgh` hit path) is stamped as a file
 *    reference and takes the pointer a link takes; its row's label rule is
 *    visible. The missing file's mark is unstamped and its rule hidden: the
 *    resolver is the gate, and nothing is tinted at rest.
 *  - The header's link glyph is visible, and pressing it shows the Table
 *    view through the Table toggle itself.
 *  - Hovering the file's mark raises the bubble with a foot reading
 *    `Open <basename>`: the words and the click agree.
 *  - Right-clicking the file's mark offers the file's own menu.
 *  - Clicking the set's mark opens a report inside the figure: the panel
 *    holds two History commit rows, one per member, in the set's order. The
 *    fence names no source, so the rows are the members described. Clicking
 *    a row's commit pill raises a Commit card; Escape closes the panel.
 *
 * @covers tugdeck/src/lib/chart/render-chart.ts
 * @covers tugdeck/src/lib/chart/chart-ref-set.ts
 * @covers tugdeck/src/lib/chart/chart-report-store.ts
 * @covers tugdeck/src/components/tugways/chart-ref-report.tsx
 * @covers tugdeck/src/components/tugways/chart-report-portals.tsx
 * @covers tugdeck/src/lib/chart/chart-figure-data.ts
 * @covers tugdeck/src/lib/chart/chart-hover.ts
 * @covers tugdeck/src/lib/chart/chart-table-refs.ts
 * @covers tugdeck/src/lib/annotator/chart-refs.ts
 * @covers tugdeck/src/lib/session-open.ts
 * @covers tugdeck/src/components/tugways/body-kinds/chart-block.css
 * @covers tugdeck/src/components/tugways/transcript-find-highlighter.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { note } from "./_harness";
import { kindBody } from "./_harness/card-reach";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import { SHOULD_RUN } from "./settle-frames-fixture";
import { CARD, CHART, launchWithCharts } from "./tugchart-fixture";

const TEST_NAME = "at0842-chart-refs-figure";

/** This repository — a real git repo whose last two commits the card's git feed confirms. */
const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const HEAD_SHA = execSync("git rev-parse HEAD", { cwd: REPO_ROOT }).toString().trim();
const PARENT_SHA = execSync("git rev-parse HEAD~1", { cwd: REPO_ROOT }).toString().trim();

/** How long the refs may take: `fs/stat` and a round trip to the git feed. */
const RESOLVE_MS = 20_000;

const REAL = "kookaburra.rs";
const MISSING = "never-written.rs";

/** The bubble, in whichever overlay root the card's page has. */
const TIP = ".tug-tooltip-content.tugx-chart-tip";
const LIST = `${CHART} .tugx-chart-set-list`;
const COMMIT_CARD = '[data-slot="commit-card"]';

let dir = "";
let realPath = "";
let missingPath = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), "at0842-")));
  realPath = join(dir, REAL);
  missingPath = join(dir, MISSING);
  writeFileSync(realPath, "fn kookaburra() {}\n", "utf8");
});
afterAll(() => {
  if (dir !== "" && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function spec(): unknown {
  return {
    tugchart: 1,
    form: "bar",
    title: "Lines changed by file",
    categories: [REAL, MISSING, "two commits"],
    series: [{ name: "lines", values: [12, 4, 30] }],
    refs: [`file:${realPath}`, `file:${missingPath}`, [`commit:${HEAD_SHA.slice(0, 12)}`, `commit:${PARENT_SHA.slice(0, 12)}`]],
  };
}

interface MarkFacts {
  annotation: string;
  cursor: string;
  rule: string;
  set: boolean;
}

interface FigureFacts {
  marks: MarkFacts[];
  linked: boolean;
  glyphShown: boolean;
  view: string;
}

const FIGURE_JS = `(function(){
  var fig = document.querySelector(${JSON.stringify(CHART)});
  if (fig === null) return null;
  var marks = [0, 1, 2].map(function (row) {
    var hit = fig.querySelector('.tgh[data-row="' + row + '"]');
    var rule = fig.querySelector('.tgl[data-row="' + row + '"]');
    return {
      annotation: hit === null ? "(no hit)" : (hit.getAttribute("data-tug-annotation") || ""),
      cursor: hit === null ? "" : getComputedStyle(hit).cursor,
      rule: rule === null ? "(no rule)" : getComputedStyle(rule).visibility,
      set: hit !== null && hit.hasAttribute("data-tugx-ref-set")
    };
  });
  var glyph = fig.querySelector(".tugx-chart-links");
  return {
    marks: marks,
    linked: fig.hasAttribute("data-tugx-chart-linked"),
    glyphShown: glyph !== null && getComputedStyle(glyph).display !== "none",
    view: fig.getAttribute("data-tugx-chart-view") || ""
  };
})()`;

const SETTLED_JS = `(function(){
  var f = ${FIGURE_JS};
  return f !== null && f.marks[0].annotation === "file-path" && f.linked;
})()`;

function enter(row: number): string {
  return `(function(){
    var hit = document.querySelector(${JSON.stringify(CHART)} + ' .tgh[data-row="${row}"]');
    var rect = hit.getBoundingClientRect();
    hit.dispatchEvent(new PointerEvent("pointerover", {
      bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
    }));
  })()`;
}

const LEAVE = `(function(){
  var body = document.querySelector(${JSON.stringify(CHART)} + " .tugx-chart-body");
  body.dispatchEvent(new PointerEvent("pointerleave", { bubbles: false }));
})()`;

function click(selector: string): string {
  return `(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return false;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    return true;
  })()`;
}

interface ListFacts {
  count: number;
  label: string;
  /** The report's title, as its head reads. */
  title: string;
  /** Each History row's sha, in order. */
  shas: string[];
  /** Every row carries the commit pill. */
  pills: boolean;
  noScan: boolean;
  /** Every row's box lies inside the panel's, and the panel's inside the figure's, which clips. */
  shown: boolean;
}

const REPORT_ROW = '[data-testid="session-history-commit"]';

const LIST_JS = `(function(){
  var lists = document.querySelectorAll(${JSON.stringify(LIST)});
  var list = lists[0] || null;
  var rows = list === null ? [] : Array.from(list.querySelectorAll(${JSON.stringify(REPORT_ROW)}));
  return {
    count: lists.length,
    label: list === null ? "" : (list.getAttribute("aria-label") || ""),
    title: list === null ? "" : ((list.querySelector(".tugx-chart-report-title") || {}).textContent || ""),
    noScan: list !== null && list.hasAttribute("data-tugx-no-scan"),
    shown: (function () {
      if (list === null) return false;
      var figure = list.closest(".tugx-chart");
      if (figure === null) return false;
      var f = figure.getBoundingClientRect();
      var l = list.getBoundingClientRect();
      var within = function (r, o) { return r.height > 0 && r.width > 0 && r.top >= o.top - 0.5 && r.bottom <= o.bottom + 0.5 && r.left >= o.left - 0.5 && r.right <= o.right + 0.5; };
      if (!within(l, f)) return false;
      return rows.every(function (a) { return within(a.getBoundingClientRect(), l); });
    })(),
    shas: rows.map(function (a) { return a.getAttribute("data-sha") || ""; }),
    pills: rows.every(function (a) { return a.querySelector(".commit-sha-text") !== null; })
  };
})()`;

/** Expression: count of deck cards with the given componentId. */
function countByComponent(componentId: string): string {
  return `window.tugdeck.diag.getDeckState().cards.filter(
    (c) => c.componentId === ${JSON.stringify(componentId)},
  ).length`;
}

describe.skipIf(!SHOULD_RUN)("at0842 — a chart's marks open what they name", () => {
  test(
    "a stamped mark links, its row's rule shows, the foot says the act, and a set lists its members",
    async () => {
      const { app, tugbankPath } = await launchWithCharts(TEST_NAME, [spec()], "tugchart", REPO_ROOT);
      const page = app.body(CARD);
      try {
        await page.waitForCondition<boolean>(SETTLED_JS, { timeoutMs: RESOLVE_MS });
        const facts = await page.evalJS<FigureFacts>(FIGURE_JS);
        note(`at0842 figure: ${JSON.stringify(facts)}`);

        const [real, missing, set] = facts.marks;
        expect(real.annotation, "the existing file's mark is a file reference").toBe("file-path");
        expect(real.cursor, "and takes the pointer a link takes").toBe("pointer");
        expect(real.rule, "its row's label rule is revealed").toBe("visible");
        expect(missing.annotation, "the missing file's mark is never a reference").toBe("");
        expect(missing.rule, "and its rule stays hidden").toBe("hidden");
        expect(set.set, "the set's mark is an actionable set").toBe(true);
        expect(set.cursor, "which takes the pointer too").toBe("pointer");
        expect(facts.glyphShown, "the header's link glyph is shown once a ref links").toBe(true);

        // The glyph shows the Table view through the Table toggle itself.
        await page.evalJS(click(`${CHART} .tugx-chart-links`));
        const after = await page.evalJS<FigureFacts>(FIGURE_JS);
        expect(after.view, "pressing the glyph shows the Table view").toBe("table");
        const pressed = await page.evalJS<string>(
          `document.querySelector(${JSON.stringify(CHART)} + " .tugx-chart-view-toggle").getAttribute("aria-pressed")`,
        );
        expect(pressed, "and the toggle's own state moved with it").toBe("true");
        await page.evalJS(click(`${CHART} .tugx-chart-view-toggle`));
        expect((await page.evalJS<FigureFacts>(FIGURE_JS)).view).toBe("chart");

        // The bubble's foot over the file's mark says what a press does.
        await page.evalJS(enter(0));
        await page.waitForCondition<boolean>(`document.querySelectorAll(${JSON.stringify(TIP)}).length === 1`, {
          timeoutMs: 5_000,
        });
        const foot = await page.evalJS<string>(
          `(document.querySelector(${JSON.stringify(TIP)} + " .tugx-chart-tip-foot") || {}).textContent || ""`,
        );
        note(`at0842 foot over the file mark: ${JSON.stringify(foot)}`);
        expect(foot, "the foot reads the act").toBe(`Open ${REAL}`);
        await page.evalJS(LEAVE);

        // A right-click on the mark offers the file's own menu. The mark is an
        // SVG path, which the harness's element-centre helper refuses, so its
        // centre is read here and the click posted at the point.
        const centre = await page.evalJS<{ x: number; y: number }>(`(function(){
          var r = document.querySelector(${JSON.stringify(CHART)} + ' .tgh[data-row="0"]').getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`);
        await page.nativeRightClick(centre);
        await page.waitForCondition<boolean>(
          `document.querySelector('[data-item-action="insert-into-prompt"]') !== null`,
          { timeoutMs: 4_000 },
        );
        const labels = JSON.parse(
          await page.evalJS<string>(
            `JSON.stringify(Array.prototype.map.call(
              document.querySelectorAll('[data-item-action]'),
              function(el){ return (el.textContent || '').trim(); },
            ))`,
          ),
        ) as string[];
        note(`at0842 mark menu: ${labels.join(" / ")}`);
        expect(labels, "the mark's menu is the file's").toContain("Open in Editor");
        await app.nativeKey("Escape");
        await page.waitForCondition<boolean>(`document.querySelector('[data-item-action]') === null`, {
          timeoutMs: 4_000,
        });

        // The set's mark opens a report of its members, each a History row.
        await page.evalJS(click(`${CHART} .tgh[data-row="2"]`));
        await page.waitForCondition<boolean>(
          `(function(){ var l = ${LIST_JS}; return l.shas.length === 2 && l.pills; })()`,
          { timeoutMs: RESOLVE_MS },
        );
        const list = await page.evalJS<ListFacts>(LIST_JS);
        note(`at0842 set list: ${JSON.stringify(list)}`);
        expect(list.count, "one list, inside the figure").toBe(1);
        expect(list.label).toBe("2 commits");
        expect(list.title, "the head says what the panel's label says").toBe("2 commits");
        expect(list.noScan, "the list is read only through its refs").toBe(true);
        expect(list.shown, "the list and its members are inside the figure's clip, not cut off by it").toBe(true);
        expect(list.shas, "the rows are the set's two commits, in the set's order").toEqual([HEAD_SHA, PARENT_SHA]);

        // Clicking a row's pill is the commit's own click: its card opens.
        expect(await app.evalJS<number>(countByComponent("commit"))).toBe(0);
        await page.evalJS(click(`${LIST} ${REPORT_ROW} .commit-sha-text`));
        await app.waitForCondition<boolean>(`${countByComponent("commit")} === 1`, { timeoutMs: 15_000 });
        await kindBody(app, "commit").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(COMMIT_CARD)}) !== null`,
          { timeoutMs: 15_000 },
        );

        // Escape closes the list.
        await page.evalJS(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
        await page.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(LIST)}) === null`, { timeoutMs: 4_000 });
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    300_000,
  );
});
