/**
 * at0504-planned-opens-at-devise.test.ts — a brief with no task list opens
 * at devise, which is what makes the recorded kind a kind; the other half of
 * the postmortem below.
 *
 * Split from `at0504-arc-rotation-carries-the-binding`, one file per test,
 * each its own launch: the plain arc's rotation in
 * `at0504-plain-rotation-carries-the-binding`, and the planned arc here. Both
 * files seed both arcs, whose documents differ by the one file that decides
 * the kind.
 *
 * ## What this is
 *
 * One incident sits behind this file: a stage rotated, and the arc was
 * stranded ([D167]). The card's arc face went blank, a
 * `tugtool arc` verb run from a shell born before the rotation was refused
 * because that shell still held the session id it started with, and the run
 * did not walk on. Six workstreams of hardening followed. Every one of them is
 * tested where its fact lives — the ledger's units, the predicate's table, the
 * CLI's fixtures — and until this file **nothing joined them**: no test drove a
 * real rotation and then asked whether the run survived it.
 *
 * ## The rotation is the event, not the errand
 *
 * The first draft of this file spent twenty minutes getting to a rotation the
 * hard way: a planned arc through a real review stage, then a real
 * implement stage, then two real step boundaries with the compaction threshold
 * on the floor so the second one rotated. It never arrived, and the reason is
 * worth keeping: **every one of those minutes was spent earning a rotation,
 * and none of them was spent on what the incident was about.** A rotation is a
 * fresh segment minted on the card's line and seated by the wheel. The
 * *opening* rotation of an arc is exactly that, and it lands about a
 * second after the door is opened.
 *
 * So the door is the gesture, and the four things the incident lost are the
 * assertions:
 *
 *   1. **The kind the documents name is recorded and obeyed.** A brief with
 *      a task list beside it opens at implement; a brief alone opens at
 *      devise. That is W5's recorded kind, driven end to end for the first
 *      time — the second test is the contrast, and the contrast is what shows
 *      the kind was derived once at the opening and then obeyed from the
 *      record.
 *   2. **The binding rode the seat.** The card's masthead sigil and the Z2
 *      ARC cell still name the arc after the fresh segment lands. That is
 *      W2's broadcast ordering: the `session_updated` push carrying the
 *      `(session_id, line_id)` pair goes out before `bind_arc_ok`, so the
 *      deck's segment → line → card walk can resolve the announcement instead
 *      of silently no-opping.
 *   3. **A stale id still lands on the live segment.** `tugtool arc bind
 *      --dry-run --json`, run with the id the card was *born* with, reports
 *      `rotated: true` and resolves to the segment the card is on *now*. That
 *      is W1's chokepoint, over a real rotation, and `--dry-run` is the
 *      reading that shows its work without writing.
 *   4. **The stage was actually seated.** A `stage_label` is written only by a
 *      rotation the wheel performed, and only the bridge can write the
 *      `arc-stage` line, because it names a claude session id nobody knows
 *      until claude announces it. The card's divider is the same fact wearing
 *      a face and is observed rather than waited on — see the note at the
 *      assertion for why blocking on its wording cost the first version its
 *      whole budget.
 *
 * ## What is deliberately not here
 *
 * **Whether the seated stage finishes.** The arc's later decisions — the
 * compaction at a boundary, the continue, the hand to audit — all wait on a
 * real claude doing real work on a fixture task, which is minutes of somebody
 * else's judgement and is not what this file claims. `at0480` owns the
 * compaction end to end, behind its own `TUG_REAL_CLAUDE` gate; the
 * predicate's table owns every arm.
 *
 * A rotation does spawn a claude and hand it a prompt, so this file is not
 * free — but it is one spawn, the same cost `at0476`'s second test already
 * pays, and the arc is stopped as soon as the reading is taken.
 *
 * @family at0504
 * @covers tugrust/crates/tugcast/src/feeds/arc.rs
 * @covers tugrust/crates/tugcast/src/feeds/arc_runner.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor/mod.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor/control/arc.rs
 * @covers tugrust/crates/tugcast/src/session_ledger.rs
 * @covers tugrust/crates/tugtool/src/arc.rs
 * @covers tugrust/crates/tugarc-core/src/arc.rs
 * @covers tugdeck/src/lib/card-session-binding-store.ts
 * @covers tugdeck/src/lib/arc-session-index.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
  arcTasksPath,
  disarmAutoreplay,
  fixturePlanDocument,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
  tugtoolPath,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

/** The card the plain arc runs on — and, after its rotation, the stale id. */
const SID_PLAIN = "a7c0d1ea-0000-4000-8000-000000000504";
/** The card the planned arc runs on. Its own card, so its own spawn id. */
const SID_PLANNED = "a7c0d1ea-0000-4000-8000-000000000505";

const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;

const PLAIN_ARC = "at0504-plain";
const PLANNED_ARC = "at0504-planned";

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: ArcScratchRepo | null = null;
const fixtureDirs: string[] = [];
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0504", checkout: CHECKOUT });

  // Two arcs whose documents differ by exactly one file. The plain arc gets a
  // brief and a task list, which is the shape the door leaves when it settles
  // the steps itself; the planned arc gets the brief alone. That one file is
  // the whole of the kind decision, so a difference in where the arc opens
  // can only be the derived-and-recorded kind talking.
  //
  // The plain arc has **no seat** before the wheel runs — no `arc create`, no
  // branch, no worktree — which is exactly what a door leaves: the documents
  // and the name. The dispatch makes the worktree before it composes the
  // `where` line that names it, and the first test asserts that it did. The
  // planned arc keeps the fixture's `arc create`: it opens at devise, which
  // makes nothing, so a seat for it is not this file's question.
  for (const arc of [PLAIN_ARC, PLANNED_ARC]) {
    if (arc === PLANNED_ARC) {
      createArc(projectDir(), arc, `at0504 ${arc}`, scratch.cli);
    } else {
      disarmAutoreplay(projectDir(), arc);
    }
    writeFileSync(arcBriefPath(projectDir(), arc), "# A brief\n\nOne small thing.\n");
    // Only the plain arc gets a task list: it is what makes the arc plain.
    if (arc === PLAIN_ARC) {
      writeFileSync(arcTasksPath(projectDir(), arc), fixturePlanDocument(1));
    }
  }

  for (const id of [SID_PLAIN, SID_PLANNED]) {
    fixtureDirs.push(seedScratchSession(projectDir(), id));
  }
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  for (const dir of fixtureDirs) rmScratchSession(dir);
});

async function openCard(app: App, sid: string): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: sessionCardShape({ width: 900, height: 660 }), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 30_000 },
  );
  await app.spawnSessionResume("A", { tugSessionId: sid, projectDir: projectDir() });
  await app.awaitEngineReady("A", { timeoutMs: 30_000 });
}

/** Run a shell command on the card through its own `$` route. */
async function shell(app: App, command: string): Promise<void> {
  await app.body("A").nativeClickAtElement(PROMPT_INPUT);
  await app.nativeType(`/shell ${command}`);
  await new Promise((r) => setTimeout(r, 150));
  await app.nativeKey("Enter", ["cmd"]);
}

interface ArcStageLine {
  stage: string;
  session_id: string;
}

interface ArcReading {
  stages: ArcStageLine[];
  kind: string | null;
  stopped: [string, string] | null;
}

// Kept local: every file's `arcReport` reads the fields its own arc assertions
// need, so the name is shared and the function is not.
/** What `tugtool arc record --json` says about an arc right now. */
function arcReport(name: string): ArcReading {
  const out = JSON.parse(
    tugtool(["arc", "record", name, "--json"], {
      cwd: projectDir(),
      binaryRoot: CHECKOUT,
      env: scratch?.cli.env,
    }),
  ) as { data: { arc: ArcReading | null } };
  return out.data.arc ?? { stages: [], kind: null, stopped: null };
}

/**
 * Wait until the arc record holds a rotation, and return the reading.
 *
 * A rotation is what the wheel writes an `arc-stage` line for, and the bridge
 * writes it when the fresh claude announces its session id — so this is the
 * moment the rotation is *complete*, not the moment it was asked for. A stop
 * ends the wait early and loudly: an arc that refused to rotate has a sentence
 * about why, and reporting it beats timing out with none.
 */
async function waitForRotation(name: string): Promise<ArcReading> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const arc = arcReport(name);
    if (arc.stages.length >= 1) return arc;
    if (arc.stopped !== null) {
      throw new Error(
        `at0504: ${name}'s arc stopped before it rotated — ${arc.stopped.join(": ")}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(`at0504: ${name}'s arc never rotated`);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

describe.skipIf(!SHOULD_RUN)("AT0504: a rotation the work does not notice", () => {
  test(
    "a brief with no task list opens at devise, which is what makes the kind a kind",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0504-arc-planned",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      const cli = tugtoolPath(CHECKOUT);
      try {
        await openCard(app, SID_PLANNED);

        // No flag, and none to pass: the brief with no task list beside it is
        // what buys the devise and the review before any step is walked, and
        // the opening reads that off the documents.
        await shell(app, `${cli} arc run ${PLANNED_ARC}`);
        const arc = await waitForRotation(PLANNED_ARC);
        note(`at0504 planned arc: ${JSON.stringify(arc)}`);

        expect(arc.kind, "the documents named it and the opening wrote it down").toBe(
          "planned",
        );
        expect(arc.stages[0]?.stage, "a brief with no plan settles first").toBe(
          "devise",
        );

        await shell(app, `${cli} arc stop ${PLANNED_ARC}`);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
