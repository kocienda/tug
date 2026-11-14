/**
 * at0511-window-sidebar-hide-row.test.ts — View ▸ Hide Sidebars stands
 * above the resize row, carrying ⌃⌘S, and names the press it would make.
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
  COMMAND,
  CONTROL,
  MIXED,
  OFF,
  ON,
  PARENT,
  RESIZE,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  TOGGLE,
  TOGGLE_SIDEBARS,
  expectRung,
  menuItem,
  viewRowOrder,
  waitMenuChord,
  waitMenuTitle,
} from "./window-sidebar-rows-fixture";

describe.skipIf(!SHOULD_RUN)("at0511 — the View menu's sidebar rows", () => {
  test(
    "Hide Sidebars stands above the resize row, carrying ⌃⌘S, and names the press",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0511-hide-sidebars-row",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );

          // Built with an EMPTY key equivalent like every row in this menu:
          // the chord is here only because `applyCommandChords` wrote it from
          // the registry, which is what keeps it rebindable.
          const row = await waitMenuChord(app, TOGGLE_SIDEBARS, "s");
          expect(row.found, `${TOGGLE_SIDEBARS} present`).toBe(true);
          if (!row.found) throw new Error(`${TOGGLE_SIDEBARS} is not in the menu`);
          expect(row.keyEquivalent, `${TOGGLE_SIDEBARS} carries "s"`).toBe("s");
          expect(row.modifierMask, `${TOGGLE_SIDEBARS} is ⌃⌘`).toBe(
            COMMAND | CONTROL,
          );
          // Ungated: with a rail standing there is one to hide, and with none
          // standing there is the last hide to put back.
          expect(row.enabled, `${TOGGLE_SIDEBARS} is live`).toBe(true);

          // The two verbs about the rails as rails stand together, above the
          // card rows they act on.
          const rows = await viewRowOrder(app);
          expect(
            rows.indexOf(TOGGLE_SIDEBARS),
            `${TOGGLE_SIDEBARS} stands directly above ${RESIZE}`,
          ).toBe(rows.indexOf(RESIZE) - 1);
          expect(
            rows.indexOf(TOGGLE_SIDEBARS),
            `${TOGGLE_SIDEBARS} stands above ${PARENT}`,
          ).toBeLessThan(rows.indexOf(PARENT));

          // Nothing standing yet: the row names the press that brings the
          // rails back rather than one that would take nothing away.
          expect(
            (await waitMenuTitle(app, TOGGLE_SIDEBARS, "Show Sidebars")).title,
            "with no rail standing the row says Show",
          ).toBe("Show Sidebars");

          // A card on a rail flips it, and the press takes that rail away —
          // read off the card's OWN row, which is the deck answering rather
          // than this row restating itself.
          await app.dispatchControlAction("toggle-jots");
          await expectRung(app, MIXED, "Hide Jots");
          expect(
            (await waitMenuTitle(app, TOGGLE_SIDEBARS, "Hide Sidebars")).title,
            "a rail standing makes the next press a hide",
          ).toBe("Hide Sidebars");

          await app.dispatchControlAction("toggle-sidebars");
          await expectRung(app, OFF, "Show Jots");
          expect(
            (await waitMenuTitle(app, TOGGLE_SIDEBARS, "Show Sidebars")).title,
            "and the row turns around with the deck",
          ).toBe("Show Sidebars");

          // And it is a toggle: the same frame puts back what it took, which
          // is the member the hide recorded rather than a default.
          await app.dispatchControlAction("toggle-sidebars");
          expect(
            (await menuItem(app, TOGGLE)).state,
            "the Jots card is back on its rail",
          ).toBe(ON);
          expect(
            (await waitMenuTitle(app, TOGGLE_SIDEBARS, "Hide Sidebars")).title,
            "and the row is a hide again",
          ).toBe("Hide Sidebars");
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
