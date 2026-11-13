/**
 * AT0816 — a red re-audit closes its block on the reason, and seats the audit.
 *
 * ## Why this exists
 *
 * The other ending of the engine's re-audit (at0815 reads the green one): the
 * replay is clean but the fit is red on the moved base, so the engine cannot
 * write a fresh mark. It hands the arc back to its audit stage instead, and
 * the card's re-audit block has to close on that, in words, rather than
 * leaving a block that reads as running or as nothing at all. This file reads:
 *
 * 1. the block closes on `handed to the audit stage: the fit did not verify`;
 * 2. the arc's record seats its audit again: the engine writes the one
 *    `arc-resume audit` line every re-audit door writes, which clears `done`.
 *    The derived stage still reads `audit-stale` — the mark is stale until
 *    the audit marks again — so the record's line is what says it was seated.
 *
 * It does not wait for the audit stage's divider: seating the audit makes the
 * wheel rotate a real stage turn onto the card, which the harness does not
 * stand up. That the closing row is written before the seat is the engine's
 * own Rust test to prove.
 *
 * ## The fixture
 *
 * at0815's, with a check that is green until the base carries a flag file:
 * `test ! -e red.flag`. The arc verifies and marks `audited` honestly, and the
 * base move that lands the flag is what turns the fit red — which is exactly
 * the case the engine's quiet path exists to catch.
 *
 * @covers tugdeck/src/components/tugways/cards/session-reaudit-block.tsx
 * @covers tugdeck/src/components/tugways/reaudit-rows.tsx
 * @covers tugdeck/src/lib/reaudit-row.ts
 * @covers tugrust/crates/tugcast/src/feeds/base_motion.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
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

const SID = "a7c0d1ea-0000-4000-8000-000000000816";
const ARC = "at0816-reaudit-red";

/** One surface claiming every path, green until the base lands the flag. */
const SURFACES =
  "[tugtool.arc]\n\n" +
  "[[tugtool.arc.surface]]\n" +
  'name = "all"\n' +
  'paths = [".tugtool/", "README.md", "one.txt", "red.flag"]\n' +
  'check = ["test ! -e red.flag"]\n';

const CARD = '[data-card-id="A"]';
const BLOCK = `${CARD} [data-slot="reaudit-block"]`;
const VERDICT = `${BLOCK} .reaudit-block-verdict`;
const FAILED_ROW = `${BLOCK} .reaudit-row[data-status="fail"]`;
const ARC_VALUE = `${CARD} [data-slot="session-telemetry-arc-value"]`;

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({
    prefix: "at0816",
    checkout: CHECKOUT,
    files: { ".tugtool/config.toml": SURFACES },
  });
  const cli = scratch.cli;
  const arc = createArc(projectDir(), ARC, "at0816 a red re-audit", cli);
  // The engine's arc: let base motion act on it.
  gitRetry(projectDir(), "config", `branch.${ARC_BRANCH_PREFIX}${ARC}.tugautoreplay`, "true");
  writeFileSync(join(arc.worktree, "one.txt"), "the arc's one change\n");
  commitRound(projectDir(), ARC, "tugarc(at0816-reaudit-red): Land the one round", cli);

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

/** This arc's `arc-resume` lines in the arc log — the record of a seat. */
function resumeLines(): string[] {
  return readFileSync(arcLogPath(scratch?.dataRoot ?? ""), "utf8")
    .split("\n")
    .filter((line) => line.split(/\s{2,}/)[1] === ARC && line.split(/\s{2,}/)[2] === "arc-resume");
}

describe.skipIf(!SHOULD_RUN)("AT0816: a red re-audit in the transcript", () => {
  test(
    "a fit the base move turned red closes the block on its reason and seats the audit",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0816-reaudit-transcript-red",
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

        // ── The base moves, and lands the flag that turns the fit red ────
        writeFileSync(join(projectDir(), "red.flag"), "the base turned the fit red\n");
        gitRetry(projectDir(), "add", "red.flag");
        gitRetry(projectDir(), "commit", "-m", "Land the red flag");

        await app.body("A").waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(VERDICT)})?.textContent ?? "").indexOf("handed to the audit stage") !== -1`,
          { timeoutMs: 20000 },
        );
        const verdict = await app.body("A").evalJS<string>(
          `document.querySelector(${JSON.stringify(VERDICT)})?.textContent ?? ""`,
        );
        note(`at0816 verdict: ${JSON.stringify(verdict)}`);
        expect(
          verdict.startsWith("handed to the audit stage: the fit did not verify"),
          "the block closes on the reason the engine could not re-mark",
        ).toBe(true);
        expect(
          await app.body("A").evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(FAILED_ROW)}).length`,
          ),
          "the red surface is a row of its own",
        ).toBe(1);

        // ── And the record agrees: the audit is seated again ─────────────
        const resumes = resumeLines();
        note(`at0816 resume lines: ${JSON.stringify(resumes)}`);
        expect(resumes.length, "the engine seated the audit once").toBe(1);
        expect(resumes[0]?.split(/\s{2,}/)[3]?.split(" ")[0], "at the audit stage").toBe("audit");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
