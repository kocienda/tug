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
 * Only the overlap mark is driven here. The other three need the *base branch*
 * to move, and branch motion is already covered at the Rust layer in tempdir
 * repos (`tugdash-core`'s replay tests and `tugcast`'s base-motion engine
 * tests); what those cannot cover is that the composed entry reaches the lane
 * and paints, which is this file's whole job. Now that the fixture owns its
 * repository outright, the other three marks are reachable here too — moving
 * the base is a commit in a scratch tree — and that is the natural next round.
 *
 * The overlap is produced honestly: a real dash whose round changes a tracked
 * file, and the same file left uncommitted in the base checkout — which is a
 * scratch repository this file owns, not the developer's tree.
 *
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-lane.tsx
 * @covers tugdeck/src/lib/changeset-types.ts
 * @covers tugrust/crates/tugdash-core/src/ops.rs
 * @covers tugrust/crates/tugcast/src/feeds/base_motion.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  commitRound,
  createDash,
  makeDashScratchRepo,
  rmDashScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type DashScratchRepo,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000427";
const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const LANE = `${SHEET} [data-slot="session-changes-dash-lane"]`;

const DASH_NAME = "at0427-marks";
const ROW = `${LANE} [data-slot="session-changes-dash-row"][data-dash="${DASH_NAME}"]`;
const OVERLAP_MARK = `${ROW} [data-slot="session-changes-dash-divergence"][data-divergence="overlap"]`;

/** This checkout — the build under test, and never the tree a dash is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
/** The scratch repository this fixture owns, and the only tree it touches. */
let scratch: DashScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

/**
 * The tracked file the overlap is staged on.
 *
 * The base half of an overlap is uncommitted dirt in the repository the dash
 * forked from — which is why this fixture needs a repository of its own. It
 * used to append to the developer's `.gitignore` and restore its bytes *and*
 * mtime afterwards, because restoring bytes alone leaves a spurious
 * modification hint on the path. Owning the repo retires all of that: the
 * dirt is made in a tree nobody else can see, and the teardown is the
 * directory going away.
 */
const OVERLAP_FILE = "at0427-overlap.txt";
const OVERLAP_LINE = "at0427 the base's own uncommitted line\n";
/** The file's committed bytes — what reverting the base dirt restores. */
const OVERLAP_BASE = "at0427 the line both sides start from\n";

/** The base checkout's copy of that file. */
const basePath = (): string => join(projectDir(), OVERLAP_FILE);

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeDashScratchRepo({
    prefix: "at0427",
    checkout: CHECKOUT,
    files: { [OVERLAP_FILE]: OVERLAP_BASE },
  });

  const created = createDash(projectDir(), DASH_NAME, "at0427 divergence marks", scratch.cli);
  // The dash's round changes the same tracked file the base will be dirty on —
  // an intersection, which is exactly what `base_overlap` reports.
  const worktreeFile = join(created.worktree, OVERLAP_FILE);
  writeFileSync(worktreeFile, `${OVERLAP_BASE}at0427 the dash's round\n`);
  commitRound(
    projectDir(),
    DASH_NAME,
    "at0427(round): the dash changes this file too",
    scratch.cli,
  );

  // The base half: uncommitted dirt on that same path.
  writeFileSync(basePath(), `${OVERLAP_BASE}${OVERLAP_LINE}`);

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
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0427-dash-divergence-marks",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // A *spawned* session, not a bound one: spawning registers the scratch
        // repo as a workspace, so its dash reaches the aggregate.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
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
        // Reverting the base's dirt is the whole gesture: the file goes back to
        // its committed bytes, so the intersection is empty and the mark has
        // nothing left to report.
        writeFileSync(basePath(), OVERLAP_BASE);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(OVERLAP_MARK)}) === null`,
          { timeoutMs: 30000 },
        );
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
