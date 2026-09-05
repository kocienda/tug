/**
 * at0475-arc-faces.test.ts — where the arc shows on a card's faces, and where
 * it deliberately does not ([AT0475]).
 *
 * ## Why this exists
 *
 * An arc run rotates on a server tick. Nobody pressed anything, so there is no
 * spinner somebody is watching and no reply somebody is waiting for — which
 * makes a **stopped** arc the one state in the whole system that can go
 * silently dark. Every other stalled thing on these surfaces is explained by a
 * gesture nobody made. An arc that stopped is explained by nothing.
 *
 * So the arc gets two faces, both of them existing surfaces:
 *
 *   1. the **Z2 ARC cell**, where it costs no height at all — the arc's stage
 *      rides the cell's accessible sentence and its stopped-ness turns both
 *      flanking dots and takes the reading itself, because the cell's box is
 *      one short word wide and has no room for a clause beside it;
 *   2. the **placard's metadata line**, one press away, where there is room for
 *      the words: which stage it stopped in and why.
 *
 * And it gets **no third face**. `derive_stage` still answers what the arc is
 * doing in git, untouched — the arc is reported beside it and never folded in,
 * which is what lets a card say `implementing` and `stopped in review` at
 * once. That is not a nicety: a stopped arc has usually walked several steps,
 * so a face that let the arc overwrite the git stage would erase the progress
 * at the exact moment somebody needs to see it.
 *
 * Driven against the real feed, on a real arc in a scratch repository, with
 * the arc's own arc log lines written in the grammar `tugarc_core::arc`
 * writes them — the runner's writers are not reachable from a test process, but
 * the record is a file, and reading it back through the whole stack (arc log →
 * `read_arc` → `ArcDetail` → `CHANGESET_ALL` → the session index → the cell)
 * is the point.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugrust/crates/tugarc-core/src/ops.rs
 * @covers tugrust/crates/tugcast/src/feeds/changeset.rs
 * @covers tugrust/crates/tugcast-core/src/types.rs
 * @covers tugdeck/src/lib/changeset-types.ts
 * @covers tugdeck/src/lib/arc-session-index.ts
 * @covers tugdeck/src/components/tugways/arc-lifecycle-line.tsx
 * @covers tugdeck/src/components/tugways/tug-arc-track.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";

import { launchTugApp, note, type App } from "./_harness";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch } from "./_harness/tugbank-helpers";
import {
  appendArcLogLine,
  bindArc,
  createArc,
  arcLogPath,
  discardArc,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000475";
const ARC_NAME = "at0475-arc";
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

/** The Z2 work cell's ARC reading — the value span, where the arc rides. */
const ARC_VALUE =
  '[data-card-id="A"] [data-slot="tug-status-cell"][data-priority="tasks"] [data-slot="session-telemetry-arc-value"]';
const ARC_CELL =
  '[data-card-id="A"] [data-slot="tug-status-cell"][data-priority="tasks"]';
const PLACARD = '[data-slot="session-arc-popover-body"]';
/** The placard's own reading of a stopped arc: the note leads with the stop,
 *  and the strip tints the cell it stopped in. The line drops the two arc
 *  FACTS on purpose — the track already says the arc is running, and the note
 *  already says it stopped, so a fact restating either would be a third voice
 *  on one subject. */
const ARC_NOTE = `${PLACARD} [data-slot="tug-arc-lifecycle-note"]`;
const ARC_TRACK = `${PLACARD} [data-slot="tug-arc-track"][data-stopped="true"]`;
/** The ARC cell's whole sentence — where the arc rides, since the reading
 *  itself is one short word with no room beside it. */
const arcLabel = (app: App): Promise<string> =>
  app.evalJS<string>(
    `document.querySelector(${JSON.stringify(ARC_VALUE)})?.getAttribute("aria-label") ?? ""`,
  );

/** The reading between the two dots. */
const arcReading = (app: App): Promise<string> =>
  app.evalJS<string>(
    `(document.querySelector(${JSON.stringify(ARC_VALUE)})?.textContent ?? "").trim()`,
  );

/** Both flanking dots' states, in order. */
const dotStates = (app: App): Promise<string[]> =>
  app.evalJS<string[]>(
    `Array.from(
       document.querySelectorAll(
         ${JSON.stringify(`${ARC_CELL} [data-slot="tug-progress-indicator"]`)},
       ),
     ).map((el) => el.getAttribute("data-state") ?? "")`,
  );

let project: ArcScratchRepo | null = null;
let fixture = "";
let logPath = "";
const dir = (): string => project?.repo ?? "";

/** One arc log line about this test's arc, in the grammar the engine writes. */
function appendArcLine(marker: string, arcNote: string): void {
  appendArcLogLine(logPath, ARC_NAME, marker, arcNote);
}

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 640 },
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

beforeAll(() => {
  if (!SHOULD_RUN) return;
  project = makeArcScratchRepo({ prefix: "at0475", checkout: CHECKOUT });
  createArc(dir(), ARC_NAME, "at0475 arc faces", project.cli);
  logPath = arcLogPath(project.dataRoot);
  fixture = seedScratchSession(dir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  if (project !== null) {
    discardArc(dir(), ARC_NAME, { binaryRoot: CHECKOUT, env: project.cli.env });
  }
  rmArcScratchRepo(project);
  rmScratchSession(fixture);
});

describe.skipIf(!SHOULD_RUN)("AT0475: the arc's faces", () => {
  test(
    "a running arc tints the cell, a stopped one says why on the placard, and neither touches the git stage",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0475-arc-faces",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: project?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: dir() });
        await app.awaitEngineReady("A", { timeoutMs: 30_000 });
        bindArc(dir(), ARC_NAME, SID, {
          binaryRoot: CHECKOUT,
          env: project!.cli.env,
        });

        // The cell reads ARC once the binding reaches the aggregate. Until
        // then it is TASKS, and asserting the arc on it would be asserting
        // against the wrong reading entirely.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ARC_VALUE)}) !== null`,
          { timeoutMs: 40_000 },
        );
        note("at0475 arc log", logPath);

        // An arc with no arc says nothing about one — the absence has to be
        // silence rather than an empty reading. The cell's whole sentence is
        // its accessible label, which is where the arc rides now: the reading
        // itself is one short word, so the arc's clause could never have
        // fitted beside it.
        // The clause, not the bare word: this arc is *named* `at0475-arc`.
        expect(await arcLabel(app)).not.toContain(", arc");

        // ── A rotation in flight ──────────────────────────────────────────
        appendArcLine("arc-start", "paperwork/at0475-brief.md");
        appendArcLine("arc-stage", "devise claude-at0475-a opus");
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(ARC_VALUE)})
              ?.getAttribute("aria-label") ?? "").includes(", in devise")`,
          { timeoutMs: 40_000 },
        );
        // …and quietly: a stage in flight is the ordinary case, so nothing is
        // tinted for it. The cell reads the lifecycle phase, and both dots
        // hold the arc's ordinary pose rather than the stopped one.
        expect(await arcReading(app)).toBe("Devising");
        expect(await dotStates(app)).not.toContain("aborted");

        // ── The stop ──────────────────────────────────────────────────────
        appendArcLine("arc-stop", "review the plan did not lint");
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(ARC_VALUE)})?.textContent ?? "").trim()
             === "Stopped"`,
          { timeoutMs: 40_000 },
        );
        // A stopped arc outranks every other reading, and it turns BOTH dots
        // rather than one: the cell is two dots and a reading, and a single
        // tinted dot would read as a fact about one end of it.
        const stoppedDots = await dotStates(app);
        expect(stoppedDots.length).toBe(2);
        expect(stoppedDots.every((s) => s === "aborted")).toBe(true);

        // The words are on the placard, which is where there is room for them.
        await app.click(ARC_CELL);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ARC_TRACK)}) !== null`,
          { timeoutMs: 10_000 },
        );
        const stopNote = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(ARC_NOTE)})?.textContent ?? "").trim()`,
        );
        note("at0475 placard note", stopNote);
        // The note leads with the stop and then says why, in the arc receipt's
        // own words — which is more than the retired fact's `arc stopped ·
        // review` said, and in the one place there is room to say it.
        expect(stopNote.startsWith("Stopped · ")).toBe(true);
        expect(stopNote).toContain("the plan did not lint");

        // And the footer says nothing the block above it already said. It
        // carried the git stage once, which read as a gerund spelling of the
        // very phase on the lifecycle line; the stage reaches the eye at the
        // Changes lane's join register instead, where a decision turns on it.
        expect(
          await app.evalJS<string>(
            `(document.querySelector('[data-slot="tug-popup-list-footer"]')?.textContent ?? "").trim()`,
          ),
        ).toBe("Show in Changes");

        // The stop says where it got to, which is what a resume needs and what
        // a cleared field would have thrown away. The cell's sentence carries
        // both halves — the stage and the reason.
        const stoppedLabel = await arcLabel(app);
        note("at0475 arc cell label", stoppedLabel);
        expect(stoppedLabel).toContain("stopped in review");
        expect(stoppedLabel).toContain("the plan did not lint");

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0475] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
