/**
 * at0848-chart-report-measure.test.ts — a report of a measuring recipe shows
 * each member's share of the mark, and the set's sum.
 *
 * The chart is the real one: this worktree's built `tugtool chart churn` is
 * run in this checkout and its `TUG-CHART:` line is driven, verbatim, as a
 * Bash tool result on a card bound to this checkout (the `at0843` footing).
 * `churn` draws each day as a stacked bar, lines added above zero and lines
 * removed below, and measures each commit by the lines it changed, carrying
 * its added and removed lines apart. A day's hit carries the day's set
 * whichever segment is pressed, so pressing a day opens a report in which:
 *
 *  - every row ends in the commit's `+n −m`, the engine's own text;
 *  - the head carries the set's `+n −m` with its unit;
 *  - the measure rides the commit row's first line: its centre is the centre
 *    of the row's own trailing stamp.
 *
 * The day pressed is one with 2 to 25 commits, so the whole set is one page.
 * The window driven is a week.
 *
 * @covers tugdeck/src/components/tugways/chart-ref-report.tsx
 * @covers tugdeck/src/components/tugways/chart-ref-report.css
 * @covers tugdeck/src/lib/chart/chart-report-store.ts
 * @covers tugrust/crates/tugcast/src/chart_report.rs
 * @covers tugrust/crates/tugchart-core/src/members.rs
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import { tugtoolPath } from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;
const FEED_CODE_OUTPUT = 0x40;

/** This repository — a real git repo whose history the report endpoint reads. */
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

const SID = "at0848-A";
const USE_ID = `${SID}-tc1`;
const BLOCK = `[data-slot="bash-tool-block"][data-tool-use-id="${USE_ID}"]`;
const CHART = `${BLOCK} [data-slot="bash-tool-block-charts"] .tugx-chart`;
const LIST = `${CHART} .tugx-chart-set-list`;

/** How long the page may take: one run of the recipe over the window. */
const READ_MS = 8_000;

interface Picked {
  line: string;
  row: number;
  count: number;
}

/**
 * The recipe's chart line, and the latest day holding 2 to 25 commits. A week
 * is driven, not the recipe's default month: a month of this checkout is a
 * 12 KB line, and a driven frame that size does not settle in the harness.
 */
function pickChart(): Picked {
  const out = Bun.spawnSync([tugtoolPath(REPO_ROOT), "chart", "churn", "--days", "7"], { cwd: REPO_ROOT })
    .stdout.toString();
  const line = out.split("\n").find((l) => l.startsWith("TUG-CHART: "));
  if (line === undefined) throw new Error("chart churn drew nothing in this checkout");
  const spec = JSON.parse(line.slice("TUG-CHART: ".length)) as { refs?: unknown[] };
  const refs = spec.refs ?? [];
  for (let row = refs.length - 1; row >= 0; row -= 1) {
    const slot = refs[row];
    if (Array.isArray(slot) && slot.length >= 2 && slot.length <= 25) return { line, row, count: slot.length };
  }
  throw new Error("no day in this checkout's last week holds 2 to 25 commits");
}

function frame(app: App, decoded: Record<string, unknown>): Promise<unknown> {
  return app.driveSession("A", {
    op: "ingestFrame",
    feedId: FEED_CODE_OUTPUT,
    decoded: { tug_session_id: SID, ...decoded },
  });
}

interface MeasureFacts {
  rows: number;
  measures: string[];
  sum: string;
  /** Per row: the measure's centre minus the row's trailing stamp's centre, px. */
  offsets: number[];
  /** Per row: the measure's right edge minus the panel body's right edge, px. */
  rights: number[];
}

const FACTS_JS = `(function(){
  var list = document.querySelector(${JSON.stringify(LIST)});
  if (list === null) return { rows: 0, measures: [], sum: "", offsets: [], rights: [] };
  var body = list.querySelector(".tugx-chart-report-body");
  var edge = body === null ? 0 : body.getBoundingClientRect().right;
  var rows = Array.from(list.querySelectorAll(".tugx-chart-report-row"));
  var measures = [], offsets = [], rights = [];
  rows.forEach(function (row) {
    var cell = row.querySelector(".tugx-chart-report-measure");
    var stamp = row.querySelector(".tug-history-list-row-trailing");
    measures.push(cell === null ? "" : (cell.textContent || "").trim());
    if (cell !== null && stamp !== null) {
      var c = cell.getBoundingClientRect(), s = stamp.getBoundingClientRect();
      offsets.push((c.top + c.height / 2) - (s.top + s.height / 2));
      rights.push(c.right - edge);
    }
  });
  return {
    rows: list.querySelectorAll('[data-testid="session-history-commit"]').length,
    measures: measures,
    sum: ((list.querySelector(".tugx-chart-report-head .tugx-chart-report-sum") || {}).textContent || "").trim(),
    offsets: offsets,
    rights: rights
  };
})()`;

describe.skipIf(!SHOULD_RUN)("AT0848: a measuring recipe's report shows each member's share", () => {
  test(
    "a churn day opens rows that each end in their lines, under the day's sum",
    async () => {
      const picked = pickChart();
      note(`at0848 driving churn, row ${picked.row} with ${picked.count} commits`);
      const app = await launchTugApp({ testName: "at0848-chart-report-measure" });
      try {
        await app.seedDeckState({ state: sessionCardShape({ width: 900, height: 700 }), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // The binding is what gives the figure somebody to ask: this repository.
        await app.bindSession("A", { tugSessionId: SID, projectDir: REPO_ROOT });
        const card = app.body("A");

        await app.driveSession("A", { op: "send", text: "chart the churn" });
        await frame(app, { type: "prompt_anchor", promptUuid: `${SID}-u1` });
        await frame(app, {
          type: "tool_use",
          msg_id: `${SID}-m1`,
          tool_use_id: USE_ID,
          tool_name: "Bash",
          input: { command: "tugtool chart churn --days 7" },
          seq: 1,
        });
        await frame(app, { type: "tool_result", tool_use_id: USE_ID, is_error: false, output: `${picked.line}\n` });
        await frame(app, { type: "turn_complete", seq: 0, msg_id: `${SID}-m1`, result: "success" });

        const DAY = `${CHART} .tgh[data-row="${picked.row}"][data-tugx-ref-set]`;
        await card.waitForCondition<boolean>(
          `(function(){ var c = document.querySelector(${JSON.stringify(CHART)}); return c !== null && c.getAttribute("data-tugx-chart-state") === "rendered" && document.querySelector(${JSON.stringify(DAY)}) !== null; })()`,
          { timeoutMs: 6_000 },
        );

        await card.evalJS(`(function(){
          var el = document.querySelector(${JSON.stringify(DAY)});
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
          return true;
        })()`);
        try {
          await card.waitForCondition<boolean>(`(${FACTS_JS}).rows === ${picked.count}`, { timeoutMs: READ_MS });
        } catch (error) {
          // Say what the panel held, so a red names the read that went wrong.
          const held = await card.evalJS<string>(
            `(function(){ var l = document.querySelector(${JSON.stringify(LIST)}); return l === null ? "no panel" : (l.textContent || "").slice(0, 400); })()`,
          );
          note(`at0848 panel at the miss: ${JSON.stringify(held)}`);
          throw error;
        }
        const facts = await card.evalJS<MeasureFacts>(FACTS_JS);
        note(
          `at0848 sum ${JSON.stringify(facts.sum)}, measures ${JSON.stringify(facts.measures)}, offsets ${JSON.stringify(facts.offsets)}, rights ${JSON.stringify(facts.rights)}`,
        );

        expect(facts.measures, "one measure cell per row").toHaveLength(picked.count);
        expect(
          facts.measures.every((m) => m !== ""),
          "every commit of a churn day carries the lines it changed",
        ).toBe(true);
        expect(
          facts.measures.every((m) => /^\+\S+ −\S+$/.test(m)),
          "every commit of a churn day carries its lines added and removed",
        ).toBe(true);
        expect(facts.sum, "the head carries the day's pair with its unit").toMatch(/^\+\S+ −\S+ lines$/);

        expect(facts.offsets, "every row has a stamp to sit beside").toHaveLength(picked.count);
        for (const offset of facts.offsets) {
          expect(Math.abs(offset), "the measure rides the row's first line").toBeLessThanOrEqual(2);
        }
        // One column: every measure ends at the same right edge.
        for (const right of facts.rights) {
          expect(Math.abs(right - facts.rights[0]!), "the measures share a right edge").toBeLessThanOrEqual(0.5);
        }
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
