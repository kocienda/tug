/**
 * at0852-figure-share-pdf.test.ts — a chart rendered as a PDF through the
 * share path is one page at the figure's own width, and the header's Share
 * button opens the figure's share sheet on its card.
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
 *   - A native click on the header's Share button opens the share sheet on
 *     the card, in the deck and not in a window of its own: the figure
 *     drawn as a picture, a Format choice that opens on Image, and the
 *     share family's bottom row with Copy, Save… and Share… behind an
 *     action button that opens on Save…. Done dismisses it.
 *
 * @covers tugdeck/src/lib/chart/render-chart.ts
 * @covers tugdeck/src/lib/chart/figure-export.ts
 * @covers tugdeck/src/lib/share-turns.ts
 * @covers tugdeck/src/share/share-main.ts
 * @covers tugdeck/src/share/share-page.css
 * @covers tugapp/Sources/ShareRenderer.swift
 * @covers tugapp/Sources/ShareRenderOutput.swift
 * @covers tugapp/Sources/MainWindow.swift
 * @covers tugdeck/src/lib/chart/figure-share-open.ts
 * @covers tugdeck/src/components/tugways/cards/figure-share-sheet.tsx
 * @covers tugdeck/src/components/tugways/cards/figure-share-sheet.css
 * @covers tugdeck/src/components/tugways/cards/share-parts.tsx
 * @covers tugdeck/src/components/tugways/cards/share-parts.css
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
const SHEET = '[data-testid="figure-share-sheet"]';

interface SheetReading {
  title: string;
  pictureState: string | null;
  pictureIsPicture: boolean;
  formats: string[];
  format: string | null;
  action: string | null;
  goLabel: string;
  hasDone: boolean;
  familyRow: boolean;
}

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
        const pressed = Date.now();
        await page.nativeClickAtElement(SHARE);
        await page.waitForCondition<boolean>(
          `(function () {
            var p = document.querySelector('${SHEET} [data-testid="figure-share-picture"] .tugx-chart');
            return p !== null && p.getAttribute("data-tugx-chart-state") === "rendered";
          })()`,
          { timeoutMs: 10_000 },
        );
        note(`at0852 sheet with its picture after ${Date.now() - pressed} ms`);
        const state = await app.windowState();
        expect(state.isKeyWindow, "the sheet is the deck's own: the card's window keeps the keyboard").toBe(true);
        const sheet = JSON.parse(
          await page.evalJS<string>(
            `(function () {
              var sheet = document.querySelector('${SHEET}');
              var q = function (sel) { return sheet.querySelector(sel); };
              var dialog = sheet.closest('[role="dialog"]') || document;
              var title = dialog.querySelector(".tug-sheet-title");
              var picture = q('[data-testid="figure-share-picture"] .tugx-chart');
              var format = q('[data-testid="figure-share-format"]');
              var options = Array.prototype.slice.call(format.querySelectorAll('[role="radio"], button'));
              var chosen = options.filter(function (o) {
                return o.getAttribute("aria-checked") === "true" || o.getAttribute("aria-pressed") === "true" || o.getAttribute("data-state") === "on";
              })[0];
              var go = q('[data-testid="figure-share-go"]');
              return JSON.stringify({
                title: title === null ? "" : title.textContent,
                pictureState: picture.getAttribute("data-tugx-chart-state"),
                pictureIsPicture: picture.hasAttribute("data-tugx-chart-picture"),
                formats: options.map(function (o) { return o.textContent.trim(); }),
                format: chosen === undefined ? null : chosen.textContent.trim(),
                action: go.getAttribute("data-share-action"),
                goLabel: go.querySelector(".share-parts__stable-label > span").textContent,
                hasDone: q('[data-testid="figure-share-done"]') !== null,
                familyRow: q(".share-parts__actions") !== null,
              });
            })()`,
          ),
        ) as SheetReading;
        note(`at0852 sheet: ${JSON.stringify(sheet)}`);
        expect(sheet.title, "the sheet is titled for a chart").toBe("Share Chart");
        expect(sheet.pictureIsPicture, "the figure is drawn as the picture that leaves").toBe(true);
        expect(sheet.formats, "the family's format names").toEqual(["PDF", "Image"]);
        expect(sheet.format, "the sheet opens on Image").toBe("Image");
        expect(sheet.action, "the sheet opens on Save…").toBe("save");
        expect(sheet.goLabel).toBe("Save…");
        expect(sheet.familyRow && sheet.hasDone, "the share family's bottom row, with Done").toBe(true);

        await page.nativeClickAtElement(`${SHEET} [data-testid="figure-share-done"]`);
        await page.waitForCondition<boolean>(`document.querySelector('${SHEET}') === null`, { timeoutMs: 4_000 });
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
