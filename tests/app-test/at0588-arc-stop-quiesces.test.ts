/**
 * at0588-arc-stop-quiesces.test.ts — Stop is a protocol, and this file is the
 * whole chain of it.
 *
 * ## Why this exists
 *
 * Stop used to be a record that flipped. The press wrote `arc-stop`, the row
 * redrew as Resume, and the stage's turn, its background jobs, its scheduled
 * wakes and its shell children all carried on in a card that said the arc had
 * stopped. The protocol that replaced it has an order, and the order is the
 * claim: the mark goes up first, the stage's card is interrupted, tugcode
 * tears the work down and answers, the runner waits on the quiet edge, and the
 * record is the **last** thing the stop writes — so an `arc_stop_ok` means the
 * arc stopped rather than that somebody asked.
 *
 * Every link is pinned in Rust or in bun over a fixture. What no unit test can
 * say is that they are one chain: that the button a user presses reaches a real
 * claude, kills real processes, and comes back as a receipt on the card before
 * the row changes its face.
 *
 * ## The rotation is the fixture's whole point
 *
 * `at0523` presses the same button and deliberately seats no claude, so the
 * arc's segment id and the card's tug session id are one string — which is
 * precisely why the identity defect survived: every effect the stop performs
 * addresses the **card**, and a fixture where the two ids are equal cannot tell
 * a correct address from a wrong one. This file drives a real rotation and
 * asserts the two ids differ *before* the press, so every assertion after it is
 * about the address as well as the act. Nobody may "simplify" the rotation away:
 * without it this file is at0523 with more steps.
 *
 * The stage is a real claude doing real work — it is what makes a turn to
 * cancel, a job to close and a process to kill — so this is a real-claude file,
 * on demand only:
 *
 *     TUG_REAL_CLAUDE=1 just app-test tests/app-test/at0588-arc-stop-quiesces.test.ts
 *
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 * @covers tugrust/crates/tugcast/src/feeds/arc_runner.rs
 * @covers tugrust/crates/tugcast/src/arc_api.rs
 * @covers tugrust/crates/tugarc-core/src/arc.rs
 * @covers tugcode/src/session.ts
 * @covers tugdeck/src/lib/arc-press-store.ts
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
  createArc,
  arcBriefPath,
  arcTasksPath,
  discardArc,
  disarmAutoreplay,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
  tugtoolPath,
  type ArcScratchRepo,
} from "./arc-fixture";

/**
 * Two gates, meaning different things. `TUGAPP_APP_TEST` is every app-test's;
 * `TUG_REAL_CLAUDE` is this file's own, because a real stage doing real work is
 * not something a derived selection should ever start on its own.
 */
const SHOULD_RUN =
  process.env.TUGAPP_APP_TEST === "1" && process.env.TUG_REAL_CLAUDE === "1";
const GATED_OFF = process.env.TUGAPP_APP_TEST === "1" && !SHOULD_RUN;

/** A real rotation, a real stage, and a stop that waits on it. */
const TEST_TIMEOUT_MS = 600_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000588";
const CARD = '[data-card-id="A"]';
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;
const AI_CHIP = `${CARD} [data-slot="ai-chip-value"]`;
const SECTION = ".arcs-section";

const ARC_NAME = "at0588-stop";
const ROW = `${SECTION} [data-slot="arcs-row"][data-arc="${ARC_NAME}"]`;
const TRANSPORT = `${ROW} [data-slot="arc-transport"]`;
const transportWith = (verb: string): string =>
  `${TRANSPORT}[data-verb="${verb}"]`;

/**
 * The string the killed process wears, so `pgrep -f` finds exactly it and
 * nothing else on a machine that is also running the suite.
 */
const SENTINEL = `at0588-sentinel-${process.pid}`;

const BRIEF_BODY = "# A brief\n\nOne small thing, done slowly.\n";

/**
 * The arc's ledger, and the stage's instructions.
 *
 * A plain arc — a brief with a task list beside it — opens straight at
 * implement with no devise and no review, which is one rotation rather than
 * three. The step's tasks are what put a turn, a background job and a shell
 * child in front of the press: a backgrounded `sleep` is all three at once, and
 * the foreground wait after it is what keeps the turn open long enough to be
 * cancelled rather than finished.
 */
const TASKS_BODY = `## The fixture's tasks {#fixture-tasks}

### Plan Metadata {#plan-metadata}

| Field | Value |
|---|---|
| Owner | app-test |

### Phase Overview {#phase-overview}

A fixture that waits.

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The only step | pending | — |

#### Step 1: The only step {#step-1}

**Commit:** \`fixture(at0588): wait\`

**References:** [P01] the decision, (#phase-overview)

**Tasks:**
- [ ] Run exactly this, with the Bash tool and \`run_in_background: true\`: \`sleep 600 # ${SENTINEL}\`
- [ ] Then run exactly this in the foreground, with a timeout of 500000 ms: \`sleep 480\`
- [ ] Do nothing else, write no files, and close no step.

**Tests:**
- [ ] None: the waiting is the work.

**Checkpoint:**
- [ ] \`true\`
`;

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (GATED_OFF) {
    note(
      "at0588 skipped",
      "real-claude only — run with TUG_REAL_CLAUDE=1 just app-test tests/app-test/at0588-arc-stop-quiesces.test.ts",
    );
  }
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0588", checkout: CHECKOUT });
  // No `arc create`: the implement dispatch makes the seat before it composes
  // the `where` line, which is what a door leaves behind. `disarmAutoreplay`
  // keeps the branch out of the replay machinery.
  disarmAutoreplay(projectDir(), ARC_NAME);
  writeFileSync(arcBriefPath(projectDir(), ARC_NAME), BRIEF_BODY);
  writeFileSync(arcTasksPath(projectDir(), ARC_NAME), TASKS_BODY);
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  // The sentinel outliving the test is the failure this file is about, so it
  // is swept either way rather than left for the next run to find.
  try {
    execFileSync("/usr/bin/pkill", ["-f", SENTINEL], { stdio: "ignore" });
  } catch {
    // Nothing matched, which is the green case.
  }
  discardArc(projectDir(), ARC_NAME, scratch?.cli);
  rmArcScratchRepo(scratch);
  rmScratchSession(fixtureDir);
});

function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
    ],
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

/** Run a shell command on the card through its own `$` route. */
async function shell(app: App, command: string): Promise<void> {
  const prompt = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
  await app.nativeClickAtElement(prompt);
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
  stopped: [string, string] | null;
  stopping: string | null;
  done: boolean;
}

/** What `tugtool arc record --json` says about the arc right now. */
function arcReport(): ArcReading {
  const out = JSON.parse(
    tugtool(["arc", "record", ARC_NAME, "--json"], {
      cwd: projectDir(),
      binaryRoot: CHECKOUT,
      env: scratch?.cli.env,
    }),
  ) as { data: { arc: ArcReading | null } };
  return (
    out.data.arc ?? { stages: [], stopped: null, stopping: null, done: false }
  );
}

/** Whether any process still carries the sentinel. */
function sentinelAlive(): boolean {
  try {
    execFileSync("/usr/bin/pgrep", ["-f", SENTINEL], { stdio: "pipe" });
    return true;
  } catch {
    // `pgrep` exits 1 when nothing matched, which is the answer we want.
    return false;
  }
}

/** Wait until the arc record holds a rotation, and return the reading. */
async function waitForRotation(): Promise<ArcReading> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const arc = arcReport();
    if (arc.stages.length >= 1) return arc;
    if (arc.stopped !== null) {
      throw new Error(
        `at0588: the arc stopped before it rotated — ${arc.stopped.join(": ")}`,
      );
    }
    if (Date.now() >= deadline) throw new Error("at0588: the arc never rotated");
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

describe.skipIf(!SHOULD_RUN)("AT0588: a stop that ends the work", () => {
  test(
    "the press ends the turn, the job and the child, then writes the record",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0588-arc-stop-quiesces",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      const cli = tugtoolPath(CHECKOUT);
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        // A *spawned* session, not a bound one: spawning registers the scratch
        // repo as a workspace, which is what puts its arcs in the aggregate.
        await app.spawnSessionResume("A", {
          tugSessionId: SID,
          projectDir: projectDir(),
        });
        await app.awaitEngineReady("A", { timeoutMs: 30_000 });

        // The deck's model, read before the arc touches it. The stop hands the
        // card back to it, and the only honest way to say "the deck's" is to
        // have read it from the deck's own card first.
        const deckModel = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(AI_CHIP)})?.textContent ?? "").trim()`,
        );
        note("at0588 the deck's model before the arc runs", deckModel);

        await app.dispatchControlAction("toggle-arcs");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) !== null`,
          { timeoutMs: 30_000 },
        );

        // ── The arc runs for real, and rotates ────────────────────────────
        await shell(app, `${cli} arc run ${ARC_NAME}`);
        const rotated = await waitForRotation();
        note("at0588 the arc after its rotation", JSON.stringify(rotated));
        const segment = rotated.stages[0]!.session_id;

        // ── The fixture's whole point, asserted before the press ──────────
        //
        // The stage lives on a segment the rotation minted; the card's address
        // is the id it was spawned with and never moves. Every effect the stop
        // performs — the interrupt, the teardown verb, the receipt, the model
        // hand-back — converts back to the card, and a fixture where these two
        // are one string cannot tell a right address from a wrong one.
        expect(segment, "the stage is not on the card's own session").not.toBe(
          SID,
        );

        // ── A turn, a job and a child, all of them real ───────────────────
        //
        // The stage's first act is the backgrounded `sleep`, which is all
        // three at once: a turn that is running, an open job the supervisor is
        // holding, and a process in claude's group. The wait below is on the
        // process, because it is the one of the three this test can see from
        // outside the app.
        const childDeadline = Date.now() + 240_000;
        while (!sentinelAlive() && Date.now() < childDeadline) {
          await new Promise((r) => setTimeout(r, 1_000));
        }
        expect(
          sentinelAlive(),
          "the stage launched the background child the task list asked for",
        ).toBe(true);
        note("at0588 the stage at work", (await app.screenshot()).path);

        const controlBefore = await app.evalJS<string>(
          `(() => {
             const button = document.querySelector(${JSON.stringify(TRANSPORT)});
             return button === null ? "(none)" : button.outerHTML;
           })()`,
        );
        note("at0588 the row's control before the press", controlBefore);

        // ── The two orderings, watched from the moment of the press ───────
        //
        // The receipt and the row are both on screen, so the page itself is
        // what times them: a stamp each, taken by the first poll that sees the
        // thing, rather than two separate waits whose order is the harness's
        // scheduling rather than the app's.
        await app.evalJS<boolean>(
          `(() => {
             window.__at0588 = { receiptAt: null, resumeAt: null };
             const rows = ${JSON.stringify(SHELL_ROWS)};
             const resume = ${JSON.stringify(transportWith("resume"))};
             const id = setInterval(() => {
               const seen = window.__at0588;
               if (seen.receiptAt === null &&
                   Array.from(document.querySelectorAll(rows))
                     .some((el) => (el.textContent || "").indexOf("you stopped it") !== -1)) {
                 seen.receiptAt = performance.now();
               }
               if (seen.resumeAt === null && document.querySelector(resume) !== null) {
                 seen.resumeAt = performance.now();
               }
               if (seen.receiptAt !== null && seen.resumeAt !== null) clearInterval(id);
             }, 20);
             return true;
           })()`,
        );

        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(transportWith("stop"))}) !== null`,
          { timeoutMs: 30_000 },
        );
        await app.nativeClickAtElement(transportWith("stop"));

        // ── The mark stands while the protocol is in flight ───────────────
        //
        // [P06]: the record is the last thing a stop writes, so a reading with
        // the mark up and no `stopped` is what the middle of the protocol
        // looks like. Read through the verb rather than by parsing the log.
        let sawTheMark = false;
        let settled = arcReport();
        const stopDeadline = Date.now() + 120_000;
        while (settled.stopped === null && Date.now() < stopDeadline) {
          if (settled.stopping !== null) sawTheMark = true;
          await new Promise((r) => setTimeout(r, 100));
          settled = arcReport();
        }
        note("at0588 the arc after the press", JSON.stringify(settled));
        expect(sawTheMark, "the mark went up before the record was written").toBe(
          true,
        );
        expect(settled.stopped?.[1]).toBe("stopped by user");
        expect(settled.stopping, "and the mark came down with it").toBeNull();
        expect(settled.done).toBe(false);

        // ── The work is gone ──────────────────────────────────────────────
        //
        // The child first, because it is the one thing a record cannot claim.
        // The open job is claimed by the record itself: the runner waits on the
        // quiet edge and only writes `arc-stop` on the far side of it, so a
        // record that reads `stopped` is a ledger entry that went quiet within
        // the ceiling — and a stop that timed out abandons the mark instead,
        // which the assertion above would have caught.
        const goneDeadline = Date.now() + 30_000;
        while (sentinelAlive() && Date.now() < goneDeadline) {
          await new Promise((r) => setTimeout(r, 500));
        }
        expect(sentinelAlive(), "the stage's shell child is gone").toBe(false);

        // ── The card says it, and says it first ───────────────────────────
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(transportWith("resume"))}) !== null`,
          { timeoutMs: 60_000 },
        );
        const timing = await app.evalJS<{
          receiptAt: number | null;
          resumeAt: number | null;
        }>(`window.__at0588`);
        note("at0588 receipt and row, in the order they landed", JSON.stringify(timing));
        expect(timing.receiptAt, "the receipt reached the card").not.toBeNull();
        expect(timing.resumeAt, "and the row took its second face").not.toBeNull();
        expect(
          timing.receiptAt!,
          "the receipt arrives before the row flips — the record is written last",
        ).toBeLessThanOrEqual(timing.resumeAt!);
        note("at0588 card with the stop receipt", (await app.screenshot()).path);

        const controlAfter = await app.evalJS<string>(
          `(() => {
             const buttons = document.querySelectorAll(${JSON.stringify(TRANSPORT)});
             return JSON.stringify({
               count: buttons.length,
               html: buttons[0] ? buttons[0].outerHTML : "(none)",
             });
           })()`,
        );
        note("at0588 the row's control after the press", controlAfter);
        expect(JSON.parse(controlAfter).count, "one control, second face").toBe(1);

        // ── And the card is the deck's again ──────────────────────────────
        //
        // The stage's rotation set a model on the card; the stop hands it back,
        // addressed to the card rather than to the segment the stage was on —
        // which is the identity claim wearing its most visible face.
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(AI_CHIP)})?.textContent ?? "").trim() === ${JSON.stringify(deckModel)}`,
          { timeoutMs: 60_000 },
        );
        const handedBack = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(AI_CHIP)})?.textContent ?? "").trim()`,
        );
        note("at0588 the card's model after the stop", handedBack);
        expect(handedBack, "the card is the deck's again").toBe(deckModel);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
