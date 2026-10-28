/**
 * at0762-arc-join-fit.test.ts — the arc-join face opens its report on the
 * arc's fit, so the audit's all-clear is seen before the join is pressed.
 *
 * The join gate is reconcile-clean alone: nothing at the join re-runs the
 * arc's checks. What the user reads instead is the fit fact the last green
 * `tugtool arc verify` recorded, resolved against the live tips — and it has
 * three readings, each one sentence: never verified, verified and current,
 * verified but stale naming what moved.
 *
 * One arc walks all three. It starts with one round and no verify, so the face
 * says it was never verified. A `verified <head> onto <base>` line is then
 * appended to the arc log at the live pair, the line `tugtool arc verify`
 * writes, and the face says the pair stands. Then a second round lands on the
 * arc, and the face says the arc has moved since. None of it gates anything.
 *
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-arc-join.tsx
 * @covers tugdeck/src/lib/arc-fit.ts
 * @covers tugrust/crates/tugarc-core/src/ops/show.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  appendArcLogLine,
  arcLogPath,
  commitRound,
  createArc,
  currentBranch,
  gitRetry,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type ArcScratchRepo,
} from "./arc-fixture";
import { kindBody, waitForNoBodyOfKind } from "./_harness/card-reach";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000762";
const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const LANE = `${SHEET} [data-slot="session-changes-arc-lane"]`;

const ARC = "at0762-fit";
const ROW = `${LANE} [data-slot="session-changes-arc-row"][data-arc="${ARC}"]`;
const FIT = `${ROW} [data-slot="session-changes-arc-join"] [data-slot="session-changes-arc-join-fit"]`;

const ARCS_CARD = ".arcs-section";

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
let worktree = "";
const projectDir = (): string => scratch?.repo ?? "";

const SUBJECT_FILE = "at0762-subject.txt";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({
    prefix: "at0762",
    checkout: CHECKOUT,
    files: { [SUBJECT_FILE]: "at0762 first line\n" },
  });
  worktree = createArc(projectDir(), ARC, "at0762 fit", scratch.cli).worktree;
  writeFileSync(join(worktree, SUBJECT_FILE), "at0762 the arc's line\n");
  commitRound(projectDir(), ARC, `at0762(round): edit ${SUBJECT_FILE}`, scratch.cli);
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  rmScratchSession(fixtureDir);
});

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

async function runCommand(app: App, line: string): Promise<void> {
  await app.body("A").nativeClickAtElement(EDITOR);
  await app.nativeType(line);
  await settle();
  // Dismiss the slash completion popup so Enter submits rather than accepting.
  await app.nativeKey("Escape");
  await settle();
  await app.nativeKey("Return", ["cmd"]);
}

/** Wait for the fit row to wear `reading`, and return its sentence. */
async function fitReads(app: App, reading: string): Promise<string> {
  try {
    await app.body("A").waitForCondition<boolean>(
      `document.querySelector(${JSON.stringify(FIT)})?.getAttribute("data-fit") === ${JSON.stringify(reading)}`,
      { timeoutMs: 30000 },
    );
  } finally {
    note(
      `at0762 fit (${reading})`,
      await app.body("A").evalJS<string>(
        `(function(){
          var el = document.querySelector(${JSON.stringify(FIT)});
          return el === null ? "(no fit row)" : el.getAttribute("data-fit") + ": " + (el.textContent || "");
        })()`,
      ),
    );
  }
  return app.body("A").evalJS<string>(
    `(document.querySelector(${JSON.stringify(FIT)})?.textContent || "")`,
  );
}

describe.skipIf(!SHOULD_RUN)("AT0762: the arc-join face shows the fit", () => {
  test(
    "never verified, then verified and current, then stale naming the arc",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0762-arc-join-fit",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // Spawned, so the scratch repo is registered as a workspace and its
        // arc reaches the aggregate.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        await app.dispatchControlAction("toggle-arcs");
        await kindBody(app, "dashes").waitForCondition<boolean>(
          `document.querySelector('${ARCS_CARD} [data-slot="arcs-row"][data-arc="${ARC}"]') !== null`,
          { timeoutMs: 30000 },
        );
        await app.dispatchControlAction("toggle-arcs");
        await waitForNoBodyOfKind(app, "dashes", { timeoutMs: 8000 });

        // Aim the join by name: the shade rises with the arc fronted.
        await runCommand(app, `/arc-join ${ARC}`);

        // ── Never verified ─────────────────────────────────────────────────
        expect(await fitReads(app, "never")).toBe(
          "Not verified — no verify has passed on this arc.",
        );

        // ── Verified at the live pair: the line `tugtool arc verify` writes ─
        const head = gitRetry(projectDir(), "rev-parse", `tugarc/${ARC}`).trim();
        const base = gitRetry(projectDir(), "rev-parse", currentBranch(projectDir())).trim();
        appendArcLogLine(arcLogPath(scratch?.dataRoot ?? ""), ARC, "verified", `${head} onto ${base}`);
        expect(await fitReads(app, "current")).toBe(
          `Verified at ${head.slice(0, 7)} onto ${base.slice(0, 7)}, and both still stand.`,
        );

        // ── A round lands after the verify: stale, and it names the arc ────
        writeFileSync(join(worktree, SUBJECT_FILE), "at0762 a later line\n");
        commitRound(projectDir(), ARC, `at0762(round): edit ${SUBJECT_FILE} again`, scratch?.cli);
        expect(await fitReads(app, "stale")).toBe(
          `Verified at ${head.slice(0, 7)} onto ${base.slice(0, 7)}, but the arc has moved since.`,
        );
        note("at0762 stale", (await app.screenshot()).path);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
