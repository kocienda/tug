/**
 * AT0815 — the engine's re-audit reads on the card, from base move to verdict.
 *
 * ## Why this exists
 *
 * When a landing on the base makes a finished arc's audit stale, the engine
 * re-audits it with no turn spent: it replays the arc onto the moved base,
 * verifies the fit and writes a fresh mark. All of that used to happen out of
 * sight — the card holding the arc showed a toast, an idle composer, an ARC
 * cell reading `Finished`, and nothing in its transcript, while the engine
 * was minutes into a verify. This file drives the whole story on a real card,
 * with no key and no click, and reads what the user now sees:
 *
 * 1. within two seconds of the base moving, the transcript holds a re-audit
 *    block whose headline names the new base tip and the arc whose join moved
 *    it (read from the tip's `Tug-Arc` trailer);
 * 2. a surface row runs (`data-status="running"`) while the verify does;
 * 3. the block closes on its verdict, `verified on main <sha>`;
 * 4. the ARC cell read `Re-auditing` during the run and reads `Ready` after;
 * 5. no turn was spent — the transcript holds exactly the user and assistant
 *    entries it held before the base moved.
 *
 * ## The fixture
 *
 * A scratch repository with one declared surface claiming every path, whose
 * checks are `sleep 2` then `true`, so the running row is readable and the
 * fit is green. A plain arc, one round, verified and marked `audited` through
 * the real CLI, then closed with the `arc-start` / `arc-done` lines the wheel
 * writes — the same record `repo_with_a_stale_audit` builds in the engine's
 * own tests. `createArc` turns the arc's auto-replay off, since most fixtures
 * want the ground still; this one is the engine's, so it turns it back on.
 *
 * @covers tugdeck/src/components/tugways/cards/session-reaudit-block.tsx
 * @covers tugdeck/src/components/tugways/reaudit-rows.tsx
 * @covers tugdeck/src/lib/reaudit-row.ts
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.tsx
 * @covers tugrust/crates/tugcast/src/feeds/base_motion.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  ARC_BRANCH_PREFIX,
  appendArcLogLine,
  arcLogPath,
  bindArc,
  commitRound,
  createArc,
  gitRetry,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000815";
const ARC = "at0815-reaudit";
const JOINED = "other-arc";

/** One surface claiming every path the arc and the base move touch. */
const SURFACES =
  "[tugtool.arc]\n\n" +
  "[[tugtool.arc.surface]]\n" +
  'name = "all"\n' +
  'paths = [".tugtool/", "README.md", "one.txt", "base.txt"]\n' +
  'check = ["sleep 2", "true"]\n';

const CARD = '[data-card-id="A"]';
const BLOCK = `${CARD} [data-slot="reaudit-block"]`;
const HEADLINE = `${BLOCK} .reaudit-block-headline`;
const VERDICT = `${BLOCK} .reaudit-block-verdict`;
const RUNNING_ROW = `${BLOCK} .reaudit-row[data-status="running"]`;
const ARC_VALUE = `${CARD} [data-slot="session-telemetry-arc-value"]`;
const TURN_ENTRIES = `${CARD} .tug-transcript-entry[data-participant="user"], ${CARD} .tug-transcript-entry[data-participant="assistant"]`;

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({
    prefix: "at0815",
    checkout: CHECKOUT,
    files: { ".tugtool/config.toml": SURFACES },
  });
  const cli = scratch.cli;
  const arc = createArc(projectDir(), ARC, "at0815 the engine's re-audit", cli);
  // The engine's arc: let base motion act on it.
  gitRetry(projectDir(), "config", `branch.${ARC_BRANCH_PREFIX}${ARC}.tugautoreplay`, "true");
  writeFileSync(join(arc.worktree, "one.txt"), "the arc's one change\n");
  commitRound(projectDir(), ARC, "tugarc(at0815-reaudit): Land the one round", cli);

  // Finished and audited, through the real CLI: the verify records the fit,
  // and the mark is refused over a tree no verify saw.
  const run = { cwd: projectDir(), binaryRoot: cli.binaryRoot, env: cli.env };
  tugtool(["arc", "verify", ARC], run);
  tugtool(["arc", "mark", ARC, "audited"], run);
  const log = arcLogPath(scratch.dataRoot);
  appendArcLogLine(log, ARC, "arc-start", `.tug/arcs/${ARC}/plan.md`);
  appendArcLogLine(log, ARC, "arc-done", "");

  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  rmScratchSession(fixtureDir);
});

describe.skipIf(!SHOULD_RUN)("AT0815: the re-audit in the transcript", () => {
  test(
    "a base move under a finished arc draws one live re-audit block that closes on its verdict, with no turn spent",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0815-reaudit-transcript",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 15000 },
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });
        bindArc(projectDir(), ARC, SID, scratch?.cli ?? {});
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ARC_VALUE)}) !== null`,
          { timeoutMs: 10000 },
        );

        const turnsBefore = await app.body("A").evalJS<number>(
          `document.querySelectorAll(${JSON.stringify(TURN_ENTRIES)}).length`,
        );
        expect(
          await app.body("A").evalJS<boolean>(
            `document.querySelector(${JSON.stringify(BLOCK)}) === null`,
          ),
          "nothing re-audits before the base moves",
        ).toBe(true);

        // Every reading the ARC cell shows from here on, sampled in the page.
        await app.body("A").evalJS<null>(
          `(function(){
             window.__at0815Arc = [];
             window.__at0815Tick = setInterval(function(){
               var el = document.querySelector(${JSON.stringify(ARC_VALUE)});
               var word = el === null ? "" : (el.textContent ?? "");
               var seen = window.__at0815Arc;
               if (seen.length === 0 || seen[seen.length - 1] !== word) seen.push(word);
             }, 50);
             return null;
           })()`,
        );

        // ── The base moves: a join's squash, with its trailer ────────────
        writeFileSync(join(projectDir(), "base.txt"), "the base moved\n");
        gitRetry(projectDir(), "add", "base.txt");
        gitRetry(
          projectDir(),
          "commit",
          "-m",
          `Land ${JOINED}\n\nTug-Arc: ${ARC_BRANCH_PREFIX}${JOINED} onto main`,
        );
        const movedAt = Date.now();
        const tip = gitRetry(projectDir(), "rev-parse", "main").trim();
        const short = tip.slice(0, 7);

        await app.body("A").waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(HEADLINE)})?.textContent ?? "").indexOf(${JSON.stringify(short)}) !== -1`,
          { timeoutMs: 10000 },
        );
        const appearedMs = Date.now() - movedAt;
        const headline = await app.body("A").evalJS<string>(
          `document.querySelector(${JSON.stringify(HEADLINE)})?.textContent ?? ""`,
        );
        note(`at0815 block after ${appearedMs} ms: ${JSON.stringify(headline)}`);
        expect(appearedMs, "the block is on the card within two seconds of the move").toBeLessThanOrEqual(
          2000,
        );
        expect(headline, "it names the arc whose join moved the base").toContain(JOINED);

        // ── A surface runs, and the block reaches its verdict ────────────
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(RUNNING_ROW)}) !== null`,
          { timeoutMs: 10000 },
        );
        await app.body("A").waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(VERDICT)})?.textContent ?? "").indexOf("verified on main") !== -1`,
          { timeoutMs: 20000 },
        );
        const verdict = await app.body("A").evalJS<string>(
          `document.querySelector(${JSON.stringify(VERDICT)})?.textContent ?? ""`,
        );
        expect(verdict, "the verdict names the base tip").toBe(`verified on main ${short}`);
        expect(
          await app.body("A").evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(BLOCK)}).length`,
          ),
          "the story is one block, upserted at every transition",
        ).toBe(1);

        // ── The ARC cell held the re-audit, and lands on Ready ───────────
        await app.body("A").waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(ARC_VALUE)})?.textContent ?? "") === "Ready"`,
          { timeoutMs: 15000 },
        );
        const readings = await app.body("A").evalJS<string[]>(
          `(clearInterval(window.__at0815Tick), window.__at0815Arc)`,
        );
        note(`at0815 ARC readings: ${JSON.stringify(readings)}`);
        expect(readings, "the cell read Re-auditing while the engine held the arc").toContain(
          "Re-auditing",
        );
        // The first reading is the cell at rest before the move; every one
        // after it is the cell while the engine answers the stale audit.
        expect(readings.slice(1), "and never fell through to Finished").not.toContain("Finished");

        // ── No turn was spent ────────────────────────────────────────────
        expect(
          await app.body("A").evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(TURN_ENTRIES)}).length`,
          ),
          "the transcript holds the same user and assistant entries it held before",
        ).toBe(turnsBefore);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
