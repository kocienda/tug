/**
 * at0619-arc-card-reload-shape.test.ts — **one card, one bridge, one live
 * segment, and a join that is offered.**
 *
 * ## The incident this is the shape of
 *
 * An arc that had finished cleanly presented itself as wedged for seven hours,
 * refused its join as "still working", and after the card was closed went on
 * reporting itself live. Every fault behind it is the same mistake wearing a
 * different face: **the card is a line of work, and the machinery keyed on a
 * segment of it** ([P01]). A rotation mints a fresh segment on the card's line,
 * and from that moment on every reader that keyed on the id the card was born
 * with is reading an id nothing wears any more.
 *
 * The invariants that answer it are each pinned where they live — the
 * supervisor's units for the bridge, the ledger's for the live row, the
 * changeset's for the holder gate. What no unit test can say is that they are
 * **one shape**: that a deck which reconnects after a rotation re-holds the
 * bridge it already had, leaves one live row on the line, and gets the join
 * offered when the arc finishes rather than refused as still working.
 *
 * ## What the reload is for
 *
 * The rotation moves the deck's seat for the card onto the segment the wheel
 * minted (`at0504` is where that is asserted). So the id this deck re-announces
 * after a reload is **claude's**, not the card's address — an id the
 * supervisor's map is not keyed by. A spawn that could not resolve it spawned a
 * second bridge onto the same card, which is the first of the incident's faces
 * and is what assertion A is about. The reload is fired while the stage is
 * still working, because that is when it happened.
 *
 * ## Why it is real-claude only
 *
 * The join being *offered* is the assertion the whole file is aimed at, and an
 * arc is only offered one when it has finished — which means a real stage
 * walking a real step to a real commit. That is minutes of somebody else's
 * judgement and is not something a derived selection may start on its own:
 *
 *     TUG_REAL_CLAUDE=1 just app-test tests/app-test/at0619-arc-card-reload-shape.test.ts
 *
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 * @covers tugrust/crates/tugcast/src/session_ledger.rs
 * @covers tugrust/crates/tugcast/src/feeds/changeset.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
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
 * `TUG_REAL_CLAUDE` is this file's own, for the reason the header gives.
 */
const SHOULD_RUN =
  process.env.TUGAPP_APP_TEST === "1" && process.env.TUG_REAL_CLAUDE === "1";
const GATED_OFF = process.env.TUGAPP_APP_TEST === "1" && !SHOULD_RUN;

/** A real rotation, a real step, and a real finish. */
const TEST_TIMEOUT_MS = 900_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000619";
const ARC_NAME = "at0619-reload";

const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SECTION = ".arcs-section";
const ROW = `${SECTION} [data-slot="arcs-row"][data-arc="${ARC_NAME}"]`;
const ROW_TRACK = `${ROW} [data-slot="tug-arc-track"]`;

const BRIEF_BODY = "# A brief\n\nOne small thing, written down.\n";

/**
 * The arc's ledger, and the stage's instructions.
 *
 * A brief with a task list beside it is a plain arc: it opens straight at
 * implement, which is one rotation rather than three. The step is deliberately
 * the smallest piece of real work there is — one file written, one round
 * committed, one step closed — because what this file asserts is the shape the
 * walk leaves behind, not the walk.
 */
const TASKS_BODY = `## The fixture's tasks {#fixture-tasks}

### Plan Metadata {#plan-metadata}

| Field | Value |
|---|---|
| Owner | app-test |

### Phase Overview {#phase-overview}

A fixture that writes one file.

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The only step | pending | — |

#### Step 1: The only step {#step-1}

**Commit:** \`fixture(at0619): write the note\`

**References:** [P01] the decision, (#phase-overview)

**Tasks:**
- [ ] Write a file \`note.txt\` at the root of the worktree, containing exactly the word \`done\` and a newline.
- [ ] Do nothing else: read no other file, run no other command, and change nothing else.

**Tests:**
- [ ] None: the file is the work.

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
      "at0619 skipped",
      "real-claude only — run with TUG_REAL_CLAUDE=1 just app-test tests/app-test/at0619-arc-card-reload-shape.test.ts",
    );
  }
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0619", checkout: CHECKOUT });
  // No `arc create`: the implement dispatch makes the seat before it composes
  // the `where` line, which is what a door leaves behind.
  disarmAutoreplay(projectDir(), ARC_NAME);
  writeFileSync(arcBriefPath(projectDir(), ARC_NAME), BRIEF_BODY);
  writeFileSync(arcTasksPath(projectDir(), ARC_NAME), TASKS_BODY);
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
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
  return out.data.arc ?? { stages: [], stopped: null, done: false };
}

/** Wait until the arc record holds a rotation, and return the reading. */
async function waitForRotation(): Promise<ArcReading> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const arc = arcReport();
    if (arc.stages.length >= 1) return arc;
    if (arc.stopped !== null) {
      throw new Error(
        `at0619: the arc stopped before it rotated — ${arc.stopped.join(": ")}`,
      );
    }
    if (Date.now() >= deadline) throw new Error("at0619: the arc never rotated");
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/**
 * Every tugcode bridge running against this fixture's repository.
 *
 * `--dir <project>` is what the bridge spawns tugcode with, and the scratch
 * repository's path is minted per run, so the match is this test's own
 * processes and nothing else on a machine that is also running the suite.
 * `-ww` because `ps` truncates its argument column to the terminal otherwise,
 * and the flag we are matching on sits past the truncation.
 */
function bridgesForThisRepo(): string[] {
  const out = Bun.spawnSync(["/bin/ps", "-axww", "-o", "args="])
    .stdout.toString()
    .split("\n");
  return out.filter((line) => line.includes(`--dir ${projectDir()}`));
}

/**
 * The live rows the per-instance session ledger holds for one line.
 *
 * Through `just db-inspect`, which copies the database and its WAL aside and
 * reads the copy: a foreign SQLite participating in recovery on a live ledger
 * is a corruption vector, and the harness instance's ledger is live for as long
 * as the app under test is up.
 */
function liveSegmentsOnLine(app: App, lineId: string): string[] {
  const db = join(
    homedir(),
    "Library",
    "Application Support",
    "Tug",
    "instances",
    app.instanceId,
    "sessions.db",
  );
  const run = Bun.spawnSync(
    [
      "just",
      "db-inspect",
      db,
      `SELECT session_id FROM sessions WHERE line_id = '${lineId}' AND state = 'live';`,
    ],
    { cwd: CHECKOUT },
  );
  if (run.exitCode !== 0) {
    throw new Error(
      `at0619: db-inspect failed (${run.exitCode}): ${run.stderr.toString()}`,
    );
  }
  return run.stdout.toString().trim().split("\n").filter(Boolean);
}

describe.skipIf(!SHOULD_RUN)("AT0619: the arc card's reload shape", () => {
  test(
    "a deck that reloads after a rotation re-holds one bridge, leaves one live segment, and is offered the join",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0619-arc-card-reload-shape",
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
        // repo as a workspace, which is what puts its arcs in the aggregate the
        // Arcs card reads.
        await app.spawnSessionResume("A", {
          tugSessionId: SID,
          projectDir: projectDir(),
        });
        await app.awaitEngineReady("A", { timeoutMs: 30_000 });

        await app.dispatchControlAction("toggle-arcs");

        // ── The arc runs for real, and rotates ────────────────────────────
        await shell(app, `${cli} arc run ${ARC_NAME}`);
        const rotated = await waitForRotation();
        note("at0619 the arc after its rotation", JSON.stringify(rotated));
        const segment = rotated.stages[0]!.session_id;
        expect(segment, "the stage is not on the card's own session").not.toBe(
          SID,
        );

        // The row the assertions below read. Before the arc ran there was no
        // branch and no worktree, so the Arcs card drew it as a *document*
        // row — the one shape a branchless arc has. The implement dispatch
        // makes the seat before it composes the `where` line, so by the time
        // the rotation is recorded the arc is a real one and the row it draws
        // is the one that carries the join's own word.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) !== null`,
          { timeoutMs: 60_000 },
        );

        // The deck's own seat for the card, which the rotation moves onto the
        // segment — and which is therefore the id the deck re-announces below.
        let facts = await app.evalJS<{ tugSessionId: string; lineId: string }>(
          `window.__tug.cardLineFacts("A")`,
        );
        const seatDeadline = Date.now() + 60_000;
        while (facts.tugSessionId === SID && Date.now() < seatDeadline) {
          await new Promise((r) => setTimeout(r, 1_000));
          facts = await app.evalJS<{ tugSessionId: string; lineId: string }>(
            `window.__tug.cardLineFacts("A")`,
          );
        }
        note("at0619 the deck's seat after the rotation", JSON.stringify(facts));
        expect(facts.tugSessionId, "the deck seated the segment").toBe(segment);

        const before = bridgesForThisRepo();
        note(`at0619 bridges before the reload: ${before.length}`);
        expect(before.length, "one card, one bridge").toBe(1);

        // ── The reload, while the stage is still working ──────────────────
        //
        // Same tugcast, fresh WKWebView: the deck comes back and re-announces
        // the session its card is seated on, which is claude's segment rather
        // than the card's address. The announcement is issued rather than
        // waited for, because what it lands on is the assertion — a resume
        // naming an id no entry is *keyed* by must re-hold the entry wearing it
        // as its claude session, not open a second bridge beside it.
        await app.appReload({ timeoutMs: 30_000 });
        // The deck comes back empty: under test mode the layout is not
        // persisted, and its restore is `at0027`'s claim rather than this
        // file's. What this file is about is what the *server* sees, and that
        // is identical either way — a fresh client connection, then the card
        // announcing the session it is seated on.
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.spawnSessionResume("A", {
          tugSessionId: facts.tugSessionId,
          projectDir: projectDir(),
        });
        await app.awaitEngineReady("A", { timeoutMs: 60_000 });

        // The rail the reload closed. The Arcs card is a fresh deck's away,
        // so assertion C's row has to be opened again before it can be read.
        await app.dispatchControlAction("toggle-arcs");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) !== null`,
          { timeoutMs: 60_000 },
        );

        // ── A. One bridge ────────────────────────────────────────────────
        const after = bridgesForThisRepo();
        note(`at0619 bridges after the reload: ${after.length}\n${after.join("\n")}`);
        expect(
          after.length,
          "the reload re-held the card's bridge rather than spawning a second one",
        ).toBe(1);

        // ── B. One live segment on the line ──────────────────────────────
        //
        // The rotation's own record: the fresh segment is recorded live and the
        // parent it replaced is closed in the same breath, so the line carries
        // exactly one live row however many times it has rotated.
        const live = liveSegmentsOnLine(app, facts.lineId);
        note(`at0619 live segments on the line: ${JSON.stringify(live)}`);
        expect(live.length, "one line, one live segment").toBe(1);
        expect(live[0], "and it is the one the wheel seated").toBe(segment);

        // ── C. The join is offered ───────────────────────────────────────
        //
        // The stage walks its one step and the wheel finishes the arc. From
        // there the track's own arm decides between two words: `audit` while a
        // holder is still working, `join` once none is. The incident's arc sat
        // on the first of those with nobody working at all, because the gate
        // was asked about a segment rather than about the line.
        const doneDeadline = Date.now() + 600_000;
        for (;;) {
          const arc = arcReport();
          if (arc.done) {
            note("at0619 the arc finished", JSON.stringify(arc));
            break;
          }
          if (arc.stopped !== null) {
            throw new Error(
              `at0619: the arc stopped before it finished — ${arc.stopped.join(": ")}`,
            );
          }
          if (Date.now() >= doneDeadline) {
            throw new Error("at0619: the arc never finished its one step");
          }
          await new Promise((r) => setTimeout(r, 2_000));
        }

        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(ROW_TRACK)})?.getAttribute("data-phase") ?? "") === "join"`,
          { timeoutMs: 120_000 },
        ).catch(async (error: unknown) => {
          // What the row actually read, so a failure here says which of the
          // two words it stuck on rather than only that it never changed.
          note(
            "at0619 the row when the join never came",
            await app.evalJS<string>(
              `JSON.stringify((function(){
                 var row = document.querySelector(${JSON.stringify(ROW)});
                 var track = document.querySelector(${JSON.stringify(ROW_TRACK)});
                 return {
                   row: row !== null,
                   word: row ? row.getAttribute("data-join-word") : null,
                   phase: track ? track.getAttribute("data-phase") : null,
                 };
               })())`,
            ),
          );
          throw error;
        });
        const phase = await app.evalJS<string | null>(
          `document.querySelector(${JSON.stringify(ROW_TRACK)})?.getAttribute("data-phase") ?? null`,
        );
        note(`at0619 the arc track's phase: ${JSON.stringify(phase)}`);
        expect(phase, "the join is offered, not refused as still working").toBe(
          "join",
        );

        // The same fact in the register's own word, which is where the
        // incident's sentence was written: `working` is "<arc> is still
        // working — the join waits for it to finish", said over an arc that
        // had finished, because the gate was asked about a segment.
        const word = await app.evalJS<string | null>(
          `document.querySelector(${JSON.stringify(ROW)})?.getAttribute("data-join-word") ?? null`,
        );
        note(`at0619 the join register's word: ${JSON.stringify(word)}`);
        expect(word, "nobody is still working this arc").not.toBe("working");
        note("at0619 the join offered", (await app.screenshot()).path);

        // The bridge the whole file is about, read once more now that the
        // orphan sweep's settle window has long passed: a card that is still
        // held by a client is never one of its targets.
        note(`at0619 bridges at the end: ${bridgesForThisRepo().length}`);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
