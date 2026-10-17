/**
 * at0476-second-arc-refused.test.ts — a second `/arc` naming another arc, on a
 * card already running one, is refused by name.
 *
 * Split from `at0476-arc-interruptions`, one file per test, each its own
 * launch: `arc stop` and its Resume in `at0476-arc-stop-resume`, and the
 * refused second arc here.
 *
 * ## Why this exists
 *
 * `tuglaws/arc-lifecycle.md`'s Interruptions table promises three things of
 * every interruption: the arc does something sayable, the user sees a receipt,
 * and there is a gesture that resumes. The second is a claim about a card, and
 * a claim about a card is only true if the card shows it. This file drives a
 * real `tugtool` verb through the card's own `$` shell route (the route that
 * stamps `TUG_SESSION_ID`, so the server can resolve which card asked) and
 * reads the answer off the real DOM.
 *
 * The row it drives: **a second `/arc` naming another arc** — refused by name,
 * with the first arc's binding untouched.
 *
 * @family at0476
 * @covers tugrust/crates/tugcast/src/feeds/arc.rs
 * @covers tugrust/crates/tugcast/src/feeds/arc_runner.rs
 * @covers tugrust/crates/tugcast/src/arc_api.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor/control/arc.rs
 * @covers tugrust/crates/tugtool/src/arc.rs
 * @covers tugdeck/src/components/tugways/cards/session-arc-receipt-block.tsx
 * @covers tugdeck/src/lib/arc-receipt.ts
 * @covers tugdeck/src/components/tugways/tug-inline-dialog.tsx
 * @covers tugdeck/src/lib/arc-press-store.ts
 * @covers tugcode/src/session.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
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
  shellAndSettle,
  tugtoolPath,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/** Minted per run, for the reason at0496 gives: `arc bind` asks every
 *  instance on the machine, and a fixed id lets another's stale row answer. */
const SID = randomUUID();
const CARD = '[data-card-id="A"]';
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;

const OTHER_ARC = "at0476-other";
const THIRD_ARC = "at0476-third";
/** Every arc's brief lives at its own address, so there is nothing to name. */
const BRIEF_BODY = "# A brief\n\nSome prose the arc opens on.\n";

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0476-refused", checkout: CHECKOUT });
  createArc(projectDir(), OTHER_ARC, "at0476 second arc", scratch.cli);
  createArc(projectDir(), THIRD_ARC, "at0476 third arc", scratch.cli);
  // The arc opens on the arc's own brief, so the one that runs gets one.
  writeFileSync(arcBriefPath(projectDir(), OTHER_ARC), BRIEF_BODY);
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  rmScratchSession(fixtureDir);
});

/** Every shell row's text, in transcript order. */
async function shellRowText(app: App): Promise<string[]> {
  const raw = await app.body("A").evalJS<string>(
    `JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(
      SHELL_ROWS,
    )})).map((el) => el.textContent || ""))`,
  );
  return JSON.parse(raw) as string[];
}

async function openCard(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: sessionCardShape({ width: 900, height: 660 }), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 30_000 },
  );
  await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
  await app.awaitEngineReady("A", { timeoutMs: 30_000 });
}

describe.skipIf(!SHOULD_RUN)("AT0476: an interrupted arc says so on the card", () => {
  test(
    "a second arc on a card already running one is refused by name",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0476-second-arc-refused",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      const cli = tugtoolPath(CHECKOUT);
      try {
        await openCard(app);

        // One line, and for a reason: the refusal is about a card running a
        // **live** arc, and a tick between the two verbs would seat a stage
        // or stop the arc, either of which changes the question being asked.
        await shellAndSettle(
          app,
          `${cli} arc run ${OTHER_ARC} && ${cli} arc bind ${THIRD_ARC}`,
        );

        // ── The interruption that is refused rather than described ────────
        //
        // The message is the whole proof of the binding it protects: the
        // server names what the card is running back to the person who asked
        // to displace it.
        const rows = await shellRowText(app);
        const refusal = rows[0] ?? "";
        note("at0476 bind refusal", refusal);
        expect(refusal).toContain(`card runs ${OTHER_ARC}`);
        expect(refusal).toContain(THIRD_ARC);
        note("at0476 card with the refusal", (await app.screenshot()).path);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
