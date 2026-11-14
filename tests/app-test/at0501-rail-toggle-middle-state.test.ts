/**
 * at0501-rail-toggle-middle-state.test.ts — a showing side takes the keyboard
 * before it will hide.
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
    "a showing side takes the keyboard before it will hide",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0501-rail-middle-state",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );

          await toggleRail(app, "right");
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(railSelector("right"))}).length > 0`,
            { timeoutMs: 3_000 },
          );
          const railCardId = await app.evalJS<string | null>(
            `window.__tug.getActiveCardId()`,
          );
          expect(railCardId).not.toBeNull();

          // Put the keyboard back on the free card: the side is showing but
          // does not hold it — the middle rung.
          await app.dispatchControlAction("focus-session-card", {
            cardId: "A",
          });
          expect(
            await app.evalJS<string | null>(`window.__tug.getActiveCardId()`),
          ).toBe("A");

          // Showing but not holding → focus it, and the side stays up.
          await toggleRail(app, "right");
          expect(
            await app.evalJS<string | null>(`window.__tug.getActiveCardId()`),
          ).toBe(railCardId);
          expect(await railCount(app, "right")).toBeGreaterThan(0);

          // Only now does the press take the side away.
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
