/**
 * at0511-window-sidebar-resize-row.test.ts — View ▸ Resize Sidebars to Fit
 * stands above the card rows, carrying ⌥⇧⌘S ([B11]).
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
  OPTION,
  PARENT,
  RESIZE,
  SHIFT,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  viewRowOrder,
  waitMenuChord,
} from "./window-sidebar-rows-fixture";

describe.skipIf(!SHOULD_RUN)("at0511 — the View menu's sidebar rows", () => {
  test(
    "Resize Sidebars to Fit stands above the card rows, carrying ⌥⇧⌘S",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0511-resize-sidebars-row",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );

          // Built with an EMPTY key equivalent, like every row in this menu:
          // the chord below can only be here because `applyCommandChords`
          // wrote it from the frontend's registry, which is what keeps it
          // rebindable.
          const row = await waitMenuChord(app, RESIZE, "s");
          expect(row.found, `${RESIZE} present in the View menu`).toBe(true);
          if (!row.found) throw new Error(`${RESIZE} is not in the menu`);
          expect(row.keyEquivalent, `${RESIZE} carries "s"`).toBe("s");
          expect(row.modifierMask, `${RESIZE} is ⌥⇧⌘`).toBe(
            COMMAND | OPTION | SHIFT,
          );
          // Ungated: the rails are the deck's geometry and no focused surface
          // declines a verb about them.
          expect(row.enabled, `${RESIZE} is live`).toBe(true);

          // Above the card rows it resizes, which is the placement the row
          // was given rather than one AppKit would arrive at ([B11]).
          const rows = await viewRowOrder(app);
          expect(
            rows.indexOf(RESIZE),
            `${RESIZE} stands above ${PARENT}`,
          ).toBeLessThan(rows.indexOf(PARENT));
          expect(rows.indexOf(RESIZE), `${RESIZE} is one of the rows`).toBeGreaterThanOrEqual(0);
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
