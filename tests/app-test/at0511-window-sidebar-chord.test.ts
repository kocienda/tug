/**
 * at0511-window-sidebar-chord.test.ts — the ⌃⌘J chord walks the same three
 * rungs as the View ▸ Jots row it is written on ([D172]).
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
    "the chord walks the same three rungs as the row it is written on",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0511-sidebar-chord",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );

          await expectRung(app, OFF, "Show Jots");

          // ⌃⌘J. Nothing dispatches a frame here: AppKit matches the key
          // equivalent `applyCommandChords` wrote onto the toggle two levels
          // into the View menu, and fires that item. A chord the sweep had
          // not reached would leave the mark exactly where it was.
          await app.nativeKey("j", ["cmd", "ctrl"]);
          await expectRung(app, MIXED, "Hide Jots");

          // The middle rung, which is the whole reason this is a ladder and
          // not a toggle: the keyboard goes elsewhere, and the SAME chord
          // brings it back rather than taking the card away.
          await app.dispatchControlAction("focus-session-card", { cardId: "A" });
          await expectRung(app, ON, "Activate Jots");

          await app.nativeKey("j", ["cmd", "ctrl"]);
          await expectRung(app, MIXED, "Hide Jots");

          // And only from the top rung does it hide.
          await app.nativeKey("j", ["cmd", "ctrl"]);
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
