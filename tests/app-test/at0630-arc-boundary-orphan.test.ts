/**
 * at0630-arc-boundary-orphan.test.ts — a step closes with a job still running,
 * and the arc walks on.
 *
 * ## Why this exists
 *
 * A stage that backgrounded a shell and then closed its step left the busy
 * latch true with nothing that would ever clear it: the turn had ended, the
 * step was closed, and the wheel — which judges a stage only at a settled idle
 * edge — read the session as still working for the whole of the job reaper's
 * thirty minutes. Every surface said the arc was implementing, the ledger said
 * the step was done, and nothing moved. The remedy is that a closed step ends
 * the session's open jobs, on both paths of the step-done edge, and says so in
 * the verb's own receipt.
 *
 * Nothing but a real stage produces the wire shape this rests on — a `tool_use`
 * carrying `run_in_background`, the `task_started` that confirms it, and a
 * `step_closed` report from inside the turn that closed the step — so this file
 * is the tripwire and the Rust and bun suites are the proof. Every seam has a
 * test that runs in the ordinary suite.
 *
 * ## The 60 s deadline is below the boundary horizon on purpose
 *
 * The wheel also prompts past a boundary it cannot read idle, once
 * `[tugtool.arc].boundary_horizon_secs` (120 s by default) has run. That
 * backstop must not be what makes this file green: if the close stopped ending
 * jobs, the horizon would still walk the arc on and this test would keep
 * passing over a regression it exists to catch. So the horizon is left at its
 * default and the deadline below it, and the assertions include the absence of
 * a `prompted past` note — the ordinary idle path answered this boundary, not
 * the backstop. **Nobody may "stabilise" this file by lowering the horizon or
 * by raising the deadline past it.**
 *
 * The stage is a real claude doing real work, so this is a real-claude file, on
 * demand only:
 *
 *     TUG_REAL_CLAUDE=1 just app-test tests/app-test/at0630-arc-boundary-orphan.test.ts
 *
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 * @covers tugrust/crates/tugcast/src/feeds/arc_runner.rs
 * @covers tugrust/crates/tugcast/src/feeds/arc.rs
 * @covers tugrust/crates/tugcast/src/feeds/arc_notes.rs
 * @covers tugrust/crates/tugcast/src/server.rs
 * @covers tugrust/crates/tugtool/src/arc.rs
 * @covers tugrust/crates/tugtool/src/arc_turn.rs
 * @covers tugcode/src/session.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  arcBriefPath,
  arcLogPath,
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

/** A real rotation, a real stage, and two steps of it. */
const TEST_TIMEOUT_MS = 900_000;

/**
 * How long the next step has to open after the close.
 *
 * Deliberately below the 120 s boundary horizon — see the docblock. Generous
 * against the settle (5 s) and the sweep, and nowhere near the backstop.
 */
const BOUNDARY_DEADLINE_MS = 60_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000630";
const CARD = '[data-card-id="A"]';
/**
 * The stage's own Bash calls. The step verbs run through the tool rather than
 * through the composer's `/shell` route, so the receipt this file reads is a
 * tool call's output.
 */
const BASH_BLOCKS = `${CARD} [data-slot="bash-tool-block"]`;
const SECTION = ".arcs-section";

const ARC_NAME = "at0630-orphan";
/**
 * The arc's row, whichever of the two the card draws it as.
 *
 * Before the implement dispatch there is no branch, so a fixture that waited
 * on `arcs-row` alone would wait on a face this arc does not have yet: the
 * paperwork row (`arc-document-row`) is what a brief-and-task-list arc shows
 * until something cuts the branch.
 */
const ROW = `${SECTION} [data-arc="${ARC_NAME}"]`;

/**
 * The string the orphaned process wears, so `pgrep -f` finds exactly it and
 * nothing else on a machine that is also running the suite.
 */
const SENTINEL = `at0630-sentinel-${process.pid}`;

const BRIEF_BODY = "# A brief\n\nOne step that backgrounds a job, and one after it.\n";

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

/**
 * The arc's ledger, and the stage's instructions.
 *
 * A plain arc — a brief with a task list beside it — opens straight at
 * implement with no devise and no review. Step 1 is the shape the whole file is
 * about: a backgrounded `sleep` that will still be running when the step
 * closes, and a close that does not wait for it. The CLI is named by absolute
 * path because the scratch repo carries no build of its own, and `tugtool` on a
 * developer's `PATH` is the installed app's binary rather than this checkout's.
 */
const tasksBody = (cli: string): string => `## The fixture's tasks {#fixture-tasks}

### Plan Metadata {#plan-metadata}

| Field | Value |
|---|---|
| Owner | app-test |

### Phase Overview {#phase-overview}

A fixture that leaves a job running across a step close.

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The step that backgrounds a job | pending | — |
| #step-2 | The step after it | pending | — |

#### Step 1: The step that backgrounds a job {#step-1}

**Commit:** \`fixture(at0630): background a job\`

**References:** [P01] the decision, (#phase-overview)

**Tasks:**
- [ ] Run exactly this: \`${cli} arc step ${ARC_NAME} start 1 --through 2\`
- [ ] Run exactly this, with the Bash tool and \`run_in_background: true\`: \`sleep 600 # ${SENTINEL}\`
- [ ] Do **not** wait for it, do not read its output, and do not collect it.
- [ ] Run exactly this: \`${cli} arc step ${ARC_NAME} done 1\`
- [ ] Then end the turn, saying nothing else. Write no files.

**Tests:**
- [ ] None: the leaving-it-running is the work.

**Checkpoint:**
- [ ] \`true\`

#### Step 2: The step after it {#step-2}

**Commit:** \`fixture(at0630): the step after\`

**References:** [P01] the decision, (#phase-overview)

**Tasks:**
- [ ] Run exactly this: \`${cli} arc step ${ARC_NAME} start 2 --through 2\`
- [ ] Run exactly this: \`true\`
- [ ] Run exactly this: \`${cli} arc step ${ARC_NAME} done 2\`
- [ ] Then end the turn, saying nothing else. Write no files.

**Tests:**
- [ ] None.

**Checkpoint:**
- [ ] \`true\`
`;

let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (GATED_OFF) {
    note(
      "at0630 skipped",
      "real-claude only — run with TUG_REAL_CLAUDE=1 just app-test tests/app-test/at0630-arc-boundary-orphan.test.ts",
    );
  }
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0630", checkout: CHECKOUT });
  // No `arc create`: the implement dispatch makes the seat before it composes
  // the `where` line, which is what a door leaves behind. `disarmAutoreplay`
  // keeps the branch out of the replay machinery.
  disarmAutoreplay(projectDir(), ARC_NAME);
  writeFileSync(arcBriefPath(projectDir(), ARC_NAME), BRIEF_BODY);
  writeFileSync(
    arcTasksPath(projectDir(), ARC_NAME),
    tasksBody(tugtoolPath(CHECKOUT)),
  );
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
  notes: string[];
  stopped: [string, string] | null;
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
  return out.data.arc ?? { stages: [], notes: [], stopped: null, done: false };
}

/** The arc log as it stands, or `""` before the record exists. */
function arcLog(): string {
  try {
    return readFileSync(arcLogPath(scratch?.dataRoot ?? ""), "utf8");
  } catch {
    return "";
  }
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
        `at0630: the arc stopped before it rotated — ${arc.stopped.join(": ")}`,
      );
    }
    if (Date.now() >= deadline) throw new Error("at0630: the arc never rotated");
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/** Wait for an arc-log line matching `pattern`, polling the file. */
async function waitForLogLine(
  pattern: RegExp,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pattern.test(arcLog())) return;
    const arc = arcReport();
    if (arc.stopped !== null) {
      throw new Error(
        `at0630: the arc stopped waiting for ${what} — ${arc.stopped.join(": ")}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(`at0630: ${what} never landed\n${arcLog()}`);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

describe.skipIf(!SHOULD_RUN)("AT0630: a closed step ends its jobs", () => {
  test(
    "a step closing over a running job kills it and the next step opens inside the deadline",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0630-arc-boundary-orphan",
        env: {
          TUGBANK_PATH: tugbankPath,
          TUG_DATA_DIR: scratch?.dataRoot ?? "",
        },
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

        await app.dispatchControlAction("toggle-arcs");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) !== null`,
          { timeoutMs: 30_000 },
        );

        // ── The arc runs for real, and rotates ────────────────────────────
        await shell(app, `${cli} arc run ${ARC_NAME}`);
        const rotated = await waitForRotation();
        note("at0630 the arc after its rotation", JSON.stringify(rotated));

        // ── The stage backgrounds the job the step will close over ────────
        const childDeadline = Date.now() + 300_000;
        while (!sentinelAlive() && Date.now() < childDeadline) {
          await new Promise((r) => setTimeout(r, 1_000));
        }
        expect(
          sentinelAlive(),
          "the stage launched the background child the task list asked for",
        ).toBe(true);
        note("at0630 the stage with its job running", (await app.screenshot()).path);

        // ── The step closes with the job still open ───────────────────────
        await waitForLogLine(/step-done\s+1\/2/, 300_000, "the step-1 close");
        const closedAt = Date.now();
        note("at0630 the arc log at the close", arcLog());

        // ── The close ended the job, and the arc walked on ────────────────
        //
        // Both inside one deadline, which is deliberately below the boundary
        // horizon: if the close had stopped ending jobs, the wheel's backstop
        // would still open step 2 — two minutes later, and with a note saying
        // it had walked past an open job. Neither of those may be what makes
        // this file green.
        while (sentinelAlive() && Date.now() - closedAt < BOUNDARY_DEADLINE_MS) {
          await new Promise((r) => setTimeout(r, 500));
        }
        expect(
          sentinelAlive(),
          "the closed step ended the job it was launched inside",
        ).toBe(false);
        note(
          "at0630 close → job gone",
          `${((Date.now() - closedAt) / 1000).toFixed(1)}s`,
        );

        await waitForLogLine(
          /step-start\s+2\/2/,
          Math.max(1_000, BOUNDARY_DEADLINE_MS - (Date.now() - closedAt)),
          "the step-2 open",
        );
        const openedAt = Date.now();
        note(
          "at0630 close → next step open",
          `${((openedAt - closedAt) / 1000).toFixed(1)}s (deadline ${
            BOUNDARY_DEADLINE_MS / 1000
          }s, boundary horizon 120s)`,
        );
        expect(
          openedAt - closedAt,
          "the ordinary idle path answered the boundary, well inside the horizon",
        ).toBeLessThan(BOUNDARY_DEADLINE_MS);

        // ── And it answered it, rather than the backstop answering ────────
        const settled = arcReport();
        note("at0630 the arc after the boundary", JSON.stringify(settled));
        expect(settled.stopped, "nothing stopped").toBeNull();
        expect(
          settled.notes.filter((line) => line.includes("prompted past")),
          "the close is what freed the boundary — not the wheel's backstop",
        ).toEqual([]);

        // ── The receipt said what it ended, on the card ───────────────────
        //
        // Read off the Bash blocks rather than the `/shell` rows: the stage ran
        // the close through its own tool, so the receipt is a tool call's
        // output and not a row the composer made. Risk R01's mitigation is this
        // sentence being *visible* — a stage that meant to keep the job has to
        // be able to see that it did not.
        // A collapsed block does not mount its body at all, and transcript
        // history collapses — so the block is found by its command, tagged,
        // and opened before its output is read.
        const found = await app.evalJS<string>(
          `(() => {
             const blocks = Array.from(document.querySelectorAll(${JSON.stringify(
               BASH_BLOCKS,
             )}));
             const target = blocks.find((el) =>
               (el.querySelector('[data-slot="bash-tool-block-command"]')?.textContent ?? "")
                 .indexOf("done 1") !== -1);
             if (target === undefined) {
               return JSON.stringify({
                 found: false,
                 commands: blocks.map((el) =>
                   (el.querySelector('[data-slot="bash-tool-block-command"]')?.textContent ?? "").trim()),
               });
             }
             target.setAttribute("data-at0630", "close");
             return JSON.stringify({
               found: true,
               collapsed: target.getAttribute("data-block-collapsed") === "true",
             });
           })()`,
        );
        note("at0630 the close's own block", found);
        expect(
          JSON.parse(found).found,
          "the stage ran the close through the card",
        ).toBe(true);
        if (JSON.parse(found).collapsed === true) {
          // Dispatched rather than pressed natively: the block is scrolled far
          // up the transcript by now, and this is a read of what the receipt
          // *says* rather than a test of the disclosure's hit target.
          await app.evalJS<boolean>(
            `(() => {
               const cue = document.querySelector(
                 '[data-at0630="close"] [data-slot="tool-call-header-disclosure"]');
               if (cue === null) return false;
               cue.click();
               return true;
             })()`,
          );
          await new Promise((r) => setTimeout(r, 500));
        }
        const receipt = await app.evalJS<string>(
          `(() => {
             const target = document.querySelector('[data-at0630="close"]');
             return target === null ? "(the block went away)" : (target.textContent || "");
           })()`,
        );
        note("at0630 the step receipt on the card", receipt);
        expect(
          receipt,
          "the close's receipt names what it ended, so the stage cannot miss it",
        ).toContain("Ended 1 background job");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
