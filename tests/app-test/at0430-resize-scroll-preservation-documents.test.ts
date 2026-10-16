/**
 * at0430-resize-scroll-preservation-documents.test.ts — changing a
 * document card's width never moves what the reader is looking at.
 *
 * One piece of the at0430 split; the decks and instruments are
 * `resize-scroll-preservation-fixture.ts`. Each gesture is asserted to have
 * raised a resize episode (the frame's `data-resize-episode` stamp), so a
 * card whose content happens not to reflow at that width cannot pass while
 * the mechanism is dead.
 *
 *  1. **The generic fallback on a plain-flow card.** A card that never took
 *     over its own scrolling owns no anchor semantics and never claims the
 *     episode, so it is held by the module's own element anchor in the PANE's
 *     content box — a different code path from the transcript's resolver, and
 *     the one every future card inherits by default.
 *  2. **The document substrate, in its own unit.** A CodeMirror view claims
 *     the episode and holds the character under the top edge. Its assertion is
 *     WHICH LINE stands at the top rather than a pixel, because soft wrap
 *     means holding the top edge is exactly what makes the text beneath it
 *     move.
 *  3. **The PDF, where an element anchor is the wrong answer.** Its layout is
 *     derived from a scale that IS the card's width, so a page's top edge is
 *     not a fixed point. The assertion is the page and the fraction of the way
 *     down it — the two quantities a re-scale leaves alone.
 *
 * `TugMarkdownView` is not driven: it ships in the gallery only and claims
 * nothing, and the episode's own anchor descends past its aria-hidden spacers
 * to the block under the top edge, which the plain-flow case pins.
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
import { chooseWidth } from "./fixtures/card-width";
import { encodePdf } from "./fixtures/pdf";
import {
  AFTER_LAND_MS,
  ANCHOR_TOLERANCE_PX,
  FRAME,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  WRAPPED_ROW_TOLERANCE_PX,
  armEpisodeWatch,
  claimSubject,
  episodeCount,
  galleryDeck,
  paneWidth,
  readSubject,
  textDeck,
  wait,
  waitForEpisodesClosed,
} from "./resize-scroll-preservation-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0430 — a width change never moves what the reader is looking at",
  () => {
    test(
      "a plain-flow card is held by the generic element anchor",
      async () => {
        // A card that never took over its own scrolling scrolls in the PANE's
        // content box, owns no anchor semantics, and never claims the episode
        // — so the module's own element anchor holds it. That is the path
        // every card inherits without writing a line of code, and it is what
        // lets the invariant be stated for cards of all types rather than for
        // the ones that opted in.
        //
        // The gesture is the deck-wide Card Width, a third raise site and the
        // one that bypasses `movePane` entirely.
        const app = await launchTugApp({ testName: "at0430-plain-flow" });
        try {
          await app.seedDeckState({ state: galleryDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll('.tug-pane[data-pane-id]').length === 1`,
            { timeoutMs: 8_000 },
          );
          await wait(AFTER_LAND_MS);

          const scroller = `${FRAME} .tug-pane-content`;
          await app.waitForCondition<boolean>(
            `(function () {
              var el = document.querySelector(${JSON.stringify(scroller)});
              return el !== null && el.scrollHeight > el.clientHeight + 200;
            })()`,
            { timeoutMs: 10_000 },
          );
          await armEpisodeWatch(app, FRAME);

          await app.evalJS<null>(
            `(function () {
              var el = document.querySelector(${JSON.stringify(scroller)});
              el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) * 0.4);
              el.dispatchEvent(new Event("scroll", { bubbles: true }));
              return null;
            })()`,
          );
          await wait(300);

          const before = await claimSubject(app, scroller);
          const widthBefore = await paneWidth(app, FRAME);
          const episodesBefore = await episodeCount(app);

          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("set-content-width", { preset: "slim" }), null)`,
          );
          await waitForEpisodesClosed(app, FRAME);

          const widthAfter = await paneWidth(app, FRAME);
          expect(widthAfter).not.toBe(widthBefore);
          expect(await episodeCount(app)).toBeGreaterThan(episodesBefore);

          const after = await readSubject(app, scroller);
          expect(after).not.toBeNull();
          note(
            `plain flow: width ${widthBefore}→${widthAfter},` +
              ` subject delta ${before.delta}→${after!.delta},` +
              ` scrollTop ${before.scrollTop}→${after!.scrollTop}`,
          );
          expect(Math.abs(after!.delta - before.delta)).toBeLessThanOrEqual(
            ANCHOR_TOLERANCE_PX,
          );
          // Stated separately because it is the failure this leg actually
          // caught: a scroller the module could find no anchor element for
          // used to resolve to the TOP, so "we could not find your place"
          // was answered by throwing the reader back to the beginning of the
          // document — worse than the drift the module exists to prevent, and
          // invisible to a delta-only assertion on content that happens to
          // reflow. Zero is not a preserved position.
          expect(after!.scrollTop).toBeGreaterThan(0);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a CodeMirror document holds its viewport-top line",
      async () => {
        // The CM6 substrate claims the episode with an anchor of its own, in
        // the unit that survives a re-wrap: the line. The file is long, soft
        // wrapped, and made of lines far wider than the card, so narrowing it
        // genuinely re-flows the document rather than nudging it.
        const dir = mkdtempSync(join(tmpdir(), "at0430-"));
        const file = join(dir, "wrap.txt");
        writeFileSync(
          file,
          Array.from(
            { length: 300 },
            (_unused, i) =>
              `line ${i}: ` + "the quick brown fox jumps over the lazy dog. ".repeat(6),
          ).join("\n") + "\n",
          "utf8",
        );

        const app = await launchTugApp({ testName: "at0430-text-card" });
        try {
          await app.seedDeckState({
            state: textDeck(),
            cardStates: {
              A: { content: { path: file, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
            },
            focusCardId: "A",
          });
          const editor = `${FRAME} [data-slot="tug-text-card-editor"] .cm-scroller`;
          await app.waitForCondition<boolean>(
            `(function () {
              var el = document.querySelector(${JSON.stringify(editor)});
              return el !== null && el.scrollHeight > el.clientHeight + 200;
            })()`,
            { timeoutMs: 15_000 },
          );
          await wait(AFTER_LAND_MS);
          await armEpisodeWatch(app, FRAME);

          await app.evalJS<null>(
            `(function () {
              var el = document.querySelector(${JSON.stringify(editor)});
              el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) * 0.4);
              el.dispatchEvent(new Event("scroll", { bubbles: true }));
              return null;
            })()`,
          );
          await wait(400);

          // The claim is measured on the document's own unit, read straight
          // from the DOM: WHICH LINE stands at the viewport top.
          //
          // The pixel form the other cases use does not transfer here, and
          // the reason is soft wrap. Narrowing the card makes the line under
          // the top edge taller by a row or more, so every block below it
          // moves down by that much no matter how exactly the reader's place
          // is kept — holding the top edge is precisely what makes the text
          // beneath it shift. What must not change is the line the reader is
          // looking at, and how far into it they are, to within the row the
          // re-wrap added.
          const topLineJS = `(function () {
            var el = document.querySelector(${JSON.stringify(editor)});
            var top = el.getBoundingClientRect().top;
            var lines = el.querySelectorAll(".cm-line");
            for (var i = 0; i < lines.length; i++) {
              var r = lines[i].getBoundingClientRect();
              if (r.bottom > top + 1) {
                return {
                  text: (lines[i].textContent || "").slice(0, 40),
                  delta: Math.round(r.top - top),
                  scrollTop: Math.round(el.scrollTop),
                };
              }
            }
            return null;
          })()`;
          const before = await app.evalJS<{
            text: string;
            delta: number;
            scrollTop: number;
          }>(topLineJS);
          const widthBefore = await paneWidth(app, FRAME);
          const episodesBefore = await episodeCount(app);

          await chooseWidth(app, "p1", "slim");
          await waitForEpisodesClosed(app, FRAME);

          const widthAfter = await paneWidth(app, FRAME);
          expect(widthAfter).not.toBe(widthBefore);
          expect(await episodeCount(app)).toBeGreaterThan(episodesBefore);

          const after = await app.evalJS<{
            text: string;
            delta: number;
            scrollTop: number;
          }>(topLineJS);
          note(
            `text card: width ${widthBefore}→${widthAfter},` +
              ` top line "${before.text.slice(0, 12)}"→"${after.text.slice(0, 12)}",` +
              ` delta ${before.delta}→${after.delta},` +
              ` scrollTop ${before.scrollTop}→${after.scrollTop}`,
          );
          // The same line, still at the top. Unanchored this lands hundreds
          // of lines away, so the string compare is the sharp end of the
          // assertion and the pixel bound below is the fine adjustment.
          expect(after.text).toBe(before.text);
          expect(Math.abs(after.delta - before.delta)).toBeLessThanOrEqual(
            WRAPPED_ROW_TOLERANCE_PX,
          );
          // Narrowing a soft-wrapped document makes it taller, so holding the
          // same place means `scrollTop` MOVED. A number that did not move is
          // a document that did not re-wrap, and this case would be proving
          // nothing at all.
          expect(after.scrollTop).not.toBe(before.scrollTop);
        } finally {
          await app.close();
          rmSync(dir, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );

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
          await app.waitForCondition<boolean>(
            `document.querySelector('${surface} [data-pdf-page-status="rendered"]') !== null`,
            { timeoutMs: 30_000 },
          );
          await wait(AFTER_LAND_MS);

          const pdfFrame = await app.evalJS<string>(
            `(function () {
              var pane = document.querySelector('${surface}').closest(".tug-pane");
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
          await app.evalJS<null>(
            `(function () {
              var el = document.querySelector('${surface}');
              el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) * 0.35);
              el.dispatchEvent(new Event("scroll", { bubbles: true }));
              return null;
            })()`,
          );
          await wait(500);

          const before = await app.evalJS<{
            page: number;
            fraction: number;
            scrollTop: number;
          }>(placeJS);
          const widthBefore = await paneWidth(app, pdfFrame);
          const episodesBefore = await episodeCount(app);

          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("set-content-width", { preset: "slim" }), null)`,
          );
          await waitForEpisodesClosed(app, pdfFrame);

          const widthAfter = await paneWidth(app, pdfFrame);
          expect(widthAfter).not.toBe(widthBefore);
          expect(await episodeCount(app)).toBeGreaterThan(episodesBefore);

          const after = await app.evalJS<{
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
