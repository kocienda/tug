/**
 * at0847-chart-report-paging.test.ts — a bar too big for the spec to list
 * opens, and its report pages.
 *
 * The chart is the real one: this worktree's built `tugtool chart commits
 * --by week` is run in this checkout and its `TUG-CHART:` line is driven,
 * verbatim, as a Bash tool result on a card bound to this checkout (the
 * `at0843` footing). The week driven is one whose slot is a **count form**:
 * more than 100 commits, which the spec folds to `{kind, count}` with no
 * list. The window is widened until such a week exists. The recipe stamps
 * its `source`, and the card can ask, so:
 *
 *  - that week's bar carries its set: a count form is pressable where the
 *    recipe that drew it can be asked;
 *  - pressing it opens a report of 25 History commit rows, under a title
 *    naming the week and the count, with a foot reading `25 of N`;
 *  - pressing the foot reads the next page: 50 rows, the first 25 unchanged.
 *
 * @covers tugdeck/src/lib/chart/chart-report-store.ts
 * @covers tugdeck/src/lib/chart/chart-ref-set.ts
 * @covers tugdeck/src/lib/chart/chart-table-refs.ts
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

const SID = "at0847-A";
const USE_ID = `${SID}-tc1`;
const BLOCK = `[data-slot="bash-tool-block"][data-tool-use-id="${USE_ID}"]`;
const CHART = `${BLOCK} [data-slot="bash-tool-block-charts"] .tugx-chart`;
const LIST = `${CHART} .tugx-chart-set-list`;
const MORE = `${LIST} .tugx-chart-report-more`;

/** How long a page may take: one run of the recipe over the window. */
const READ_MS = 30_000;

interface Picked {
  line: string;
  days: number;
  row: number;
  label: string;
  count: number;
}

/**
 * The recipe's chart line, and a week whose slot is a count form. The window
 * starts at a quarter and widens until one is found.
 */
function pickChart(): Picked {
  const bin = tugtoolPath(REPO_ROOT);
  for (const days of [90, 180, 365]) {
    const out = Bun.spawnSync([bin, "chart", "commits", "--by", "week", "--days", String(days)], { cwd: REPO_ROOT })
      .stdout.toString();
    const line = out.split("\n").find((l) => l.startsWith("TUG-CHART: "));
    if (line === undefined) continue;
    const spec = JSON.parse(line.slice("TUG-CHART: ".length)) as { refs?: unknown[]; categories?: string[] };
    const refs = spec.refs ?? [];
    for (let row = refs.length - 1; row >= 0; row -= 1) {
      const slot = refs[row] as { kind?: unknown; count?: unknown } | null;
      if (slot !== null && typeof slot === "object" && !Array.isArray(slot) && typeof slot.count === "number") {
        return { line, days, row, label: spec.categories?.[row] ?? "", count: slot.count };
      }
    }
  }
  throw new Error("no week in a year of this checkout's commits holds more than 100 commits");
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

interface ReportFacts {
  title: string;
  shas: string[];
  foot: string;
}

const REPORT_JS = `(function(){
  var list = document.querySelector(${JSON.stringify(LIST)});
  if (list === null) return { title: "", shas: [], foot: "" };
  return {
    title: (list.querySelector(".tugx-chart-report-title") || {}).textContent || "",
    shas: Array.from(list.querySelectorAll('[data-testid="session-history-commit"]')).map(function (a) {
      return a.getAttribute("data-sha") || "";
    }),
    foot: ((list.querySelector(".tugx-chart-report-more") || {}).textContent || "").trim()
  };
})()`;

describe.skipIf(!SHOULD_RUN)("AT0847: a count-form bar opens a report that pages", () => {
  test(
    "a week of more than 100 commits opens 25 rows, and the foot reads 25 more",
    async () => {
      const picked = pickChart();
      note(`at0847 driving --days ${picked.days}, row ${picked.row} (${picked.label}) with ${picked.count} commits`);
      const app = await launchTugApp({ testName: "at0847-chart-report-paging" });
      try {
        await app.seedDeckState({ state: sessionCardShape({ width: 900, height: 700 }), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // The binding is what gives the figure somebody to ask: this repository.
        await app.bindSession("A", { tugSessionId: SID, projectDir: REPO_ROOT });
        const card = app.body("A");

        await app.driveSession("A", { op: "send", text: "chart the commits by week" });
        await frame(app, { type: "prompt_anchor", promptUuid: `${SID}-u1` });
        await frame(app, {
          type: "tool_use",
          msg_id: `${SID}-m1`,
          tool_use_id: USE_ID,
          tool_name: "Bash",
          input: { command: `tugtool chart commits --by week --days ${picked.days}` },
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
        expect(isSet, "a count form is pressable where the recipe can be asked").toBe(true);

        // The first page.
        await card.evalJS(click(BAR));
        await card.waitForCondition<boolean>(`(${REPORT_JS}).shas.length === 25`, { timeoutMs: READ_MS });
        const first = await card.evalJS<ReportFacts>(REPORT_JS);
        note(`at0847 first page: ${JSON.stringify(first.title)}, foot ${JSON.stringify(first.foot)}`);
        expect(first.title, "the title names the week and the count").toBe(`${picked.label} · ${picked.count} commits`);
        expect(first.foot, "the foot counts what is shown against the whole").toMatch(/^25 of \d+ · show \d+ more$/);
        expect(new Set(first.shas).size, "no commit is listed twice").toBe(25);

        // The foot reads the next page under the first.
        await card.evalJS(click(MORE));
        await card.waitForCondition<boolean>(`(${REPORT_JS}).shas.length === 50`, { timeoutMs: READ_MS });
        const second = await card.evalJS<ReportFacts>(REPORT_JS);
        expect(second.shas.slice(0, 25), "the first page stands as it was").toEqual(first.shas);
        expect(new Set(second.shas).size, "and the second brings 25 new commits").toBe(50);
        expect(second.foot).toMatch(/^50 of \d+ · show \d+ more$/);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
