/**
 * sc-image-pdf.test.ts — the site's Image-and-PDF still: a viewer card over
 * an image beside a viewer card over a PDF, one window capture per mode.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that the still was written. Run by path, once per
 * mode (`_site-clips.ts` has the invocation); skips unless the runner and
 * both site variables are set.
 *
 * The scene: two `file-view` cards, seeded the way `at0310-file-view-open`
 * reaches them — one bound to a PNG (the site's own tall illustration), one
 * to a PDF (a journal post typeset by the site's tools), both staged under
 * one plain directory so the masthead's path reads cleanly. The two stand
 * side by side in a two-up under Fit, and the whole content area is
 * captured; the site's `tools/crop-excerpts.mjs` cuts each card out of the
 * still. The files are the site's to supply: `TUG_SITE_IMAGE` and
 * `TUG_SITE_PDF` name them, and the driver copies them into the scene.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { onTestRunEnd } from "../_harness/test-cleanup";
import { standUpKind } from "../body-grounding/_kind-bodies";
import { cardKind, kindPane } from "../body-grounding/_kinds";
import { MODE, RUNS, THEME_FOR_MODE, contentSize, launchForMode, outDirFor, standIns, stillTo } from "./_site-clips";

const TEST_TIMEOUT_MS = 110_000;
const IMAGE = "sc-image";
const PDF = "sc-pdf";

/** The scene's directory: plain, since the masthead prints the path; the files keep their own names. */
const PROJECT_DIR = "/tmp/tug-site";
const scenePath = (dir: string, file: string): string => join(PROJECT_DIR, dir, basename(file));

const CARD_IMG = '[data-slot="file-view-card"] img.tugx-image-img';
const PDF_SURFACE = '[data-slot="file-view-pdf"]';
const PDF_CANVAS = `${PDF_SURFACE} [data-slot="pdf-page"] canvas`;

function deck(imagePath: string, pdfPath: string): Record<string, unknown> {
  return {
    cards: [
      { id: IMAGE, componentId: "file-view", title: basename(imagePath), closable: true },
      { id: PDF, componentId: "file-view", title: basename(pdfPath), closable: true },
    ],
    panes: [kindPane("file-view", IMAGE, 0), kindPane("file-view", PDF, 1)],
    activePaneId: `${IMAGE}-pane`,
    imposition: { kind: "two-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

describe.skipIf(!RUNS)("site still: Image and PDF", () => {
  test(
    "captures a viewer card over an image beside a viewer card over a PDF",
    async () => {
      const image = process.env.TUG_SITE_IMAGE;
      const pdf = process.env.TUG_SITE_PDF;
      if (image === undefined || pdf === undefined) throw new Error("sc-image-pdf: TUG_SITE_IMAGE and TUG_SITE_PDF name the files to show");
      const IMAGE_PATH = scenePath("art", image);
      const PDF_PATH = scenePath("docs", pdf);
      mkdirSync(join(PROJECT_DIR, "art"), { recursive: true });
      mkdirSync(join(PROJECT_DIR, "docs"), { recursive: true });
      onTestRunEnd(() => rmSync(PROJECT_DIR, { recursive: true, force: true }));
      copyFileSync(image, IMAGE_PATH);
      copyFileSync(pdf, PDF_PATH);

      // An empty launch deck: the cards mount from the seed below, with their
      // states, rather than from the restore (see `launchForMode`).
      const app = await launchForMode("sc-image-pdf", { cards: [], panes: [], imposition: { sidebars: {} } });
      try {
        await app.seedDeckState({
          state: deck(IMAGE_PATH, PDF_PATH),
          cardStates: {
            [IMAGE]: { content: { path: IMAGE_PATH } },
            [PDF]: { content: { path: PDF_PATH, view: { pageMode: "continuous", zoom: "fit-width" } } },
          },
          focusCardId: IMAGE,
        });
        const viewer = await standUpKind(app, cardKind("file-view"), IMAGE);
        const reader = await standUpKind(app, cardKind("file-view"), PDF);
        // The image's bytes have arrived and decoded.
        await viewer.waitForCondition<boolean>(
          `(function(){ var el = document.querySelector(${JSON.stringify(CARD_IMG)}); return el !== null && el.naturalWidth > 0; })()`,
          { timeoutMs: 20_000 },
        );
        // The document's first page has rendered.
        await reader.waitForCondition<boolean>(
          `(function(){ var c = document.querySelector(${JSON.stringify(PDF_CANVAS)}); return c !== null && c.width > 0; })()`,
          { timeoutMs: 30_000 },
        );
        await Bun.sleep(1_500);
        expect(
          await app.evalJS<string>(`document.documentElement.dataset.themeMode || ""`),
          "the window is still in the mode being recorded",
        ).toBe(MODE ?? "");

        const outDir = outDirFor("image-pdf");
        const { scale } = await stillTo(app, undefined, join(outDir, "still.png"));
        const content = await contentSize(app);
        // Where each card stands, in content points, for the site's crop table.
        const cards = await standIns(app);
        writeFileSync(
          join(outDir, "reading.json"),
          JSON.stringify({ clip: "image-pdf", mode: MODE, theme: THEME_FOR_MODE[MODE!], scale, crop: null, contentWidth: content.width, contentHeight: content.height, cards, image: IMAGE_PATH, pdf: PDF_PATH }, null, 2),
        );
        expect(scale, "the still was taken").toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
