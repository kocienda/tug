/**
 * at0478-arc-fit-verified.test.ts — a project declares its surfaces, an
 * unclaimed path really refuses, and a verified fit reaches the arc lane.
 *
 * Two claims, in the order a project actually meets them.
 *
 * The refusal first, because it is the half a table test cannot prove: the
 * resolver's `Unclaimed` is covered in `tugarc-core`, but that a real arc,
 * over a real diff, against a real committed `.tugtool/config.toml`, exits 2
 * and names the path is a property of the verb over a tree. A project's table
 * is complete exactly when the verb stops refusing, and the first incomplete
 * arc is the one that says so — so the fixture declares a table that misses a
 * directory the round touches, watches it refuse, declares the surface, and
 * watches the refusal clear.
 *
 * Then the face. A green verify records the head it verified and the base it
 * verified onto; the fact rides the changeset entry that already reaches the
 * lane, and `arcMetaFacts` derives `fit verified` from it purely. What the
 * fact *says* is settled in `bun:test` over that pure function; what cannot be
 * settled there is that the composed entry reaches the lane and paints, which
 * is this file's job.
 *
 * The exit-2 assertion is spawned directly rather than through the fixture's
 * `tugtool()` helper, which throws on a non-zero exit and so cannot express a
 * refusal. `tugtoolPath` is the only correct way to name the binary:
 * `~/.local/bin/tugtool` is a symlink into the *main* checkout's build, which
 * would run a `tugtool` with no `verify` subcommand at all.
 *
 * @covers tugdeck/src/components/tugways/arc-lifecycle-line.tsx
 * @covers tugdeck/src/lib/arc-meta-facts.ts
 * @covers tugdeck/src/lib/changeset-types.ts
 * @covers tugrust/crates/tugarc-core/src/ops.rs
 * @covers tugrust/crates/tugarc-core/src/surfaces.rs
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
  createArc,
  gitRetry,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
  tugtoolPath,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000478";
const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const LANE = `${SHEET} [data-slot="session-changes-arc-lane"]`;

const ARC_NAME = "at0478-fit";
const ROW = `${LANE} [data-slot="session-changes-arc-row"][data-arc="${ARC_NAME}"]`;
/** The line's mark, and the sentence under the block the mark stands for. */
const FIT_MARK = `${ROW} [data-slot="tug-arc-lifecycle-fact-mark"][data-fact="fit"]`;
const FIT_NOTE = `${ROW} [data-slot="arc-trouble-note"][data-fact="fit"]`;

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

/**
 * The table the project starts with: `src/` claimed, `docs/` not.
 *
 * The round touches both, so the first verify refuses on `docs/` — the gap a
 * declaration can have and a script never could.
 */
const PARTIAL_TABLE = [
  "[[tugtool.arc.surface]]",
  'name  = "src"',
  'paths = ["src/"]',
  'check = ["true"]',
  "",
].join("\n");

/**
 * The same table with the gap closed — and `.tugtool/` claimed too, because
 * the round that closes the gap edits the config file itself. A table is
 * complete when the verb stops refusing, and the refusal counts every path the
 * arc would land, including the declaration that fixed it.
 */
const COMPLETE_TABLE = [
  PARTIAL_TABLE,
  "[[tugtool.arc.surface]]",
  'name  = "docs"',
  'paths = ["docs/"]',
  "check = []",
  "",
  "[[tugtool.arc.surface]]",
  'name  = "project"',
  'paths = [".tugtool/"]',
  "check = []",
  "",
].join("\n");

/** Run `arc verify` for its exit code, which the throwing helper cannot give. */
function verifyExit(): { code: number; out: string } {
  const run = Bun.spawnSync([tugtoolPath(CHECKOUT), "arc", "verify", ARC_NAME], {
    cwd: projectDir(),
    env: { ...process.env, ...(scratch?.cli.env ?? {}) },
  });
  return {
    code: run.exitCode ?? -1,
    out: `${run.stdout.toString()}${run.stderr.toString()}`,
  };
}

/** Rewrite the project's committed table, on the base and on the arc alike. */
function declareTable(worktree: string, table: string): void {
  for (const root of [projectDir(), worktree]) {
    mkdirSync(join(root, ".tugtool"), { recursive: true });
    writeFileSync(join(root, ".tugtool/config.toml"), table);
  }
}

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({
    prefix: "at0478",
    checkout: CHECKOUT,
    files: { ".tugtool/config.toml": PARTIAL_TABLE, "src/seed.txt": "seed\n" },
  });

  const created = createArc(projectDir(), ARC_NAME, "at0478 the fit fact", scratch.cli);
  // The round touches both directories: one the table claims, one it does not.
  mkdirSync(join(created.worktree, "docs"), { recursive: true });
  writeFileSync(join(created.worktree, "src/a.txt"), "the arc's own change\n");
  writeFileSync(join(created.worktree, "docs/b.md"), "prose the table forgot\n");
  commitRound(projectDir(), ARC_NAME, "at0478(round): touch two surfaces", scratch.cli);

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

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!SHOULD_RUN)("AT0478: the fit an arc was verified at", () => {
  test(
    "an unclaimed path refuses, declaring the surface clears it, and the lane says the fit",
    async () => {
      // ── The refusal, before the app is involved at all ──────────────────
      const refused = verifyExit();
      note(`refused: exit ${refused.code}`);
      expect(refused.code).toBe(2);
      expect(refused.out).toContain("docs/b.md");
      expect(refused.out).toContain("[[tugtool.arc.surface]]");
      expect(refused.out).toContain("TUG-VERIFY-RECEIPT: unclaimed");
      // The refusal is about the gap, not about a check that ran beside it.
      expect(refused.out).not.toContain("TUG-VERIFY-RECEIPT: verified");

      // ── Declaring the missing surface clears it ─────────────────────────
      const worktree = join(projectDir(), ".tug/worktrees", ARC_NAME);
      declareTable(worktree, COMPLETE_TABLE);
      commitRound(
        projectDir(),
        ARC_NAME,
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
        tugtool(["arc", "status", ARC_NAME, "--json"], {
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
        testName: "at0478-arc-fit-verified",
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
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FIT_NOTE)}) !== null`,
          { timeoutMs: 30000 },
        );
        const mark = await app.evalJS<{ text: string; tone: string }>(
          `(() => {
             const el = document.querySelector(${JSON.stringify(FIT_MARK)});
             const note = document.querySelector(${JSON.stringify(FIT_NOTE)});
             return {
               text: (note.textContent ?? "").trim(),
               tone: el.getAttribute("data-tone") ?? "",
             };
           })()`,
        );
        note(`lane fact: ${mark.text} (${mark.tone})`);
        // Under the block, `verified` is the whole of what a reader needs;
        // "fit" is `tugtool arc verify`'s word and stays in the hover ([B07]).
        // The line itself carries the receipt as a mark in the same tone.
        expect(mark.text).toBe("verified");
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
