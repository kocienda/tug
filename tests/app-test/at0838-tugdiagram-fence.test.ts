/**
 * at0838-tugdiagram-fence.test.ts — a ` ```tugdiagram ` fence in a streamed
 * turn draws its figure and, beneath it, the keyed table, whose locations
 * the file-reference resolver confirms or marks unresolved.
 *
 * tugcast renders the turn and promotes the closed fence to the chart
 * placeholder, naming the diagram door on it; the page's enhancer hands it
 * to the one chart renderer and then annotates the table with the block's
 * context. The spec's two keyed rows point at a file written to a temp
 * directory and at a sibling that was never written. This holds:
 *
 *  - The figure reaches `rendered` as a diagram (`data-tugx-chart-kind`),
 *    its SVG holds a hit target per keyed mark, and there is no Table
 *    toggle: the keyed table is the figure's own.
 *  - The keyed table is on screen, not clipped: one row per key, in key
 *    order, the number in a disc.
 *  - The location that exists becomes a file reference
 *    (`data-tug-annotation="file-path"`) and wears no unresolved mark.
 *  - The location that does not exist is never a reference, and its cell
 *    wears the "unresolved" mark.
 *
 * @covers tugdeck/src/lib/chart/render-chart.ts
 * @covers tugdeck/src/lib/chart/keyed-table.ts
 * @covers tugdeck/src/lib/markdown/enhance-chart.ts
 * @covers tugdeck/src/lib/markdown/render-incremental.ts
 * @covers tugdeck/src/lib/markdown/block-transformers/tugchart.ts
 * @covers tugdeck/src/components/tugways/body-kinds/chart-block.css
 * @covers tugdeck/crates/tugmark/src/transform.rs
 * @covers tugdeck/crates/tuggraphics/src/diagram/mod.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { note } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import { SHOULD_RUN } from "./settle-frames-fixture";
import { CARD, CHART, launchWithCharts } from "./tugchart-fixture";

const TEST_NAME = "at0838-tugdiagram-fence";

/** How long a location may take to be confirmed by `fs/stat`. */
const RESOLVE_MS = 10_000;

let dir = "";
let realPath = "";
let missingPath = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  dir = mkdtempSync(join(tmpdir(), "at0838-"));
  realPath = join(dir, "gate.rs");
  missingPath = join(dir, "never-written.rs");
  writeFileSync(realPath, "fn gate() {}\n", "utf8");
});
afterAll(() => {
  if (dir !== "" && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function diagramSpec(): unknown {
  return {
    tugdiagram: 1,
    form: "flow",
    title: "A shell edit is read before it runs",
    columns: [
      [{ id: "model", name: "Model", sub: "a Bash call" }],
      [
        {
          id: "gate",
          name: "Gate",
          rows: [
            { key: 1, name: "Read the command", what: "Finds the files it writes.", where: realPath },
            { key: 2, name: "Deny the unreadable", what: "Refuses what it cannot read.", where: missingPath },
          ],
        },
      ],
    ],
    edges: [{ from: "model", to: "gate.1", tone: "good", label: "runs" }],
  };
}

interface DiagramFacts {
  count: number;
  state: string;
  kind: string;
  checked: boolean;
  hits: number;
  toggles: number;
  tableHeight: number;
  tablePosition: string;
  rows: string[][];
  discs: number;
  real: { annotation: string; after: string };
  missing: { annotation: string; after: string };
}

const RESOLVED_JS = `(function(){
  var fig = document.querySelector(${JSON.stringify(CHART)});
  if (fig === null) return false;
  var cells = fig.querySelectorAll("td.tugx-diagram-where");
  return cells.length === 2 && cells[0].querySelector('[data-tug-annotation="file-path"]') !== null;
})()`;

const READ_FACTS = `(function(){
  var charts = document.querySelectorAll(${JSON.stringify(CHART)});
  var fig = charts[0];
  var table = fig.querySelector("table.tugx-diagram-table");
  var cells = fig.querySelectorAll("td.tugx-diagram-where");
  function where(td) {
    var a = td.querySelector("[data-tug-annotation]");
    return {
      annotation: a === null ? "" : (a.getAttribute("data-tug-annotation") || ""),
      after: getComputedStyle(td, "::after").content
    };
  }
  return {
    count: charts.length,
    state: fig.getAttribute("data-tugx-chart-state") || "",
    kind: fig.getAttribute("data-tugx-chart-kind") || "",
    checked: fig.hasAttribute("data-tugx-where-checked"),
    hits: fig.querySelectorAll("svg .tgh[data-row]").length,
    toggles: fig.querySelectorAll(".tugx-chart-view-toggle").length,
    tableHeight: table === null ? 0 : table.getBoundingClientRect().height,
    tablePosition: table === null ? "" : getComputedStyle(table).position,
    rows: table === null ? [] : Array.from(table.querySelectorAll("tbody tr")).map(function (tr) {
      return Array.from(tr.querySelectorAll("td")).map(function (td) { return (td.textContent || "").trim(); });
    }),
    discs: fig.querySelectorAll("td.tugx-diagram-key .tugx-diagram-disc").length,
    real: cells.length > 0 ? where(cells[0]) : { annotation: "", after: "" },
    missing: cells.length > 1 ? where(cells[1]) : { annotation: "", after: "" }
  };
})()`;

describe.skipIf(!SHOULD_RUN)("at0838 — a tugdiagram fence draws its figure and keyed table", () => {
  test(
    "the table stands beneath the figure, and only the location that exists resolves",
    async () => {
      const { app, tugbankPath } = await launchWithCharts(TEST_NAME, [diagramSpec()], "tugdiagram");
      const page = app.body(CARD);
      try {
        await page.waitForCondition<boolean>(RESOLVED_JS, { timeoutMs: RESOLVE_MS });
        const facts = await page.evalJS<DiagramFacts>(READ_FACTS);
        note(`at0838 diagram: ${JSON.stringify({ state: facts.state, rows: facts.rows.length, real: facts.real, missing: facts.missing })}`);

        expect(facts.count, "the fence became one figure").toBe(1);
        expect(facts.state).toBe("rendered");
        expect(facts.kind, "it is drawn as a diagram").toBe("diagram");
        expect(facts.hits, "each keyed mark has a hit target").toBe(2);
        expect(facts.toggles, "a diagram has no Table toggle").toBe(0);

        expect(facts.tablePosition, "the keyed table is not clipped away").not.toBe("absolute");
        expect(facts.tableHeight, "the keyed table is on screen").toBeGreaterThan(20);
        expect(facts.discs, "each key is a disc").toBe(2);
        expect(facts.rows.map((r) => r.slice(0, 3))).toEqual([
          ["1", "Read the command", "Finds the files it writes."],
          ["2", "Deny the unreadable", "Refuses what it cannot read."],
        ]);

        expect(facts.checked, "a resolver was asked").toBe(true);
        expect(facts.real.annotation, "the existing location is a file reference").toBe("file-path");
        expect(facts.real.after, "and wears no unresolved mark").toBe("none");
        expect(facts.missing.annotation, "the missing location is never a reference").toBe("");
        expect(facts.missing.after, "and is marked unresolved").toContain("unresolved");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    300_000,
  );
});
