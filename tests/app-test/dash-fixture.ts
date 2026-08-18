/**
 * dash-fixture.ts — creating, rounding, and discarding a real dash from an
 * app-test, by the real CLI.
 *
 * Shared because the alternative is four copies, and because the one thing
 * that is genuinely hard here has to be got right in all of them: **these
 * fixtures drive the developer's own repository, which other processes are
 * holding at the same time.** Every live tugcast instance — the release app,
 * every other app-test instance — runs a base-motion engine that shells git
 * against this repo, so a `tugutil dash create` here can lose a coin toss for
 * `index.lock`. The lock is transient by construction, so every git-touching
 * verb retries through it rather than failing the file that lost.
 *
 * A failure that is *not* transient fails immediately and carries the whole
 * corpse — exit code, signal, both streams. The alternative is what actually
 * happened: `tugutil dash create … failed:` with nothing after the colon,
 * because the message quoted only stderr and the process died before writing
 * any.
 *
 * Everything else about a dash fixture is deliberately unclever: the dash is
 * real, the round is a real commit, and the discard really deletes the branch
 * and the worktree.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

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
  /** JSON handed to the command on stdin (`dash commit`'s round metadata). */
  stdin?: string;
  /** Extra environment, merged over the caller's. */
  env?: Record<string, string>;
  /** Whether a non-zero exit throws. Off for best-effort cleanup. */
  required?: boolean;
}

/** Run one `tugutil` verb, retrying through a transient git lock. */
export function tugutil(args: string[], opts: TugutilRun): string {
  const bin = tugutilPath(opts.cwd);
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
export function createDash(
  projectDir: string,
  name: string,
  description: string,
): CreatedDash {
  const out = JSON.parse(
    tugutil(["dash", "create", name, "--description", description, "--json"], {
      cwd: projectDir,
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
): void {
  tugutil(["dash", "commit", name, "--message", subject, "--json"], {
    cwd: projectDir,
    stdin: JSON.stringify({ instruction: subject, summary: "app-test fixture round" }),
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
): string {
  const planPath = join(worktree, "plan.md");
  writeFileSync(planPath, FIXTURE_PLAN);
  tugutil(["dash", "step", name, "start", "1", "--plan", "plan.md"], {
    cwd: projectDir,
  });
  tugutil(["plan", "stamp", planPath], { cwd: projectDir });
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
): string {
  const planPath = join(worktree, "plan.md");
  writeFileSync(planPath, FIXTURE_PLAN);
  tugutil(["dash", "adopt-plan", name, "--plan", "plan.md", "--json"], {
    cwd: projectDir,
  });
  return planPath;
}

/** Move the document past its stamp — one appended line is the whole edit. */
export function makePlanStale(planPath: string): void {
  writeFileSync(planPath, `${readFileSync(planPath, "utf8")}\nOne more line.\n`);
}

/** Discard the dash — branch and worktree, dirt included. Best effort: a
 *  cleanup that throws would mask the failure the test was reporting. */
export function discardDash(projectDir: string, name: string): void {
  tugutil(["dash", "discard", name, "--json"], {
    cwd: projectDir,
    required: false,
  });
}
