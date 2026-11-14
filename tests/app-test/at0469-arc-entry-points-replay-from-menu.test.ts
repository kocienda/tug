/**
 * at0469-arc-entry-points-replay-from-menu.test.ts — a diverged arc offers
 * Replay, and its outcome is never silent.
 *
 * One of the at0469-arc-entry-points split, a test to a file so each launch
 * fits its own budget. Why a surface that shows an arc lets you act on one,
 * the scratch repository this file builds for itself, and the shared helpers
 * are `arc-entry-points-fixture.ts`.
 *
 * In the original file this test ran second, after the row test had bound
 * `at0469-held` to the session in the shared scratch repository. Nothing here
 * reads that binding — this test binds `at0469-behind` itself before it
 * reads anything — so the fresh scratch this file builds needs no extra step.
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
import {
  openArcRowMenu,
  closeArcRowMenu,
  pressArcRowMenuItem,
  readArcRowMenu,
} from "./arc-row-menu-fixture";
import { bindArc } from "./arc-fixture";
import { kindBody } from "./_harness/card-reach";
import {
  BEHIND,
  BULLETIN,
  BULLETIN_TITLE,
  CHECKOUT,
  SHOULD_RUN,
  SID,
  TEST_TIMEOUT_MS,
  arcRow,
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
    "a diverged arc offers Replay, and its outcome is never silent",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0469-replay-from-the-row-menu",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await openArcsRail(app);
        // Bound, deliberately: the outcome notice reports on the card, and
        // binding is also what makes this the case [P03] was wrong about —
        // a *bound* diverged arc the engine will never touch, because this
        // repository's arcs have autoreplay off.
        bindArc(projectDir(), BEHIND, SID, scratch?.cli ?? {});
        await kindBody(app, "dashes").waitForCondition<boolean>(
          `document.querySelector('${arcRow(BEHIND)} [data-slot="tug-arc-lifecycle-worker"]') !== null`,
          { timeoutMs: 30000 },
        );

        // ── The verb is offered, on a bound row, naming its destination ────
        // A live Replay item IS the row's knowledge that it is behind: the
        // predicate reads the same divergence the line no longer prints.
        const menu = await readArcRowMenu(kindBody(app, "dashes"), arcRow(BEHIND));
        note("at0469 behind-row menu", JSON.stringify(menu));
        expect(menu.replay.present).toBe(true);
        expect(menu.replay.disabled).toBe(false);
        expect(menu.replay.label).toContain("Replay onto");

        // The disabled half of the predicate is asserted at the end of this
        // test, on an arc that has just replayed: every arc in this fixture is
        // behind the moment the base moves, so there is no row here that is
        // born current. The predicate's whole truth table is a unit test.

        // ── The press moves the rounds ─────────────────────────────────────
        // The bulletin is the receipt. A replay that moves the rounds changes
        // nothing any arc row prints — the line carries the arc's standing,
        // not the checkout's git bookkeeping — so success speaks here or it
        // does not speak at all.
        await pressArcRowMenuItem(kindBody(app, "dashes"), arcRow(BEHIND), "request-replay-arc");
        // The bulletin is the bound card's pane bulletin, in A's body.
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(BULLETIN)}) !== null`,
          { timeoutMs: 30000 },
        );
        const landed = await app.body("A").evalJS<string>(
          `(document.querySelector(${JSON.stringify(BULLETIN_TITLE)})?.textContent ?? "")`,
        );
        note("at0469 the replay's own bulletin", landed);
        expect(landed).toContain(BEHIND);

        // ── A second press moves nothing — and still speaks ────────────────
        // This is the dead-button guard. The arc is current now, so the item
        // is disabled with its reason in the label rather than offering a
        // press whose answer nothing on the row could show ([L31]).
        // The bulletin speaks the moment the server answers, while the
        // aggregate the predicate reads recomputes on its own beat — so the
        // reading is taken until it catches up rather than once.
        let afterwards = { disabled: false, label: "" };
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          await openArcRowMenu(kindBody(app, "dashes"), arcRow(BEHIND));
          // The row's menu opens in the overlay root of the page that holds
          // the row — the Arcs card's body.
          afterwards = await kindBody(app, "dashes").evalJS<{ disabled: boolean; label: string }>(
            `(() => {
               const el = document.querySelector('[data-slot="tug-editor-context-menu"] [data-item-action="request-replay-arc"]');
               return {
                 disabled: el !== null && el.hasAttribute("data-disabled"),
                 label: el === null ? "" : (el.textContent || ""),
               };
             })()`,
          );
          await closeArcRowMenu(kindBody(app, "dashes"));
          if (afterwards.disabled) break;
          await settle(1000);
        }
        note("at0469 replay after replaying", JSON.stringify(afterwards));
        expect(afterwards.disabled).toBe(true);
        expect(afterwards.label).toContain("already current with");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
