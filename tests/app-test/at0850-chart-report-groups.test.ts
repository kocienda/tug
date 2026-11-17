/**
 * at0850-chart-report-groups.test.ts — a row of a stacked chart reports
 * across all its series, grouped under each series' name.
 *
 * The chart is the real one: this worktree's built `tugtool chart
 * commit-kinds` is run in this checkout and its `TUG-CHART:` line is driven,
 * verbatim, as a Bash tool result on a card bound to this checkout (the
 * `at0843` footing). `commit-kinds` stacks a day's commits by kind, so its
 * refs are per cell and a day has no slot of its own. Where the recipe can
 * be asked, the Table view gives each such day one more atom, reading the
 * day's whole count. Pressing it opens a report in which:
 *
 *  - the title names the day and its whole count;
 *  - the rows are the day's commits, every one a History row;
 *  - a heading stands before each series' rows, in the chart's series order,
 *    one per series that holds anything that day.
 *
 * The day pressed is the latest with commits in two or more series and 25
 * or fewer in all, so the whole set is one page.
 *
 * @covers tugdeck/src/lib/chart/render-chart.ts
 * @covers tugdeck/src/lib/chart/chart-ref-set.ts
 * @covers tugdeck/src/lib/chart/chart-table-refs.ts
 * @covers tugdeck/src/lib/chart/chart-report-store.ts
 * @covers tugdeck/src/components/tugways/chart-ref-report.tsx
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

const SID = "at0850-A";
const USE_ID = `${SID}-tc1`;
const BLOCK = `[data-slot="bash-tool-block"][data-tool-use-id="${USE_ID}"]`;
const CHART = `${BLOCK} [data-slot="bash-tool-block-charts"] .tugx-chart`;
const LIST = `${CHART} .tugx-chart-set-list`;

/** How long the page may take: one run of the recipe over the window. */
const READ_MS = 8_000;

interface Picked {
  line: string;
  row: number;
  label: string;
  /** The series holding anything that day, in the chart's order. */
  series: string[];
  count: number;
}

/** How many refs a slot of the spec stands for. */
function slotSize(slot: unknown): number {
  if (typeof slot === "string") return 1;
  if (Array.isArray(slot)) return slot.length;
  if (slot !== null && typeof slot === "object" && typeof (slot as { count?: unknown }).count === "number") {
    return (slot as { count: number }).count;
  }
  return 0;
}

/**
 * The recipe's chart line, and the latest day with commits in two or more
 * series and 25 or fewer in all. A week is driven: a longer window's line is
 * past what a driven frame settles on in the harness.
 */
function pickChart(): Picked {
  const out = Bun.spawnSync([tugtoolPath(REPO_ROOT), "chart", "commit-kinds", "--days", "7"], { cwd: REPO_ROOT })
    .stdout.toString();
  const line = out.split("\n").find((l) => l.startsWith("TUG-CHART: "));
  if (line === undefined) throw new Error("chart commit-kinds drew nothing in this checkout");
  const spec = JSON.parse(line.slice("TUG-CHART: ".length)) as {
    x?: string[];
    categories?: string[];
    series: { name: string; refs?: unknown[] }[];
  };
  const labels = spec.x ?? spec.categories ?? [];
  for (let row = labels.length - 1; row >= 0; row -= 1) {
    const held = spec.series
      .map((s) => ({ name: s.name, size: slotSize(s.refs?.[row] ?? null) }))
      .filter((s) => s.size > 0);
    const count = held.reduce((sum, s) => sum + s.size, 0);
    if (held.length >= 2 && count <= 25) {
      return { line, row, label: String(labels[row]), series: held.map((s) => s.name), count };
    }
  }
  throw new Error("no day in this checkout's last week has commits in two series and 25 or fewer in all");
}

function frame(app: App, decoded: Record<string, unknown>): Promise<unknown> {
  return app.driveSession("A", {
    op: "ingestFrame",
    feedId: FEED_CODE_OUTPUT,
    decoded: { tug_session_id: SID, ...decoded },
  });
}

interface GroupFacts {
  title: string;
  /** The panel's children in order: `group:<text>` for a heading, `commit` for a History row, the kind otherwise. */
  order: string[];
}

const FACTS_JS = `(function(){
  var list = document.querySelector(${JSON.stringify(LIST)});
  if (list === null) return { title: "", order: [] };
  var rows = list.querySelector(".tugx-chart-report-rows");
  var order = rows === null ? [] : Array.from(rows.children).map(function (child) {
    if (child.classList.contains("tugx-chart-report-group")) return "group:" + (child.textContent || "").trim();
    if (child.querySelector('[data-testid="session-history-commit"]') !== null) return "commit";
    return child.getAttribute("data-kind") || "other";
  });
  return {
    title: ((list.querySelector(".tugx-chart-report-title") || {}).textContent || "").trim(),
    order: order
  };
})()`;

describe.skipIf(!SHOULD_RUN)("AT0850: a stacked chart's row reports across its series", () => {
  test(
    "a day's whole-row atom opens its commits under one heading per series",
    async () => {
      const picked = pickChart();
      note(`at0850 driving commit-kinds, row ${picked.row} (${picked.label}): ${picked.count} commits in ${picked.series.join(", ")}`);
      const app = await launchTugApp({ testName: "at0850-chart-report-groups" });
      try {
        await app.seedDeckState({ state: sessionCardShape({ width: 900, height: 700 }), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // The binding is what gives the figure somebody to ask: this repository.
        await app.bindSession("A", { tugSessionId: SID, projectDir: REPO_ROOT });
        const card = app.body("A");

        await app.driveSession("A", { op: "send", text: "chart the commit kinds" });
        await frame(app, { type: "prompt_anchor", promptUuid: `${SID}-u1` });
        await frame(app, {
          type: "tool_use",
          msg_id: `${SID}-m1`,
          tool_use_id: USE_ID,
          tool_name: "Bash",
          input: { command: "tugtool chart commit-kinds --days 7" },
          seq: 1,
        });
        await frame(app, { type: "tool_result", tool_use_id: USE_ID, is_error: false, output: `${picked.line}\n` });
        await frame(app, { type: "turn_complete", seq: 0, msg_id: `${SID}-m1`, result: "success" });

        // The day's whole-row atom is in the Table view, at the row's own address.
        const ATOM = `${CHART} .tugx-chart-table [data-tugx-ref-report="row"][data-tugx-ref-at="row:${picked.row}"]`;
        await card.waitForCondition<boolean>(
          `(function(){ var c = document.querySelector(${JSON.stringify(CHART)}); return c !== null && c.getAttribute("data-tugx-chart-state") === "rendered" && document.querySelector(${JSON.stringify(ATOM)}) !== null; })()`,
          { timeoutMs: 6_000 },
        );
        const atom = await card.evalJS<{ text: string; set: boolean }>(`(function(){
          var el = document.querySelector(${JSON.stringify(ATOM)});
          return { text: (el.textContent || "").trim(), set: el.hasAttribute("data-tugx-ref-set") };
        })()`);
        expect(atom.set, "the whole-row atom is a set a press can open").toBe(true);
        expect(atom.text, "it reads the day's whole count").toBe(`${picked.count} commits`);

        await card.evalJS(`(function(){
          document.querySelector(${JSON.stringify(`${CHART} .tugx-chart-view-toggle`)}).click();
          var el = document.querySelector(${JSON.stringify(ATOM)});
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
          return true;
        })()`);
        try {
          await card.waitForCondition<boolean>(
            `(${FACTS_JS}).order.filter(function (o) { return o === "commit"; }).length === ${picked.count}`,
            { timeoutMs: READ_MS },
          );
        } catch (error) {
          // Say what the panel held, so a red names the read that went wrong.
          const held = await card.evalJS<string>(
            `(function(){ var l = document.querySelector(${JSON.stringify(LIST)}); return l === null ? "no panel" : (l.textContent || "").slice(0, 400); })()`,
          );
          note(`at0850 panel at the miss: ${JSON.stringify(held)}`);
          throw error;
        }
        const facts = await card.evalJS<GroupFacts>(FACTS_JS);
        note(`at0850 title ${JSON.stringify(facts.title)}, order ${JSON.stringify(facts.order)}`);

        expect(facts.title, "the title names the day and its whole count").toBe(`${picked.label} · ${picked.count} commits`);
        const groups = facts.order.filter((o) => o.startsWith("group:")).map((o) => o.slice("group:".length));
        expect(groups, "one heading per series that holds anything, in the chart's order").toEqual(picked.series);
        expect(facts.order[0], "a heading stands before the first row").toBe(`group:${picked.series[0]}`);
        expect(
          facts.order.every((o) => o === "commit" || o.startsWith("group:")),
          "every row under a heading is a commit row",
        ).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
