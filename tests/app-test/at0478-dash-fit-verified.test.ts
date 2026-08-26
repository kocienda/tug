/**
 * at0478-dash-fit-verified.test.ts — a project declares its surfaces, an
 * unclaimed path really refuses, and a verified fit reaches the dash lane.
 *
 * Two claims, in the order a project actually meets them.
 *
 * The refusal first, because it is the half a table test cannot prove: the
 * resolver's `Unclaimed` is covered in `tugdash-core`, but that a real dash,
 * over a real diff, against a real committed `.tugtool/config.toml`, exits 2
 * and names the path is a property of the verb over a tree. A project's table
 * is complete exactly when the verb stops refusing, and the first incomplete
 * dash is the one that says so — so the fixture declares a table that misses a
 * directory the round touches, watches it refuse, declares the surface, and
 * watches the refusal clear.
 *
 * Then the face. A green verify records the head it verified and the base it
 * verified onto; the fact rides the changeset entry that already reaches the
 * lane, and `dashMetaFacts` derives `fit verified` from it purely. What the
 * fact *says* is settled in `bun:test` over that pure function; what cannot be
 * settled there is that the composed entry reaches the lane and paints, which
 * is this file's job.
 *
 * The exit-2 assertion is spawned directly rather than through the fixture's
 * `tugutil()` helper, which throws on a non-zero exit and so cannot express a
 * refusal. `tugutilPath` is the only correct way to name the binary:
 * `~/.local/bin/tugutil` is a symlink into the *main* checkout's build, which
 * would run a `tugutil` with no `verify` subcommand at all.
 *
 * @covers tugdeck/src/components/tugways/dash-lifecycle-line.tsx
 * @covers tugdeck/src/lib/dash-meta-facts.ts
 * @covers tugdeck/src/lib/changeset-types.ts
 * @covers tugrust/crates/tugdash-core/src/ops.rs
 * @covers tugrust/crates/tugdash-core/src/surfaces.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync, mkdirSync } from "node:fs";
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
  gitRetry,
  makeDashScratchRepo,
  rmDashScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugutil,
  tugutilPath,
  type DashScratchRepo,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000478";
const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const LANE = `${SHEET} [data-slot="session-changes-dash-lane"]`;

const DASH_NAME = "at0478-fit";
const ROW = `${LANE} [data-slot="session-changes-dash-row"][data-dash="${DASH_NAME}"]`;
const FIT_MARK = `${ROW} [data-slot="tug-dash-lifecycle-fact"][data-fact="fit"]`;

/** This checkout — the build under test, and never the tree a dash is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
let scratch: DashScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

/**
 * The table the project starts with: `src/` claimed, `docs/` not.
 *
 * The round touches both, so the first verify refuses on `docs/` — the gap a
 * declaration can have and a script never could.
 */
const PARTIAL_TABLE = [
  "[[tugtool.dash.surface]]",
  'name  = "src"',
  'paths = ["src/"]',
  'check = ["true"]',
  "",
].join("\n");

/**
 * The same table with the gap closed — and `.tugtool/` claimed too, because
 * the round that closes the gap edits the config file itself. A table is
 * complete when the verb stops refusing, and the refusal counts every path the
 * dash would land, including the declaration that fixed it.
 */
const COMPLETE_TABLE = [
  PARTIAL_TABLE,
  "[[tugtool.dash.surface]]",
  'name  = "docs"',
  'paths = ["docs/"]',
  "check = []",
  "",
  "[[tugtool.dash.surface]]",
  'name  = "project"',
  'paths = [".tugtool/"]',
  "check = []",
  "",
].join("\n");

/** Run `dash verify` for its exit code, which the throwing helper cannot give. */
function verifyExit(): { code: number; out: string } {
  const run = Bun.spawnSync([tugutilPath(CHECKOUT), "dash", "verify", DASH_NAME], {
    cwd: projectDir(),
    env: { ...process.env, ...(scratch?.cli.env ?? {}) },
  });
  return {
    code: run.exitCode ?? -1,
    out: `${run.stdout.toString()}${run.stderr.toString()}`,
  };
}

/** Rewrite the project's committed table, on the base and on the dash alike. */
function declareTable(worktree: string, table: string): void {
  for (const root of [projectDir(), worktree]) {
    mkdirSync(join(root, ".tugtool"), { recursive: true });
    writeFileSync(join(root, ".tugtool/config.toml"), table);
  }
}

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeDashScratchRepo({
    prefix: "at0478",
    checkout: CHECKOUT,
    files: { ".tugtool/config.toml": PARTIAL_TABLE, "src/seed.txt": "seed\n" },
  });

  const created = createDash(projectDir(), DASH_NAME, "at0478 the fit fact", scratch.cli);
  // The round touches both directories: one the table claims, one it does not.
  mkdirSync(join(created.worktree, "docs"), { recursive: true });
  writeFileSync(join(created.worktree, "src/a.txt"), "the dash's own change\n");
  writeFileSync(join(created.worktree, "docs/b.md"), "prose the table forgot\n");
  commitRound(projectDir(), DASH_NAME, "at0478(round): touch two surfaces", scratch.cli);

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

describe.skipIf(!SHOULD_RUN)("AT0478: the fit a dash was verified at", () => {
  test(
    "an unclaimed path refuses, declaring the surface clears it, and the lane says the fit",
    async () => {
      // ── The refusal, before the app is involved at all ──────────────────
      const refused = verifyExit();
      note(`refused: exit ${refused.code}`);
      expect(refused.code).toBe(2);
      expect(refused.out).toContain("docs/b.md");
      expect(refused.out).toContain("[[tugtool.dash.surface]]");
      expect(refused.out).toContain("TUG-VERIFY-RECEIPT: unclaimed");
      // The refusal is about the gap, not about a check that ran beside it.
      expect(refused.out).not.toContain("TUG-VERIFY-RECEIPT: verified");

      // ── Declaring the missing surface clears it ─────────────────────────
      const worktree = join(projectDir(), ".tug/worktrees", DASH_NAME);
      declareTable(worktree, COMPLETE_TABLE);
      commitRound(
        projectDir(),
        DASH_NAME,
        "at0478(round): declare the surface the refusal named",
        scratch?.cli ?? {},
      );
      gitRetry(projectDir(), "checkout", "--", ".tugtool/config.toml");

      const green = verifyExit();
      note(`green: exit ${green.code}`);
      expect(green.code).toBe(0);
      expect(green.out).toContain("TUG-VERIFY-RECEIPT: verified");
      // One checked surface (`src`), two claimed-and-unchecked (`docs` and the
      // `.tugtool/` declaration itself) — counted apart, never conflated.
      expect(green.out).toContain("1 surfaces checked · 2 claimed unchecked");

      // The fact is recorded where the faces read it.
      const status = JSON.parse(
        tugutil(["dash", "status", DASH_NAME, "--json"], {
          cwd: projectDir(),
          ...(scratch?.cli ?? {}),
        }),
      ) as { data: { fit?: { head: string; base: string; current: boolean } } };
      expect(status.data.fit?.current).toBe(true);
      expect(status.data.fit?.head.length).toBe(40);
      expect(status.data.fit?.base.length).toBe(40);

      // ── And the lane says it ────────────────────────────────────────────
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0478-dash-fit-verified",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

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
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) !== null`,
          { timeoutMs: 30000 },
        );

        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FIT_MARK)}) !== null`,
          { timeoutMs: 30000 },
        );
        const mark = await app.evalJS<{ text: string; tone: string }>(
          `(() => {
             const el = document.querySelector(${JSON.stringify(FIT_MARK)});
             return {
               text: (el.textContent ?? "").trim(),
               tone: el.getAttribute("data-tone") ?? "",
             };
           })()`,
        );
        note(`lane fact: ${mark.text} (${mark.tone})`);
        expect(mark.text).toBe("fit verified");
        // A quiet receipt, not a warning — the fit says; it never gates.
        expect(mark.tone).toBe("subtle");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
