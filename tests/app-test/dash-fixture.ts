/**
 * dash-fixture.ts — creating, rounding, and discarding a real dash from an
 * app-test, by the real CLI, in a repository the fixture owns.
 *
 * **A dash is for implementing a plan, not for running a test.** A dash is a
 * real branch and a real worktree, so a fixture that cuts one in the
 * developer's checkout leaves its litter in the tree somebody is working in —
 * and a test killed mid-file leaves it there for good. Fourteen files used to
 * do exactly that, which is why the app-test recipe once carried a janitor for
 * `tugdash/at04??-*` branches. Every fixture repository is a scratch repository
 * now ({@link makeDashScratchRepo}), and {@link createDash} refuses the
 * checkout outright so the rule cannot quietly lapse.
 *
 * Two things follow from a scratch repo that a test has to know:
 *
 * - **It is invisible until a session is spawned on it.** tugcast registers one
 *   workspace at startup — the `--source-tree` bootstrap, which is the checkout
 *   — and every other workspace comes from `spawn_session`. See
 *   {@link seedScratchSession}.
 * - **Its Tug state goes with it.** `TUG_DATA_DIR` is redirected per fixture,
 *   so dash state, journals, and drafts land beside the repo rather than in the
 *   developer's live data root. {@link DashScratchRepo.cli} carries that
 *   redirect; spread it into every fixture call.
 *
 * The git-lock retry stays, and still earns its keep: every live tugcast
 * instance runs a base-motion engine that shells git, so a verb can lose a coin
 * toss for `index.lock`. The lock is transient by construction, so every
 * git-touching verb retries through it rather than failing the file that lost.
 * A failure that is *not* transient fails immediately and carries the whole
 * corpse — exit code, signal, both streams. The alternative is what actually
 * happened: `tugutil dash create … failed:` with nothing after the colon,
 * because the message quoted only stderr and the process died before writing
 * any.
 *
 * Everything else about a dash fixture is deliberately unclever: the dash is
 * real, the round is a real commit, and the teardown is the whole repository
 * going away.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { App } from "./_harness";

/** How many times a git-touching verb retries through a held `index.lock`. */
const LOCK_RETRIES = 12;
const LOCK_BACKOFF_MS = 250;

/**
 * The built CLI, by absolute path.
 *
 * `~/.local/bin/tugutil` is a symlink whose target is somebody else's build
 * decision, which is not a thing a test should inherit silently.
 *
 * `projectDir`'s **own** `tugrust/target` comes first, then the main
 * checkout's. That order matters on a dash worktree: a worktree builds into
 * its own target dir, so a test exercising a CLI verb this branch adds would
 * otherwise run the main checkout's older binary and fail with `unrecognized
 * subcommand` — a stale build reported as a broken feature. A worktree that
 * has not been built falls back, which is what a test touching no Rust wants.
 */
export function tugutilPath(projectDir: string): string {
  const commonDir = Bun.spawnSync(
    ["git", "-C", projectDir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    {},
  )
    .stdout.toString()
    .trim();
  const roots = [projectDir, resolve(commonDir, "..")];
  for (const root of roots) {
    for (const profile of ["debug", "release"]) {
      const candidate = join(root, "tugrust/target", profile, "tugutil");
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`dash-fixture: no built tugutil under ${roots.join(" or ")}`);
}

/**
 * The checkout that owns `projectDir`'s dash state — the TypeScript mirror of
 * `tugutil_core::find_repo_root_from`.
 *
 * Tests need this because dash state lives beside the resolved root: the
 * `project_state_dir` slug (and so the join journal's home) is derived from it.
 * A mirror that answered differently from the Rust would read the wrong
 * directory and find nothing, which looks exactly like a feature that did not
 * fire.
 *
 * `TUG_REPO_UNIVERSE` wins when set — the `app-test` recipe always sets it, so
 * this is the live branch under `just`. Unset (a bare `bun test`), the hop
 * applies: a linked worktree's state belongs to the checkout holding the
 * common dir.
 */
export function universeRoot(projectDir: string): string {
  const universe = process.env.TUG_REPO_UNIVERSE;
  if (universe !== undefined && universe.trim() !== "") {
    return realpathSync(universe.trim());
  }
  const commonDir = Bun.spawnSync(
    ["git", "-C", projectDir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    {},
  )
    .stdout.toString()
    .trim();
  return realpathSync(resolve(commonDir, ".."));
}

/**
 * Whether a failure is a git contention that will clear on its own.
 *
 * The set is literal and closed: anything not named here fails fast with its
 * evidence, because retrying an unknown failure twelve times only delays the
 * diagnosis by three seconds.
 */
function transientGitFailure(stderr: string): boolean {
  return (
    stderr.includes("index.lock") ||
    stderr.includes("Another git process") ||
    stderr.includes("could not lock") ||
    stderr.includes("cannot lock ref") ||
    (stderr.includes("Unable to create") && stderr.includes(".lock"))
  );
}

/** Block the calling thread — these run in `beforeAll`, which is synchronous. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** What a failed spawn leaves behind, kept whole rather than reduced to stderr. */
interface SpawnFailure {
  exitCode: number | null;
  signalCode: string | null;
  stdout: string;
  stderr: string;
}

const EMPTY_FAILURE: SpawnFailure = {
  exitCode: null,
  signalCode: null,
  stdout: "",
  stderr: "",
};

/** The last `n` lines of `text`, or all of it when it is shorter. */
function tailLines(text: string, n: number): string {
  const lines = text.trimEnd().split("\n");
  return lines.length <= n ? lines.join("\n") : lines.slice(-n).join("\n");
}

/**
 * Render a failure as something a red run can be diagnosed from.
 *
 * Exit code and signal are always present, so a process killed before it could
 * write anything still says so. stdout matters as much as stderr here: the
 * `--json` verbs put their refusals *on stdout* inside the JSON envelope, so a
 * message quoting stderr alone hides exactly the refusals they work hardest to
 * phrase.
 */
function describeFailure(f: SpawnFailure): string {
  const parts = [`exit ${f.exitCode ?? "none"}`];
  if (f.signalCode !== null && f.signalCode !== undefined) parts.push(`signal ${f.signalCode}`);
  const stderr = f.stderr.trim();
  const stdout = tailLines(f.stdout, 20).trim();
  parts.push(`stderr: ${stderr === "" ? "(empty)" : stderr}`);
  parts.push(`stdout: ${stdout === "" ? "(empty)" : stdout}`);
  return parts.join("\n  ");
}

export interface TugutilRun {
  /** Where to run — the project the dash belongs to. */
  cwd: string;
  /**
   * Which checkout's built CLI to run, when that is not `cwd`. A fixture on a
   * scratch repo has no `tugrust/target` of its own, so it names the checkout
   * under test here and keeps `cwd` on the repo the verb should act upon.
   */
  binaryRoot?: string;
  /** JSON handed to the command on stdin (`dash commit`'s round metadata). */
  stdin?: string;
  /** Extra environment, merged over the caller's. */
  env?: Record<string, string>;
  /** Whether a non-zero exit throws. Off for best-effort cleanup. */
  required?: boolean;
}

/** Run one `tugutil` verb, retrying through a transient git lock. */
export function tugutil(args: string[], opts: TugutilRun): string {
  const bin = tugutilPath(opts.binaryRoot ?? opts.cwd);
  let last = EMPTY_FAILURE;
  for (let attempt = 0; attempt <= LOCK_RETRIES; attempt += 1) {
    const out = Bun.spawnSync([bin, ...args], {
      cwd: opts.cwd,
      stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    if (out.exitCode === 0) return out.stdout.toString();
    last = {
      exitCode: out.exitCode,
      signalCode: out.signalCode ?? null,
      stdout: out.stdout.toString(),
      stderr: out.stderr.toString(),
    };
    if (!transientGitFailure(last.stderr)) break;
    sleepSync(LOCK_BACKOFF_MS);
  }
  if (opts.required === false) return "";
  throw new Error(`tugutil ${args.join(" ")} failed\n  ${describeFailure(last)}`);
}

/**
 * `git`, in a directory, throwing on failure — retrying past a transient lock.
 *
 * One copy, shared: the lane files each grew their own, and three predicates
 * that must agree is two too many.
 */
export function gitRetry(cwd: string, ...args: string[]): string {
  let last = EMPTY_FAILURE;
  for (let attempt = 0; attempt <= LOCK_RETRIES; attempt += 1) {
    const out = Bun.spawnSync(["git", "-C", cwd, ...args], {});
    if (out.exitCode === 0) return out.stdout.toString();
    last = {
      exitCode: out.exitCode,
      signalCode: out.signalCode ?? null,
      stdout: out.stdout.toString(),
      stderr: out.stderr.toString(),
    };
    if (!transientGitFailure(last.stderr)) break;
    sleepSync(LOCK_BACKOFF_MS);
  }
  throw new Error(`git ${args.join(" ")} failed\n  ${describeFailure(last)}`);
}

/** A base commit and one small text file it modified — a conflict's subject. */
export interface ConflictSubject {
  /** The commit that modified `path`. A dash rewound to its parent diverges. */
  commit: string;
  /** Repo-relative path of the modified file. */
  path: string;
  /** That commit's subject line — what an archaeology face must name. */
  subject: string;
}

/**
 * Pick a conflict subject: the newest first-parent commit on `main` that
 * modified a **small** text file, and that file.
 *
 * The size bound is the whole point. A fixture that took whatever `main` last
 * touched had its outcome decided by unrelated work: when the newest modified
 * file was a 2050-line `Justfile`, the resolution's diff overran the server's
 * 400-line review cap and the assertion looking for the resolved body failed —
 * a red suite that said nothing about the code under test. The bound keeps the
 * conflict small enough to render whole.
 *
 * Deriving rather than hardcoding is deliberate too: a pinned sha ages out of
 * the history, and the rewind has to stay shallow so the divergence is minimal
 * and `merge-tree` stays cheap.
 *
 * A path the developer has uncommitted work on is skipped. The dash side of
 * the conflict is built in the dash's own worktree and never touches the
 * checkout — but the landing preview reads the checkout too, and uncommitted
 * work on a file the dash also changes is `base_overlap`, a different outcome
 * than the `conflicted` these fixtures are staged to produce. That is the
 * preview answering correctly about the repository it was handed; the fixture
 * simply must not stage its conflict on a file the developer is mid-edit on.
 * It bites exactly when the newest commit touched a file still being worked,
 * which is the ordinary state of a checkout an hour after a commit.
 *
 * A path that no longer exists on `main` is skipped for the same reason from
 * the other direction: the dash side can stage its half against any path in
 * history, but the base side is `main` as it stands, and a file deleted or
 * renamed since has nothing left to conflict with. A rename is both traps at
 * once — the old path is gone from the tip, the new one is dirty while the
 * rename is still uncommitted.
 */
export function smallConflictSubject(
  projectDir: string,
  opts: { maxLines?: number; maxCommits?: number } = {},
): ConflictSubject {
  const maxLines = opts.maxLines ?? 120;
  const maxCommits = opts.maxCommits ?? 25;
  const dirty = dirtyPaths(projectDir);
  const log = gitRetry(
    projectDir,
    "log",
    "--first-parent",
    "--diff-filter=M",
    "--pretty=%H",
    "--name-only",
    `-${maxCommits}`,
    "main",
  )
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let commit = "";
  for (const line of log) {
    if (/^[0-9a-f]{40}$/.test(line)) {
      commit = line;
      continue;
    }
    if (commit === "") continue;
    // The dash rewinds to the parent, so a root commit is no use here.
    if (!revExists(projectDir, `${commit}~1`)) continue;
    // Uncommitted work here would read as base overlap, not a conflict.
    if (dirty.has(line)) continue;
    // The commit modified it; a later commit may have deleted or renamed it.
    // The dash side stages its half against the path, but the base side is
    // `main` as it stands, where a vanished path has nothing to conflict with.
    if (!pathAtTip(projectDir, line)) continue;
    const blob = gitRetry(projectDir, "show", `${commit}:${line}`);
    if (blob.includes("\0")) continue; // binary — no content conflict to resolve
    if (blob.split("\n").length > maxLines) continue;
    return {
      commit,
      path: line,
      subject: gitRetry(projectDir, "log", "-1", "--pretty=%s", commit).trim(),
    };
  }
  throw new Error(
    `dash-fixture: no commit in main's last ${maxCommits} first-parent commits ` +
      `modified a text file of ${maxLines} lines or fewer that is clean in the ` +
      `working tree`,
  );
}

/**
 * Every repo-relative path with uncommitted work of any kind — staged,
 * unstaged, untracked, and both halves of a rename, since a rename is a
 * deletion the preview sees on the old path.
 */
function dirtyPaths(projectDir: string): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const line of gitRetry(projectDir, "status", "--porcelain").split("\n")) {
    if (line.length < 4) continue;
    for (const part of line.slice(3).split(" -> ")) {
      const path = part.trim().replace(/^"(.*)"$/, "$1");
      if (path.length > 0) paths.add(path);
    }
  }
  return paths;
}

/** Whether `main` still carries this path — the conflict needs both sides. */
function pathAtTip(projectDir: string, path: string): boolean {
  return (
    Bun.spawnSync(["git", "-C", projectDir, "cat-file", "-e", `main:${path}`], {})
      .exitCode === 0
  );
}

/** Whether a revision resolves — used to skip a commit with no parent. */
function revExists(projectDir: string, rev: string): boolean {
  return (
    Bun.spawnSync(["git", "-C", projectDir, "rev-parse", "--verify", "--quiet", rev], {})
      .exitCode === 0
  );
}

export interface CreatedDash {
  /** The dash's owner key — what `bind_dash_ok` carries and the lane fronts on. */
  id: string;
  /** Absolute worktree path. */
  worktree: string;
}

/**
 * Create a dash, returning its owner key and worktree.
 *
 * The dash opts out of automatic base motion the moment it exists. Every
 * tugcast process watching this repository runs a base-motion engine — the
 * user's release instance and every other app-test instance included — and each
 * one treats any dash it can see as its own to keep current. One of them was
 * caught replaying a fixture dash mid-test, between its round commit and its
 * release. A fixture asserting on a tip sha, a round list, or a worktree state
 * cannot have the ground moving under it.
 */
export interface DashFixtureOpts {
  /** Checkout whose built `tugutil` runs, when `projectDir` has none. */
  binaryRoot?: string;
  /**
   * Extra environment for the verb. A fixture on a scratch repo redirects
   * `TUG_DATA_DIR` here, so the dash state the CLI writes lands in the same
   * root the app under test reads.
   */
  env?: Record<string, string>;
}

/**
 * The branch `projectDir` has out, or `""` when detached.
 *
 * A dash forks from — and lands back onto — the branch its project is actually
 * working on. Left to the default, a fixture created from a checkout parked off
 * `main` would fork from content nobody has out, and its landing preflight
 * would refuse over a base branch that is not the checked-out one.
 */
export function currentBranch(projectDir: string): string {
  return gitRetry(projectDir, "branch", "--show-current").trim();
}

/** The checkout this test corpus lives in — the one repository no fixture may touch. */
const THIS_CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

/**
 * Refuse a fixture act aimed at the developer's checkout.
 *
 * A dash is for implementing a plan, not for running a test. A fixture dash in
 * the checkout is a real branch and a real worktree in the tree somebody is
 * working in — and a test killed mid-file strands them there. Every fixture
 * repository is a scratch repository ({@link makeDashScratchRepo}); this guard
 * is what keeps that a law rather than a convention.
 */
function refuseCheckout(projectDir: string, act: string): void {
  let resolved = projectDir;
  try {
    resolved = realpathSync(projectDir);
  } catch {
    return; // a path that does not resolve is not the checkout
  }
  if (resolved === THIS_CHECKOUT) {
    throw new Error(
      `dash-fixture: refusing to ${act} in the developer's checkout (${resolved}). ` +
        "A dash is for implementing a plan, not for running a test — " +
        "cut it in a scratch repository (makeDashScratchRepo).",
    );
  }
}

export function createDash(
  projectDir: string,
  name: string,
  description: string,
  opts: DashFixtureOpts = {},
): CreatedDash {
  refuseCheckout(projectDir, "create a dash");
  const branch = currentBranch(projectDir);
  const base = branch === "" ? [] : ["--base", branch];
  const out = JSON.parse(
    tugutil(["dash", "create", name, "--description", description, ...base, "--json"], {
      cwd: projectDir,
      binaryRoot: opts.binaryRoot,
      env: opts.env,
    }),
  ) as { data: { id: string; worktree: string } };
  gitRetry(projectDir, "config", `branch.tugdash/${name}.tugautoreplay`, "false");
  return { id: out.data.id, worktree: out.data.worktree };
}

/** Commit everything dirty in the dash's worktree as one round. */
export function commitRound(
  projectDir: string,
  name: string,
  subject: string,
  opts: DashFixtureOpts = {},
): void {
  refuseCheckout(projectDir, "commit a round");
  tugutil(["dash", "commit", name, "--message", subject, "--json"], {
    cwd: projectDir,
    binaryRoot: opts.binaryRoot,
    env: opts.env,
    stdin: JSON.stringify({ instruction: subject, summary: "app-test fixture round" }),
  });
}

/**
 * Declare a dash `built` — which is what starts the join arc.
 *
 * The pilot acts on a `built` dash and on nothing else: reconciling it with its
 * base and running the project's Tier 0 over the result, unprompted. So a
 * fixture that wants the machine to do its work says so here, and then asserts
 * with no gesture at all. A fixture that wants a dash left alone simply does
 * not call this.
 */
export function markDashBuilt(
  projectDir: string,
  name: string,
  opts: DashFixtureOpts = {},
): void {
  refuseCheckout(projectDir, "mark a dash built");
  tugutil(["dash", "mark", name, "built"], {
    cwd: projectDir,
    binaryRoot: opts.binaryRoot,
    env: opts.env,
  });
}

/**
 * A document that parses as a plan, carrying one unstamped Review Record round
 * for `plan stamp` to write into.
 *
 * It has to be a *real* plan, not a stub: `dash step start` is the only writer
 * of the dash's recorded plan path, and it refuses unless the document parses
 * and carries a `#step-1` ledger row.
 */
const FIXTURE_PLAN = `## A Fixture Plan {#fixture-plan}

### Plan Metadata {#plan-metadata}

| Field | Value |
|---|---|
| Owner | app-test |

### Review Record {#review-record}

**Round 1 — 2026-08-14, opus.** Lint: 0 errors, 0 warnings.

### Phase Overview {#phase-overview}

The fixture's context.

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The only step | pending | — |

#### Step 1: The only step {#step-1}

**Commit:** \`fixture(scope): do it\`

**References:** [P01] the decision, (#phase-overview)

**Tasks:**
- [ ] Do the thing.

**Tests:**
- [ ] Unit: the thing works.

**Checkpoint:**
- [ ] \`cargo nextest run\`

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** the thing.
`;

/**
 * Give a dash a plan it is driving, reviewed and stamped.
 *
 * The order is load-bearing in both directions. `dash step start` **mutates**
 * the plan — it flips the ledger row to `in progress` — so it must run before
 * the stamp, or the stamp would be invalidated by the very next verb. And
 * ledger status cells sit outside the hashed content, so that mutation does
 * not itself make the plan stale, which is what makes a test's "not stale yet"
 * assertion mean anything.
 */
export function recordStampedPlan(
  projectDir: string,
  name: string,
  worktree: string,
  opts: DashFixtureOpts = {},
): string {
  const planPath = join(worktree, "plan.md");
  writeFileSync(planPath, FIXTURE_PLAN);
  tugutil(["dash", "step", name, "start", "1", "--plan", "plan.md"], {
    cwd: projectDir,
    binaryRoot: opts.binaryRoot,
    env: opts.env,
  });
  tugutil(["plan", "stamp", planPath], {
    cwd: projectDir,
    binaryRoot: opts.binaryRoot,
    env: opts.env,
  });
  return planPath;
}

/**
 * Give a dash a plan it is driving with **no step started** — the state a
 * surface has to say something about rather than fall silent on.
 *
 * `adopt-plan` with the worktree copy already written has nothing to
 * transplant, so it only records the path: the dash carries a `plan_path` and
 * no step declaration, which is exactly the split the missing-step fact
 * exists to catch.
 */
export function recordAdoptedPlan(
  projectDir: string,
  name: string,
  worktree: string,
  opts: DashFixtureOpts = {},
): string {
  const planPath = join(worktree, "plan.md");
  writeFileSync(planPath, FIXTURE_PLAN);
  tugutil(["dash", "adopt-plan", name, "--plan", "plan.md", "--json"], {
    cwd: projectDir,
    binaryRoot: opts.binaryRoot,
    env: opts.env,
  });
  return planPath;
}

/** Move the document past its stamp — one appended line is the whole edit. */
export function makePlanStale(planPath: string): void {
  writeFileSync(planPath, `${readFileSync(planPath, "utf8")}\nOne more line.\n`);
}

/** Discard the dash — branch and worktree, dirt included. Best effort: a
 *  cleanup that throws would mask the failure the test was reporting. */
export function discardDash(
  projectDir: string,
  name: string,
  opts: DashFixtureOpts = {},
): void {
  // Same law as `createDash`, and sharper here: a discard aimed at the
  // checkout could tear down a dash the developer actually made, on nothing
  // more than a name collision.
  refuseCheckout(projectDir, "discard a dash");
  tugutil(["dash", "discard", name, "--json"], {
    cwd: projectDir,
    binaryRoot: opts.binaryRoot,
    env: opts.env,
    required: false,
  });
}

// ---------------------------------------------------------------------------
// The scratch repository
// ---------------------------------------------------------------------------

/** A scratch repository a fixture owns outright, and its redirected data root. */
export interface DashScratchRepo {
  /** The repository the app opens — the only tree the fixture's dashes touch. */
  repo: string;
  /** Tug's data root for it, redirected away from the developer's own. */
  dataRoot: string;
  /**
   * Spread into every dash-fixture call: run the checkout's built CLI, against
   * this repo, writing into this data root. Threading the three by hand at each
   * call site is how one of them gets forgotten and a dash lands in the
   * developer's repository again.
   */
  cli: DashFixtureOpts;
}

/** How a scratch repo is shaped. */
export interface DashScratchOpts {
  /** Prefix for the temp directories, so a failed run is identifiable. */
  prefix: string;
  /** The checkout whose built `tugutil` drives the fixture. */
  checkout: string;
  /**
   * Files at the root commit, path → body, merged over the defaults.
   *
   * `.tugtool/config.toml` is written whether or not it is named here:
   * `.tugtool/` is what marks a project root — `find_project_root` in
   * `tugutil-core/src/config.rs` walks up looking for exactly that — and a
   * scratch repo without one resolves its root somewhere above the temp dir
   * instead, which is a fixture whose dashes exist and are never listed.
   */
  files?: Record<string, string>;
}

/**
 * Build an empty git repository for a fixture to cut its dashes in.
 *
 * **A dash is for implementing a plan, not for running a test.** A dash is a
 * real branch and a real worktree, so a fixture that creates one in the
 * developer's checkout leaves its litter in the tree somebody is working in —
 * and a fixture killed mid-file leaves it there for good, which is why the
 * app-test recipe once had to carry a janitor for `tugdash/at04??-*`.
 *
 * The dash a fixture needs is a *mechanism* under test, and a mechanism needs
 * no particular repository. So it gets one of its own: two commits deep, torn
 * down whole at the end, and invisible to every other process on the machine.
 */
/**
 * The one temp-dir namespace every scratch fixture lives under.
 *
 * The name is what makes leftovers sweepable: `afterAll` removes a scratch
 * repo promptly, but a test killed mid-file never runs its teardown, and its
 * directories — the repo, the data root, and the transcript dir the encoded
 * repo path lands under `~/.claude/projects` — would otherwise accumulate
 * forever. The app-test recipe sweeps `tug-scratch-*` in both places at run
 * start, so nothing a dead run left behind outlives the next one.
 */
export const SCRATCH_NAMESPACE = "tug-scratch";

export function makeDashScratchRepo(opts: DashScratchOpts): DashScratchRepo {
  const repo = realpathSync(
    mkdtempSync(join(tmpdir(), `${SCRATCH_NAMESPACE}-${opts.prefix}-`)),
  );
  const dataRoot = realpathSync(
    mkdtempSync(join(tmpdir(), `${SCRATCH_NAMESPACE}-${opts.prefix}-data-`)),
  );

  // `-b main` is explicit: the machine's `init.defaultBranch` may be anything,
  // and the dash's base has to be a branch this repo actually has out.
  gitRetry(repo, "init", "-b", "main");
  gitRetry(repo, "config", "user.email", "app-test@tugtool.dev");
  gitRetry(repo, "config", "user.name", opts.prefix);
  const files: Record<string, string> = {
    "README.md": `${opts.prefix} scratch repository\n`,
    ".tugtool/config.toml": "[tugtool.dash]\n",
    ...(opts.files ?? {}),
  };
  for (const [path, body] of Object.entries(files)) {
    const full = join(repo, path);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  gitRetry(repo, "add", "-A");
  gitRetry(repo, "commit", "-m", `${opts.prefix}: the scratch repository`);

  return {
    repo,
    dataRoot,
    cli: { binaryRoot: opts.checkout, env: { TUG_DATA_DIR: dataRoot } },
  };
}

/** Delete everything {@link makeDashScratchRepo} made. */
export function rmDashScratchRepo(scratch: DashScratchRepo | null): void {
  if (scratch === null) return;
  for (const dir of [scratch.repo, scratch.dataRoot]) {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  }
}

/** Mirrors tugcode's `encodeProjectDir` (see at0192 for the rationale). */
export const encodeProjectDir = (absDir: string): string =>
  absDir.replace(/[^A-Za-z0-9-]/g, "-");

/**
 * Give a scratch repo a resumable Claude session, and return the directory to
 * remove afterwards.
 *
 * **A scratch repo is invisible until a session is spawned on it.** tugcast
 * registers exactly one workspace at startup — the `--source-tree` bootstrap,
 * which is the checkout, because that is also where `tugdeck/dist` is served
 * from (`main.rs`'s `watch_dir`). Every other workspace is registered by
 * `spawn_session`. So a fixture that creates dashes in a scratch repo and then
 * binds a card with `App.bindSession` sees none of them: `bindSession` is a
 * client-side binding the ledger and the registry both know nothing about, and
 * the aggregate it reads is still composed over the checkout.
 *
 * The way in is a real session on the scratch repo — `App.spawnSessionResume`
 * against the transcript this writes. That is the whole reason these fixtures
 * ever cut their dashes in the developer's checkout: it was the one repository
 * the app had open.
 */
export function seedScratchSession(repo: string, sessionId: string): string {
  // `claude --resume <sid>` requires a UUID. A prose-shaped id fails the
  // resume, which reverts the card to the session picker mid-test — a failure
  // that surfaces as "composer selector matched no element", nowhere near its
  // cause. Refused here so it is never diagnosed from that distance again.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId)) {
    throw new Error(
      `seedScratchSession: session id ${JSON.stringify(sessionId)} is not a UUID — ` +
        "claude --resume refuses it. Use a uuid-shaped constant " +
        '(e.g. "a7c0d1ea-0000-4000-8000-000000000421").',
    );
  }
  const dir = join(homedir(), ".claude", "projects", encodeProjectDir(repo));
  mkdirSync(dir, { recursive: true });
  const base = {
    isSidechain: false,
    userType: "external",
    cwd: repo,
    sessionId,
    version: "2.1.105",
    gitBranch: "main",
  };
  const rows = [
    {
      ...base,
      parentUuid: null,
      type: "user",
      uuid: "00000000-0000-4000-8000-0000000000a1",
      timestamp: new Date(Date.now() - 2000).toISOString(),
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    },
    {
      ...base,
      parentUuid: "00000000-0000-4000-8000-0000000000a1",
      type: "assistant",
      uuid: "00000000-0000-4000-8000-0000000000a2",
      timestamp: new Date(Date.now() - 1000).toISOString(),
      message: {
        id: `msg-${sessionId}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "hi there" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 1200,
          output_tokens: 50,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 8000,
        },
      },
    },
  ];
  writeFileSync(join(dir, `${sessionId}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return dir;
}

/** Remove what {@link seedScratchSession} wrote. */
export function rmScratchSession(dir: string): void {
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
}

/**
 * Run `command` through the card's `$` shell route and wait for its exit.
 *
 * This is how a dash test binds and unbinds for real: the shell child is what
 * carries `TUG_SESSION_ID`, so `tugutil dash bind` run through it resolves the
 * session the card actually holds. One copy here because four files had grown
 * their own, differing only in a default parameter.
 */
export async function shellAndSettle(
  app: App,
  command: string,
  expectedIndex = 0,
  cardId = "A",
): Promise<void> {
  const prompt = `[data-card-id="${cardId}"] [data-slot="tug-text-editor"] .cm-content`;
  const rows = `[data-card-id="${cardId}"] [data-slot="session-transcript-shell-row"]`;
  await app.nativeClickAtElement(prompt);
  await app.nativeType(`/shell ${command}`);
  await new Promise((r) => setTimeout(r, 150));
  await app.nativeKey("Enter", ["cmd"]);
  await app.waitForCondition<boolean>(
    `(function(){
       var rows = document.querySelectorAll(${JSON.stringify(rows)});
       if (rows.length !== ${expectedIndex + 1}) return false;
       var foot = rows[${expectedIndex}].querySelector('[data-slot="session-z1b-end-state"]');
       return foot !== null && foot.textContent.indexOf("exit") !== -1;
     })()`,
    { timeoutMs: 30_000 },
  );
}

// ---------------------------------------------------------------------------
// The join fixtures' scratch repository
// ---------------------------------------------------------------------------

/** A scratch repo built for a join arc, and everything needed to tear it down. */
export interface JoinScratchRepo {
  /** The repository the app opens — the only tree the fixture touches. */
  repo: string;
  /** Tug's data root for it, redirected away from the developer's own. */
  dataRoot: string;
  /** Where the stub scripts live. */
  stubDir: string;
  /** The dash worktree the round was committed on. */
  worktree: string;
  /** The dash's creation id — what a bind gesture addresses it by. */
  dashId: string;
}

/** How a join scratch repo is shaped. */
export interface JoinScratchOpts {
  /** Prefix for the temp directories, so a failed run is identifiable. */
  prefix: string;
  /** The dash's name. */
  dash: string;
  /** The dash's one-line description. */
  description: string;
  /** The checkout whose built `tugutil` drives the fixture. */
  checkout: string;
  /** The file both sides rewrite. */
  file: string;
  /** Its body at the fork, then the base's rewrite, then the dash's. */
  fork: string;
  base: string;
  dashBody: string;
  /**
   * The project's declared Tier 0 command ([P11]).
   *
   * Every join fixture declares one and none declares a Tier 1: a fixture join
   * runs inside an app-test that already holds the machine-wide apptest gate,
   * so a real tier-1 command would queue on the gate its own run is holding.
   * The tier-0 command is a sentinel grep — seconds cheap, no toolchain, and
   * able to go genuinely red, which is what a red-path fixture needs.
   */
  verifyTier0: string;
  /** The resolver stub's script body, with `$1` the workshop path. */
  resolver: string;
  /**
   * Put the base's rewrite in a file of its own, so the squash has nothing to
   * reconcile.
   *
   * The clean join is its own arc now, not the absence of one: entering join
   * mode resolves it, the one-shot squash anchors a candidate, and the declared
   * Tier 0 judges that candidate — so a fixture that wants a *joinable* dash
   * without a conflict asks for one here rather than skipping the pipeline.
   */
  cleanMerge?: boolean;
  /** An optional merge-driver stub body, for an arc that needs a ladder-clean candidate. */
  mergeDriver?: string;
  /**
   * Declare the dash `built` once the round is in — which hands it to the
   * pilot ({@link markDashBuilt}).
   *
   * A fixture asserting that the machine reconciles and checks a dash *with no
   * gesture* sets this and then presses nothing. A fixture about a dash still
   * being worked leaves it off, and the pilot never looks at it.
   */
  built?: boolean;
}

/**
 * Build a scratch repository holding one genuine conflict, a declared Tier 0,
 * and a scripted resolver.
 *
 * A repository per fixture rather than the developer's checkout, and that is
 * safety rather than tidiness: a join that succeeds squashes its dash onto the
 * base branch **in that branch's live working tree**, which for the checkout
 * would be the developer's own `main`. Owning the repository is what lets these
 * arcs run to their end instead of stopping one beat short.
 */
export function makeJoinScratchRepo(opts: JoinScratchOpts): JoinScratchRepo {
  const base = makeDashScratchRepo({
    prefix: opts.prefix,
    checkout: opts.checkout,
    files: {
      [opts.file]: opts.fork,
      ".tugtool/config.toml": `[tugtool.dash]\nverify_tier0 = ["${opts.verifyTier0}"]\n`,
    },
  });
  const { repo, dataRoot } = base;
  const stubDir = mkdtempSync(
    join(tmpdir(), `${SCRATCH_NAMESPACE}-${opts.prefix}-stubs-`),
  );

  const created = createDash(repo, opts.dash, opts.description, base.cli);

  // Both sides move the same lines, after the fork: a genuine conflict — or,
  // when the fixture asked for a clean merge, two files that never meet.
  const baseFile = opts.cleanMerge === true ? `base-${opts.file}` : opts.file;
  writeFileSync(join(repo, baseFile), opts.base);
  gitRetry(repo, "add", "-A");
  gitRetry(repo, "commit", "-m", `${opts.prefix}: the base rewrites it`);
  writeFileSync(join(created.worktree, opts.file), opts.dashBody);
  commitRound(repo, opts.dash, `${opts.prefix}(round): rewrite ${opts.file}`, base.cli);

  const script = (name: string, body: string): string => {
    const path = join(stubDir, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
    return path;
  };
  gitRetry(repo, "config", "tugdash.joinresolver", script("stub-resolver.sh", opts.resolver));
  if (opts.mergeDriver !== undefined) {
    gitRetry(repo, "config", "tugdash.mergedriver", script("stub-driver.sh", opts.mergeDriver));
  }

  // Last, and after the resolver is configured: `built` is what hands the dash
  // to the pilot, and the pilot may start reconciling the moment a tugcast
  // process sees the stage move. A dash declared built before its resolver
  // exists would be reconciled by whatever `tugdash.joinresolver` said then,
  // which is nothing.
  if (opts.built === true) markDashBuilt(repo, opts.dash, base.cli);

  return { repo, dataRoot, stubDir, worktree: created.worktree, dashId: created.id };
}

/** Delete everything {@link makeJoinScratchRepo} made. */
export function rmJoinScratchRepo(scratch: JoinScratchRepo | null): void {
  if (scratch === null) return;
  for (const dir of [scratch.repo, scratch.dataRoot, scratch.stubDir]) {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  }
}
