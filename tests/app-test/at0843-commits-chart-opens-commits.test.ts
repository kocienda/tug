/**
 * at0843-commits-chart-opens-commits.test.ts — a bar of the `commits` recipe
 * opens the commits behind it.
 *
 * The chart is the real one: this worktree's built `tugtool chart commits`
 * is run in this checkout and its `TUG-CHART:` line is driven, verbatim, as
 * a Bash tool result on a card bound to this checkout, so the card's git
 * feed confirms the shas (the `at0526` footing). The day driven is one whose
 * slot is an **array** of 2 to 100 commits: a one-commit day is a single ref
 * with no report, and a day past 100 is a count form (`at0847` pages one).
 * The window is widened until such a day exists. The recipe stamps its
 * `source` on the spec, so the report asks the recipe for the day. Then:
 *
 *  - clicking that day's bar opens a report holding one History commit row
 *    per sha of the slot, in the slot's order, up to the first page of 25,
 *    under a title naming the day and the count;
 *  - an unfolded row's detail survives the figure announcing its hosts
 *    again, and no annotation host in the panel is filled twice: the report
 *    is its own component's, and the figure's collectors leave it alone;
 *  - the row's right-click menu raises a Commit card for that sha, with the
 *    panel still standing: a press in the menu is the menu's.
 *
 * @covers tugrust/crates/tugchart-core/src/commits.rs
 * @covers tugrust/crates/tugchart-core/src/refs.rs
 * @covers tugdeck/src/lib/chart/chart-ref-set.ts
 * @covers tugdeck/src/lib/chart/chart-report-store.ts
 * @covers tugdeck/src/components/tugways/chart-ref-report.tsx
 * @covers tugdeck/src/components/tugways/chart-report-portals.tsx
 * @covers tugdeck/src/lib/annotator/annotate-content.ts
 * @covers tugdeck/src/components/tugways/use-span-portals.tsx
 * @covers tugrust/crates/tugcast/src/chart_report.rs
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { kindBody } from "./_harness/card-reach";
import { sessionCardShape } from "./_harness/shapes";
import { tugtoolPath } from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;
const FEED_CODE_OUTPUT = 0x40;

/** This repository — a real git repo whose commits the card's git feed confirms. */
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

const SID = "at0843-A";
const USE_ID = `${SID}-tc1`;
const BLOCK = `[data-slot="bash-tool-block"][data-tool-use-id="${USE_ID}"]`;
const CHART = `${BLOCK} [data-slot="bash-tool-block-charts"] .tugx-chart`;
const LIST = `${CHART} .tugx-chart-set-list`;
const ROW = `${LIST} [data-testid="session-history-commit"]`;
const MENU = '[data-slot="tug-editor-context-menu"]';
/** The first page of a report. */
const PAGE = 25;

/** How long the refs may take: a round trip to the git feed for up to 100 shas. */
const RESOLVE_MS = 30_000;

interface Picked {
  line: string;
  days: number;
  row: number;
  /** The day's label, as the chart's axis and its table write it. */
  label: string;
  shas: string[];
}

/**
 * The recipe's chart line, and a day whose slot is an array. The window
 * starts at a week and widens until one is found.
 */
function pickChart(): Picked {
  const bin = tugtoolPath(REPO_ROOT);
  for (const days of [7, 30, 90, 365]) {
    const out = Bun.spawnSync([bin, "chart", "commits", "--days", String(days)], { cwd: REPO_ROOT })
      .stdout.toString();
    const line = out.split("\n").find((l) => l.startsWith("TUG-CHART: "));
    if (line === undefined) continue;
    const spec = JSON.parse(line.slice("TUG-CHART: ".length)) as { refs?: unknown[]; categories?: string[] };
    const refs = spec.refs ?? [];
    // The newest such day: the right edge is what a reader reaches for.
    for (let row = refs.length - 1; row >= 0; row -= 1) {
      const slot = refs[row];
      if (Array.isArray(slot)) {
        return {
          line,
          days,
          row,
          label: spec.categories?.[row] ?? "",
          shas: slot.map((r) => String(r).slice("commit:".length)),
        };
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
  if (list === null) return { title: "", shas: [], detail: false, crowded: 0 };
  return {
    title: (list.querySelector(".tugx-chart-report-title") || {}).textContent || "",
    shas: Array.from(list.querySelectorAll('[data-testid="session-history-commit"]')).map(function (a) {
      return a.getAttribute("data-sha") || "";
    }),
    detail: list.querySelector(".tugx-commit-detail") !== null,
    crowded: Array.from(list.querySelectorAll("[data-tug-annotation]")).filter(function (host) {
      return host.childElementCount > 1;
    }).length
  };
})()`;

interface ListFacts {
  title: string;
  shas: string[];
  /** An unfolded row's detail is mounted. */
  detail: boolean;
  /** Annotation hosts in the panel holding more than one element: a host filled twice. */
  crowded: number;
}

/** Expression: count of deck cards with the given componentId. */
function countByComponent(componentId: string): string {
  return `window.tugdeck.diag.getDeckState().cards.filter(
    (c) => c.componentId === ${JSON.stringify(componentId)},
  ).length`;
}

describe.skipIf(!SHOULD_RUN)("AT0843: a commits bar opens the commits behind it", () => {
  test(
    "the recipe's chart reports a day's commits as History rows, and a row's menu opens its card",
    async () => {
      const picked = pickChart();
      note(`at0843 driving --days ${picked.days}, row ${picked.row} with ${picked.shas.length} commits`);
      const app = await launchTugApp({ testName: "at0843-commits-chart-opens-commits" });
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
        await frame(app, {
          type: "tool_result",
          tool_use_id: USE_ID,
          is_error: false,
          output: `${picked.line}\n`,
        });
        await frame(app, { type: "turn_complete", seq: 0, msg_id: `${SID}-m1`, result: "success" });

        const BAR = `${CHART} .tgh[data-row="${picked.row}"]`;
        await card.waitForCondition<boolean>(
          `(function(){ var c = document.querySelector(${JSON.stringify(CHART)}); return c !== null && c.getAttribute("data-tugx-chart-state") === "rendered" && document.querySelector(${JSON.stringify(BAR)}) !== null; })()`,
          { timeoutMs: 20_000 },
        );
        const isSet = await card.evalJS<boolean>(
          `document.querySelector(${JSON.stringify(BAR)}).hasAttribute("data-tugx-ref-set")`,
        );
        expect(isSet, "the day's bar carries its set").toBe(true);

        // The bar opens the day's commits, each a History row.
        const expected = picked.shas.slice(0, PAGE);
        await card.evalJS(click(BAR));
        await card.waitForCondition<boolean>(
          `(${LIST_JS}).shas.length === ${expected.length}`,
          { timeoutMs: RESOLVE_MS },
        );
        const opened = await card.evalJS<ListFacts>(LIST_JS);
        note(`at0843 report: ${JSON.stringify(opened.title)}, ${opened.shas.length} rows`);
        // The spec abbreviates a sha; a row carries the whole of it.
        const abbreviated = (shas: string[]): string[] => shas.map((sha, i) => sha.slice(0, expected[i]?.length ?? 0));
        expect(opened.shas.every((sha) => /^[0-9a-f]{40}$/.test(sha)), "each row carries a full sha").toBe(true);
        expect(abbreviated(opened.shas), "the report holds the slot's shas, in order").toEqual(expected);
        expect(opened.title, "the title names the day and the count").toBe(
          `${picked.label} · ${picked.shas.length} commits`,
        );

        // Unfold the first row, then have the figure announce its hosts again,
        // as a verdict landing does. The detail is the report's own: it stays
        // mounted, and no host in the panel gains a second pill.
        await card.evalJS(click(`${ROW} .tug-history-list-row-hit`));
        await card.waitForCondition<boolean>(`(${LIST_JS}).detail`, { timeoutMs: RESOLVE_MS });
        await card.evalJS(`(function(){
          var figure = document.querySelector(${JSON.stringify(CHART)});
          figure.dispatchEvent(new CustomEvent("tugx-chart-annotated", { bubbles: true }));
          window.__at0843Turned = false;
          setTimeout(function () { window.__at0843Turned = true; }, 250);
          return true;
        })()`);
        // The collectors run in the event; a later turn of the page lets any
        // portal they would have mounted commit before the panel is read.
        await card.waitForCondition<boolean>(`window.__at0843Turned === true`, { timeoutMs: 5_000 });
        const after = await card.evalJS<ListFacts>(LIST_JS);
        expect(after.detail, "the unfolded detail survives the figure's pass").toBe(true);
        expect(after.crowded, "no annotation host in the panel was filled twice").toBe(0);
        expect(after.shas, "and the rows are the rows").toEqual(opened.shas);

        // A row's own menu raises the commit's card, and the press in the
        // menu does not close the panel out from under it. The row is folded
        // again first, since its detail pushes every other row below the
        // panel's clip. The fourth row is the one pressed: in a card this
        // short the panel fills the transcript's whole scrollport, and the
        // rows at its top stand under the card's pinned header.
        const PRESSED = 3;
        const STAMP = `${LIST} .tugx-chart-report-row:nth-child(${PRESSED + 1}) .tugx-commit-stamp`;
        await card.evalJS(click(`${ROW} .tug-history-list-row-hit`));
        await card.waitForCondition<boolean>(`!(${LIST_JS}).detail`, { timeoutMs: RESOLVE_MS });
        expect(await app.evalJS<number>(countByComponent("commit"))).toBe(0);
        // Where the press will land, and what stands there: the stamp has to
        // be the topmost thing at its own centre for the press to be the row's.
        const aim = await card.evalJS<string>(`(function(){
          var stamp = document.querySelector(${JSON.stringify(STAMP)});
          var panel = document.querySelector(${JSON.stringify(LIST)});
          var s = stamp.getBoundingClientRect();
          var p = panel.getBoundingClientRect();
          var top = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2);
          var box = function (r) { return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
          return JSON.stringify({
            stamp: box(s),
            panel: box(p),
            viewport: [window.innerWidth, window.innerHeight],
            top: top === null ? null : (top.className && top.className.baseVal !== undefined ? top.className.baseVal : top.className) + " <" + top.tagName + ">",
            inStamp: top !== null && stamp.contains(top)
          });
        })()`);
        note(`at0843 aim: ${aim}`);
        expect((JSON.parse(aim) as { inStamp: boolean }).inStamp, "the stamp is the topmost thing where the press lands").toBe(true);
        await card.nativeRightClickAtElement(STAMP);
        await card.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(MENU)}) !== null`, {
          timeoutMs: 8_000,
        });
        const menus = await card.evalJS<string[][]>(`Array.prototype.map.call(
          document.querySelectorAll(${JSON.stringify(MENU)}),
          function (menu) {
            return Array.prototype.map.call(menu.querySelectorAll('[role="menuitem"]'), function (item) {
              return item.getAttribute("data-item-action") || "";
            });
          })`);
        note(`at0843 menus over the row: ${JSON.stringify(menus)}`);
        expect(menus.length, "one menu answers the press").toBe(1);
        expect(menus[0], "and it is the commit's own, led by its card").toContain("open-commit");
        await card.nativeClickAtElement(`${MENU} [data-item-action="open-commit"]`);
        await app.waitForCondition<boolean>(`${countByComponent("commit")} === 1`, { timeoutMs: 15_000 });
        const masthead = await kindBody(app, "commit").waitForCondition<string>(
          `(() => {
             const el = document.querySelector('[data-testid="commit-masthead"]');
             const text = el === null ? "" : el.innerText.replace(/\\s+/g, " ").trim();
             return text === "" ? false : text;
           })()`,
          { timeoutMs: 15_000 },
        );
        note(`at0843 commit card masthead: ${JSON.stringify(masthead)}`);
        expect(masthead, "the card is the pressed row's commit").toContain(picked.shas[PRESSED]!.slice(0, 7));
        expect(
          await card.evalJS<boolean>(`document.querySelector(${JSON.stringify(LIST)}) !== null`),
          "the panel is still standing after the menu's act",
        ).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
