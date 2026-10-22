/**
 * at0751-text-card-caret-height-under-zoom.test.ts — the Text card's painted
 * caret is the composer's caret at every deck zoom ([AT0751]).
 *
 * The defect this pins: the Text card wore WebKit's native caret, sized from
 * the font's ascent and descent rather than the row, and it stopped at the
 * baseline. Moving it onto the composer's painted caret (`tugPaintedCaret`)
 * changed nothing on an 80 % deck, because the layer's row-height fallback
 * for an editor without the `1lh` ruler was `view.defaultLineHeight` — a
 * `getBoundingClientRect` reading, so viewport px under a zoom — and the
 * layer multiplied it by the zoom again. The caret came out 72 % of the row
 * instead of 90 %, and read as the same baseline-stopping stroke it replaced.
 *
 * Asserted on the real pixels: the caret's height is `CARET_HEIGHT_FACTOR`
 * (0.9) of its `.cm-line`'s rendered height, and centred on it, at 80 %,
 * 100 % and 125 % — the first is the reported deck, the last catches a
 * division that only looks right below 1.
 *
 * @covers tugdeck/src/components/tugways/tug-text-editor/caret-layer.ts
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.tsx
 * @covers tugdeck/src/components/tugways/tug-text-card-editor/theme.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";
import { mkTextFixture } from "./_harness/fixtures";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const FILE_EDITOR = '[data-card-id="A"] [data-slot="tug-text-card-editor"]';
const CONTENT = `${FILE_EDITOR} .cm-content`;
const CARET = `${FILE_EDITOR} .tug-text-editor-caret`;

/** The composer's `CARET_HEIGHT_FACTOR`; the Text card must draw the same. */
const CARET_HEIGHT_FACTOR = 0.9;
/** Zoom factors: the reported deck, the default, and one above 1. */
const FACTORS = [0.8, 1, 1.25] as const;
/** Ratio slack: a 1 px rounding on a 16 px row. */
const RATIO_SLACK = 0.07;
/** Centre slack, viewport px. */
const CENTRE_SLACK_PX = 1.5;

interface CaretReading {
  caret: { top: number; height: number };
  line: { top: number; height: number };
  ratio: number;
  centreDelta: number;
}

async function seedTextCard(app: App, filePath: string): Promise<void> {
  await app.seedDeckState({
    state: {
      cards: [{ id: "A", componentId: "text", title: "File", closable: true }],
      panes: [
        {
          id: "p1",
          position: { x: 40, y: 40 },
          size: { width: 760, height: 560 },
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
      A: { content: { path: filePath, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
    },
    focusCardId: "A",
  });
  await app.body("A").waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(CONTENT)});
      return el !== null && el.innerText.indexOf("hello") !== -1;
    })()`,
    { timeoutMs: 15000 },
  );
}

/**
 * Focus the editor so the layer paints, wait for the stroke, and read it
 * against the line it sits on — both as `getBoundingClientRect`, so the
 * comparison is in the one coordinate space whatever the zoom.
 */
async function readCaret(app: App): Promise<CaretReading> {
  await app.body("A").evalJS<void>(
    `(function(){ document.querySelector(${JSON.stringify(CONTENT)}).focus(); })()`,
  );
  await app.body("A").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(CARET)}) !== null`,
    { timeoutMs: 5000 },
  );
  return app.body("A").evalJS<CaretReading>(
    `(function(){
      var caret = document.querySelector(${JSON.stringify(CARET)}).getBoundingClientRect();
      var line = document.querySelector(${JSON.stringify(CONTENT)} + " .cm-line").getBoundingClientRect();
      var caretCentre = caret.top + caret.height / 2;
      var lineCentre = line.top + line.height / 2;
      return {
        caret: { top: caret.top, height: caret.height },
        line: { top: line.top, height: line.height },
        ratio: caret.height / line.height,
        centreDelta: caretCentre - lineCentre,
      };
    })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0751: the Text card's caret under zoom", () => {
  test(
    "the caret is 90 % of its row and centred on it at 80 %, 100 % and 125 %",
    async () => {
      const { file } = mkTextFixture("at0751-", "hello world\nsecond line\n");
      const app = await launchTugApp({
        testName: "at0751-text-card-caret-height-under-zoom",
      });
      const readings: Record<string, CaretReading> = {};
      try {
        await seedTextCard(app, file);
        for (const f of FACTORS) {
          expect(await app.setPageZoom(f)).toBeCloseTo(f, 5);
          const got = await readCaret(app);
          readings[`zoom ${f}`] = got;
          expect(
            Math.abs(got.ratio - CARET_HEIGHT_FACTOR),
            `zoom ${f}: caret is ${got.caret.height.toFixed(2)} px on a ${got.line.height.toFixed(2)} px row (${got.ratio.toFixed(3)} of it, want ${CARET_HEIGHT_FACTOR})`,
          ).toBeLessThanOrEqual(RATIO_SLACK);
          expect(
            Math.abs(got.centreDelta),
            `zoom ${f}: caret centre is ${got.centreDelta.toFixed(2)} px off the row's`,
          ).toBeLessThanOrEqual(CENTRE_SLACK_PX);
        }
        note("caret by zoom", readings);
        await app.setPageZoom(1);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
