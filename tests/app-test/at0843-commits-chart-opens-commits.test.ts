/**
 * at0843-commits-chart-opens-commits.test.ts — a bar of the `commits` recipe
 * opens the commits behind it.
 *
 * The chart is the real one: this worktree's built `tugtool chart commits`
 * is run in this checkout and its `TUG-CHART:` line is driven, verbatim, as
 * a Bash tool result on a card bound to this checkout, so the card's git
 * feed confirms the shas (the `at0526` footing). The day driven is one whose
 * slot is an **array** of 2 to 100 commits: a one-commit day is a single ref
 * with no list, and a day past 100 is a count form with no act. The window
 * is widened until such a day exists. Then:
 *
 *  - clicking that day's bar opens a list holding exactly the slot's shas,
 *    each a commit atom wearing the commit pill;
 *  - clicking one raises a Commit card for that sha.
 *
 * @covers tugrust/crates/tugchart-core/src/commits.rs
 * @covers tugrust/crates/tugchart-core/src/refs.rs
 * @covers tugdeck/src/lib/chart/chart-ref-set.ts
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
const COMMIT_CARD = '[data-slot="commit-card"]';

/** How long the refs may take: a round trip to the git feed for up to 100 shas. */
const RESOLVE_MS = 30_000;

interface Picked {
  line: string;
  days: number;
  row: number;
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
    const spec = JSON.parse(line.slice("TUG-CHART: ".length)) as { refs?: unknown[] };
    const refs = spec.refs ?? [];
    // The newest such day: the right edge is what a reader reaches for.
    for (let row = refs.length - 1; row >= 0; row -= 1) {
      const slot = refs[row];
      if (Array.isArray(slot)) {
        return { line, days, row, shas: slot.map((r) => String(r).slice("commit:".length)) };
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
  return list === null ? [] : Array.from(list.querySelectorAll(".tugx-chart-ref")).map(function (a) {
    return {
      ref: a.getAttribute("data-tugx-ref") || "",
      annotation: a.getAttribute("data-tug-annotation") || "",
      pill: a.querySelector('[data-slot="tug-commit-atom"]') !== null
    };
  });
})()`;

/** Expression: count of deck cards with the given componentId. */
function countByComponent(componentId: string): string {
  return `window.tugdeck.diag.getDeckState().cards.filter(
    (c) => c.componentId === ${JSON.stringify(componentId)},
  ).length`;
}

describe.skipIf(!SHOULD_RUN)("AT0843: a commits bar opens the commits behind it", () => {
  test(
    "the recipe's chart lists a day's commits as atoms, and one opens its card",
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

        // The bar opens the day's commits, every one a confirmed atom.
        await card.evalJS(click(BAR));
        await card.waitForCondition<boolean>(
          `(function(){ var rows = ${LIST_JS}; return rows.length === ${picked.shas.length} && rows.every(function (r) { return r.pill; }); })()`,
          { timeoutMs: RESOLVE_MS },
        );
        const rows = await card.evalJS<{ ref: string; annotation: string; pill: boolean }[]>(LIST_JS);
        note(`at0843 list: ${rows.length} rows, first ${JSON.stringify(rows[0])}`);
        expect(rows.map((r) => r.ref), "the list holds exactly the slot's shas, in order").toEqual(
          picked.shas.map((sha) => `commit:${sha}`),
        );
        expect(rows.every((r) => r.annotation === "commit-sha"), "each confirmed by the git feed").toBe(true);

        // One of them is the commit's own click: its card opens, for that sha.
        expect(await app.evalJS<number>(countByComponent("commit"))).toBe(0);
        await card.evalJS(click(`${LIST} .tugx-chart-ref`));
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
        expect(masthead, "the card is the clicked commit's").toContain(picked.shas[0]!.slice(0, 7));
        expect(await card.evalJS<boolean>(`document.querySelector(${JSON.stringify(COMMIT_CARD)}) === null`)).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
