/**
 * at0511-window-sidebar-sides.test.ts — View ▸ Jots's side pair is dark
 * until the card shows, then checks where it stands, and moving the side
 * moves the check.
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

import { describe, expect, test } from "bun:test";

import { launchTugApp } from "./_harness";
import { priorCardDeck } from "./_harness/shapes";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  LEFT,
  MIXED,
  OFF,
  ON,
  RIGHT,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  expectRung,
  menuItem,
  waitMenuMark,
} from "./window-sidebar-rows-fixture";

describe.skipIf(!SHOULD_RUN)("at0511 — the View menu's sidebar rows", () => {
  test(
    "the side pair is dark until the card shows, then checks where it stands",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0511-sidebar-sides",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );

          // Hidden: nothing is standing anywhere, so there is no side to set.
          // The default side is still marked — where the card WOULD go.
          const darkLeft = await menuItem(app, LEFT);
          expect(darkLeft.enabled, `${LEFT} is dark while the card is hidden`).toBe(false);
          const darkRight = await menuItem(app, RIGHT);
          expect(darkRight.enabled, `${RIGHT} is dark while the card is hidden`).toBe(false);

          await app.dispatchControlAction("toggle-jots");
          await expectRung(app, MIXED, "Hide Jots");

          // Showing: the pair lights, and the left edge — the side Jots takes
          // when nobody has placed it — carries the check.
          const litLeft = await waitMenuMark(app, LEFT, ON);
          expect(litLeft.state, `${LEFT} checked at the default side`).toBe(ON);
          const litRight = await menuItem(app, RIGHT);
          expect(litRight.enabled, `${RIGHT} lights once the card shows`).toBe(true);
          expect(litRight.state, `${RIGHT} unchecked`).toBe(OFF);

          // Moving the card moves the check — the same frame the Right row
          // sends, and the same store the Layout card writes.
          await app.dispatchControlAction("set-sidebar-side", {
            componentId: "jots",
            side: "right",
          });
          const movedRight = await waitMenuMark(app, RIGHT, ON);
          expect(movedRight.state, `${RIGHT} checked after the move`).toBe(ON);
          const movedLeft = await waitMenuMark(app, LEFT, OFF);
          expect(movedLeft.state, `${LEFT} unchecked after the move`).toBe(OFF);
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
