/**
 * at0805-gallery-find-bar-closes.test.ts — the gallery's find bar is hosted
 * the way a real one is, so it closes.
 *
 * `TugFindBar` asks to close by dispatching `close-find` to its parent
 * responder, and a host answers it through `useFindBarHost`. A gallery card
 * that mounted the bar with no host left the close button dead and Escape
 * consumed with nothing done. This holds, on the first demo of the
 * `gallery-tug-find-bar` card:
 *
 *  - a native click on the close button removes the bar;
 *  - the card's `Show Find Bar` button brings it back;
 *  - Escape typed in the bar's field removes it again.
 *
 * @covers tugdeck/src/components/tugways/cards/gallery-tug-find-bar.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp } from "./_harness";
import { bodyOfKind } from "./_harness/card-reach";
import { priorCardDeck } from "./_harness/shapes";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const DEMO = '[data-testid="gallery-tug-find-bar"] > .cg-section:first-child';
const BAR = `${DEMO} .tug-find-bar`;
const CLOSE = `${BAR} [aria-label="Close find bar"]`;
const FIELD = `${BAR} .cm-content`;
const SHOW = `${DEMO} [data-testid="gallery-find-bar-show"]`;

const present = (sel: string): string =>
  `document.querySelector(${JSON.stringify(sel)}) !== null`;
const absent = (sel: string): string =>
  `document.querySelector(${JSON.stringify(sel)}) === null`;

describe.skipIf(!SHOULD_RUN)("at0805 — the gallery find bar closes", () => {
  test(
    "the close button and Escape both close the bar, and Show Find Bar brings it back",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0805-gallery-find-bar-closes",
          env: { TUGBANK_PATH: tugbankPath },
        });
        try {
          await app.seedDeckState({
            state: priorCardDeck({
              card: { componentId: "gallery-tug-find-bar", title: "TugFindBar" },
              size: { width: 640, height: 520 },
            }),
            focusCardId: "A",
          });
          const page = await bodyOfKind(app, "gallery-tug-find-bar");
          await page.waitForCondition<boolean>(present(CLOSE), { timeoutMs: 10_000 });

          await page.nativeClickAtElement(CLOSE);
          await page.waitForCondition<boolean>(`${absent(BAR)} && ${present(SHOW)}`, {
            timeoutMs: 5_000,
          });

          await page.nativeClickAtElement(SHOW);
          await page.waitForCondition<boolean>(`${present(FIELD)} && ${absent(SHOW)}`, {
            timeoutMs: 5_000,
          });

          await page.nativeClickAtElement(FIELD);
          await page.waitForCondition<boolean>(
            `(function () {
               var field = document.querySelector(${JSON.stringify(FIELD)});
               return field !== null && field.contains(document.activeElement);
             })()`,
            { timeoutMs: 5_000 },
          );
          await app.nativeKey("Escape");
          await page.waitForCondition<boolean>(`${absent(BAR)} && ${present(SHOW)}`, {
            timeoutMs: 5_000,
          });

          // The second demo was never touched and keeps its bar.
          const others = await page.evalJS<number>(
            `document.querySelectorAll('[data-testid="gallery-tug-find-bar"] .tug-find-bar').length`,
          );
          expect(others).toBe(1);
        } finally {
          await app.close();
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
