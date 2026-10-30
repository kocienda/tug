/**
 * at0770-tugchart-hover.test.ts — hovering a bar reads that bar's row of the
 * chart's table, in the app's tooltip bubble.
 *
 * One turn streams the bar spec, and this holds:
 *
 *  - The target over the bar's centre is what the page hit-tests to, so the
 *    invisible target really is on top of the marks, and it names row 3.
 *  - A zero is a target and a gap is not: six targets for seven categories.
 *  - The pointer entering it raises one bubble, painted as the tooltip is, whose
 *    label and value are the cells of that row in the `<table>`.
 *  - Moving to the next target retargets the same bubble, rather than adding one.
 *  - The pointer leaving the figure takes the bubble away.
 *  - A pointer that crosses to another mark before the bubble opens gets the bubble
 *    over the mark it stopped on, not the one it entered first.
 *
 * The pointer is dispatched rather than moved, as `revealPaneControls` does: the
 * product reads pointer events and not `:hover`, because a background app-test
 * has no business moving the physical cursor.
 *
 * @covers tugdeck/src/lib/chart/chart-hover.ts
 * @covers tugdeck/src/lib/chart/render-chart.ts
 * @covers tugdeck/src/components/tugways/body-kinds/chart-block.css
 * @covers tugdeck/crates/tuggraphics/src/chart/forms/bar.rs
 * @covers tugdeck/crates/tuggraphics/src/draw/svg.rs
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import { SHOULD_RUN } from "./settle-frames-fixture";
import { BAR_SPEC, CHART, launchWithCharts } from "./tugchart-fixture";

const TEST_NAME = "at0770-tugchart-hover";

/** The bubble, in whichever overlay root the card's page has. */
const TIP = ".tug-tooltip-content.tugx-chart-tip";

interface TipFacts {
  count: number;
  label: string;
  value: string;
  background: string;
  tooltipToken: string;
}

const READ_TIP = `(function(){
  var tips = document.querySelectorAll(${JSON.stringify(TIP)});
  var out = { count: tips.length, label: "", value: "", background: "", tooltipToken: "" };
  if (tips.length > 0) {
    var tip = tips[0];
    var label = tip.querySelector(".tugx-chart-tip-label");
    out.label = label === null ? "" : (label.textContent || "");
    var value = tip.querySelector(".tugx-chart-tip-row[data-current] span:last-child");
    out.value = value === null ? "" : (value.textContent || "");
    out.background = getComputedStyle(tip).backgroundColor;
    var probe = document.createElement("span");
    probe.style.backgroundColor = "var(--tugx-tooltip-bg)";
    document.body.appendChild(probe);
    out.tooltipToken = getComputedStyle(probe).backgroundColor;
    probe.remove();
  }
  return out;
})()`;

/** The cells of a row of the `<table>`, which is what the bubble has to agree with. */
function tableRow(row: number): string {
  return `(function(){
    var cells = document.querySelectorAll(${JSON.stringify(CHART)} + " tbody tr")[${row}].querySelectorAll("td");
    return Array.from(cells).map(function (c) { return c.textContent || ""; });
  })()`;
}

function enter(row: number): string {
  return `(function(){
    var hit = document.querySelector(${JSON.stringify(CHART)} + ' .tgh[data-row="${row}"]');
    var rect = hit.getBoundingClientRect();
    hit.dispatchEvent(new PointerEvent("pointerover", {
      bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
    }));
  })()`;
}

const READ_HIT = `(function(){
  var chart = document.querySelector(${JSON.stringify(CHART)});
  var bar = chart.querySelectorAll(".tgf-series-1")[3 - 1];
  var rect = bar.getBoundingClientRect();
  var top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return {
    targets: chart.querySelectorAll(".tgh").length,
    row: top === null ? "" : (top.getAttribute("data-row") || ""),
  };
})()`;

/** How far the bubble's centre stands from the centre of row `row`'s target. */
function tipOffset(row: number): string {
  return `(function(){
    var tip = document.querySelector(${JSON.stringify(TIP)}).getBoundingClientRect();
    var hit = document.querySelector(${JSON.stringify(CHART)} + ' .tgh[data-row="${row}"]').getBoundingClientRect();
    return Math.abs((tip.left + tip.width / 2) - (hit.left + hit.width / 2));
  })()`;
}

const LEAVE = `(function(){
  var body = document.querySelector(${JSON.stringify(CHART)} + " .tugx-chart-body");
  body.dispatchEvent(new PointerEvent("pointerleave", { bubbles: false }));
})()`;

describe.skipIf(!SHOULD_RUN)("at0770 — a chart mark reads its row on hover", () => {
  test(
    "hovering a bar shows its table row in the one tooltip bubble",
    async () => {
      const { app, tugbankPath, page } = await launchWithCharts(TEST_NAME, [BAR_SPEC]);
      try {
        const hit = await page.evalJS<{ targets: number; row: string }>(READ_HIT);
        note(`at0770 targets: ${hit.targets}, under the bar: row ${hit.row}`);
        expect(hit.targets, "a zero is a target and a gap is not").toBe(6);
        // The bars drawn are 4, 7, 12, 3, 9: the zero and the gap draw none, so
        // the third bar is category 3.
        expect(hit.row, "the target is over the bar").toBe("3");

        await page.evalJS(enter(3));
        await page.waitForCondition<boolean>(`document.querySelectorAll(${JSON.stringify(TIP)}).length === 1`, {
          timeoutMs: 5_000,
        });
        const row = await page.evalJS<string[]>(tableRow(3));
        const tip = await page.evalJS<TipFacts>(READ_TIP);
        note(`at0770 bubble: ${JSON.stringify(tip)}; table: ${JSON.stringify(row)}`);
        expect(tip.count).toBe(1);
        expect(tip.label, "the label is the row's first cell").toBe(row[0]!);
        expect(tip.value, "the value is the row's value").toBe(row[1]!);
        expect(row, "the table is the spec's").toEqual(["10-24", "12"]);
        expect(tip.background, "it is painted as the tooltip is").toBe(tip.tooltipToken);

        await page.evalJS(enter(0));
        const next = await page.evalJS<TipFacts>(READ_TIP);
        expect(next.count, "the bubble is retargeted, not added to").toBe(1);
        expect(next.label).toBe("10-21");
        expect(next.value).toBe("4");

        await page.evalJS(LEAVE);
        const gone = await page.evalJS<TipFacts>(READ_TIP);
        expect(gone.count, "leaving the figure ends the hover").toBe(0);

        await page.evalJS(enter(0));
        await page.evalJS(enter(3));
        await page.waitForCondition<boolean>(`document.querySelectorAll(${JSON.stringify(TIP)}).length === 1`, {
          timeoutMs: 5_000,
        });
        const crossed = await page.evalJS<TipFacts>(READ_TIP);
        expect(crossed.label, "the row of the mark it stopped on").toBe("10-24");
        const offset = await page.evalJS<number>(tipOffset(3));
        note(`at0770 bubble centre to target centre: ${offset}px`);
        expect(offset, "the bubble stands over the mark it stopped on").toBeLessThan(3);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    300_000,
  );
});
