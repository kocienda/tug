/**
 * at0513-arc-stopped-audit.test.ts — the row a stopped audit draws.
 *
 * The Changes shade once read, for one arc in sequence, `check planned`, then
 * `stopped · audit did not mark planned`, then **Ready to join** beneath it:
 * one wrong word, one sentence that is not English, and one offer to land
 * code nothing audited. This file drives a real planned arc to exactly that
 * state — every step closed, a round committed, the audit seated and then
 * stopped without marking — and reads the Arcs card's row for the three
 * things that have to be true of it now:
 *
 *  - the strip's lit cell and the line's note both spell the stage `audit`,
 *    and the note is the stop alone: `stopped · audit did not mark`, with no
 *    `kind` span trailing it — the kind is the strip's cell set, which draws
 *    six cells here because the arc is planned;
 *  - the join register reads `unaudited`, the caution pulse for work that has
 *    stopped for somebody, and nowhere on the row does `Ready to join` stand;
 *  - the server agrees: `join_ready` is shut, so the derived stage is not a
 *    joinable word, and the register speaks anyway because the stop is the
 *    thing it has a sentence for.
 *
 * The stop is written as the engine writes it — the `arc-stop` line the wheel
 * appends when an audit ends unmarked — because `tugtool arc stop` is a
 * person's gesture and records `stopped by user`; the sentence under test is
 * the wheel's own. The register reads both stops the same way, and the pure
 * table in `arc-join-register.test.ts` pins that; what this file pins is the
 * whole chain from the record through the feed to the row.
 *
 * @covers tugdeck/src/lib/arc-join-register.ts
 * @covers tugdeck/src/components/tugways/arc-lifecycle-line.tsx
 * @covers tugdeck/src/components/tugways/tug-arc-track.tsx
 * @covers tugrust/crates/tugarc-core/src/log.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  appendArcLogLine,
  arcBriefPath,
  arcLogPath,
  commitRound,
  createArc,
  makeArcScratchRepo,
  recordStampedPlan,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000513";

/** A planned arc whose walk finished and whose audit stopped unmarked. */
const ARC_NAME = "at0513-unmarked";

const SECTION = ".arcs-section";
const ROW = `${SECTION} [data-slot="arcs-row"][data-arc="${ARC_NAME}"]`;

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0513", checkout: CHECKOUT });
  const cli = scratch.cli;

  // A planned arc, as the `/arc-plan` door leaves it: a brief, a stamped
  // two-row plan with its run declared over both rows, and the kind on the
  // record. The log lines are appended rather than driven through `arc run`,
  // which is what writes them in life — the runner would seat a stage and
  // start rotating this arc, and the fixture wants the record without the
  // machinery. It is the route `at0407` and `at0483` take, for the same reason.
  const arc = createArc(projectDir(), ARC_NAME, "at0513 stopped audit", cli);
  writeFileSync(arcBriefPath(projectDir(), ARC_NAME), "# at0513 brief\n");
  recordStampedPlan(projectDir(), ARC_NAME, arc.worktree, {
    ...cli,
    rows: 2,
    through: 2,
  });
  const log = arcLogPath(scratch.dataRoot);
  appendArcLogLine(log, ARC_NAME, "arc-start", `.tug/arcs/${ARC_NAME}/plan.md`);
  appendArcLogLine(log, ARC_NAME, "arc-kind", "planned");

  // The walk, through the real verbs, with one real round on the branch — the
  // gate refuses an arc with no rounds before it ever reads the wheel, and
  // the row under test is one whose implement stage genuinely finished.
  writeFileSync(join(arc.worktree, "one.txt"), "first\n");
  commitRound(projectDir(), ARC_NAME, "tugarc(at0513-unmarked): Land the one round", cli);
  const step = (...args: string[]): void => {
    tugtool(["arc", "step", ARC_NAME, ...args], {
      cwd: projectDir(),
      binaryRoot: cli.binaryRoot,
      env: cli.env,
    });
  };
  // `recordStampedPlan` already opened step 1 and declared the selection.
  step("done", "1");
  step("start", "2", "--through", "2");
  step("done", "2");

  // The audit is seated, and then it ends without marking. This is the
  // wheel's own stop line, spelled as `ArcStopReason::AuditDidNotMark` spells
  // it; `tugtool arc stop` would record `stopped by user`, which the register
  // reads the same way and the pure table pins.
  appendArcLogLine(log, ARC_NAME, "arc-stage", "audit claude-at0513 opus");
  appendArcLogLine(log, ARC_NAME, "arc-stop", "audit audit did not mark");

  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  rmScratchSession(fixtureDir);
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

interface RowReading {
  phase: string | null;
  stopped: string | null;
  phases: string[];
  litCell: string | null;
  note: string;
  facts: Array<{ key: string | null; label: string }>;
  registerWord: string | null;
  registerLine: string;
  text: string;
}

/** The row, read whole from one beat: strip, note, facts, register. */
const readRow = (app: App): Promise<RowReading> =>
  app.evalJS<RowReading>(
    `(() => {
       const row = document.querySelector(${JSON.stringify(ROW)});
       const track = row.querySelector('[data-slot="tug-arc-track"]');
       const lit = track.querySelector('[data-slot="tug-arc-track-cell"][data-state="stopped"]');
       const register = row.querySelector('[data-slot="arc-join-register"]');
       return {
         phase: track.getAttribute("data-phase"),
         stopped: track.getAttribute("data-stopped"),
         phases: Array.from(track.querySelectorAll('[data-slot="tug-arc-track-cell"]'))
           .map((el) => el.getAttribute("data-phase")),
         litCell: lit?.getAttribute("data-phase") ?? null,
         note: (row.querySelector('[data-slot="tug-arc-lifecycle-note"]')?.textContent ?? "").trim(),
         facts: Array.from(row.querySelectorAll('[data-slot="tug-arc-lifecycle-fact"]'))
           .map((el) => ({ key: el.getAttribute("data-fact"), label: (el.textContent ?? "").trim() })),
         registerWord: register?.getAttribute("data-word") ?? null,
         registerLine: (register?.textContent ?? "").trim(),
         text: (row.textContent ?? "").trim(),
       };
     })()`,
  );

describe.skipIf(!SHOULD_RUN)("AT0513: a stopped audit on the Arcs card", () => {
  test(
    "the row reads `stopped · audit did not mark` with the word `unaudited`, no kind span, and no Ready to join",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0513-arc-stopped-audit",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // A *spawned* session, not a bound one: spawning registers the scratch
        // repo as a workspace, so its arcs reach the aggregate.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });
        await app.dispatchControlAction("toggle-arcs");

        // The row, with the stop folded into it: `data-stopped` on the strip
        // is the last fact the feed derives from the record, so a row that
        // has it has everything else this file reads.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${ROW} [data-slot="tug-arc-track"][data-stopped="true"]`)}) !== null`,
          { timeoutMs: 30000 },
        );
        const row = await readRow(app);
        note("at0513 row", JSON.stringify(row));
        note("at0513 screenshot", (await app.screenshot()).path);

        // ── The word is `audit`, everywhere the row says the stage ──────────
        // The strip lights the cell the stop names, not the join cell git's
        // joinable facts would light; the line says the stop and nothing after it.
        expect(row.phase).toBe("audit");
        expect(row.stopped).toBe("true");
        expect(row.litCell).toBe("audit");
        // `Stopped` capitalised, then the reason word off the record
        // unchanged — the log's own vocabulary, explained on hover ([B05]).
        expect(row.note).toBe("Stopped · audit did not mark");
        expect(row.text).not.toContain("check");

        // ── The kind is the cell set, and no word repeats it ──────────────
        expect(row.phases).toEqual(["brief", "devise", "review", "implement", "audit", "join"]);
        expect(row.facts.map((f) => f.key)).not.toContain("kind");
        expect(row.facts.map((f) => f.label)).not.toContain("planned");
        expect(row.text).not.toContain("planned");

        // ── The offer is not made ─────────────────────────────────────────
        // The server holds `join_ready` shut over a stopped audit, and the
        // register says why in the caution register rather than going dark.
        expect(row.registerWord).toBe("unaudited");
        expect(row.registerLine).toContain("audit stopped");
        expect(row.text).not.toContain("Ready to join");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
