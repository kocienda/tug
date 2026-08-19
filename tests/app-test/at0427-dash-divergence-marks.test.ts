/**
 * at0427-dash-divergence-marks.test.ts — the dash lane says how far a dash has
 * drifted from its base, the moment it becomes true.
 *
 * A landing problem should surface when it becomes true, not when you try to
 * land. The marks are where that surfaces: `base overlap (N)` when uncommitted
 * work on the base touches files the dash also changes, `base +N` when the base
 * has moved ahead, `replay conflicts (N)` when replaying stopped on one, and a
 * quiet `replayed` receipt when history moved under the dash and nothing asked.
 *
 * Only the overlap mark is drivable here, and that is deliberate. The other
 * three need the *base branch* to move, and this suite runs against the live
 * repository — moving the base means committing to the developer's real `main`.
 * Branch motion is covered at the Rust layer in tempdir repos
 * (`tugdash-core`'s replay tests and `tugcast`'s base-motion engine tests);
 * what those cannot cover is that the composed entry reaches the lane and
 * paints, which is this file's whole job.
 *
 * The overlap is produced honestly: a real dash whose round changes a tracked
 * file, and the same file left uncommitted in the base checkout. The base
 * checkout is the developer's own tree, so the fixture is strict about it — it
 * refuses to run at all if that path is already dirty, and it restores both
 * bytes and mtime afterwards, which is `tugutil file probe`'s contract done in
 * `beforeAll`/`afterAll` because the assertion has to happen while the dirt is
 * live.
 *
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-lane.tsx
 * @covers tugdeck/src/lib/changeset-types.ts
 * @covers tugrust/crates/tugdash-core/src/ops.rs
 * @covers tugrust/crates/tugcast/src/feeds/base_motion.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import { commitRound, createDash, discardDash, universeRoot } from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "at0427-session";
const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const LANE = `${SHEET} [data-slot="session-changes-dash-lane"]`;

const DASH_NAME = "at0427-marks";
const ROW = `${LANE} [data-slot="session-changes-dash-row"][data-dash="${DASH_NAME}"]`;
const OVERLAP_MARK = `${ROW} [data-slot="session-changes-dash-divergence"][data-divergence="overlap"]`;

/** The checkout this file sits in — the project the aggregate composes. */
const PROJECT_DIR = realpathSync(resolve(import.meta.dir, "..", ".."));

/**
 * The checkout a dash's base lives in, and therefore the only tree whose dirt
 * `base_overlap` reads. Under `just app-test` that is the pinned universe —
 * this file's own checkout, worktree or not. Bare, it is the checkout that owns
 * the common dir. `universeRoot` is the one mirror of the Rust rule.
 */
function mainRepoRoot(): string {
  return universeRoot(PROJECT_DIR);
}

/**
 * The tracked file the overlap is staged on. `.gitignore` is chosen for being
 * tracked, tiny, and inert: an appended comment changes nothing the app reads,
 * and nothing else in the corpus writes it.
 */
const OVERLAP_FILE = ".gitignore";
const OVERLAP_LINE = "# at0427 overlap fixture — removed by this test\n";

let baseRoot = "";
let basePath = "";
/** The base file's bytes and mtime before the fixture touched it. */
let baseBefore: string | null = null;
let baseMtime = new Date(0);
/** Set when the base checkout was already dirty on that path — the one state in
 *  which this fixture must not run. */
let refusedReason: string | null = null;

function baseIsClean(): boolean {
  const out = execFileSync("git", ["status", "--porcelain", "--", OVERLAP_FILE], {
    cwd: baseRoot,
    encoding: "utf8",
  });
  return out.trim() === "";
}

beforeAll(() => {
  if (!SHOULD_RUN) return;
  baseRoot = mainRepoRoot();
  basePath = join(baseRoot, OVERLAP_FILE);
  if (!baseIsClean()) {
    refusedReason = `${OVERLAP_FILE} is already uncommitted in ${baseRoot}`;
    return;
  }

  const created = createDash(PROJECT_DIR, DASH_NAME, "at0427 divergence marks");
  // The dash's round changes the same tracked file the base will be dirty on —
  // an intersection, which is exactly what `base_overlap` reports.
  const worktreeFile = join(created.worktree, OVERLAP_FILE);
  writeFileSync(
    worktreeFile,
    `${readFileSync(worktreeFile, "utf8")}# at0427 dash round\n`,
  );
  commitRound(PROJECT_DIR, DASH_NAME, "at0427(round): the dash changes this file too");

  // Now the base half. Bytes and mtime are both captured, because restoring
  // bytes alone would leave a spurious modification hint on the path.
  baseBefore = readFileSync(basePath, "utf8");
  baseMtime = statSync(basePath).mtime;
  writeFileSync(basePath, `${baseBefore}${OVERLAP_LINE}`);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  if (baseBefore !== null) {
    writeFileSync(basePath, baseBefore);
    utimesSync(basePath, baseMtime, baseMtime);
    baseBefore = null;
  }
  if (refusedReason === null) discardDash(PROJECT_DIR, DASH_NAME);
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

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!SHOULD_RUN)("AT0427: the dash lane's divergence marks", () => {
  test(
    "base dirt overlapping the dash's own files paints the overlap mark, and clears when it goes",
    async () => {
      if (refusedReason !== null) {
        note(`at0427 skipped: ${refusedReason}`);
        return;
      }
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: PROJECT_DIR });
      const app = await launchTugApp({
        testName: "at0427-dash-divergence-marks",
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", {
          tugSessionId: SID,
          projectDir: PROJECT_DIR,
          workspaceKey: PROJECT_DIR,
        });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        // ── Raise the changes shade ────────────────────────────────────────
        await app.nativeClickAtElement(PROMPT_INPUT);
        await app.nativeType("/commit");
        await settle();
        await app.nativeKey("Escape");
        await settle();
        await app.nativeKey("Return", ["cmd"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 8000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(LANE)}) !== null`,
          { timeoutMs: 30000 },
        );
        // The non-fronted dash is a visible row — no fold to open first.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) !== null`,
          { timeoutMs: 30000 },
        );

        // ── The mark ───────────────────────────────────────────────────────
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(OVERLAP_MARK)}) !== null`,
          { timeoutMs: 30000 },
        );
        const mark = await app.evalJS<{ text: string; tip: string }>(
          `(() => {
             const el = document.querySelector(${JSON.stringify(OVERLAP_MARK)});
             const tip = el.closest("[aria-describedby], [data-state]") ?? el;
             return {
               text: (el.textContent ?? "").trim(),
               tip: tip.getAttribute("aria-label") ?? "",
             };
           })()`,
        );
        // The count is the point — a warning that does not say how much is
        // overlapping is not actionable.
        expect(mark.text).toBe("base overlap (1)");

        // The conflicted and behind marks are absent: this dash is current
        // with its base and nothing has attempted a replay on it.
        const others = await app.evalJS<number>(
          `document.querySelectorAll(${JSON.stringify(
            `${ROW} [data-slot="session-changes-dash-divergence"]:not([data-divergence="overlap"])`,
          )}).length`,
        );
        expect(others).toBe(0);

        // ── And it goes when the overlap goes ──────────────────────────────
        writeFileSync(basePath, baseBefore!);
        utimesSync(basePath, baseMtime, baseMtime);
        baseBefore = null;
        // The aggregate recomposes on file events under a watched project; the
        // base checkout is not one, so nudge the watched tree.
        const nudge = join(PROJECT_DIR, "at0427-nudge.txt");
        writeFileSync(nudge, "at0427 recompose nudge\n");
        try {
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(OVERLAP_MARK)}) === null`,
            { timeoutMs: 30000 },
          );
        } finally {
          rmSync(nudge, { force: true });
        }
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
