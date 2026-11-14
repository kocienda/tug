/**
 * at0407-arcs-card-fold.test.ts — the row folds open to the plan's own
 * ledger, and the press picks nothing.
 *
 * One of the at0407-arcs-card split, a test to a file so each launch fits its
 * own budget; the others are `at0407-arcs-card-unbound`, `-meta` and `-kind`.
 * What the Arcs card paints, and the scratch repository of real arcs every
 * piece builds, are `arcs-card-fixture.ts`.
 *
 * @covers tugdeck/src/components/arcs/arcs-card.tsx
 * @covers tugdeck/src/components/arcs/arcs-card.css
 * @covers tugdeck/src/components/tugways/arc-lifecycle-block.tsx
 * @covers tugdeck/src/components/tugways/arc-lifecycle-block.css
 * @covers tugdeck/src/components/tugways/arc-lifecycle-line.tsx
 * @covers tugdeck/src/components/tugways/arc-lifecycle-line.css
 * @covers tugdeck/src/components/tugways/arc-step-list.tsx
 * @covers tugdeck/src/components/tugways/arc-step-list.css
 * @covers tugdeck/src/components/tugways/body-kinds/affordances/block-fold-cue.tsx
 * @covers tugdeck/src/components/tugways/tug-arc-track.tsx
 * @covers tugdeck/src/components/tugways/tug-arc-track.css
 * @covers tugdeck/src/components/tugways/tug-step-fraction.tsx
 * @covers tugdeck/src/lib/changeset-all-store.ts
 * @covers tugdeck/src/lib/changeset-types.ts
 * @covers tugdeck/src/lib/arc-meta-facts.ts
 * @covers tugdeck/src/lib/arc-review.ts
 * @family at0407-arcs-card
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import { kindBody } from "./_harness/card-reach";
import {
  CHECKOUT,
  PLAN_ARC,
  PLAN_ROW,
  ROW,
  SECTION,
  SHOULD_RUN,
  SID,
  TEST_TIMEOUT_MS,
  withArcsCardScratch,
} from "./arcs-card-fixture";

const { projectDir, dataRoot } = withArcsCardScratch();

describe.skipIf(!SHOULD_RUN)("AT0407: the Arcs card", () => {
  test(
    "the row folds open to the plan's own ledger, and the press picks nothing",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0407-arcs-fold",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: dataRoot() },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });
        await app.dispatchControlAction("toggle-arcs");
        await kindBody(app, "dashes").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PLAN_ROW)}) !== null &&
           document.querySelector(${JSON.stringify(ROW)}) !== null`,
          { timeoutMs: 30000 },
        );

        // ── The cue is on the arc with a ledger, and on no other ──────────
        // Every row draws the cue, at the same edge of its line — a row with nothing to
        // fold draws it disabled rather than dropping it, so the column of
        // chevrons never goes ragged. `at0407-arc` was created and never
        // planned, so it is that row.
        const cues = await kindBody(app, "dashes").evalJS<{
          planned: number;
          bare: number;
          bareDisabled: boolean | null;
          label: string | null;
          expanded: string | null;
          lists: number;
        }>(
          `(() => {
             const planned = document.querySelector(${JSON.stringify(PLAN_ROW)});
             const bare = document.querySelector(${JSON.stringify(ROW)});
             const cue = planned.querySelector('[data-slot="arcs-steps-fold"]');
             const bareCue = bare.querySelector('[data-slot="arcs-steps-fold"]');
             return {
               planned: planned.querySelectorAll('[data-slot="arcs-steps-fold"]').length,
               bare: bare.querySelectorAll('[data-slot="arcs-steps-fold"]').length,
               bareDisabled: bareCue === null ? null : bareCue.hasAttribute("disabled"),
               label: cue?.getAttribute("aria-label") ?? null,
               expanded: cue?.getAttribute("aria-expanded") ?? null,
               lists: planned.querySelectorAll('[data-slot="arcs-steps"]').length,
             };
           })()`,
        );
        note("at0407 fold cues", JSON.stringify(cues));
        expect(cues.planned, "an arc with a ledger carries the cue").toBe(1);
        expect(cues.bare, "an arc with no steps carries one too").toBe(1);
        expect(cues.bareDisabled, "and it is disabled, having nothing to fold").toBe(true);
        // The cue names its arc, because a card full of rows offers a screen
        // reader a great many chevrons that would otherwise read alike.
        expect(cues.label).toContain(PLAN_ARC);
        // Every row starts collapsed: the card stays a list at a glance.
        expect(cues.expanded).toBe("false");
        expect(cues.lists, "and nothing is mounted beneath it yet").toBe(0);

        // What the row would disturb if the press reached it — read BEFORE,
        // so the claim below is that neither moved rather than that both hold
        // some remembered constant.
        const focusedBefore = await app.getFocusedCardId();
        const selectedBefore = await kindBody(app, "dashes").evalJS<string[]>(
          `Array.from(
             document.querySelectorAll(${JSON.stringify(`${SECTION} [data-selected="true"]`)}),
           ).map((el) => el.getAttribute("data-arc") ?? el.className)`,
        );

        // ── The press ────────────────────────────────────────────────────
        await kindBody(app, "dashes").click(`${PLAN_ROW} [data-slot="arcs-steps-fold"]`);
        await kindBody(app, "dashes").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${PLAN_ROW} [data-slot="arcs-steps"]`)}) !== null`,
          { timeoutMs: 10000 },
        );

        const opened = await kindBody(app, "dashes").evalJS<{
          rows: Array<{ status: string | null; dot: string | null; text: string }>;
          expanded: string | null;
          ticks: string[];
        }>(
          `(() => {
             const row = document.querySelector(${JSON.stringify(PLAN_ROW)});
             const list = row.querySelector('[data-slot="arcs-steps"]');
             const cue = row.querySelector('[data-slot="arcs-steps-fold"]');
             const cell = row
               .querySelector('[data-slot="tug-arc-track"]')
               ?.querySelector('[data-slot="tug-arc-track-cell"][data-phase="implement"]');
             return {
               rows: Array.from(list.querySelectorAll('[data-slot="arc-step"]')).map((el) => ({
                 status: el.getAttribute("data-status"),
                 dot: el
                   .querySelector('[data-slot="tug-progress-indicator"]')
                   ?.getAttribute("data-state") ?? null,
                 text: (el.textContent ?? "").trim(),
               })),
               expanded: cue?.getAttribute("aria-expanded") ?? null,
               ticks: cell
                 ? Array.from(cell.querySelectorAll(".tug-arc-track-tick")).map(
                     (el) => el.getAttribute("data-state"),
                   )
                 : [],
             };
           })()`,
        );
        note("at0407 folded open", JSON.stringify(opened));
        expect(opened.expanded).toBe("true");
        // One row per ledger line, each carrying its ordinal and its title —
        // the plan's own spelling, nothing derived. This fixture's plan holds
        // three rows with the first one open.
        expect(opened.rows.map((r) => r.text)).toEqual([
          "1.The only step",
          "2.The second step",
          "3.The third step",
        ]);
        // And the status the entry carries, which is the same fact the track
        // beside it paints: the row and its ticks read one ledger.
        expect(opened.rows.map((r) => r.status)).toEqual([
          "in progress",
          "pending",
          "pending",
        ]);
        expect(opened.ticks).toEqual(["active", "pending", "pending"]);

        // And nothing on this row breathes. `in progress` is a cell somebody
        // wrote into a document, and this fixture's arc has no wheel running
        // it and no holder working — so the ledger says step 1 is under way
        // and the glyph declines to claim it is happening right now. The tick
        // above still paints `active`, because where the walk stands and
        // whether anybody is walking it are two different facts.
        expect(opened.rows.map((r) => r.dot)).toEqual([
          "stopped",
          "stopped",
          "stopped",
        ]);

        // ── And the press picked nothing ─────────────────────────────────
        // The list commits selection at pointerdown and excuses any
        // descendant that refuses focus, so a control inside a row never
        // reaches the delegate. Nothing was fronted and nothing was selected —
        // the claim that needs the real app, since the excusing happens in the
        // list's own pointer handling.
        const focusedAfter = await app.getFocusedCardId();
        const selectedAfter = await kindBody(app, "dashes").evalJS<string[]>(
          `Array.from(
             document.querySelectorAll(${JSON.stringify(`${SECTION} [data-selected="true"]`)}),
           ).map((el) => el.getAttribute("data-arc") ?? el.className)`,
        );
        expect(focusedAfter, "the press fronted no card").toBe(focusedBefore);
        expect(selectedAfter, "and picked no row").toEqual(selectedBefore);
        note("at0407 folded row", await app.screenshot().then((s) => s.path));

        // ── Folding again unmounts it ────────────────────────────────────
        // Structure, not appearance: an arc nobody has opened costs no ledger
        // DOM at all, which is why this is a presence claim rather than a
        // visibility one.
        await kindBody(app, "dashes").click(`${PLAN_ROW} [data-slot="arcs-steps-fold"]`);
        await kindBody(app, "dashes").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${PLAN_ROW} [data-slot="arcs-steps"]`)}) === null`,
          { timeoutMs: 10000 },
        );
        const closedCue = await kindBody(app, "dashes").evalJS<string | null>(
          `document
             .querySelector(${JSON.stringify(`${PLAN_ROW} [data-slot="arcs-steps-fold"]`)})
             ?.getAttribute("aria-expanded") ?? null`,
        );
        expect(closedCue).toBe("false");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
