/**
 * at0765-tugchart-theme-view.test.ts — a rendered chart restyles on a theme
 * switch without a re-render, and its table view survives a remount.
 *
 * One turn streams a bar spec. Then:
 *
 *  - The theme is switched (dark to light, or the reverse, whichever the
 *    page is not in). The same `<rect>` node — marked before the switch —
 *    reports a different computed fill afterwards: no new figure was built,
 *    the classes resolved to the new theme's tokens.
 *  - Clicking the Table toggle puts the figure in table view: the attribute
 *    flips, the table takes a box, the SVG body does not. The transport then
 *    drops and recovers, which moves the card to `restoring` and unmounts
 *    its body, and the binding's re-ack settles it, which mounts a new one
 *    (`at0668`'s path). The rebuilt figure comes back in table view, read
 *    from the chart view memory by source hash.
 *
 * @covers tugdeck/src/lib/chart/render-chart.ts
 * @covers tugdeck/src/lib/chart/chart-view-memory.ts
 * @covers tugdeck/src/lib/markdown/enhance-chart.ts
 * @covers tugdeck/src/components/tugways/body-kinds/chart-block.tsx
 * @covers tugdeck/src/components/tugways/body-kinds/chart-block.css
 * @covers tugdeck/src/lib/chart/chart-measure.ts
 * @covers tugdeck/src/lib/lazy/load-tuggraphics.ts
 * @covers tugdeck/src/lib/markdown/block-transformers/tugchart.ts
 * @covers tugdeck/crates/tugmark/src/transform.rs
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import { SHOULD_RUN } from "./settle-frames-fixture";
import { BAR_SPEC, CARD, CHART, launchWithCharts, waitForCharts } from "./tugchart-fixture";

const TEST_NAME = "at0765-tugchart-theme-view";

const BAR = `${CHART} svg.tugx-chart-svg .tgf-series-1`;
const TOGGLE = `${CHART} .tugx-chart-view-toggle`;

/** A dark page goes light and a light one goes dark, so the fill must move. */
const LIGHT = "sloop";
const DARK = "ironclad";

interface ViewFacts {
  view: string | null;
  tableHeight: number;
  bodyDisplay: string;
}

const READ_VIEW = `(function(){
  var fig = document.querySelector(${JSON.stringify(CHART)});
  if (fig === null) return { view: null, tableHeight: -1, bodyDisplay: "" };
  var table = fig.querySelector("table.tugx-chart-table");
  var body = fig.querySelector(".tugx-chart-body");
  return {
    view: fig.getAttribute("data-tugx-chart-view"),
    tableHeight: table === null ? -1 : table.getBoundingClientRect().height,
    bodyDisplay: body === null ? "" : getComputedStyle(body).display,
  };
})()`;

describe.skipIf(!SHOULD_RUN)("at0765 — a chart follows the theme in place and remembers its view", () => {
  test(
    "the same rect changes fill on a theme switch, and the table view survives a remount",
    async () => {
      const { app, tugbankPath, page } = await launchWithCharts(TEST_NAME, [BAR_SPEC]);
      try {
        // ---- Theme: the same node, a different fill ----
        const before = await page.evalJS<{ fill: string; mode: string | null }>(
          `(function(){
            var bar = document.querySelector(${JSON.stringify(BAR)});
            bar.__at0765 = true;
            return { fill: getComputedStyle(bar).fill, mode: document.documentElement.getAttribute("data-theme-mode") };
          })()`,
        );
        const target = before.mode === "light" ? DARK : LIGHT;
        note(`at0765 theme ${before.mode} → ${target}; fill before ${before.fill}`);
        await app.evalJS<null>(
          `(window.tugdeck.lab.dispatch("set-theme", { theme: ${JSON.stringify(target)} }), null)`,
        );
        await page.waitForCondition<boolean>(
          `(function(){
            var bar = document.querySelector(${JSON.stringify(BAR)});
            return bar !== null && getComputedStyle(bar).fill !== ${JSON.stringify(before.fill)};
          })()`,
          { timeoutMs: 10_000 },
        );
        const after = await page.evalJS<{ fill: string; sameNode: boolean }>(
          `(function(){
            var bar = document.querySelector(${JSON.stringify(BAR)});
            return { fill: getComputedStyle(bar).fill, sameNode: bar.__at0765 === true };
          })()`,
        );
        note(`at0765 fill after ${after.fill}`);
        expect(after.sameNode, "the figure was restyled, not rebuilt").toBe(true);
        expect(after.fill).not.toBe(before.fill);

        // ---- Table view, then a remount ----
        await page.click(TOGGLE);
        await page.waitForCondition<boolean>(
          `(function(){ var f = document.querySelector(${JSON.stringify(CHART)}); return f !== null && f.getAttribute("data-tugx-chart-view") === "table"; })()`,
          { timeoutMs: 5_000 },
        );
        const shown = await page.evalJS<ViewFacts>(READ_VIEW);
        expect(shown.view).toBe("table");
        expect(shown.tableHeight, "the table takes a box").toBeGreaterThan(0);
        expect(shown.bodyDisplay, "the SVG body is hidden in table view").toBe("none");

        // The transport drops, and recovery moves the card to `restoring`,
        // which unmounts the body…
        await app.driveSession(CARD, { op: "transportClose" });
        await app.driveSession(CARD, { op: "transportReconnect" });
        await page.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(CHART)}) === null`, {
          timeoutMs: 10_000,
        });
        // …and the binding's re-ack settles it, which mounts a new one.
        await app.driveSession(CARD, { op: "transportSettled" });
        await waitForCharts(page, 1);

        const rebuilt = await page.evalJS<ViewFacts>(READ_VIEW);
        note(`at0765 rebuilt view: ${JSON.stringify(rebuilt)}`);
        expect(rebuilt.view, "the rebuilt figure remembers table view").toBe("table");
        expect(rebuilt.tableHeight).toBeGreaterThan(0);
        expect(rebuilt.bodyDisplay).toBe("none");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    300_000,
  );
});
