/**
 * at0511-window-sidebar-marks.test.ts — View ▸ Jots's mark walks the
 * toggle's three rungs and back, and the parent row wears the same mark.
 *
 * One piece of the at0511-window-sidebar split (formerly
 * at0511-window-sidebar-rows), a test to a file so each launch fits its own
 * budget. The ladder these read, and why only the built menu reads it end to
 * end, is `window-sidebar-rows-fixture.ts`.
 *
 * @covers tugapp/Sources/AppDelegate.swift
 * @covers tugapp/Sources/MenuStateSync.swift
 * @covers tugdeck/src/lib/host-menu-state.ts
 * @covers tugdeck/src/components/tugways/command-registry.ts
 * @covers tugdeck/src/sidebar-toggle.ts
 * @family at0511-window-sidebar
 */

import { describe, test } from "bun:test";

import { launchTugApp } from "./_harness";
import { priorCardDeck } from "./_harness/shapes";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  MIXED,
  OFF,
  ON,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  expectRung,
} from "./window-sidebar-rows-fixture";

describe.skipIf(!SHOULD_RUN)("at0511 — the View menu's sidebar rows", () => {
  test(
    "the row's mark walks the toggle's three rungs and back",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0511-sidebar-marks",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          // One free content card, so the keyboard has somewhere to be that is not the rail.
          await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );

          // Hidden: no instance, so no mark, and the row still says Show.
          await expectRung(app, OFF, "Show Jots");

          // Showing and holding the keyboard — the toggle both opens the card
          // and lands the keyboard in it, so one dispatch reaches the top rung.
          await app.dispatchControlAction("toggle-jots");
          await expectRung(app, MIXED, "Hide Jots");

          // Showing without holding it: the keyboard goes back to the free
          // card and the mark drops to the plain check. This is the rung a
          // two-state check could not tell from the one above, and the title
          // says what the next click would now do instead.
          await app.dispatchControlAction("focus-session-card", { cardId: "A" });
          await expectRung(app, ON, "Activate Jots");

          // From the middle rung the toggle takes the keyboard rather than
          // the card, so the card is still showing.
          await app.dispatchControlAction("toggle-jots");
          await expectRung(app, MIXED, "Hide Jots");

          // And only now does it hide.
          await app.dispatchControlAction("toggle-jots");
          await expectRung(app, OFF, "Show Jots");
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
