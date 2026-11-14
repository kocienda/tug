/**
 * at0430-resize-scroll-preservation-documents-codemirror.test.ts — changing a
 * CodeMirror document card's width never moves the line the reader is
 * looking at.
 *
 * One of the at0430-resize-scroll-preservation split, a test to a file so each
 * launch fits its own budget (it was the second of the three document cases
 * in `at0430-resize-scroll-preservation-documents`; the others are
 * `-documents-plain-flow` and `-documents-pdf`). The decks and instruments are
 * `resize-scroll-preservation-fixture.ts`. The gesture is asserted to have
 * raised a resize episode (the frame's `data-resize-episode` stamp), so a
 * card whose content happens not to reflow at that width cannot pass while
 * the mechanism is dead.
 *
 *  2. **The document substrate, in its own unit.** A CodeMirror view claims
 *     the episode and holds the character under the top edge. Its assertion is
 *     WHICH LINE stands at the top rather than a pixel, because soft wrap
 *     means holding the top edge is exactly what makes the text beneath it
 *     move.
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
import { waitForBodyReady } from "./_harness/card-reach";
import { chooseWidth } from "./fixtures/card-width";
import {
  AFTER_LAND_MS,
  FRAME,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  WRAPPED_ROW_TOLERANCE_PX,
  armEpisodeWatch,
  episodeCount,
  paneWidth,
  textDeck,
  wait,
  waitForEpisodesClosed,
} from "./resize-scroll-preservation-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0430 — a width change never moves what the reader is looking at",
  () => {
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
          // The editor is in the card's body; the pane frame is the shell's.
          const card = await waitForBodyReady(app, "A");
          const editor = `[data-slot="tug-text-card-editor"] .cm-scroller`;
          await card.waitForCondition<boolean>(
            `(function () {
              var el = document.querySelector(${JSON.stringify(editor)});
              return el !== null && el.scrollHeight > el.clientHeight + 200;
            })()`,
            { timeoutMs: 15_000 },
          );
          await wait(AFTER_LAND_MS);
          await armEpisodeWatch(app, FRAME);

          await card.evalJS<null>(
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
          const before = await card.evalJS<{
            text: string;
            delta: number;
            scrollTop: number;
          }>(topLineJS);
          const widthBefore = await paneWidth(app, FRAME);
          const episodesBefore = await episodeCount(app);

          // The pane's chrome, width popup and all, is the card's own page's.
          await chooseWidth(app, "p1", "slim", "A");
          await waitForEpisodesClosed(app, FRAME, episodesBefore);

          const widthAfter = await paneWidth(app, FRAME);
          expect(widthAfter).not.toBe(widthBefore);
          expect(await episodeCount(app)).toBeGreaterThan(episodesBefore);

          const after = await card.evalJS<{
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
  },
);
