/**
 * at0504-arc-rotation-carries-the-binding.test.ts — **the postmortem, as an
 * asserted property.**
 *
 * ## What this is
 *
 * `notes/wheel-rotation-strands-the-arc.md` records one incident: an implement
 * stage rotated mid-run, and the arc was stranded. The card's dash face went
 * blank, a `tugtool dash` verb run from the card's own shell was refused
 * because the shell still held the session id it was born with, and nothing
 * prompted the next step. Six workstreams of hardening followed. Every one of
 * them is tested where its fact lives — the ledger's units, the predicate's
 * table, the CLI's fixtures — and until this file **nothing joined them**: no
 * test drove a real rotation and then asked whether the run survived it.
 *
 * That is what this is. One rotation, forced rather than waited for, and the
 * three things the incident lost:
 *
 *   1. **The binding rode the seat.** The card's masthead sigil and the Z2
 *      DASH cell both still name the dash after the fresh segment lands. That
 *      is W2's broadcast ordering — the `session_updated` push carrying the
 *      `(session_id, line_id)` pair goes out before `bind_dash_ok`, so the
 *      deck's segment → line → card walk can resolve the announcement instead
 *      of silently no-opping.
 *   2. **A stale id still lands on the live segment.** A `tugtool dash` verb
 *      run with the session id the card was *born* with resolves to the
 *      segment the card is on *now*, and says so. That is W1's chokepoint,
 *      and `--dry-run` is the reading that shows its work without writing.
 *   3. **The next step is prompted.** The wheel's continue reaches the fresh
 *      session with the range the ledger has left. That is the runner.
 *
 * ## And the course the retrofit added
 *
 * The second test drives `--course dash` — implement → audit, with the task
 * list as implement's first act — which W5 landed with no app-test at all,
 * only the predicate's units. The claim is small and exact: the arc opens at
 * **implement**, having devised and reviewed nothing, and the record says
 * which course it is running rather than leaving a later reader to sniff the
 * documents for it.
 *
 * ## Running it
 *
 * On demand only, like `at0480`. A rotation seats a real claude on a real
 * stage prompt and the run costs real minutes and real tokens, so
 * `app-test-changed` skips it:
 *
 *     TUG_REAL_CLAUDE=1 just app-test tests/app-test/at0504-arc-rotation-carries-the-binding.test.ts
 *
 * @covers tugrust/crates/tugcast/src/feeds/dash_arc.rs
 * @covers tugrust/crates/tugcast/src/feeds/dash_arc_runner.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 * @covers tugrust/crates/tugcast/src/session_ledger.rs
 * @covers tugrust/crates/tugtool/src/dash.rs
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
  dashPlanPath,
  dashTasksPath,
  discardDash,
  fixturePlanDocument,
  makeDashScratchRepo,
  rmDashScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
  tugtoolPath,
  type DashScratchRepo,
} from "./dash-fixture";

/**
 * Two gates, meaning different things. `TUGAPP_APP_TEST` is every app-test's;
 * `TUG_REAL_CLAUDE` is this file's own, because a real rotation is not
 * something a derived selection should ever start on its own.
 */
const SHOULD_RUN =
  process.env.TUGAPP_APP_TEST === "1" && process.env.TUG_REAL_CLAUDE === "1";
const GATED_OFF = process.env.TUGAPP_APP_TEST === "1" && !SHOULD_RUN;

/** Real stages and real steps: minutes, not seconds. */
const TEST_TIMEOUT_MS = 1_200_000;
const STAGE_WAIT_MS = 420_000;

/** The card's spawn-time session id — and, after the rotation, the stale one. */
const SID = "a7c0d1ea-0000-4000-8000-000000000504";
/** The dash-course dash runs on its own card, so its own session. */
const SID_DASH_COURSE = "a7c0d1ea-0000-4000-8000-000000000505";

const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const NOTICE_ROWS = `${CARD} [data-slot="tug-notice"]`;
const STAGE_DIVIDERS = `${CARD} [data-slot="stage-divider"]`;
const MASTHEAD_DASH =
  '[data-slot="session-masthead"] [data-slot="session-identity-dash"]';
/** The Z2 DASH cell — the placard the incident blanked. */
const Z2_DASH_VALUE = `${CARD} [data-slot="tug-status-cell"][data-priority="tasks"] [data-slot="session-telemetry-dash-value"]`;

const ROTATION_DASH = "at0504-rotation";
const COURSE_DASH = "at0504-course";

/** This checkout — the build under test, and never the tree a dash is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

/**
 * A threshold no real turn can stay under, and it is **not raised**.
 *
 * `at0480` raises it the moment a compaction is seen, precisely so the stage
 * is continued rather than rotated. This file wants the rotation, so the
 * threshold stays where it is: the first step boundary compacts, and the
 * second — with the context still over the line and the compaction remembered
 * as having been tried — rotates. That is the arc's own second answer to an
 * oversized context, and it is the rotation the postmortem is about.
 */
const SCRATCH_CONFIG = `[tugtool.dash]
implement_compact_tokens = 1
`;

let scratch: DashScratchRepo | null = null;
const fixtureDirs: string[] = [];
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (GATED_OFF) {
    note(
      "at0504 skipped",
      "real-claude only — run with TUG_REAL_CLAUDE=1 just app-test tests/app-test/at0504-arc-rotation-carries-the-binding.test.ts",
    );
  }
  if (!SHOULD_RUN) return;
  scratch = makeDashScratchRepo({ prefix: "at0504", checkout: CHECKOUT });

  // ── The plan-course dash ───────────────────────────────────────────────
  // A plan and **no brief**: the document an arc opens on is the brief when
  // there is one, so writing none puts the plan in that seat — and a document
  // that lints as a plan skips devise. Three steps, because the rotation is
  // the *second* boundary and the stage needs a third step to be prompted
  // with afterwards.
  createDash(projectDir(), ROTATION_DASH, "at0504 rotation fixture", scratch.cli);
  writeFileSync(dashPlanPath(projectDir(), ROTATION_DASH), fixturePlanDocument(3));

  // ── The dash-course dash ───────────────────────────────────────────────
  // A brief and a task list, which is the shape `/dash` leaves: nothing to
  // devise, nothing to review, and a ledger implement can walk immediately.
  createDash(projectDir(), COURSE_DASH, "at0504 dash-course fixture", scratch.cli);
  writeFileSync(dashBriefPath(projectDir(), COURSE_DASH), "# A brief\n\nOne small thing.\n");
  writeFileSync(dashTasksPath(projectDir(), COURSE_DASH), fixturePlanDocument(1));

  writeFileSync(resolve(projectDir(), ".tugtool", "config.toml"), SCRATCH_CONFIG);
  for (const id of [SID, SID_DASH_COURSE]) {
    fixtureDirs.push(seedScratchSession(projectDir(), id));
  }
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  for (const dash of [ROTATION_DASH, COURSE_DASH]) {
    discardDash(projectDir(), dash, scratch?.cli);
  }
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

/** Wait until a wheel-attributed notice whose text contains `marker` is up. */
async function waitForWheelNotice(app: App, marker: string): Promise<void> {
  await app.waitForCondition<boolean>(
    `Array.from(document.querySelectorAll(${JSON.stringify(NOTICE_ROWS)}))
       .filter((el) => el.getAttribute("data-notice-origin") === "wheel")
       .some((el) => (el.textContent || "").indexOf(${JSON.stringify(marker)}) !== -1)`,
    { timeoutMs: STAGE_WAIT_MS },
  );
}

/** Wait until the arc record holds `count` `arc-stage` lines. */
async function waitForStages(name: string, count: number): Promise<void> {
  const deadline = Date.now() + STAGE_WAIT_MS;
  for (;;) {
    const arc = arcReport(name);
    if (arc.stages.length >= count) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `at0504: ${name} held ${arc.stages.length} stage(s), waited for ${count}`,
      );
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

interface ArcStageLine {
  stage: string;
  session_id: string;
}

/** What `tugtool dash arc --json` says about a dash right now. */
function arcReport(name: string): {
  stages: ArcStageLine[];
  course: string | null;
  stopped: [string, string] | null;
} {
  const out = JSON.parse(
    tugtool(["dash", "arc", name, "--json"], {
      cwd: projectDir(),
      binaryRoot: CHECKOUT,
      env: scratch?.cli.env,
    }),
  ) as {
    data: {
      arc: {
        stages: ArcStageLine[];
        course: string | null;
        stopped: [string, string] | null;
      } | null;
    };
  };
  const arc = out.data.arc;
  if (arc === null) return { stages: [], course: null, stopped: null };
  return { stages: arc.stages, course: arc.course, stopped: arc.stopped };
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
    "an implement rotation keeps the binding, resolves a stale id, and prompts the next step",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0504-arc-rotation-carries-the-binding",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      const cli = tugtoolPath(CHECKOUT);
      try {
        await openCard(app, SID);

        // Opening the arc binds this card and starts the wheel. The plan
        // document lints, so the course opens at review and reaches implement
        // once review has ended a turn.
        await shell(app, `${cli} dash run ${ROTATION_DASH}`);
        await app.waitForCondition<boolean>(
          `Array.from(document.querySelectorAll(${JSON.stringify(STAGE_DIVIDERS)}))
             .some((el) => (el.textContent || "").indexOf("implement") !== -1)`,
          { timeoutMs: STAGE_WAIT_MS },
        );
        const seated = arcReport(ROTATION_DASH);
        note(`at0504 stages at implement: ${JSON.stringify(seated.stages)}`);
        expect(seated.course, "the arc recorded its course").toBe("plan");
        const stagesBefore = seated.stages.length;

        // The first step boundary is above the threshold, so the arc's first
        // answer is a compaction — and the threshold is never raised, so the
        // second boundary is the rotation.
        await waitForWheelNotice(app, "/compact");
        note("at0504 the compaction landed", (await app.screenshot()).path);

        // ── The rotation ─────────────────────────────────────────────────
        await waitForStages(ROTATION_DASH, stagesBefore + 1);
        const rotated = arcReport(ROTATION_DASH);
        note(`at0504 stages after the rotation: ${JSON.stringify(rotated.stages)}`);
        expect(rotated.stages.at(-1)?.stage, "implement rotated onto a fresh session").toBe(
          "implement",
        );
        expect(rotated.stopped, "the rotation is not a stop").toBeNull();

        // ── 1. The binding rode the seat ─────────────────────────────────
        //
        // The masthead's sigil reads the account-global aggregate's
        // `bound_sessions`, which only a live row actually carrying the
        // binding reaches; the Z2 cell reads the same dash through the card's
        // own binding store, which is what `bind_dash_ok` writes. The
        // incident blanked both. Waited for rather than sampled, because the
        // fresh segment's frames arrive on their own beat.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(MASTHEAD_DASH)}) !== null`,
          { timeoutMs: 60_000 },
        );
        const sigil = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(MASTHEAD_DASH)})?.textContent ?? "").trim()`,
        );
        note(`at0504 masthead after the rotation: ${JSON.stringify(sigil)}`);
        expect(sigil, "the card still names its dash").toContain(ROTATION_DASH);

        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(Z2_DASH_VALUE)}) !== null`,
          { timeoutMs: 60_000 },
        );
        const placard = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(Z2_DASH_VALUE)})?.textContent ?? "").trim()`,
        );
        note(`at0504 Z2 placard after the rotation: ${JSON.stringify(placard)}`);
        expect(placard.length, "the Z2 placard did not blank").toBeGreaterThan(0);

        // ── 2. A stale id lands on the live segment ──────────────────────
        //
        // `SID` is the id the card was born on, and the rotation has moved
        // the line's tip past it. Every process started before the rotation —
        // the card's own `$` shell above all — is still holding it.
        const dry = bindDryRun(ROTATION_DASH, SID);
        note(`at0504 stale-id resolution: ${JSON.stringify(dry)}`);
        expect(dry.posted_session_id, "the stale id is what went out").toBe(SID);
        expect(dry.resolved, "an instance answered").toBe(true);
        expect(dry.rotated, "and said the posted id had rotated").toBe(true);
        expect(dry.tug_session_id, "so the verb landed on the live segment").not.toBe(SID);
        expect(dry.state, "which is live").toBe("live");
        expect(dry.tug_session_id, "the segment the rotation seated").toBe(
          rotated.stages.at(-1)?.session_id,
        );

        // ── 3. The next step is prompted ─────────────────────────────────
        //
        // The rotation happened at a step boundary, so the fresh session's
        // opening prompt names what the ledger has left — the third step, on
        // its own, because the second closed to produce the boundary.
        await waitForWheelNotice(app, "Steps 3-3");
        note("at0504 the run walked on", (await app.screenshot()).path);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a dash-course arc opens at implement and records the course it runs",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0504-arc-dash-course",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      const cli = tugtoolPath(CHECKOUT);
      try {
        await openCard(app, SID_DASH_COURSE);

        await shell(app, `${cli} dash run ${COURSE_DASH} --course dash`);

        // The claim, and it is the whole of what `--course dash` means: the
        // first stage the wheel seats is **implement**. A brief with no plan
        // would open at devise under the default course, so this is the
        // recorded kind deciding rather than the documents being sniffed.
        await waitForStages(COURSE_DASH, 1);
        const opened = arcReport(COURSE_DASH);
        note(`at0504 dash-course opening: ${JSON.stringify(opened)}`);
        expect(opened.course, "the kind is recorded, not derived later").toBe("dash");
        expect(opened.stages[0]?.stage, "no devise, no review").toBe("implement");
        expect(
          opened.stages.map((s) => s.stage),
          "nothing before implement",
        ).not.toContain("devise");

        await app.waitForCondition<boolean>(
          `Array.from(document.querySelectorAll(${JSON.stringify(STAGE_DIVIDERS)}))
             .some((el) => (el.textContent || "").indexOf("implement") !== -1)`,
          { timeoutMs: STAGE_WAIT_MS },
        );
        note("at0504 dash-course seated at implement", (await app.screenshot()).path);

        // ── implement → audit ────────────────────────────────────────────
        //
        // The one-step task list runs out, and the progression's next and
        // last stage is the audit. This is the half of `--course dash` that
        // had no test at all.
        await waitForStages(COURSE_DASH, 2);
        const walked = arcReport(COURSE_DASH);
        note(`at0504 dash-course stages: ${JSON.stringify(walked.stages)}`);
        expect(walked.stages.at(-1)?.stage, "implement hands to audit").toBe("audit");
        expect(
          walked.stages.map((s) => s.stage),
          "and review was never run",
        ).not.toContain("review");
        note("at0504 dash-course at audit", (await app.screenshot()).path);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
