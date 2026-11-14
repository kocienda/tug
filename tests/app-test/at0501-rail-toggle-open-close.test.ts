/**
 * at0501-rail-toggle-open-close.test.ts — the chord opens a side, lands the
 * keyboard in it, and takes it away.
 *
 * One of the at0501-rail-toggle split, a test to a file so each launch fits
 * its own budget. The rail ladder this reads, and the shared readers, are
 * `rail-toggle-fixture.ts`.
 *
 * @covers tugdeck/src/sidebar-toggle.ts
 * @covers tugdeck/src/action-dispatch.ts
 * @covers tugdeck/src/components/tugways/command-registry.ts
 * @family at0501-rail-toggle
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
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  railCount,
  railSelector,
  toggleRail,
} from "./rail-toggle-fixture";

describe.skipIf(!SHOULD_RUN)("at0501 — the rail toggle chords", () => {
  test(
    "the chord opens a side, lands the keyboard in it, and takes it away",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0501-rail-open-close",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );
          expect(await railCount(app, "right")).toBe(0);

          // Hidden → show the side and focus its frontmost member. The deck's
          // Workspaces and Layout cards default to the right edge, so the
          // right chord has something to open on a factory deck.
          await toggleRail(app, "right");
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(railSelector("right"))}).length > 0`,
            { timeoutMs: 3_000 },
          );
          const opened = await app.evalJS<string | null>(
            `window.__tug.getActiveCardId()`,
          );
          expect(opened).not.toBe("A");
          expect(opened).not.toBeNull();

          // Holding the keyboard → hide the side.
          await toggleRail(app, "right");
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(railSelector("right"))}).length === 0`,
            { timeoutMs: 3_000 },
          );
          expect(await railCount(app, "right")).toBe(0);
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
