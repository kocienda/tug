/**
 * at0852-figure-share-pdf.test.ts — a chart rendered as a PDF through the
 * share path is one page at the figure's own width, and the header's Share
 * button opens the preview sheet over it.
 *
 * ## What this gates
 *
 * The figure document's codec and the host's width arithmetic have unit
 * tests. What only the running app has is the hidden share page drawing a
 * spec as a picture and the host writing a PDF at the width the page
 * reported. This holds:
 *
 *   - A chart whose spec fixes its width renders, through the same document
 *     the Share button sends, as a `%PDF` of exactly one page whose page is
 *     the figure's width plus the picture's margin — never the share
 *     column's 720 points — and the same width as its PNG, so the two
 *     formats are one picture.
 *   - A native click on the header's Share button renders and opens the
 *     preview sheet, which takes the keyboard from the card's window; Escape
 *     dismisses it and the window has the keyboard again.
 *
 * @covers tugdeck/src/lib/chart/render-chart.ts
 * @covers tugdeck/src/lib/chart/figure-export.ts
 * @covers tugdeck/src/lib/share-turns.ts
 * @covers tugdeck/src/share/share-main.ts
 * @covers tugdeck/src/share/share-page.css
 * @covers tugapp/Sources/ShareRenderer.swift
 * @covers tugapp/Sources/ShareRenderOutput.swift
 * @covers tugapp/Sources/SharePreviewSheet.swift
 * @covers tugapp/Sources/MainWindow.swift
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";

import { note } from "./_harness";
import { decodePngFile } from "./_harness/png";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import { SHOULD_RUN } from "./settle-frames-fixture";
import { CHART, launchWithCharts } from "./tugchart-fixture";

const TEST_NAME = "at0852-figure-share-pdf";
const TITLE = "Commits per day fell after the freeze";
/** The spec's own width, in CSS px. */
const FIGURE_WIDTH = 520;
/** The picture's margin on each side, from `share-page.css`. */
const MARGIN = 24;

const SPEC = {
  tugchart: 1,
  form: "bar",
  title: TITLE,
  unit: "commits",
  format: "int",
  size: { w: FIGURE_WIDTH, h: 260 },
  categories: ["10-01", "10-02", "10-03", "10-04", "10-05"],
  series: [{ name: "commits", values: [4, 7, 6, 1, 0] }],
};

const SHARE = `${CHART} .tugx-chart-share`;

interface Rendered {
  result: "ok" | "failed";
  path: string;
  height: number;
  pages: number;
  html: string;
}

/** The PDF's page width in points, read with `sips`. */
function pdfPointWidth(path: string): number {
  const out = Bun.spawnSync(["sips", "-g", "pixelWidth", path]).stdout.toString();
  const m = /pixelWidth:\s*(\d+)/.exec(out);
  return m === null ? -1 : Number(m[1]);
}

describe.skipIf(!SHOULD_RUN)("at0852 — a chart shared as a PDF is one page at its own width", () => {
  test(
    "the PDF is one page at the figure's width, and Share opens the sheet",
    async () => {
      const { app, tugbankPath, page } = await launchWithCharts(TEST_NAME, [SPEC]);
      const paths: string[] = [];
      try {
        const scale = await page.evalJS<number>("window.devicePixelRatio");
        const render = async (format: "pdf" | "png"): Promise<Rendered> => {
          await page.evalJS<null>(
            `(window.__at0852 = undefined,
              window.__tug.shareRenderFigure(${JSON.stringify(format)}, ${JSON.stringify(JSON.stringify(SPEC))}).then(function (r) {
                window.__at0852 = JSON.stringify(r);
              }),
              null)`,
          );
          await page.waitForCondition<boolean>("window.__at0852 !== undefined", { timeoutMs: 15_000 });
          return JSON.parse(await page.evalJS<string>("window.__at0852")) as Rendered;
        };

        // ── The PDF: one page, the figure's width ───────────────────────────
        const startedAt = Date.now();
        const pdf = await render("pdf");
        note(`at0852 pdf render: ${Date.now() - startedAt} ms, ${JSON.stringify({ ...pdf, html: pdf.html.length })}`);
        expect(pdf.result, "the figure rendered").toBe("ok");
        paths.push(pdf.path);
        const bytes = readFileSync(pdf.path);
        expect(bytes.subarray(0, 4).toString("latin1"), "the file is a PDF").toBe("%PDF");
        expect(pdf.pages, "one page").toBe(1);
        const width = pdfPointWidth(pdf.path);
        note(`at0852 pdf page width ${width} pt, height ${pdf.height}`);
        expect(width, "the page is the figure plus its margin, not the 720 column").toBe(FIGURE_WIDTH + 2 * MARGIN);
        expect(pdf.height, "taller than the figure's own height").toBeGreaterThan(260);

        // ── The PNG is the same picture ─────────────────────────────────────
        const png = await render("png");
        expect(png.result).toBe("ok");
        paths.push(png.path);
        const decoded = decodePngFile(png.path);
        note(`at0852 png ${decoded.width}×${decoded.height}`);
        expect(decoded.width, "the PNG is the same width, at the backing scale").toBe(Math.round(width * scale));

        // ── Share opens the sheet ───────────────────────────────────────────
        const before = await app.windowState();
        expect(before.isKeyWindow, "the card's window holds the keyboard before Share").toBe(true);
        const pressed = Date.now();
        await page.nativeClickAtElement(SHARE);
        const deadline = Date.now() + 15_000;
        let state = await app.windowState();
        while ((state.isKeyWindow || !state.appKeyWindow) && Date.now() < deadline) {
          await Bun.sleep(100);
          state = await app.windowState();
        }
        note(`at0852 sheet after ${Date.now() - pressed} ms: ${JSON.stringify(state)}`);
        expect(state.isKeyWindow, "the preview sheet took the keyboard").toBe(false);
        await page.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHARE)}).getAttribute("aria-busy") !== "true"`,
          { timeoutMs: 4_000 },
        );
        await app.nativeKey("Escape");
        const gone = Date.now() + 4_000;
        let after = await app.windowState();
        while (!after.isKeyWindow && Date.now() < gone) {
          await Bun.sleep(100);
          after = await app.windowState();
        }
        expect(after.isKeyWindow, "Escape dismissed the sheet").toBe(true);
      } catch (err) {
        const lines = app
          .tugappLog()
          .split("\n")
          .filter((line) => /share|pageFault|fault/i.test(line));
        note(`at0852 tugapp.log share lines:\n${lines.slice(-30).join("\n")}`);
        throw err;
      } finally {
        await app.close();
        for (const path of paths) rmSync(path, { force: true });
        rmTempTugbank(tugbankPath);
      }
    },
    120_000,
  );
});
