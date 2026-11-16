/**
 * at0839-tugdiagram-over-wide.test.ts — a ` ```tugdiagram ` fence whose
 * figure is past every limit a diagram should stay inside still draws.
 *
 * A diagram that parses always draws. The spec here is the one that was
 * withheld from a reader: five ordinary columns that lay out wider than
 * the 1,040 px a diagram reads well at. Beside its width it carries the
 * mistakes a model makes when it writes a spec unchecked — a coordinate no
 * form takes, an edge to a box that is not there, a key number given
 * twice. Each is a warning to whoever wrote the spec and none is a reason
 * to show the reader "Diagram not drawn". This holds:
 *
 *  - The figure reaches `rendered` as a diagram, and its header shows the
 *    spec's title, never "Diagram not drawn".
 *  - Its SVG is laid out wider than the cap, and the card fits it by
 *    scaling it no further than three quarters of that width; if it still
 *    does not fit, the figure's body scrolls sideways.
 *  - The keyed table stands beneath it at the card's width, a row per key
 *    that kept its number, and neither scales nor scrolls with the figure.
 *  - Nothing of the warnings is shown to the reader.
 *
 * @covers tugdeck/src/lib/chart/render-chart.ts
 * @covers tugdeck/src/components/tugways/body-kinds/chart-block.css
 * @covers tugdeck/src/lib/lazy/load-tuggraphics.ts
 * @covers tugdeck/crates/tuggraphics/src/diagram/mod.rs
 * @covers tugdeck/crates/tuggraphics/src/diagram/spec.rs
 * @covers tugdeck/crates/tuggraphics/src/diagram/budget.rs
 * @covers tugdeck/crates/tuggraphics/src/diagram/wrap.rs
 * @covers tugdeck/crates/tuggraphics/src/chart/mod.rs
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import { SHOULD_RUN } from "./settle-frames-fixture";
import { CARD, CHART, launchWithCharts, waitForCharts } from "./tugchart-fixture";

const TEST_NAME = "at0839-tugdiagram-over-wide";

/** The width past which a diagram is warned of, and the least the card scales one to. */
const WIDTH_CAP_PX = 1040;
const SCALE_FLOOR = 0.75;

const TITLE = "Claude Code is made to work Tug's way by a plugin, and the plugin hands every decision to tugtool";

const OVER_WIDE_SPEC = {
  tugdiagram: 1,
  form: "flow",
  title: TITLE,
  columns: [
    // A coordinate: no form takes one, so it is ignored.
    [{ id: "code", name: "tugcode", sub: "starts claude with --plugin-dir", x: 40 }],
    [
      {
        id: "claude",
        name: "claude",
        sub: "about to run a tool",
        rows: [
          { name: "Bash", mono: true },
          { name: "Skill", mono: true },
        ],
      },
    ],
    [
      {
        id: "hooks",
        name: "tugplug hooks",
        rows: [
          { key: 1, name: "hooks.json", mono: true, what: "Registers a PreToolUse hook on Bash and Skill calls." },
          { key: 2, name: "pre-tool-use.sh", mono: true, what: "Finds tugtool and passes it the hook payload on stdin." },
        ],
      },
    ],
    [
      {
        id: "tool",
        name: "tugtool hook pre-tool-use",
        rows: [
          {
            key: 3,
            name: "decide",
            sub: "allow, rewrite or deny",
            what: "Approves safe calls, wraps test runners to report, refuses unattributable edits.",
          },
        ],
      },
    ],
    [
      { id: "run", name: "Runs", sub: "maybe rewritten to report progress" },
      // Key 3 again: the first mark keeps it, and this row is drawn unkeyed.
      { id: "deny", name: "Refused", sub: "with the form to write instead", rows: [{ key: 3, name: "says why" }] },
    ],
  ],
  edges: [
    { from: "code", to: "claude" },
    { from: "claude", to: "hooks.1" },
    { from: "hooks.2", to: "tool" },
    { from: "tool.1", to: "run", tone: "good", label: "allowed" },
    { from: "tool.1", to: "deny", tone: "bad", dashed: true, label: "denied" },
    // An edge to a box that is not there: dropped.
    { from: "tool", to: "nowhere" },
  ],
};

interface OverWideFacts {
  state: string;
  kind: string;
  title: string;
  text: string;
  naturalWidth: number;
  drawnWidth: number;
  bodyClient: number;
  bodyScroll: number;
  figureRight: number;
  tableRight: number;
  tableLeft: number;
  figureLeft: number;
  rows: string[];
  hits: number;
}

const READ_FACTS = `(function(){
  var fig = document.querySelector(${JSON.stringify(CHART)});
  var body = fig.querySelector(".tugx-chart-body");
  var svg = body === null ? null : body.querySelector("svg.tugx-chart-svg");
  var table = fig.querySelector("table.tugx-diagram-table");
  var title = fig.querySelector(".tugx-chart-title");
  var figBox = fig.getBoundingClientRect();
  var tableBox = table === null ? { left: 0, right: 0 } : table.getBoundingClientRect();
  return {
    state: fig.getAttribute("data-tugx-chart-state") || "",
    kind: fig.getAttribute("data-tugx-chart-kind") || "",
    title: title === null ? "" : (title.textContent || ""),
    text: fig.textContent || "",
    naturalWidth: svg === null ? 0 : Number(svg.getAttribute("width")),
    drawnWidth: svg === null ? 0 : svg.getBoundingClientRect().width,
    bodyClient: body === null ? 0 : body.clientWidth,
    bodyScroll: body === null ? 0 : body.scrollWidth,
    figureLeft: figBox.left,
    figureRight: figBox.right,
    tableLeft: tableBox.left,
    tableRight: tableBox.right,
    rows: table === null ? [] : Array.from(table.querySelectorAll("tbody tr")).map(function (tr) {
      return Array.from(tr.querySelectorAll("td")).slice(0, 2).map(function (td) { return (td.textContent || "").trim(); }).join(" ");
    }),
    hits: fig.querySelectorAll("svg .tgh[data-row]").length
  };
})()`;

describe.skipIf(!SHOULD_RUN)("at0839 — a tugdiagram past its limits still draws", () => {
  test(
    "an over-wide figure with repairable mistakes draws its figure and its table",
    async () => {
      const { app, tugbankPath } = await launchWithCharts(TEST_NAME, [OVER_WIDE_SPEC], "tugdiagram");
      const page = app.body(CARD);
      try {
        await waitForCharts(page, 1);
        const facts = await page.evalJS<OverWideFacts>(READ_FACTS);
        const scale = facts.naturalWidth > 0 ? facts.drawnWidth / facts.naturalWidth : 0;
        note(
          `at0839 over-wide: ${JSON.stringify({
            state: facts.state,
            natural: facts.naturalWidth,
            drawn: Math.round(facts.drawnWidth),
            scale: Number(scale.toFixed(3)),
            bodyClient: facts.bodyClient,
            bodyScroll: facts.bodyScroll,
          })}`,
        );

        expect(facts.state, "the figure is drawn, not withheld").toBe("rendered");
        expect(facts.kind).toBe("diagram");
        expect(facts.title, "the header is the figure's title").toBe(TITLE);
        expect(facts.text, "the reader is never told it was not drawn").not.toContain("not drawn");

        expect(facts.naturalWidth, "the figure is laid out past the width cap").toBeGreaterThan(WIDTH_CAP_PX);
        expect(scale, "the card scales it no further than the floor").toBeGreaterThanOrEqual(SCALE_FLOOR - 0.005);
        expect(scale, "and never enlarges it").toBeLessThanOrEqual(1.005);
        const fits = facts.bodyScroll <= facts.bodyClient + 1;
        if (!fits) {
          // Too wide even at the floor: it holds the floor and scrolls.
          expect(scale, "a figure that scrolls is held at the floor").toBeLessThan(SCALE_FLOOR + 0.005);
        }

        expect(facts.rows, "a row per key that kept its number, in key order").toEqual([
          "1 hooks.json",
          "2 pre-tool-use.sh",
          "3 decide",
        ]);
        expect(facts.hits, "each keyed mark has a hit target").toBe(3);
        expect(facts.tableLeft, "the table stays inside the card").toBeGreaterThanOrEqual(facts.figureLeft - 1);
        expect(facts.tableRight, "and does not scroll with the figure").toBeLessThanOrEqual(facts.figureRight + 1);

        for (const said of ["warning", "unknown field", "is dropped", "already given", "split it"]) {
          expect(facts.text, `no warning reaches the reader: ${said}`).not.toContain(said);
        }
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    300_000,
  );
});
