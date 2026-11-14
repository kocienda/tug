/**
 * at0469-arc-entry-points-row-opens-room.test.ts — an arc row opens its
 * worker's Changes shade; a row with no worker is inert.
 *
 * One of the at0469-arc-entry-points split, a test to a file so each launch
 * fits its own budget. Why a surface that shows an arc lets you act on one,
 * the scratch repository this file builds for itself, and the shared helpers
 * are `arc-entry-points-fixture.ts`.
 *
 * @covers tugdeck/src/components/arcs/arcs-card.tsx
 * @covers tugdeck/src/components/arcs/arcs-card.css
 * @covers tugdeck/src/components/tugways/cards/session-changes/arc-row-menu.tsx
 * @covers tugdeck/src/components/tugways/cards/arc-replay-notice-controller.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-notice.tsx
 * @covers tugdeck/src/lib/arc-replay-outcome-store.ts
 * @covers tugdeck/src/lib/changeset-verb-store.ts
 * @covers tugdeck/src/lib/action-vocabulary.ts
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor/control/changeset.rs
 * @family at0469-arc-entry-points
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import { bindArc } from "./arc-fixture";
import { kindBody } from "./_harness/card-reach";
import {
  CHECKOUT,
  HELD,
  IDLE,
  SHEET,
  SHOULD_RUN,
  SID,
  TEST_TIMEOUT_MS,
  arcRow,
  clickRow,
  openArcsRail,
  projectDir,
  rmArcEntryPointsScratch,
  scratch,
  seedArcEntryPointsScratch,
  settle,
} from "./arc-entry-points-fixture";

beforeAll(seedArcEntryPointsScratch);
afterAll(rmArcEntryPointsScratch);

describe.skipIf(!SHOULD_RUN)("AT0469: acting on an arc from a surface that shows one", () => {
  test(
    "an arc row opens its worker's Changes shade; a row with no worker is inert",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0469-arc-row-opens-the-room",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await openArcsRail(app);
        bindArc(projectDir(), HELD, SID, scratch?.cli ?? {});

        // The held row waits for the binding to reach the aggregate — the atom
        // is the positive signal, and it is also what makes the row a door.
        await kindBody(app, "dashes").waitForCondition<boolean>(
          `document.querySelector('${arcRow(HELD)} [data-slot="tug-arc-lifecycle-worker"]') !== null`,
          { timeoutMs: 30000 },
        );
        await kindBody(app, "dashes").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(arcRow(IDLE))}) !== null`,
          { timeoutMs: 30000 },
        );

        // ── What each row advertises about itself ──────────────────────────
        const affordance = await kindBody(app, "dashes").evalJS<{ held: string | null; idle: string | null }>(
          `(() => {
             const read = (sel) =>
               document.querySelector(sel)?.getAttribute("data-activatable") ?? null;
             return {
               held: read(${JSON.stringify(arcRow(HELD))}),
               idle: read(${JSON.stringify(arcRow(IDLE))}),
             };
           })()`,
        );
        note("at0469 row affordances", JSON.stringify(affordance));
        expect(affordance.held).toBe("true");
        // Nobody is working it here, so there is no room to open — and the row
        // says so before the press rather than after.
        expect(affordance.idle).toBeNull();

        // The shade is closed to begin with: no join stands on these
        // arcs, so nothing has revealed itself.
        expect(
          await app.body("A").evalJS<boolean>(
            `document.querySelector(${JSON.stringify(SHEET)}) === null`,
          ),
        ).toBe(true);

        // ── The inert row does nothing ─────────────────────────────────────
        await clickRow(kindBody(app, "dashes"), arcRow(IDLE));
        await settle(600);
        expect(
          await app.body("A").evalJS<boolean>(
            `document.querySelector(${JSON.stringify(SHEET)}) === null`,
          ),
        ).toBe(true);
        note("at0469 the idle row opened nothing, as it advertised");

        // ── The held row opens the room ────────────────────────────────────
        // This is the assertion the silent-dispatch defect would fail: an
        // action sent to the wrong responder scope produces no error, just a
        // shade that never comes up.
        await clickRow(kindBody(app, "dashes"), arcRow(HELD));
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 15000 },
        );
        note("at0469 arc row opened the shade", (await app.screenshot()).path);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
