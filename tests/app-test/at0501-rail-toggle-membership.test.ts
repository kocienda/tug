/**
 * at0501-rail-toggle-membership.test.ts — a side hides as a unit and comes
 * back holding the same members.
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
    "a side hides as a unit and comes back holding the same members",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0501-rail-membership",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );

          // Two members on the right, opened one card at a time through the
          // per-card rows — the door that still exists for them.
          await app.dispatchControlAction("toggle-layout");
          await app.dispatchControlAction("toggle-cards");
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(railSelector("right"))}).length === 2`,
            { timeoutMs: 3_000 },
          );
          const members = await app.evalJS<string[]>(
            `Array.from(document.querySelectorAll(${JSON.stringify(railSelector("right"))}))
               .map((el) => el.getAttribute("data-pane-id"))`,
          );
          expect(members).toHaveLength(2);

          // The keyboard is inside the side (opening Workspaces activated it), so
          // one press takes the whole side away — both members, not one.
          await toggleRail(app, "right");
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(railSelector("right"))}).length === 0`,
            { timeoutMs: 3_000 },
          );

          // And the show brings back exactly what was standing. A show that
          // read the side's stored ORDER instead would also resurrect a card
          // the user had closed by hand; a show with no memory at all would
          // bring back one.
          await toggleRail(app, "right");
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(railSelector("right"))}).length === 2`,
            { timeoutMs: 3_000 },
          );
          expect(await railCount(app, "right")).toBe(2);
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
