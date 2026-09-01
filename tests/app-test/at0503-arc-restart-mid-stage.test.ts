/**
 * at0503-arc-restart-mid-stage.test.ts — a tugcast restart in the middle of a
 * stage does not lose the arc, and the two shapes that look like a lost one
 * are told apart on the card.
 *
 * ## Why this exists
 *
 * W4 fixed three restart losses — persisted hand-backs, a re-derived
 * `last_done_count`, and the `arc-dispatch` intent that keeps a crash in the
 * dispatch gap from reading as a taken card — and every one of them is
 * unit-tested only: two wheels over one ledger, an empty state map, a
 * synthesized record. Nothing drove a real tugcast through a real restart. A
 * restart is the one interruption whose whole claim is that *nothing happens*,
 * and "nothing happens" is exactly the claim a unit test is worst at, because
 * the thing that must not happen lives in a process that a unit test does not
 * start.
 *
 * ## What is driven here
 *
 * A real dash in a scratch repository, the ledger state a rotation leaves
 * behind seeded through the bundle's own `--seed-ledger` (the same route
 * `at0485` established), an arc generation written into the real dash-log, and
 * then a full process relaunch. Two cases:
 *
 *   - **The restart itself.** The card comes back on the stage's own segment,
 *     the binding rides the restart onto it, and the arc *waits* — no stop, no
 *     receipt, no rotation. That is `dash-lifecycle.md`'s relaunch row, and it
 *     is the promise the whole Wheel rests on.
 *   - **The taken card.** The same state, but the card comes back on a fresh
 *     segment carrying no stage label — a `/new`, a reset, a rewind fork. That
 *     one *is* a taking, and the arc stops as `card taken` and says so.
 *
 * The second is here for the first's sake as much as its own: the crash-gap
 * fix is the claim that a restarted seat is **not** this, and a test that only
 * asserted the good case would pass just as well against a machine that had
 * stopped deciding anything at all.
 *
 * ## What is deliberately not here
 *
 * The crash-in-the-dispatch-gap case — an `arc-dispatch` line with no
 * `arc-stage` after it — decides `Rotate`, and a rotation seats a real claude
 * on a real stage prompt. It lives in `at0504`, behind that file's
 * `TUG_REAL_CLAUDE` gate, with the rest of the rotation work.
 *
 * **A stage-kill test is not here, and the reason is a finding rather than a
 * gap.** Killing the claude a stage is seated on does not reach
 * `ArcStopReason::SessionGone`. `session_snapshot` returns `None` for
 * `SpawnState::Idle` on purpose — a card parked `Idle` is indistinguishable
 * from a card whose tugcast just restarted, and judging it would stop every
 * in-flight arc on every relaunch — and a killed child parks the entry there
 * rather than in `Errored` or `Closed`. Driven here, the arc sat for ninety
 * seconds and decided nothing, which is the documented behaviour and not a
 * defect. `SessionGone` is reachable from `Errored`/`Closed`, which a kill is
 * not the gesture for; it is pinned in `dash_arc.rs`'s
 * `a_dead_session_stops_the_arc_whatever_the_documents_say`.
 *
 * @covers tugrust/crates/tugcast/src/feeds/dash_arc.rs
 * @covers tugrust/crates/tugcast/src/feeds/dash_arc_runner.rs
 * @covers tugrust/crates/tugcast/src/session_ledger.rs
 * @covers tugrust/crates/tugdash-core/src/arc.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  appendDashLogLine,
  createDash,
  dashLogPath,
  dashPlanPath,
  fixturePlanDocument,
  makeDashScratchRepo,
  rmDashScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
  type DashScratchRepo,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

/** The line of work every segment below belongs to. */
const LINE = "c1a0d1ea-0000-4000-8000-000000000503";
/** The root segment — the tug session id the bind was written against. */
const ROOT = "c1a0d1ea-0000-4000-8000-000000000504";
/** The implement stage the wheel seated. The arc record names it. */
const STAGE = "c1a0d1ea-0000-4000-8000-000000000505";
/** A fresh segment the user reached themselves — no stage label, ever. */
const FRESH = "c1a0d1ea-0000-4000-8000-000000000506";

const TAG = "brisk-heron";
/**
 * A dash per case, and not for tidiness.
 *
 * The dash-log is one shared, append-only file per project, so two cases
 * driving one dash write into one another's generation — and `read_arc` would
 * then be answering about a run neither test performed. One dash each is the
 * only way each case's record is its own.
 */
const DASH_WAITS = "at0503-waits";
const DASH_TAKEN = "at0503-taken";
const DASHES = [DASH_WAITS, DASH_TAKEN] as const;
const MASTHEAD_DASH =
  '[data-slot="session-masthead"] [data-slot="session-identity-dash"]';

/** This checkout — the build under test, and never the tree a dash is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: DashScratchRepo | null = null;
const dashIds = new Map<string, string>();
const fixtureDirs: string[] = [];
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeDashScratchRepo({ prefix: "at0503", checkout: CHECKOUT });
  for (const dash of DASHES) {
    const created = createDash(projectDir(), dash, `at0503 ${dash}`, scratch.cli);
    dashIds.set(dash, created.id);
    // A plan with its first step closed: an implement stage that has somewhere
    // left to go, which is what makes "the arc waits" a claim about restraint
    // rather than about an arc that had nothing to do anyway.
    writeFileSync(dashPlanPath(projectDir(), dash), fixturePlanDocument(3, ["done"]));
  }
  for (const id of [ROOT, STAGE, FRESH]) {
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
        size: { width: 900, height: 680 },
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

/**
 * The two segments of one line, exactly as a rotation leaves the ledger: both
 * live, the root bound, the stage forked from it and carrying the label only a
 * rotation writes. `tip` is the segment the card will come back on.
 *
 * Seeded *after* launch, because `demote_live_to_closed` flips every live row
 * at startup and a row seeded before one would arrive closed.
 */
function seedTheLine(app: App, dash: string, tip: "stage" | "fresh"): void {
  const repo = projectDir();
  const sessions = [
    {
      session_id: ROOT,
      workspace_key: repo,
      project_dir: repo,
      card_id: "A",
      line_id: LINE,
      tag: TAG,
      dash_id: dashIds.get(dash) ?? "",
      dash_name: dash,
    },
    {
      session_id: STAGE,
      workspace_key: repo,
      project_dir: repo,
      card_id: "A",
      line_id: LINE,
      forked_from_session_id: ROOT,
      stage_label: "implement",
      stage_model: "opus",
    },
  ];
  if (tip === "fresh") {
    // No `stage_label`: nothing the wheel did produced this session, which is
    // exactly what a `/new` on the card looks like from the ledger's side.
    sessions.push({
      session_id: FRESH,
      workspace_key: repo,
      project_dir: repo,
      card_id: "A",
      line_id: LINE,
      forked_from_session_id: STAGE,
    } as (typeof sessions)[number]);
  }
  app.seedLedger({ sessions });
}

/**
 * The arc generation a mid-stage crash leaves in the dash-log: opened on the
 * plan, running the plan course, with the implement stage seated on `STAGE`.
 *
 * Written straight into the real log rather than through a verb, because the
 * verb that writes these lines is the runner, and the runner writing them is
 * what this file is trying to interrupt.
 */
function seedTheArc(dash: string): void {
  const log = dashLogPath(scratch?.dataRoot ?? "");
  appendDashLogLine(log, dash, "arc-start", `.tug/dashes/${dash}/plan.md`);
  appendDashLogLine(log, dash, "arc-course", "plan");
  appendDashLogLine(log, dash, "arc-stage", `implement ${STAGE} opus`);
}

/** What `tugtool dash arc --json` says about the dash right now. */
function arcReport(dash: string): {
  stopped: [string, string] | null;
  stages: number;
  done: boolean;
} {
  const out = JSON.parse(
    tugtool(["dash", "arc", dash, "--json"], {
      cwd: projectDir(),
      binaryRoot: CHECKOUT,
      env: scratch?.cli.env,
    }),
  ) as {
    data: {
      arc: {
        stopped: [string, string] | null;
        stages: unknown[];
        done: boolean;
      } | null;
    };
  };
  const arc = out.data.arc;
  if (arc === null) return { stopped: null, stages: 0, done: false };
  return { stopped: arc.stopped, stages: arc.stages.length, done: arc.done };
}

async function awaitDeck(app: App): Promise<void> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 30_000 },
  );
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Give the runner room to have decided. The engine sweeps at startup and on
 * every turn end and changeset recompute, so several sweeps have gone by well
 * inside this — which is what makes "still nothing" evidence rather than
 * impatience.
 */
const SWEEPS_MS = 8_000;

describe.skipIf(!SHOULD_RUN)("AT0503: an arc across a tugcast restart", () => {
  test(
    "a restart mid-stage waits: the binding rides the seat and nothing stops",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const instanceId = `${process.env.TUG_APPTEST_ID_PREFIX ?? "apptest"}-arc-restart-${randomUUID()}`;
      const env = { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" };
      try {
        // ── Phase A: the state a crash mid-stage leaves behind ────────────
        {
          const app = await launchTugApp({
            testName: "at0503-arc-restart-mid-stage-A",
            instanceId,
            env,
          });
          try {
            await awaitDeck(app);
            seedTheLine(app, DASH_WAITS, "stage");
            seedTheArc(DASH_WAITS);
          } finally {
            await app.close();
          }
        }

        // ── Phase B: the restart ──────────────────────────────────────────
        {
          const app = await launchTugApp({
            testName: "at0503-arc-restart-mid-stage-B",
            instanceId,
            env,
          });
          try {
            await app.enableDeckTrace(true);
            await awaitDeck(app);
            await app.spawnSessionResume("A", {
              tugSessionId: STAGE,
              projectDir: projectDir(),
            });
            await app.awaitEngineReady("A", { timeoutMs: 30_000 });

            // The seat is the stage's own segment, on the line the bind was
            // written against — which is what makes the binding's move onto
            // it a move along a line rather than a guess.
            const facts = await app.evalJS<{ tugSessionId: string; lineId: string }>(
              `window.__tug.cardLineFacts("A")`,
            );
            expect(facts.tugSessionId, "seated on the stage's segment").toBe(STAGE);
            expect(facts.lineId, "on the line the bind names").toBe(LINE);

            // The binding rode the restart: the masthead's sigil reads the
            // account-global aggregate's `bound_sessions`, which only a live
            // row actually carrying the binding can reach.
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(MASTHEAD_DASH)}) !== null`,
              { timeoutMs: 20_000 },
            );
            const sigil = await app.evalJS<string>(
              `(document.querySelector(${JSON.stringify(MASTHEAD_DASH)})?.textContent ?? "").trim()`,
            );
            note(`at0503 masthead after restart: ${JSON.stringify(sigil)}`);
            expect(sigil, "the binding rode the restart").toContain(DASH_WAITS);

            // And the arc **waits**. The startup sweep has run, the card has
            // spawned, several ticks have gone by — and the stage has ended no
            // turn since the restart, so there is nothing about its documents
            // that is this stage's answer yet. No stop, no receipt, and no
            // second `arc-stage` line: the record still holds the one rotation
            // it held before the process died.
            await settle(SWEEPS_MS);
            const arc = arcReport(DASH_WAITS);
            note(`at0503 arc after the restart: ${JSON.stringify(arc)}`);
            expect(arc.stopped, "a relaunch is not an interruption").toBeNull();
            expect(arc.done).toBe(false);
            expect(arc.stages, "the stage was not rotated again").toBe(1);
            note("at0503 card after the restart", (await app.screenshot()).path);
          } finally {
            await app.close();
          }
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a card that came back on a fresh segment is a taking, and the arc says so",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const instanceId = `${process.env.TUG_APPTEST_ID_PREFIX ?? "apptest"}-arc-taken-${randomUUID()}`;
      const env = { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" };
      try {
        {
          const app = await launchTugApp({
            testName: "at0503-arc-restart-mid-stage-taken-A",
            instanceId,
            env,
          });
          try {
            await awaitDeck(app);
            seedTheLine(app, DASH_TAKEN, "fresh");
            seedTheArc(DASH_TAKEN);
          } finally {
            await app.close();
          }
        }
        {
          const app = await launchTugApp({
            testName: "at0503-arc-restart-mid-stage-taken-B",
            instanceId,
            env,
          });
          try {
            await app.enableDeckTrace(true);
            await awaitDeck(app);
            // The card comes back on a session the wheel never seated. From
            // the arc's side this is indistinguishable from the user having
            // pressed `/new` — and it should be, because that is what it is.
            await app.spawnSessionResume("A", {
              tugSessionId: FRESH,
              projectDir: projectDir(),
            });
            await app.awaitEngineReady("A", { timeoutMs: 30_000 });

            // The stop is a decision the sweep makes, so it is waited for
            // rather than settled for: the wait is the assertion.
            const deadline = Date.now() + 60_000;
            let arc = arcReport(DASH_TAKEN);
            while (arc.stopped === null && Date.now() < deadline) {
              await settle(1_000);
              arc = arcReport(DASH_TAKEN);
            }
            note(`at0503 arc after the taking: ${JSON.stringify(arc)}`);
            expect(arc.stopped?.[0]).toBe("implement");
            expect(arc.stopped?.[1]).toBe("card taken");
            note("at0503 card after the taking", (await app.screenshot()).path);
          } finally {
            await app.close();
          }
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
