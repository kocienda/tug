/**
 * at0478-arc-fit-verified.test.ts — a project declares its surfaces, an
 * unclaimed path really refuses, and a verified fit is recorded on the arc.
 *
 * The refusal is the half a table test cannot prove: the resolver's
 * `Unclaimed` is covered in `tugarc-core`, but that a real arc, over a real
 * diff, against a real committed `.tugtool/config.toml`, exits 2 and names the
 * path is a property of the verb over a tree. A project's table is complete
 * exactly when the verb stops refusing, and the first incomplete arc is the
 * one that says so — so the fixture declares a table that misses a directory
 * the round touches, watches it refuse, declares the surface, and watches the
 * refusal clear. A green verify records the head it verified and the base it
 * verified onto, and `arc status --json` carries the fact.
 *
 * The lane used to paint the fit as a `verified` mark and note; both were
 * removed on 2026-10-23 (Tug resolves fit at join itself), so this file no
 * longer launches the app.
 *
 * The exit-2 assertion is spawned directly rather than through the fixture's
 * `tugtool()` helper, which throws on a non-zero exit and so cannot express a
 * refusal. `tugtoolPath` is the only correct way to name the binary:
 * `~/.local/bin/tugtool` is a symlink into the *main* checkout's build, which
 * would run a `tugtool` with no `verify` subcommand at all.
 *
 * @covers tugrust/crates/tugarc-core/src/ops/show.rs
 * @covers tugrust/crates/tugarc-core/src/ops/commit.rs
 * @covers tugrust/crates/tugarc-core/src/surfaces.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { note } from "./_harness";
import {
  commitRound,
  createArc,
  gitRetry,
  makeArcScratchRepo,
  rmArcScratchRepo,
  tugtool,
  tugtoolPath,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const ARC_NAME = "at0478-fit";

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
let scratch: ArcScratchRepo | null = null;
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
    env: { ...process.env, ...scratch?.cli.env },
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
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
});

describe.skipIf(!SHOULD_RUN)("AT0478: the fit an arc was verified at", () => {
  test(
    "an unclaimed path refuses, declaring the surface clears it, and the fit is recorded",
    () => {
      // ── The refusal ─────────────────────────────────────────────────────
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
          ...scratch?.cli,
        }),
      ) as { data: { fit?: { head: string; base: string; current: boolean } } };
      expect(status.data.fit?.current).toBe(true);
      expect(status.data.fit?.head.length).toBe(40);
      expect(status.data.fit?.base.length).toBe(40);
    },
    TEST_TIMEOUT_MS,
  );
});
