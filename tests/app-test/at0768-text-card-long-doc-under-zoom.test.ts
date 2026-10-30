/**
 * at0768-text-card-long-doc-under-zoom.test.ts — a Text card opened on an 80 %
 * deck keeps its caret and its gutter on the text however long the document is
 * ([AT0768]).
 *
 * The defect this pins: CodeMirror read its zoom as `rect.height /
 * offsetHeight`. A view that first measures while its content is one line tall
 * reads, on an 80 % deck, 19.31 / 24 = 0.8047. CM6 only adopted a new scale past
 * a 0.005 difference, so 0.8047 stayed for the view's whole life. Each rendered
 * line's gutter cell then came out 0.6 % short, which sums to a visible error
 * across the hundred-odd lines a long document renders, and the caret landed
 * above its row by 0.6 % of its distance from the scroller's top. A short
 * document never shows it, which is why it read as a long-document bug.
 *
 * The harness's mount measures at full height and never lands in that state, so
 * the test puts the view there: it writes the exact value read off the reported
 * card into the view state and asks for a measure. The next measure must correct
 * it. Asserted on real pixels, with the caret far down a tall scrollport, where
 * the error is largest: the caret is centred on the row holding it, and every
 * gutter number's top stays on its line's top.
 *
 * @covers tugdeck/patches/@codemirror%2Fview@6.41.1.patch
 * @covers tugdeck/src/components/tugways/tug-text-editor/caret-layer.ts
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";
import { mkTextFixture } from "./_harness/fixtures";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const FILE_EDITOR = '[data-card-id="A"] [data-slot="tug-text-card-editor"]';
const CONTENT = `${FILE_EDITOR} .cm-content`;
const CARET = `${FILE_EDITOR} .tug-text-editor-caret`;
const VIEW = `document.querySelector(${JSON.stringify(CONTENT)}).cmTile.root.view`;

/** The reported deck. */
const ZOOM = 0.8;
/** What the reported card's view held: one 24.14 px line, 19.3125 / 24. */
const STUCK_SCALE_Y = 0.8046875;
/** One LayoutUnit-and-a-bit of rounding, viewport px. */
const ALIGN_SLACK_PX = 0.5;
/** The caret centre against its row's: the row is a 16 px line at this zoom. */
const CENTRE_SLACK_PX = 1.5;
/** Long enough that the rendered lines sum the per-line error to several px. */
const LINE_COUNT = 400;
const LAST_LINE = "last line of the document";

/** Every line wraps once at the card's width, as prose in a real document does. */
function longDocument(): string {
  const prose = "the quick brown fox jumps over the lazy dog ".repeat(4).trim();
  const lines: string[] = [];
  for (let i = 0; i < LINE_COUNT; i++) lines.push(i % 3 === 2 ? "" : `${i} ${prose}`);
  lines.push(LAST_LINE);
  return lines.join("\n");
}

interface Reading {
  scaleY: number;
  scrollTop: number;
  rendered: number;
  worstGutterDelta: number;
  worstGutterLine: string;
  caretCentreDelta: number;
  caretFromScrollerTop: number;
}

async function settleTwoFrames(body: ReturnType<App["body"]>): Promise<void> {
  await body.evalJS<void>(
    `(function(){
      window.__at0768Settled = false;
      requestAnimationFrame(function(){
        requestAnimationFrame(function(){ window.__at0768Settled = true; });
      });
    })()`,
  );
  await body.waitForCondition<boolean>(`window.__at0768Settled === true`, {
    timeoutMs: 5000,
  });
}

describe.skipIf(!SHOULD_RUN)("at0768: a long Text card document under zoom", () => {
  test(
    "the caret and the gutter stay on the text at the end of a long document",
    async () => {
      const { file } = mkTextFixture("at0768-", longDocument());
      const app = await launchTugApp({
        testName: "at0768-text-card-long-doc-under-zoom",
      });
      try {
        expect(await app.setPageZoom(ZOOM)).toBeCloseTo(ZOOM, 5);
        await app.seedDeckState({
          state: {
            cards: [{ id: "A", componentId: "text", title: "File", closable: true }],
            panes: [
              {
                id: "p1",
                position: { x: 40, y: 40 },
                size: { width: 760, height: 900 },
                cardIds: ["A"],
                activeCardId: "A",
                title: "",
                acceptsFamilies: ["standard"],
              },
            ],
            activePaneId: "p1",
            hasFocus: true,
          },
          cardStates: {
            A: { content: { path: file, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
          },
          focusCardId: "A",
        });
        const body = app.body("A");
        await body.waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(CONTENT)});
            return el !== null && ${VIEW}.state.doc.lines === ${LINE_COUNT + 1};
          })()`,
          { timeoutMs: 15000 },
        );

        // The state the reported card was in: the scale its first measure left.
        await body.evalJS<void>(
          `(function(){
            var view = ${VIEW};
            view.viewState.scaleY = ${STUCK_SCALE_Y};
            view.viewState.mustMeasureContent = "refresh";
            view.requestMeasure();
          })()`,
        );
        await settleTwoFrames(body);

        // The caret at the very end of the document, focused and in view.
        await body.evalJS<void>(
          `(function(){
            var view = ${VIEW};
            view.focus();
            var end = view.state.doc.length;
            view.dispatch({ selection: { anchor: end }, scrollIntoView: true });
          })()`,
        );
        await body.waitForCondition<boolean>(
          `(function(){
            var caret = document.querySelector(${JSON.stringify(CARET)});
            if (caret === null) return false;
            var last = document.querySelector(${JSON.stringify(CONTENT)} + " .cm-line:last-of-type");
            return last !== null && last.textContent === ${JSON.stringify(LAST_LINE)};
          })()`,
          { timeoutMs: 5000 },
        );
        // Two frames: the measure that scrolled, then the one that settled it.
        await settleTwoFrames(body);

        const got = await body.evalJS<Reading>(
          `(function(){
            var view = ${VIEW};
            var host = document.querySelector(${JSON.stringify(FILE_EDITOR)});
            var lines = Array.prototype.slice.call(host.querySelectorAll(".cm-content .cm-line"));
            var byNumber = {};
            lines.forEach(function(el){
              byNumber[view.state.doc.lineAt(view.posAtDOM(el)).number] = el;
            });
            var worst = 0, worstLine = "";
            host.querySelectorAll(".cm-lineNumbers .cm-gutterElement").forEach(function(cell){
              var el = byNumber[cell.textContent];
              if (!el) return;
              var delta = cell.getBoundingClientRect().top - el.getBoundingClientRect().top;
              if (Math.abs(delta) > Math.abs(worst)) { worst = delta; worstLine = cell.textContent; }
            });
            var caret = document.querySelector(${JSON.stringify(CARET)}).getBoundingClientRect();
            var row = lines[lines.length - 1].getBoundingClientRect();
            var scroller = view.scrollDOM;
            return {
              scaleY: view.scaleY,
              scrollTop: scroller.scrollTop,
              rendered: lines.length,
              worstGutterDelta: worst,
              worstGutterLine: worstLine,
              caretCentreDelta: (caret.top + caret.height / 2) - (row.top + row.height / 2),
              caretFromScrollerTop: caret.top - scroller.getBoundingClientRect().top,
            };
          })()`,
        );
        note("reading", got);

        expect(got.rendered, "the document must render enough lines to sum the error").toBeGreaterThan(20);
        expect(got.scrollTop, "the card must be scrolled deep into the document").toBeGreaterThan(1000);
        expect(got.scaleY, "CM6's scale must be the deck's").toBeCloseTo(ZOOM, 3);
        expect(
          Math.abs(got.worstGutterDelta),
          `gutter number ${got.worstGutterLine} sits ${got.worstGutterDelta.toFixed(2)} px off its line`,
        ).toBeLessThanOrEqual(ALIGN_SLACK_PX);
        expect(
          Math.abs(got.caretCentreDelta),
          `the caret sits ${got.caretCentreDelta.toFixed(2)} px off its row, ${got.caretFromScrollerTop.toFixed(0)} px down the scroller`,
        ).toBeLessThanOrEqual(CENTRE_SLACK_PX);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
