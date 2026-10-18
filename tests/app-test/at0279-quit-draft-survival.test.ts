/**
 * at0279-quit-draft-survival.test.ts — the termination pipeline
 * persists what the user typed, and says so honestly.
 *
 * ## Why this exists
 *
 * `AppDelegate.applicationShouldTerminate` awaits
 * `window.tugdeck.prepareForTermination()` and tears down as soon as it
 * answers. Everything the user has not lost depends on that one call: it
 * captures every card, writes the bags, retries the writes tugbank
 * rejected, and reports what actually landed.
 *
 * Two properties are pinned here, both against the real tugbank file the
 * app writes to — not the in-memory cache, which would pass even if every
 * write were dropped (the failure mode that motivated the pipeline: the
 * old quit path swallowed non-2xx responses and logged success anyway):
 *
 *   1. Typed text reaches the durable card-state bag.
 *   2. The layout reaches disk on quit. `saveAndFlushSync` — the old quit
 *      path — never cleared the pending layout timer and never called
 *      `saveLayout`, so a window move inside the 500 ms debounce was lost
 *      on ⌘Q. The unified teardown-save core always writes it.
 *
 * And the verdict itself is checked for shape and truthfulness: an idle
 * quit interrupts nothing, fails nothing, and reports `ok`.
 *
 * The process is deliberately *not* terminated — the harness transport
 * dies with the app. This drives the exact RPC the quit path drives, in
 * the same app, and reads the same file the relaunch would read.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/card-state-cache.ts
 * @covers tugdeck/src/teardown.ts
 * @covers tugdeck/src/layout-persistence.ts
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/settings-api.ts
 * @covers tugdeck/src/main.tsx
 * @covers tugapp/Sources/AppDelegate.swift
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App, type BodyApp } from "./_harness";
import { inputSelectorFor, INPUT_PERSIST_KEY } from "./_harness/fixtures";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankRead,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 60_000;

const CARD_ID = "A";
const TYPED = "survive-the-quit";

const CARDSTATE_DOMAIN = "dev.tugapp.deck.cardstate";
const LAYOUT_DOMAIN = "dev.tugapp.deck.layout";

/** The verdict shape `prepareForTermination` resolves. */
interface TerminationVerdict {
  ok: boolean;
  interrupted: string[];
  unacknowledged: string[];
  flushedCards: number;
  failedCards: string[];
  layoutSaved: boolean;
  elapsedMs: number;
}

/** Run the page's `prepareForTermination()` and return its verdict. */
async function runTermination(page: App | BodyApp): Promise<TerminationVerdict> {
  await page.evalJS<null>(
    `(function(){
      if (!window.tugdeck || typeof window.tugdeck.prepareForTermination !== "function") {
        throw new Error("window.tugdeck.prepareForTermination missing");
      }
      window.__quitVerdict = null;
      window.__quitError = null;
      window.tugdeck.prepareForTermination().then(
        function (v) { window.__quitVerdict = v; },
        function (e) { window.__quitError = String(e); },
      );
      return null;
    })()`,
  );
  await page.waitForCondition<boolean>(
    `window.__quitVerdict !== null || window.__quitError !== null`,
    { timeoutMs: 15_000 },
  );
  expect(await page.evalJS<string | null>(`window.__quitError`)).toBeNull();
  return page.evalJS<TerminationVerdict>(`window.__quitVerdict`);
}

describe.skipIf(!SHOULD_RUN)("m279: typing survives the termination pipeline", () => {
  test(
    "prepareForTermination writes the typed bag and the layout, and reports it",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);

      const app = await launchTugApp({
        testName: "at0279-quit-draft-survival",
        env: { TUGBANK_PATH: tugbankPath },
        skipAccessibilityPreflight: true,
        persistInTestMode: true,
      });
      try {
        await app.seedDeckState({
          state: {
            cards: [
              { id: CARD_ID, componentId: "gallery-input", title: "Card A", closable: true },
            ],
            panes: [
              {
                id: "p1",
                position: { x: 40, y: 40 },
                size: { width: 480, height: 320 },
                cardIds: [CARD_ID],
                activeCardId: CARD_ID,
                title: "",
                acceptsFamilies: ["maker"],
              },
            ],
            activePaneId: "p1",
            hasFocus: true,
          },
          focusCardId: CARD_ID,
        });

        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(CARD_ID)})`,
        );

        // Type into the card — the user state the whole pipeline exists for.
        await app.body(CARD_ID).nativeClickAtElement(inputSelectorFor(CARD_ID));
        await app.body(CARD_ID).waitForCondition<boolean>(
          `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(inputSelectorFor(CARD_ID))})`,
        );
        await app.body(CARD_ID).type(inputSelectorFor(CARD_ID), TYPED);
        expect(await app.getFormControlValue(CARD_ID, INPUT_PERSIST_KEY)).toBe(TYPED);

        // Drive the production quit RPC in each page the host asks: the
        // shell's, which owns the layout, and the card's body, which owns
        // the card's bag (`AppDelegate.applicationShouldTerminate` runs it
        // in every view). `evaluateJavaScript` does not await a promise, so
        // each verdict is parked and polled for — the same thing the host
        // does with `callAsyncJavaScript`, minus the native await.
        const shellVerdict = await runTermination(app);
        const bodyVerdict = await runTermination(app.body(CARD_ID));

        // An idle quit: nothing to interrupt, nothing left unwritten, in
        // either page.
        for (const verdict of [shellVerdict, bodyVerdict]) {
          expect(verdict.interrupted).toEqual([]);
          expect(verdict.unacknowledged).toEqual([]);
          expect(verdict.failedCards).toEqual([]);
          expect(verdict.ok).toBe(true);
          expect(typeof verdict.elapsedMs).toBe("number");
        }
        expect(shellVerdict.layoutSaved).toBe(true);
        expect(shellVerdict.flushedCards + bodyVerdict.flushedCards).toBeGreaterThan(0);

        // The verdict claims the writes landed. Check the file it wrote to.
        const bag = tugbankRead<{ formControls?: Record<string, unknown> }>(
          tugbankPath,
          CARDSTATE_DOMAIN,
          CARD_ID,
        );
        expect(bag).not.toBeNull();
        expect(JSON.stringify(bag?.value)).toContain(TYPED);

        // Layout on disk after a quit — the axis the old quit path dropped.
        const layout = tugbankRead<{ cards?: unknown[] }>(tugbankPath, LAYOUT_DOMAIN, "layout");
        expect(layout).not.toBeNull();
        expect(JSON.stringify(layout?.value)).toContain(CARD_ID);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0279-quit-draft-survival] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
