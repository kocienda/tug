/**
 * at0430-resize-scroll-preservation-documents-pdf.test.ts — changing a PDF
 * card's width never moves the page, or how far down it, the reader is.
 *
 * One of the at0430-resize-scroll-preservation split, a test to a file so each
 * launch fits its own budget (it was the third of the three document cases in
 * `at0430-resize-scroll-preservation-documents`; the others are
 * `-documents-plain-flow` and `-documents-codemirror`). The decks and
 * instruments are `resize-scroll-preservation-fixture.ts`. The gesture is
 * asserted to have raised a resize episode (the frame's
 * `data-resize-episode` stamp), so a card whose content happens not to reflow
 * at that width cannot pass while the mechanism is dead.
 *
 *  3. **The PDF, where an element anchor is the wrong answer.** Its layout is
 *     derived from a scale that IS the card's width, so a page's top edge is
 *     not a fixed point. The assertion is the page and the fraction of the way
 *     down it — the two quantities a re-scale leaves alone.
 *
 * @covers tugdeck/src/lib/resize-episode.ts
 * @covers tugdeck/src/lib/cm6-scroll-anchor.ts
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.tsx
 * @covers tugdeck/src/lib/smart-scroll.ts
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/components/tugways/cards/pdf-view.tsx
 * @covers tugdeck/src/lib/pdf-layout.ts
 * @family at0430-resize-scroll-preservation
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note } from "./_harness";
import { bodyOfKind } from "./_harness/card-reach";
import { encodePdf } from "./fixtures/pdf";
import {
  AFTER_LAND_MS,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  armEpisodeWatch,
  episodeCount,
  paneWidth,
  wait,
  waitForEpisodesClosed,
} from "./resize-scroll-preservation-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0430 — a width change never moves what the reader is looking at",
  () => {
    test(
      "a PDF holds its page and how far down it the reader is",
      async () => {
        // The PDF surface is the one place where holding an element's top edge
        // is the WRONG answer. Every number in its layout comes from a scale,
        // and under fit-width the scale is the card's width — narrowing the
        // card renders every page smaller, so a page's top edge is not a fixed
        // point and the reader slides up it. The page and the fraction of the
        // way down it are what survive, and that is what this asserts.
        const dir = mkdtempSync(join(tmpdir(), "at0430-pdf-"));
        const file = join(dir, "twelve-pages.pdf");
        writeFileSync(file, encodePdf(12));

        const app = await launchTugApp({
          testName: "at0430-pdf",
          skipAccessibilityPreflight: true,
        });
        try {
          await app.dispatchControlAction("open-file", { path: file });
          const surface = '[data-slot="file-view-pdf"]';
          // The opened file is a File View card in a body of its own; its
          // pane is the shell's, found by the card's placeholder there.
          const card = await bodyOfKind(app, "file-view");
          await card.waitForCondition<boolean>(
            `document.querySelector('${surface} [data-pdf-page-status="rendered"]') !== null`,
            { timeoutMs: 30_000 },
          );
          await wait(AFTER_LAND_MS);

          const pdfFrame = await app.evalJS<string>(
            `(function () {
              var lid = document.querySelector('[data-body-placeholder][data-card-id=${JSON.stringify(card.cardId)}]');
              var pane = lid === null ? null : lid.closest(".tug-pane");
              if (pane === null) throw new Error("the PDF is not in a pane");
              return '.tug-pane[data-pane-id="' + pane.getAttribute("data-pane-id") + '"]';
            })()`,
          );
          await armEpisodeWatch(app, pdfFrame);

          // A third of the way down a page well into the document, so both
          // the page number and the fraction are non-trivial.
          const placeJS = `(function () {
            var el = document.querySelector('${surface}');
            var top = el.getBoundingClientRect().top;
            var pages = el.querySelectorAll('[data-slot="pdf-page"]');
            for (var i = 0; i < pages.length; i++) {
              var r = pages[i].getBoundingClientRect();
              if (r.bottom > top + 1) {
                return {
                  page: Number(pages[i].dataset.pdfPage),
                  fraction: (top - r.top) / r.height,
                  scrollTop: Math.round(el.scrollTop),
                };
              }
            }
            return null;
          })()`;
          await card.evalJS<null>(
            `(function () {
              var el = document.querySelector('${surface}');
              el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) * 0.35);
              el.dispatchEvent(new Event("scroll", { bubbles: true }));
              return null;
            })()`,
          );
          await wait(500);

          const before = await card.evalJS<{
            page: number;
            fraction: number;
            scrollTop: number;
          }>(placeJS);
          const widthBefore = await paneWidth(app, pdfFrame);
          const episodesBefore = await episodeCount(app);

          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("set-content-width", { preset: "slim" }), null)`,
          );
          await waitForEpisodesClosed(app, pdfFrame, episodesBefore);

          const widthAfter = await paneWidth(app, pdfFrame);
          expect(widthAfter).not.toBe(widthBefore);
          expect(await episodeCount(app)).toBeGreaterThan(episodesBefore);

          const after = await card.evalJS<{
            page: number;
            fraction: number;
            scrollTop: number;
          }>(placeJS);
          note(
            `pdf: width ${widthBefore}→${widthAfter},` +
              ` page ${before.page}→${after.page},` +
              ` fraction ${before.fraction.toFixed(3)}→${after.fraction.toFixed(3)},` +
              ` scrollTop ${before.scrollTop}→${after.scrollTop}`,
          );
          expect(after.page).toBe(before.page);
          // A page's own height scales with the card, so the fraction is the
          // scale-free statement of the reader's place — a hundredth of a
          // page is under a millimetre of paper.
          expect(Math.abs(after.fraction - before.fraction)).toBeLessThanOrEqual(
            0.01,
          );
        } finally {
          await app.close();
          rmSync(dir, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
