/**
 * at0476-arc-stop-resume-restore.test.ts — a resumed arc's pick-up keeps its
 * place, and its stop stays folded, after the card reloads.
 *
 * The sibling of `at0476-arc-stop-resume`. That file pins the live order: the
 * Wheel's pick-up line lands below the stop it answers and above the first
 * row of the turn the resume opened, and the stop's Resume offer folds. This
 * one pins the same claims on the **restore** path, where every row is read
 * back from the ledgers rather than arriving as it happens.
 *
 * ## Why a restore needs its own pin
 *
 * Live, a row seats by when its frame arrived; restored, by the clock the
 * ledger kept for it. The two disagreed once — a pick-up written before the
 * resumed turn's ask was stamped with the moment it reached the card, which
 * put it under the turn it introduced on every reload. Both arc frames now
 * carry the ledger row's own clock, so the two paths have one answer, and
 * this file is what says they still do. The fold has the same two paths: the
 * supersession pass reads the pick-up in whichever seat it was restored to.
 *
 * The reload is the card's own page — the host saves the card and loads it
 * afresh, then the session is resumed — which replays the shell ledger the
 * way a relaunch does without paying for a second launch.
 *
 * @family at0476
 * @covers tugrust/crates/tugcast/src/feeds/arc_runner.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor/mod.rs
 * @covers tugdeck/src/lib/session-transcript-data-source.ts
 * @covers tugdeck/src/lib/arc-note-command.ts
 * @covers tugdeck/src/lib/changeset-verb-store.ts
 * @covers tugdeck/src/components/tugways/cards/use-landing-receipts.ts
 * @covers tugdeck/src/components/tugways/cards/session-arc-note-block.tsx
 * @covers tugdeck/src/components/tugways/cards/session-arc-receipt-block.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note } from "./_harness";
import { waitForBodyReady } from "./_harness/card-reach";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  createArc,
  arcBriefPath,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtoolPath,
  type ArcScratchRepo,
} from "./arc-fixture";
import {
  RESUME_BUTTON,
  openCard,
  readArcSeat,
  seatProblems,
  shellUntil,
  waitForPickUp,
} from "./arc-stop-resume-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000004761";
const ARC_NAME = "at0476-restore";
const BRIEF_BODY = "# A brief\n\nSome prose the arc opens on.\n";

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0476r", checkout: CHECKOUT });
  createArc(projectDir(), ARC_NAME, "at0476 restore fixture", scratch.cli);
  writeFileSync(arcBriefPath(projectDir(), ARC_NAME), BRIEF_BODY);
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  rmScratchSession(fixtureDir);
});

describe.skipIf(!SHOULD_RUN)("AT0476: a resumed arc reads the same after a reload", () => {
  test(
    "the pick-up keeps its seat and the stop stays folded across the card's reload",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0476-arc-stop-resume-restore",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      const cli = tugtoolPath(CHECKOUT);
      try {
        await openCard(app, SID, projectDir());

        // The same stop the live file makes, the same way: one shell line, so
        // the interruption lands before the runner's next tick seats a stage.
        await shellUntil(
          app,
          `${cli} arc run ${ARC_NAME} && ${cli} arc stop ${ARC_NAME}`,
          "you stopped it",
        );
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(RESUME_BUTTON)}) !== null`,
          { timeoutMs: 30_000 },
        );
        await app.body("A").nativeClickAtElement(RESUME_BUTTON);

        // The live order first, so a red below is a restore red and not one
        // the live file would have caught.
        await waitForPickUp(app);
        const live = await readArcSeat(app);
        note("at0476 restore: seat before the reload", JSON.stringify(live));
        expect(seatProblems(live)).toEqual([]);

        // ── The card's own page reloads → ledger replay ───────────────────
        await app.body("A").evalJS<null>(`(window.__at0476Kept = true, null)`);
        await app.body("A").evalJS<null>(`(location.reload(), null)`);
        await app.body("A").waitForCondition<boolean>(
          `window.__at0476Kept !== true && typeof window.__tug !== "undefined"`,
          { timeoutMs: 15_000 },
        );
        await waitForBodyReady(app, "A");
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });

        // The restored rows are read back from the record, so the claims are
        // the live ones, unchanged: the pick-up below the stop and above the
        // resumed turn, and no Resume offer standing over a running arc.
        await waitForPickUp(app);
        const restored = await readArcSeat(app);
        note("at0476 restore: seat after the reload", JSON.stringify(restored));
        note("at0476 restore: card after the reload", (await app.screenshot()).path);
        expect(seatProblems(restored)).toEqual([]);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
