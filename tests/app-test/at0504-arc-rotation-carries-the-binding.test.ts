/**
 * at0504-arc-rotation-carries-the-binding.test.ts — **the postmortem, as an
 * asserted property.**
 *
 * ## What this is
 *
 * `notes/wheel-rotation-strands-the-arc.md` records one incident: a stage
 * rotated, and the arc was stranded. The card's dash face went blank, a
 * `tugtool dash` verb run from a shell born before the rotation was refused
 * because that shell still held the session id it started with, and the run
 * did not walk on. Six workstreams of hardening followed. Every one of them is
 * tested where its fact lives — the ledger's units, the predicate's table, the
 * CLI's fixtures — and until this file **nothing joined them**: no test drove a
 * real rotation and then asked whether the run survived it.
 *
 * ## The rotation is the event, not the errand
 *
 * The first draft of this file spent twenty minutes getting to a rotation the
 * hard way: a plan-course arc through a real review stage, then a real
 * implement stage, then two real step boundaries with the compaction threshold
 * on the floor so the second one rotated. It never arrived, and the reason is
 * worth keeping: **every one of those minutes was spent earning a rotation,
 * and none of them was spent on what the incident was about.** A rotation is a
 * fresh segment minted on the card's line and seated by the wheel. The
 * *opening* rotation of a dash course is exactly that, and it lands about a
 * second after the door is opened.
 *
 * So the door is the gesture, and the four things the incident lost are the
 * assertions:
 *
 *   1. **The course kind is recorded and obeyed.** `--course dash` opens at
 *      implement; the same dash without it opens at devise. That is W5's
 *      recorded kind, driven end to end for the first time — the second test
 *      is the contrast, and the contrast is what makes it a *recorded* kind
 *      rather than a document sniff.
 *   2. **The binding rode the seat.** The card's masthead sigil and the Z2
 *      DASH cell still name the dash after the fresh segment lands. That is
 *      W2's broadcast ordering: the `session_updated` push carrying the
 *      `(session_id, line_id)` pair goes out before `bind_dash_ok`, so the
 *      deck's segment → line → card walk can resolve the announcement instead
 *      of silently no-opping.
 *   3. **A stale id still lands on the live segment.** `tugtool dash bind
 *      --dry-run --json`, run with the id the card was *born* with, reports
 *      `rotated: true` and resolves to the segment the card is on *now*. That
 *      is W1's chokepoint, over a real rotation, and `--dry-run` is the
 *      reading that shows its work without writing.
 *   4. **The stage was actually seated.** A `stage_label` is written only by a
 *      rotation the wheel performed, and the card's own divider says which
 *      stage it landed on.
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
 * @covers tugrust/crates/tugcast/src/feeds/dash_arc.rs
 * @covers tugrust/crates/tugcast/src/feeds/dash_arc_runner.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 * @covers tugrust/crates/tugcast/src/session_ledger.rs
 * @covers tugrust/crates/tugtool/src/dash.rs
 * @covers tugrust/crates/tugdash-core/src/arc.rs
 * @covers tugdeck/src/lib/card-session-binding-store.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  createDash,
  dashBriefPath,
  dashTasksPath,
  fixturePlanDocument,
  makeDashScratchRepo,
  rmDashScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
  tugtoolPath,
  type DashScratchRepo,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

/** The card the dash course runs on — and, after its rotation, the stale id. */
const SID_DASH = "a7c0d1ea-0000-4000-8000-000000000504";
/** The card the plan course runs on. Its own card, so its own spawn id. */
const SID_PLAN = "a7c0d1ea-0000-4000-8000-000000000505";

const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const STAGE_DIVIDERS = `${CARD} [data-slot="stage-divider"]`;
const MASTHEAD_DASH =
  '[data-slot="session-masthead"] [data-slot="session-identity-dash"]';
/** The Z2 DASH cell — the placard the incident blanked. */
const Z2_DASH_VALUE = `${CARD} [data-slot="tug-status-cell"][data-priority="tasks"] [data-slot="session-telemetry-dash-value"]`;

const DASH_COURSE = "at0504-dash-course";
const PLAN_COURSE = "at0504-plan-course";

/** This checkout — the build under test, and never the tree a dash is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: DashScratchRepo | null = null;
const fixtureDirs: string[] = [];
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeDashScratchRepo({ prefix: "at0504", checkout: CHECKOUT });

  // Two dashes with **identical documents** — a brief and a task list, which
  // is the shape `/dash` leaves. Identical on purpose: the only thing that
  // differs between the two tests is the `--course` flag, so a difference in
  // where the arc opens can only be the recorded kind talking.
  for (const dash of [DASH_COURSE, PLAN_COURSE]) {
    createDash(projectDir(), dash, `at0504 ${dash}`, scratch.cli);
    writeFileSync(dashBriefPath(projectDir(), dash), "# A brief\n\nOne small thing.\n");
    writeFileSync(dashTasksPath(projectDir(), dash), fixturePlanDocument(1));
  }

  for (const id of [SID_DASH, SID_PLAN]) {
    fixtureDirs.push(seedScratchSession(projectDir(), id));
  }
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmDashScratchRepo(scratch);
  for (const dir of fixtureDirs) rmScratchSession(dir);
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 660 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

async function openCard(app: App, sid: string): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 30_000 },
  );
  await app.spawnSessionResume("A", { tugSessionId: sid, projectDir: projectDir() });
  await app.awaitEngineReady("A", { timeoutMs: 30_000 });
}

/** Run a shell command on the card through its own `$` route. */
async function shell(app: App, command: string): Promise<void> {
  await app.nativeClickAtElement(PROMPT_INPUT);
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
  course: string | null;
  stopped: [string, string] | null;
}

/** What `tugtool dash arc --json` says about a dash right now. */
function arcReport(name: string): ArcReading {
  const out = JSON.parse(
    tugtool(["dash", "arc", name, "--json"], {
      cwd: projectDir(),
      binaryRoot: CHECKOUT,
      env: scratch?.cli.env,
    }),
  ) as { data: { arc: ArcReading | null } };
  return out.data.arc ?? { stages: [], course: null, stopped: null };
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

/**
 * `dash bind --dry-run --json`, run with `stale` in the environment.
 *
 * From **node**, not from the card's `$` route, and that is the whole point:
 * the `$` route stamps the session id the card holds *now*, and the id the
 * incident was about is the one a process born before the rotation is still
 * carrying. `--dry-run` is the reading that shows the resolution and writes
 * nothing, so the assertion costs the binding nothing.
 */
function bindDryRun(
  name: string,
  stale: string,
): {
  posted_session_id: string;
  tug_session_id: string;
  state: string | null;
  line_id: string | null;
  rotated: boolean;
  resolved: boolean;
} {
  const out = JSON.parse(
    tugtool(["dash", "bind", name, "--dry-run", "--json"], {
      cwd: projectDir(),
      binaryRoot: CHECKOUT,
      env: { ...scratch?.cli.env, TUG_SESSION_ID: stale },
    }),
  ) as {
    data: {
      posted_session_id: string;
      tug_session_id: string;
      state: string | null;
      line_id: string | null;
      rotated: boolean;
      resolved: boolean;
    };
  };
  return out.data;
}

describe.skipIf(!SHOULD_RUN)("AT0504: a rotation the work does not notice", () => {
  test(
    "a dash course opens at implement, and its rotation carries the binding and the id",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0504-arc-rotation-carries-the-binding",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      const cli = tugtoolPath(CHECKOUT);
      try {
        await openCard(app, SID_DASH);

        // The door. Opening the arc binds this card and starts the wheel,
        // whose first act is the rotation this whole file is about.
        await shell(app, `${cli} dash run ${DASH_COURSE} --course dash`);
        const arc = await waitForRotation(DASH_COURSE);
        note(`at0504 dash-course arc: ${JSON.stringify(arc)}`);

        // ── 1. The recorded course decided where to open ─────────────────
        //
        // A brief with no plan opens at *devise* under the default course —
        // which the second test drives, over identical documents. So this is
        // the kind talking, not the documents.
        expect(arc.course, "the kind is recorded, not derived later").toBe("dash");
        expect(arc.stages[0]?.stage, "no devise, no review").toBe("implement");
        const seatedSegment = arc.stages[0]!.session_id;
        expect(seatedSegment, "a rotation seated a fresh segment").not.toBe(SID_DASH);

        // ── 2. The stage was really seated ───────────────────────────────
        //
        // The card's own divider is the surface half of the same fact: a
        // `stage_label` is written only by a rotation the wheel performed.
        await app.waitForCondition<boolean>(
          `Array.from(document.querySelectorAll(${JSON.stringify(STAGE_DIVIDERS)}))
             .some((el) => (el.textContent || "").indexOf("implement") !== -1)`,
          { timeoutMs: 60_000 },
        );
        note("at0504 the stage is seated", (await app.screenshot()).path);

        // ── 3. The binding rode the seat ─────────────────────────────────
        //
        // The masthead's sigil reads the account-global aggregate's
        // `bound_sessions`, which only a live row actually carrying the
        // binding reaches; the Z2 cell reads the same dash through the card's
        // own binding store, which is what `bind_dash_ok` writes. The
        // incident blanked both.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(MASTHEAD_DASH)}) !== null`,
          { timeoutMs: 60_000 },
        );
        const sigil = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(MASTHEAD_DASH)})?.textContent ?? "").trim()`,
        );
        note(`at0504 masthead after the rotation: ${JSON.stringify(sigil)}`);
        expect(sigil, "the card still names its dash").toContain(DASH_COURSE);

        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(Z2_DASH_VALUE)}) !== null`,
          { timeoutMs: 60_000 },
        );
        const placard = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(Z2_DASH_VALUE)})?.textContent ?? "").trim()`,
        );
        note(`at0504 Z2 placard after the rotation: ${JSON.stringify(placard)}`);
        expect(placard.length, "the Z2 placard did not blank").toBeGreaterThan(0);

        // ── 4. A stale id lands on the live segment ──────────────────────
        //
        // `SID_DASH` is the id the card was born on, and the rotation has
        // moved the line's tip past it. Every process started before the
        // rotation — the card's own `$` shell above all — is still holding it,
        // and the incident is what happened when one of them was believed.
        const dry = bindDryRun(DASH_COURSE, SID_DASH);
        note(`at0504 stale-id resolution: ${JSON.stringify(dry)}`);
        expect(dry.posted_session_id, "the stale id is what went out").toBe(SID_DASH);
        expect(dry.resolved, "an instance answered").toBe(true);
        expect(dry.rotated, "and said the posted id had rotated").toBe(true);
        expect(dry.state, "the segment it resolved to is live").toBe("live");
        expect(dry.tug_session_id, "and is the one the rotation seated").toBe(
          seatedSegment,
        );

        // Stop the arc rather than leaving a stage running past the reading.
        await shell(app, `${cli} dash stop ${DASH_COURSE}`);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the same documents without --course open at devise, which is what makes the kind a kind",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0504-arc-plan-course-default",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      const cli = tugtoolPath(CHECKOUT);
      try {
        await openCard(app, SID_PLAN);

        // No `--course`, so the default. [B08]'s default is `plan`, and its
        // asymmetry is deliberate: opening a dash-course dash at devise costs
        // two rotations it did not need, while opening a plan-course dash at
        // implement skips a cold read it did.
        await shell(app, `${cli} dash run ${PLAN_COURSE}`);
        const arc = await waitForRotation(PLAN_COURSE);
        note(`at0504 plan-course arc: ${JSON.stringify(arc)}`);

        expect(arc.course, "the default is recorded like any other kind").toBe("plan");
        expect(arc.stages[0]?.stage, "a brief with no plan settles first").toBe(
          "devise",
        );

        await shell(app, `${cli} dash stop ${PLAN_COURSE}`);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
