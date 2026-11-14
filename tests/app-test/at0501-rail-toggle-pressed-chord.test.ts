/**
 * at0501-rail-toggle-pressed-chord.test.ts — the pressed chord reaches the
 * side, not the web view's arrow handling.
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
} from "./rail-toggle-fixture";

describe.skipIf(!SHOULD_RUN)("at0501 — the rail toggle chords", () => {
  test(
    "the pressed chord reaches the side, not the web view's arrow handling",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0501-rail-pressed-chord",
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

          // ⌃⌘→ as a real keystroke. The macOS never-bind list reserves PLAIN
          // ⌃-arrows for Spaces and Mission Control, not the ⌘ composition —
          // an argument worth exactly as much as a running app pressing the
          // key and seeing the side open.
          await app.nativeKey("ArrowRight", ["ctrl", "cmd"]);
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(railSelector("right"))}).length > 0`,
            { timeoutMs: 3_000 },
          );
          expect(await railCount(app, "right")).toBe(1);

          // And the same key closes it, so what the press reached is the
          // ladder rather than something that only ever opens.
          await app.nativeKey("ArrowRight", ["ctrl", "cmd"]);
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
