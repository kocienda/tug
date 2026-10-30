/**
 * at0765-tugchart-fence.test.ts — a ` ```tugchart ` fence in a streamed
 * turn renders as a token-styled chart laid out against the page's faces.
 *
 * tugcast renders the turn's text and promotes the closed fence to the
 * `tug-chart` placeholder; the page's enhancer hands it to the one chart
 * renderer. One turn streams three messages — a bar spec, a spec the
 * validator refuses and a sparkline — and this holds:
 *
 *  - The bar's figure reaches `data-tugx-chart-state="rendered"`, and its
 *    `<svg>` holds no `<style>`: colour is a class over a token, never a
 *    value, which is what lets a theme switch restyle it in place.
 *  - A bar's computed `fill` is the computed value of
 *    `--tugx-chart-series-1`, read through a probe span given that token as
 *    its `color`, so both sides resolve through the same engine.
 *  - A `<text>`'s computed `font-family` begins with "IBM Plex Sans": the
 *    type roles are the deck's own faces.
 *  - Every `<text>`'s `getComputedTextLength()` is within 0.5 px of its
 *    content measured by a canvas whose `font` is built from that element's
 *    own computed style — the compiler laid each string out at exactly that
 *    measurement, so this is the layout contract with no test-only attribute
 *    in the product DOM.
 *  - The refused spec shows `invalid`, its source in a `<pre>` and its
 *    errors as `.tugx-chart-note` items.
 *  - The title is drawn once: the header reads it and no `<text>` repeats it.
 *  - The sparkline, which has no title, wears quiet chrome: the figure carries
 *    `data-tugx-chart-untitled`, and its header has no title and no placeholder
 *    word.
 *
 * @covers tugdeck/src/lib/chart/render-chart.ts
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
import { BAR_SPEC, CHART, INVALID_SPEC, launchWithCharts } from "./tugchart-fixture";

const TEST_NAME = "at0765-tugchart-fence";

const SPARKLINE_SPEC = { tugchart: 1, form: "sparkline", values: [3, 5, 4, 8, 6, 9, 12], highlight: "last" };

/** The layout contract: a laid-out string and its drawn width agree to this. */
const WIDTH_TOLERANCE_PX = 0.5;

interface TextFacts {
  text: string;
  svg: number;
  canvas: number;
  family: string;
}

interface ChartFacts {
  count: number;
  states: string[];
  styles: number;
  barFill: string;
  tokenColor: string;
  texts: TextFacts[];
  hasTable: boolean;
  hasHeader: boolean;
  invalidPre: boolean;
  notes: string[];
  title: string;
  untitledFigures: number;
  quietTitles: number;
  quietHeaderText: string;
}

const READ_FACTS = `(function(){
  var charts = Array.from(document.querySelectorAll(${JSON.stringify(CHART)}));
  var states = charts.map(function (c) { return c.getAttribute("data-tugx-chart-state") || ""; });
  var fig = charts.filter(function (c) { return c.getAttribute("data-tugx-chart-state") === "rendered"; })[0] || null;
  var invalid = charts.filter(function (c) { return c.getAttribute("data-tugx-chart-state") === "invalid"; })[0] || null;
  var out = { count: charts.length, states: states, styles: -1, barFill: "", tokenColor: "", texts: [],
              hasTable: false, hasHeader: false, invalidPre: false, notes: [],
              title: "", untitledFigures: 0, quietTitles: -1, quietHeaderText: "" };
  if (fig !== null) {
    var svg = fig.querySelector("svg.tugx-chart-svg");
    if (svg !== null) {
      out.styles = svg.querySelectorAll("style").length;
      var bar = svg.querySelector(".tgf-series-1");
      if (bar !== null) out.barFill = getComputedStyle(bar).fill;
      var probe = document.createElement("span");
      probe.style.color = "var(--tugx-chart-series-1)";
      fig.appendChild(probe);
      out.tokenColor = getComputedStyle(probe).color;
      probe.remove();
      var ctx = document.createElement("canvas").getContext("2d");
      out.texts = Array.from(svg.querySelectorAll("text")).map(function (t) {
        var cs = getComputedStyle(t);
        ctx.font = cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
        var s = t.textContent || "";
        var ls = parseFloat(cs.letterSpacing);
        var w = ctx.measureText(s).width + (isFinite(ls) ? ls * s.length : 0);
        return { text: s, svg: t.getComputedTextLength(), canvas: w, family: cs.fontFamily };
      });
    }
    out.hasTable = fig.querySelector("table.tugx-chart-table") !== null;
    out.hasHeader = fig.querySelector(".tugx-md-chrome-header") !== null;
    var title = fig.querySelector(".tugx-chart-title");
    out.title = title === null ? "" : (title.textContent || "");
  }
  var untitled = charts.filter(function (c) { return c.hasAttribute("data-tugx-chart-untitled"); });
  out.untitledFigures = untitled.length;
  if (untitled.length > 0) {
    var quiet = untitled[0].querySelector(".tugx-md-chrome-header");
    out.quietTitles = untitled[0].querySelectorAll(".tugx-chart-title").length;
    out.quietHeaderText = quiet === null ? "" : (quiet.textContent || "");
  }
  if (invalid !== null) {
    out.invalidPre = invalid.querySelector("pre.tugx-chart-source") !== null;
    out.notes = Array.from(invalid.querySelectorAll(".tugx-chart-note li")).map(function (li) { return li.textContent || ""; });
  }
  return out;
})()`;

describe.skipIf(!SHOULD_RUN)("at0765 — a tugchart fence renders as a token-styled chart", () => {
  test(
    "the figure is laid out against the page's faces, coloured by token, and an invalid spec says why",
    async () => {
      const { app, tugbankPath, page } = await launchWithCharts(TEST_NAME, [BAR_SPEC, INVALID_SPEC, SPARKLINE_SPEC]);
      try {
        const facts = await page.evalJS<ChartFacts>(READ_FACTS);
        note(`at0765 chart states: ${JSON.stringify(facts.states)}; texts: ${facts.texts.length}`);

        expect(facts.count, "every fence became a chart").toBe(3);
        expect(facts.states.sort(), "two rendered, one invalid").toEqual(["invalid", "rendered", "rendered"]);

        expect(facts.styles, "the SVG carries no <style>").toBe(0);
        expect(facts.hasHeader, "the figure wears the block chrome header").toBe(true);
        expect(facts.hasTable, "the table alternative is in the DOM").toBe(true);

        expect(facts.barFill, "a bar's fill is the series-1 token").not.toBe("");
        expect(facts.barFill).toBe(facts.tokenColor);

        expect(facts.texts.length, "the chart has text").toBeGreaterThan(0);
        for (const t of facts.texts) {
          expect(t.family.replace(/"/g, ""), `${JSON.stringify(t.text)} face`).toStartWith("IBM Plex Sans");
          expect(Math.abs(t.svg - t.canvas), `${JSON.stringify(t.text)} drawn ${t.svg} vs laid out ${t.canvas}`)
            .toBeLessThanOrEqual(WIDTH_TOLERANCE_PX);
        }

        expect(facts.invalidPre, "the invalid spec shows its source").toBe(true);
        expect(facts.notes.length, "the invalid spec lists its errors").toBeGreaterThan(0);
        expect(facts.notes.join("\n")).toContain("form");

        expect(facts.title, "the header reads the title").toBe(BAR_SPEC.title);
        expect(facts.texts.map((t) => t.text), "no <text> repeats the title").not.toContain(BAR_SPEC.title);

        expect(facts.untitledFigures, "only the sparkline is untitled").toBe(1);
        expect(facts.quietTitles, "its header has no title").toBe(0);
        expect(facts.quietHeaderText.toLowerCase(), "its header has no placeholder word").not.toContain("chart");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    300_000,
  );
});
