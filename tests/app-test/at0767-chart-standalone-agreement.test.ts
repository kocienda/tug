/**
 * at0767-chart-standalone-agreement.test.ts — the standalone render and
 * the deck lay the same spec out the same way.
 *
 * The deck measures text with the page's canvas; `tugtool chart render`
 * measures it with the same woff2 faces parsed natively. Every text
 * position in a chart is a function of those measurements — the left
 * margin is the widest tick label, a truncation is decided by exact width,
 * a thinned axis keeps the labels that fit — so a measurer that disagreed
 * would move an `x`, drop a label, or truncate a different string.
 *
 * One turn streams a bar spec whose `size.w` is narrower than the card, so
 * the deck's width is the spec's and the standalone `--width` can match it.
 * Then the deck's `<svg>` and the file `tugtool chart render` wrote are
 * read for their `<text>` runs, and this holds:
 *
 *  - Both carry the same strings in the same order: truncation and
 *    thinning agreed. The file's title run is set aside first: a file draws
 *    its title, and the deck's title is its block header.
 *    The file's frame is one title row taller for the same reason, so both
 *    lay out the same plot and thin their ticks alike.
 *  - Every pair of `x` attributes agrees within 0.5 px.
 *
 * The binary is the checkout's own build, through `tugtoolPath` — never
 * the `tugtool` on `PATH`, which is Tug.app's Release binary and may
 * predate the verb.
 *
 * @covers tugdeck/crates/tuggraphics/src/face.rs
 * @covers tugrust/crates/tugtool/src/chart.rs
 * @covers tugdeck/src/lib/chart/chart-measure.ts
 * @covers tugdeck/src/lib/chart/render-chart.ts
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import { tugtoolPath } from "./arc-fixture";
import { SHOULD_RUN } from "./settle-frames-fixture";
import { BAR_SPEC, CHART, launchWithCharts } from "./tugchart-fixture";

const TEST_NAME = "at0767-chart-standalone-agreement";

const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

/** Narrower than any card the harness seats, so the deck lays out at this width. */
const WIDTH = 320;

/** The agreement bound: a measured width is the input to every `x`. */
const X_TOLERANCE_PX = 0.5;

const SPEC = { ...BAR_SPEC, size: { w: WIDTH, h: 200 } };

/** The compiler's `TITLE_ROW`: what the file's title takes from its frame and the deck's does not. */
const TITLE_ROW = 20;

const FILE_SPEC = { ...SPEC, size: { w: WIDTH, h: SPEC.size.h + TITLE_ROW } };

interface DeckFacts {
  state: string;
  width: string;
  svg: string;
}

const READ_DECK = `(function(){
  var fig = document.querySelector(${JSON.stringify(CHART)});
  if (fig === null) return { state: "", width: "", svg: "" };
  var svg = fig.querySelector("svg.tugx-chart-svg");
  return {
    state: fig.getAttribute("data-tugx-chart-state") || "",
    width: svg === null ? "" : (svg.getAttribute("width") || ""),
    svg: svg === null ? "" : svg.outerHTML,
  };
})()`;

interface TextRun {
  text: string;
  x: number;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/** Every `<text>` in document order: its content and its `x`. */
export function textRuns(svg: string): TextRun[] {
  const runs: TextRun[] = [];
  const re = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg)) !== null) {
    const x = /\bx="([^"]+)"/.exec(m[1]);
    runs.push({ text: unescapeXml(m[2]), x: x === null ? Number.NaN : Number(x[1]) });
  }
  return runs;
}

describe.skipIf(!SHOULD_RUN)("at0767 — the standalone render agrees with the deck", () => {
  test(
    "the same strings in the same order, every x within 0.5 px",
    async () => {
      const { app, tugbankPath, page } = await launchWithCharts(TEST_NAME, [SPEC]);
      const dir = mkdtempSync(join(tmpdir(), "at0767-"));
      try {
        const deck = await page.evalJS<DeckFacts>(READ_DECK);
        expect(deck.state, "the deck rendered the spec").toBe("rendered");
        expect(deck.width, "the deck laid out at the spec's width").toBe(String(WIDTH));

        const out = join(dir, "standalone.svg");
        const bin = tugtoolPath(CHECKOUT);
        const run = Bun.spawnSync([bin, "chart", "render", "-", "--out", out, "--width", String(WIDTH)], {
          stdin: new TextEncoder().encode(JSON.stringify(FILE_SPEC)),
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(run.exitCode, `${bin}: ${run.stderr.toString()}`).toBe(0);
        const standalone = readFileSync(out, "utf-8");

        const deckRuns = textRuns(deck.svg);
        const allFileRuns = textRuns(standalone);
        expect(allFileRuns[0]?.text, "the file draws its title first").toBe(SPEC.title);
        const fileRuns = allFileRuns.slice(1);
        note(`at0767 deck texts: ${deckRuns.length}; standalone texts: ${fileRuns.length}`);

        expect(deckRuns.length, "the chart has text").toBeGreaterThan(0);
        expect(
          fileRuns.map((r) => r.text),
          "the same strings in the same order",
        ).toEqual(deckRuns.map((r) => r.text));

        for (let i = 0; i < deckRuns.length; i += 1) {
          const a = deckRuns[i];
          const b = fileRuns[i];
          expect(Number.isFinite(a.x) && Number.isFinite(b.x), `${JSON.stringify(a.text)} has an x`).toBe(true);
          expect(Math.abs(a.x - b.x), `${JSON.stringify(a.text)} deck x ${a.x} vs standalone x ${b.x}`)
            .toBeLessThanOrEqual(X_TOLERANCE_PX);
        }
        expect(standalone.match(/<style>/g)?.length, "the file carries one <style>").toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    300_000,
  );
});
