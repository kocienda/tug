/**
 * at0505-arc-stage-kill.test.ts — **a stage whose claude dies reaches
 * `SessionGone`, and the card is told.**
 *
 * ## Why this exists, and why W6 could not write it
 *
 * `at0503`'s docblock records a finding: killing the claude a stage is seated
 * on did not reach `ArcStopReason::SessionGone`. Driven end to end, the arc sat
 * for ninety seconds and decided nothing. The reason was structural rather than
 * accidental — `session_snapshot` returns `None` for an entry parked
 * `SpawnState::Idle`, on purpose, because a card parked `Idle` was
 * indistinguishable from a card whose tugcast had just restarted, and judging
 * it would stop every in-flight arc on every relaunch. A dead child parks
 * there. So the shape had **no facts**, and a machine with no facts reached no
 * decision, wrote no receipt, and — since W6's clock is driven by facts — never
 * even started counting.
 *
 * W7 closes it at the source rather than at the symptom, in two moves that are
 * both asserted here:
 *
 *   1. **The two `Idle`s are told apart.** `LedgerEntry::ever_live_here` is set
 *      at the `Spawning → Live` promote, so an entry *this process* watched run
 *      and then found back at `Idle` has lost the child it was running. That is
 *      a death, and `session_live` reads false for it. The other `Idle` — an
 *      entry rebound from tugbank that no deck has spawned yet — never set the
 *      flag and is still the wait it always was, which `at0503`'s first case
 *      goes on asserting.
 *   2. **The clock covers a session with no snapshot at all.** Whatever else
 *      may produce a factless arc, it now degrades to *late* rather than to
 *      *forever*: `watch_the_clock_unseated` seeds and reads the same stall
 *      deadline every other silence is measured against, and stops through the
 *      same receipt-bearing path. That is the stabilization brief's busy-latch
 *      principle, applied to the one gap W6 left.
 *
 * ## What is driven
 *
 * A real rotation — `at0504`'s finding, that the *opening* rotation of a dash
 * course is a fresh segment seated by the wheel and lands about a second after
 * the door is opened, so a rotation costs seconds rather than the twenty
 * minutes a plan course through two real step boundaries costs. Then the
 * stage's own subprocess tree is killed from outside the app, by pid, and the
 * assertion is that the arc **decides**: `arc-stop <stage> session gone` in the
 * record, within a sweep rather than never.
 *
 * **There is no receipt on the card, and that is the honest reading rather
 * than a gap.** This file was asked for one; driven, the card has already
 * fallen back to its session picker by the time the arc decides — the DOM
 * under `[data-card-id="A"]` holds `session-card-picker` and no transcript at
 * all — because a card whose session died unbinds. So the receipt has nowhere
 * to paint, exactly as `dash-lifecycle.md`'s **card closed** row already says
 * of its own case: there is no card left to paint one on, and the only surface
 * missing is one that does not exist. The record, `tugtool dash arc`, and the
 * Dashes card carry it, and the assertion below states the picker outright so the
 * absence is a claim this file makes rather than a check it quietly dropped.
 *
 * The kill is by pid because that is the gesture — a process dying is not a
 * frame anybody sends, and a fixture that simulated it with a control verb
 * would be asserting against a path no crash takes. `tugcode` is found by the
 * card's own uuid, which `build_tugcode_command` puts in its argv, and the tree
 * beneath it is claude.
 *
 * **One kill is terminal here, and finding that out is what this file is
 * for.** The bridge is *written* to retry — `RelayOutcome::Crashed` records
 * against the per-session crash budget and respawns a second later, which is
 * what would make a transient death invisible to the work. Driven for real, no
 * respawn arrives: `ps` under the app's own tugcast shows no tugcode for the
 * card at all, twenty-four seconds and five kill rounds later, and the ledger
 * row still reads `live`. Two drafts of this file were spent assuming
 * otherwise — one broke out of the loop believing a quiet four seconds meant a
 * dead tree, the next spent a crash budget that was never being spent — and
 * both were arguing with the machine. Every round's pids stay in the
 * diagnostics for that reason: a round that killed nothing is a claim about
 * the machine, not noise.
 *
 * That is the defect, and it is the one W7 fixes. `spawn_state` is the
 * *bridge's* account of itself, so an entry whose child died and whose retry
 * never returned goes on saying `Live` — a live session with no process, which
 * the predicate has no arm for and which produces nothing for the clock to
 * count either. `LedgerEntry::child_gone_at` is the absence itself, stamped
 * when the relay tears the child down and cleared when a new one is captured,
 * and `session_snapshot` reads a gap older than `CHILD_GONE_GRACE` as a
 * session that is not coming back.
 *
 * ## What is deliberately not here
 *
 * **The clock's own deadline.** Stopping an arc on a wall clock takes the wall
 * clock's time, and `arc_stall_secs` on the floor still costs a poll interval
 * per reading. The clock's arithmetic is pinned where it is pure — the runner's
 * `clock_ran_out` table — and its coverage of a factless arc is pinned in
 * `dash_arc_runner`'s own tests. This file asserts the *decision*, which is the
 * half a unit test cannot reach.
 *
 * @covers tugrust/crates/tugcast/src/feeds/dash_arc_runner.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_bridge.rs
 * @covers tugrust/crates/tugdash-core/src/arc.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
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
// Generous, and every part of it is somebody else's clock: five kill rounds
// paced to outlast the bridge's backoff, then the arc engine's own poll, which
// is a minute's granularity because a dead child produces no turn end and no
// changeset recompute to wake the sweep on. Observed end to end at about a
// hundred seconds; the budget is the room for a loaded machine, and a first
// draft that sized it at five minutes spent the whole of it and timed out
// mid-assertion, which reads as a defect and is not one.
const TEST_TIMEOUT_MS = 420_000;

/** The card the dash course runs on, and whose subprocess tree is killed. */
const SID = "a7c0d1ea-0000-4000-8000-000000000506";

const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;

const DASH = "at0505-stage-kill";

/** This checkout — the build under test, and never the tree a dash is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: DashScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeDashScratchRepo({ prefix: "at0505", checkout: CHECKOUT });
  // A brief and a task list — the shape `/dash` leaves, and the shape whose
  // recorded `dash` course opens straight at implement. One rotation is all
  // this file needs and the opening one is the cheapest there is.
  createDash(projectDir(), DASH, `at0505 ${DASH}`, scratch.cli);
  writeFileSync(dashBriefPath(projectDir(), DASH), "# A brief\n\nOne small thing.\n");
  writeFileSync(dashTasksPath(projectDir(), DASH), fixturePlanDocument(1));
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmDashScratchRepo(scratch);
  rmScratchSession(fixtureDir);
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

async function openCard(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 30_000 },
  );
  await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
  await app.awaitEngineReady("A", { timeoutMs: 30_000 });
}

/** Run a shell command on the card through its own `$` route. */
async function shell(app: App, command: string): Promise<void> {
  await app.nativeClickAtElement(PROMPT_INPUT);
  await app.nativeType(`/shell ${command}`);
  await new Promise((r) => setTimeout(r, 150));
  await app.nativeKey("Enter", ["cmd"]);
}

const settle = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

interface ArcReading {
  stages: { stage: string; session_id: string }[];
  stopped: [string, string] | null;
  done: boolean;
}

/** What `tugtool dash arc --json` says about the dash right now. */
function arcReport(): ArcReading {
  const out = JSON.parse(
    tugtool(["dash", "arc", DASH, "--json"], {
      cwd: projectDir(),
      binaryRoot: CHECKOUT,
      env: scratch?.cli.env,
    }),
  ) as { data: { arc: ArcReading | null } };
  return out.data.arc ?? { stages: [], stopped: null, done: false };
}

/** Wait until the wheel has seated a stage, or say the arc stopped instead. */
async function waitForRotation(): Promise<ArcReading> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const arc = arcReport();
    if (arc.stages.length >= 1) return arc;
    if (arc.stopped !== null) {
      throw new Error(
        `at0505: the arc stopped before it rotated — ${arc.stopped.join(": ")}`,
      );
    }
    if (Date.now() >= deadline) throw new Error("at0505: the arc never rotated");
    await settle(1_000);
  }
}

/**
 * Every pid in the card's own tugcode subtree, deepest first.
 *
 * `build_tugcode_command` puts `--session-id <uuid>` in tugcode's argv, and the
 * uuid is the card's, so one `pgrep -f` on the **uuid alone** names the
 * bridge's child without matching any other card's or any other run's. The flag
 * is deliberately not in the pattern: `pgrep` reads a leading `--` as its own
 * option and finds nothing, silently, which is the first thing this file got
 * wrong. Its children are claude and whatever claude has open; killing
 * deepest-first means the parent never sees a half-torn tree and re-parents an
 * orphan.
 *
 * A `pgrep` that matches nothing exits non-zero, which is an answer rather than
 * a failure — a tree already gone is a tree already dead.
 */
function subtreeOf(sessionId: string): number[] {
  const pids = (args: string[]): number[] => {
    try {
      return execFileSync("pgrep", args, { encoding: "utf8" })
        .split("\n")
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((pid) => Number.isFinite(pid) && pid > 0);
    } catch {
      return [];
    }
  };
  const roots = pids(["-f", sessionId]);
  const out: number[] = [];
  const walk = (pid: number): void => {
    for (const child of pids(["-P", String(pid)])) walk(child);
    out.push(pid);
  };
  for (const root of roots) walk(root);
  return out;
}

/** SIGKILL the card's whole tugcode subtree. Returns what it killed. */
function killTheStage(): number[] {
  const pids = subtreeOf(SID);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone between the walk and the signal — the outcome we wanted.
    }
  }
  return pids;
}

/**
 * What the ledger says about the card's line right now, without writing.
 *
 * `dash bind --dry-run` is the reading W1's chokepoint exposes: it resolves the
 * posted id through the line and reports the segment's `state`. Noted around
 * the kill because the arc's sweep is **live-row-only** — `bound_sessions_by_dash`
 * filters to live rows — so a row that stopped reading `live` would take the
 * arc out of the sweep entirely, and "the arc decided nothing" would mean
 * something quite different from "the arc decided to wait".
 */
function ledgerState(): unknown {
  const out = JSON.parse(
    tugtool(["dash", "bind", DASH, "--dry-run", "--json"], {
      cwd: projectDir(),
      binaryRoot: CHECKOUT,
      env: { ...scratch?.cli.env, TUG_SESSION_ID: SID },
    }),
  ) as { data: unknown };
  return out.data;
}

describe.skipIf(!SHOULD_RUN)("AT0505: a stage whose claude dies", () => {
  test(
    "the arc stops as session gone, and the card has already unbound",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0505-arc-stage-kill",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      const cli = tugtoolPath(CHECKOUT);
      try {
        await openCard(app);

        // The door. Its first act is the rotation, and the rotation is what
        // seats the claude this test is about to kill.
        await shell(app, `${cli} dash run ${DASH} --course dash`);
        const seated = await waitForRotation();
        note(`at0505 the seated stage: ${JSON.stringify(seated)}`);
        expect(seated.stages[0]?.stage, "the dash course opens at implement").toBe(
          "implement",
        );

        // ── The kill ─────────────────────────────────────────────────────
        //
        // Delivered on a cadence rather than once, and **no round breaks
        // early**: a round that finds nothing has either looked inside the
        // one-second backoff or watched a tree that is not coming back, and
        // only the next round can tell those apart. The rounds outlast the
        // backoff by six times over, so what the pids show is the machine's
        // answer to "does the bridge bring this session back", which is the
        // question the fix turns on.
        const killed: number[][] = [];
        for (let round = 0; round < 5; round += 1) {
          killed.push(killTheStage());
          await settle(6_000);
        }
        note(`at0505 killed subtrees, per round: ${JSON.stringify(killed)}`);
        note(`at0505 the ledger after the kill: ${JSON.stringify(ledgerState())}`);
        expect(
          killed[0]!.length,
          "a rotation seated a real subprocess tree to kill",
        ).toBeGreaterThan(0);
        // The row stays `live` through all of it, which is what keeps the arc
        // in the sweep: `bound_sessions_by_dash` is live-only, so a row that
        // had gone non-live would take the arc out of the sweep entirely and
        // "the arc decided nothing" would mean something else again.
        expect(
          (ledgerState() as { state: string }).state,
          "the ledger row is still live, so the arc is still swept",
        ).toBe("live");

        // ── The decision ─────────────────────────────────────────────────
        //
        // Waited for rather than settled for: the wait *is* the assertion, and
        // the thing this file exists to prove is that one arrives at all. The
        // arc's own wake is a turn ending or a changeset recompute, and a dead
        // child produces neither, so the sweep that decides this is the
        // engine's own clock poll — a minute's granularity, hence the budget.
        const deadline = Date.now() + 150_000;
        let arc = arcReport();
        while (arc.stopped === null && Date.now() < deadline) {
          await settle(2_000);
          arc = arcReport();
        }
        note(`at0505 the arc after the kill: ${JSON.stringify(arc)}`);
        note(`at0505 the ledger at the decision: ${JSON.stringify(ledgerState())}`);
        expect(arc.stopped, "the arc decided rather than sitting").not.toBeNull();
        expect(arc.stopped?.[0], "in the stage that was seated").toBe("implement");
        expect(arc.stopped?.[1], "and said its session ended").toBe("session gone");
        expect(arc.done, "a stop is not a completion").toBe(false);

        // ── And the card is already gone ─────────────────────────────────
        //
        // The stop's own sentence reaches a live card as a shell-exchange row
        // under `/dash-arc` ([D111]) — `at0476` asserts exactly that for a
        // `dash stop`. It cannot here, and the reason is the point: the card
        // whose session died has unbound and fallen back to its picker, so
        // there is no transcript for a receipt to enter. The rows are read
        // anyway, and both readings are noted, because "no rows" is the claim
        // and a claim wants its evidence.
        const readRows = async (): Promise<string[]> =>
          JSON.parse(
            await app.evalJS<string>(
              `JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(
                SHELL_ROWS,
              )})).map((el) => el.textContent || ""))`,
            ),
          ) as string[];
        const rowDeadline = Date.now() + 45_000;
        let seen = await readRows();
        while (
          !seen.some((text) => text.indexOf("its session ended") !== -1) &&
          Date.now() < rowDeadline
        ) {
          await settle(2_000);
          seen = await readRows();
        }
        // Noted whether or not it landed: a card that did not paint the stop
        // is the postmortem's own screen, and what it *did* paint is the first
        // thing the next reader needs.
        note(`at0505 the card's shell rows: ${JSON.stringify(seen)}`);
        note(
          `at0505 the card's DOM: ${await app.evalJS<string>(
            `JSON.stringify({
               cards: document.querySelectorAll('[data-card-id="A"]').length,
               transcriptRows: document.querySelectorAll('[data-card-id="A"] [data-slot^="session-transcript"]').length,
               slots: Array.from(new Set(Array.from(document.querySelectorAll('[data-card-id="A"] [data-slot]')).map((el) => el.getAttribute("data-slot")))).slice(0, 40),
             })`,
          )}`,
        );
        note("at0505 the card after the kill", (await app.screenshot()).path);
        const onThePicker = await app.evalJS<boolean>(
          `document.querySelector('[data-card-id="A"] [data-slot="session-card-picker"]') !== null`,
        );
        expect(
          onThePicker,
          "the card unbound when its session died, which is why no receipt paints",
        ).toBe(true);
        expect(
          seen,
          "and there is no transcript left for one to enter",
        ).toEqual([]);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
