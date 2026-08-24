//! CLI argument parsing for the unified `tugutil` binary.
//!
//! One command tree over three surfaces: the top-level git verbs
//! (`changes`/`preflight`/`commit`/`log`/`diff`/`draft`, backed by
//! `tugchanges_core`), the `dash` namespace (worktree work units, backed by
//! `tugdash_core`), and the `host` namespace (instance/gate/state-dir/tell/init
//! plumbing).

use std::path::PathBuf;

use clap::{Parser, Subcommand, ValueEnum};

use tugdash_core::{JoinStrategy, MarkStage};

use crate::commands::{GateCommands, InstanceCommands};

/// `tugutil file` — the git-aware file lifecycle verbs. Each mutating verb
/// prints a `TUG-FILE-RECEIPT` line naming exactly the files it touched, which
/// is what makes a glob or variable-driven operation attributable at all.
#[derive(clap::Subcommand, Debug)]
pub enum FileCommands {
    /// Delete files (globs expanded here, `git rm` for tracked paths).
    Rm {
        /// Paths or globs to remove.
        #[arg(required = true)]
        paths: Vec<String>,
    },
    /// Move or rename a file or directory (`git mv` when tracked).
    Mv {
        /// Source path.
        src: String,
        /// Destination path (an existing directory receives the source under its own name).
        dst: String,
    },
    /// Copy a file or directory.
    Cp {
        /// Source path.
        src: String,
        /// Destination path.
        dst: String,
    },
    /// Edit files and report exactly which ones changed, so the edit stays
    /// attributed. Either a unified diff (`--patch`) or one substitution
    /// (`--path` with `--replace`/`--with`).
    Edit {
        /// Unified diff to apply (`-` for stdin). Multi-file diffs are fine.
        #[arg(long, conflicts_with_all = ["path", "replace", "with"])]
        patch: Option<String>,
        /// The file to substitute in.
        #[arg(long, requires_all = ["replace", "with"])]
        path: Option<String>,
        /// The text to replace (a literal substring unless `--regex`).
        #[arg(long)]
        replace: Option<String>,
        /// The replacement text (`$1`-style captures with `--regex`).
        #[arg(long = "with")]
        with: Option<String>,
        /// Replace at most this many occurrences (default: all).
        #[arg(long)]
        count: Option<usize>,
        /// Read `--replace` as a regular expression rather than a literal.
        #[arg(long)]
        regex: bool,
    },
    /// Stage a patch into the index without touching the working tree — the
    /// non-interactive equivalent of `git add -p`, which cannot run in the
    /// block shell (its stdin is /dev/null).
    Stage {
        /// Unified diff to stage (`-` for stdin).
        #[arg(long)]
        patch: String,
    },
    /// Apply a patch, run a command against it, then put the tree back exactly
    /// as it was — bytes and mtime. Records nothing: a probe that restores
    /// changed nothing.
    Probe {
        /// Unified diff to apply for the duration of the command (`-` for stdin).
        #[arg(long)]
        patch: Option<String>,
        /// Extra paths to snapshot and restore beyond the ones the patch names.
        #[arg(long = "path")]
        paths: Vec<String>,
        /// The command to run, after `--`.
        #[arg(last = true, allow_hyphen_values = true)]
        command: Vec<String>,
    },
    /// Decide whether a Bash command's file operations are readable — the
    /// PreToolUse hook's allow/deny, printed as JSON. Always exits 0.
    Gate {
        /// The Bash command to judge.
        #[arg(long)]
        command: String,
        /// Directory relative operands resolve against (default: cwd).
        #[arg(long)]
        base_dir: Option<PathBuf>,
    },
}

const VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), " (", env!("TUG_COMMIT"), ")");

/// tugutil — the unified Tug developer CLI.
#[derive(Parser)]
#[command(name = "tugutil")]
#[command(version = VERSION)]
#[command(about = "tugutil — changes & commits, dashes, and host plumbing")]
#[command(
    long_about = "tugutil — the unified Tug developer CLI.\n\nTop-level verbs own this session's git surface: changes (which files this\nsession changed), preflight (the one-shot readout a landing starts from),\ncommit (stage → commit → structured receipt), draft (the maintained landing\ndraft), log, and diff. `tugutil dash …` drives worktree-isolated work units;\n`tugutil host …` is instance/project plumbing (instance, gate, state-dir,\ntell, init)."
)]
pub struct Cli {
    /// Increase output verbosity
    #[arg(short, long, global = true)]
    pub verbose: bool,

    /// Suppress non-error output (no effect on `--json`)
    #[arg(short, long, global = true)]
    pub quiet: bool,

    /// Emit machine-readable JSON
    #[arg(long, global = true)]
    pub json: bool,

    #[command(subcommand)]
    pub command: Option<Commands>,
}

#[derive(Subcommand)]
pub enum Commands {
    /// Which files this session changed (ledger ∩ git status).
    Changes {
        /// Session id (default: $TUG_SESSION_ID).
        #[arg(long)]
        session: Option<String>,
        /// Project dir (default: cwd).
        #[arg(long)]
        project: Option<PathBuf>,
        /// Keep committed/reverted files too.
        #[arg(long)]
        all: bool,
        /// Attach each file's unified diff.
        #[arg(long)]
        diff: bool,
    },
    /// One-shot landing preflight: changed files (with diff), branch/head, recent commits.
    ///
    /// (`context` remains a hidden alias for one release — shipped skill
    /// text still says `tugutil context`.)
    #[command(alias = "context")]
    Preflight {
        /// Session id (default: $TUG_SESSION_ID).
        #[arg(long)]
        session: Option<String>,
        /// Project dir (default: cwd).
        #[arg(long)]
        project: Option<PathBuf>,
        /// Recent-commit depth.
        #[arg(long, default_value_t = 10)]
        log_limit: u32,
    },
    /// Stage the session's changed files, commit, and print a structured receipt.
    Commit {
        /// Git commit message (subject, optional body).
        #[arg(long)]
        message: String,
        /// Session id (default: $TUG_SESSION_ID).
        #[arg(long)]
        session: Option<String>,
        /// Project dir (default: cwd).
        #[arg(long)]
        project: Option<PathBuf>,
        /// Explicit file set (overrides the session's changed files).
        #[arg(long, num_args = 1..)]
        paths: Vec<String>,
        /// Include shared files (paths other sessions also hold live rows for).
        #[arg(long)]
        all: bool,
        /// Commit unattributed dirty files (no ledger rows) too.
        #[arg(long)]
        include_unattributed: bool,
        /// Proceed without unattributed files (they appear in the receipt's left_behind).
        #[arg(long)]
        leave_unattributed: bool,
        /// Commit the whole dirty tree (attributed ∪ unattributed ∪ shared), except foreign-claimed paths.
        #[arg(long)]
        tree: bool,
        /// Land only some hunks: a JSON file (or `-` for stdin) mapping each
        /// repo-relative path to the hunk ids to commit. Every path must also
        /// be in the commit's file set, and the index must be clean.
        #[arg(long, value_name = "FILE")]
        hunks: Option<String>,
    },
    /// Claim files for a session — promote "likely" hints into the changeset
    /// without re-editing them (proof-grade attribution). Paths are
    /// repo-relative, as the changeset lists them. Needs a running instance.
    Claim {
        /// Repo-relative paths to claim.
        #[arg(required = true, num_args = 1..)]
        paths: Vec<String>,
        /// Session id (default: $TUG_SESSION_ID).
        #[arg(long)]
        session: Option<String>,
        /// Project dir (default: cwd).
        #[arg(long)]
        project: Option<PathBuf>,
    },
    /// Disclaim files for a session — remove them from the session's changeset.
    /// The inverse of `claim`: the file falls to another session that still
    /// holds proof of it, or back to unattributed. Paths are repo-relative.
    /// Needs a running instance.
    Disclaim {
        /// Repo-relative paths to disclaim.
        #[arg(required = true, num_args = 1..)]
        paths: Vec<String>,
        /// Session id (default: $TUG_SESSION_ID).
        #[arg(long)]
        session: Option<String>,
        /// Project dir (default: cwd).
        #[arg(long)]
        project: Option<PathBuf>,
    },
    /// Recent commits, or a range's commits.
    Log {
        /// Number of commits (default 10).
        #[arg(long)]
        limit: Option<u32>,
        /// Two-dot range `a..b`.
        #[arg(long)]
        range: Option<String>,
    },
    /// Per-file diff stats for the working tree, the index, a range, or the session.
    Diff {
        /// Two-dot range `a..b`.
        #[arg(long)]
        range: Option<String>,
        /// Diff the index instead of the working tree.
        #[arg(long)]
        staged: bool,
        /// Narrow to the session's changed files (default session: $TUG_SESSION_ID).
        #[arg(long)]
        session: bool,
        /// Project dir (default: cwd).
        #[arg(long)]
        project: Option<PathBuf>,
    },

    /// Git-aware file lifecycle verbs that report what they touched.
    ///
    /// `rm`/`mv`/`cp` expand their own operands and print a
    /// `TUG-FILE-RECEIPT` line naming every file affected, so an operation the
    /// shell grammar could never read (a glob, a variable) still lands as
    /// proof-class attribution. `gate` answers the PreToolUse hook.
    #[command(subcommand)]
    File(FileCommands),

    /// The maintained landing draft (set/show/clear) — Spec S02.
    #[command(subcommand)]
    Draft(DraftCommands),

    /// Worktree-isolated work units (create/commit/join/discard/list/show).
    #[command(subcommand)]
    Dash(DashCommands),

    /// Plan documents — mechanical conformance against the devise skeleton.
    #[command(subcommand)]
    Plan(PlanCommands),

    /// Instance discovery, the build gate, project state, and the tell bridge.
    #[command(subcommand)]
    Host(HostCommands),

    /// The app-test results ledger — what every run leaves behind, and what
    /// a red file's history says about it.
    #[command(subcommand)]
    Apptest(ApptestCommands),
}

#[derive(Subcommand)]
pub enum ApptestCommands {
    /// Record one run, read as JSON on stdin.
    ///
    /// The payload carries the run's bounds, its root, the `HEAD` it ran
    /// against, how it was selected, and one entry per file. The base
    /// checkout every history query keys on is resolved here from the run
    /// root, so that rule lives in exactly one language.
    Record,
    /// Answer each named file's history for the run root's base checkout.
    ///
    /// One of `last-green`, `red-streak`, or `no-history` per file. `SKIP`
    /// rows are excluded — a file the runner skipped says nothing about
    /// whether it works.
    History {
        /// The root the run executed in (default: cwd). Resolved to its base
        /// checkout, so a dash worktree and its checkout share one history.
        #[arg(long)]
        root: Option<PathBuf>,
        /// Emit JSON. The only rendering today; named so the recipe's call
        /// site says what it expects.
        #[arg(long)]
        json: bool,
        /// Test files to answer for, as the report names them.
        #[arg(required = true, num_args = 1..)]
        files: Vec<String>,
    },
}

/// Clap-facing mirror of {@link JoinStrategy}.
#[derive(Copy, Clone, Debug, ValueEnum)]
pub enum CliStrategy {
    Squash,
    Merge,
    Rebase,
}

impl From<CliStrategy> for JoinStrategy {
    fn from(s: CliStrategy) -> Self {
        match s {
            CliStrategy::Squash => JoinStrategy::Squash,
            CliStrategy::Merge => JoinStrategy::Merge,
            CliStrategy::Rebase => JoinStrategy::Rebase,
        }
    }
}

#[derive(Subcommand)]
pub enum PlanCommands {
    /// Check a plan document against the devise skeleton.
    ///
    /// Exit 0 clean or warnings-only, 1 on any error diagnostic, 2 when the
    /// file cannot be read or is not a plan document. The path is explicit —
    /// there is no search cascade.
    Lint {
        /// Path to the plan document.
        path: String,
    },

    /// Report what a plan's Review Record says about the content on disk now.
    ///
    /// A readout, not a gate: exit 0 whatever the verdict, 2 only when the file
    /// cannot be read or is not a plan document. The verdict rides in the
    /// `review` field — `reviewed`, `stale`, or `never-reviewed`.
    Status {
        /// Path to the plan document.
        path: String,
    },

    /// Write the plan's content stamp into its newest Review Record round.
    ///
    /// The stamp is computed, never authored: a model cannot compute SHA-256,
    /// so any hash it types is fabricated. Run this as the *last* edit of a
    /// review — anything written afterwards invalidates it. Exit 1 when there
    /// is no round to stamp or the newest round already carries one.
    Stamp {
        /// Path to the plan document.
        path: String,
    },
}

#[derive(Subcommand)]
pub enum DraftCommands {
    /// Write (or partially update) the maintained draft for an owner.
    ///
    /// A skill-authored draft is an authored draft: rows written here always
    /// carry `edited=1`, so the draft engine never clobbers them.
    ///
    /// The draft lands in the machine-global changes ledger, so any live
    /// instance serves the write identically; `--instance`/`--port` are an
    /// override, never a requirement.
    Set {
        /// Owner: `session:<id>`, `dash:<name>`, or `unattributed`.
        /// Default: the dash whose worktree holds the project, else
        /// `session:$TUG_SESSION_ID`.
        #[arg(long)]
        owner: Option<String>,
        /// Project dir (default: cwd); canonicalized on write.
        #[arg(long)]
        project: Option<PathBuf>,
        /// The draft commit message (subject, optional body).
        #[arg(long)]
        message: Option<String>,
        /// Paths elected into the landing beyond the default rule.
        #[arg(long, num_args = 1..)]
        include: Vec<String>,
        /// Paths excluded from the landing against the default rule.
        #[arg(long, num_args = 1..)]
        exclude: Vec<String>,
        /// Tugcast server port (overrides --instance and CLI discovery).
        #[arg(long)]
        port: Option<u16>,
        /// Target a specific instance by ID (resolves to its
        /// registered port via $TMPDIR/tug-instances.json).
        #[arg(long)]
        instance: Option<String>,
    },
    /// Print the maintained draft for an owner.
    Show {
        /// Owner: `session:<id>`, `dash:<name>`, or `unattributed`.
        /// Default: the dash whose worktree holds the project, else
        /// `session:$TUG_SESSION_ID`.
        #[arg(long)]
        owner: Option<String>,
        /// Project dir (default: cwd).
        #[arg(long)]
        project: Option<PathBuf>,
    },
    /// Delete the maintained draft for an owner.
    Clear {
        /// Owner: `session:<id>`, `dash:<name>`, or `unattributed`.
        /// Default: the dash whose worktree holds the project, else
        /// `session:$TUG_SESSION_ID`.
        #[arg(long)]
        owner: Option<String>,
        /// Project dir (default: cwd).
        #[arg(long)]
        project: Option<PathBuf>,
        /// Tugcast server port (overrides --instance and CLI discovery).
        #[arg(long)]
        port: Option<u16>,
        /// Target a specific instance by ID (resolves to its
        /// registered port via $TMPDIR/tug-instances.json).
        #[arg(long)]
        instance: Option<String>,
    },
}

#[derive(Subcommand)]
pub enum DashCommands {
    /// Create a new dash (branch + worktree, hydrated via the post_create hook).
    Create {
        /// Dash name (lowercase letters, digits, hyphens; 2+ chars).
        name: String,
        /// Description of the work.
        #[arg(long)]
        description: Option<String>,
        /// Plan document the dash adopts at birth: it is committed on the dash
        /// branch and the base copy is cleaned, so there is one live copy.
        #[arg(long)]
        plan: Option<String>,
        /// Move the base checkout's uncommitted work into the new worktree,
        /// leaving it uncommitted there — for when work already under way on
        /// the base turns out to belong to this dash. Content is carried, not
        /// index state: a staged edit arrives unstaged. Without this flag the
        /// base is reported and left exactly as it is.
        #[arg(long)]
        carry: bool,
        /// Branch the dash forks from and lands back onto. Defaults to the
        /// repository's default branch; name it explicitly when the checkout
        /// is parked somewhere else and the dash belongs to *that* branch.
        /// Ignored when the dash already exists — a base is set at birth.
        #[arg(long)]
        base: Option<String>,
    },
    /// Adopt a plan into an existing dash: the worktree copy becomes the only
    /// live one, with the worktree's ledger progress replayed onto it.
    AdoptPlan {
        /// Dash name.
        name: String,
        /// Plan path; required only when the dash has no plan recorded.
        #[arg(long)]
        plan: Option<String>,
    },
    /// Commit the dash worktree (if dirty) and append a dash-log line.
    ///
    /// Reads round metadata (instruction/summary) from stdin as JSON.
    Commit {
        /// Dash name.
        name: String,
        /// Git commit message (the conventional-commit subject).
        #[arg(long)]
        message: String,
    },
    /// Join a dash into its base branch, then tear down ([P14]).
    Join {
        /// Dash name.
        name: String,
        /// Custom commit message (default: the maintained draft, else the
        /// dash description).
        #[arg(long)]
        message: Option<String>,
        /// Integration strategy.
        #[arg(long, value_enum, default_value_t = CliStrategy::Squash)]
        strategy: CliStrategy,
        /// Report conflicts in-memory (git merge-tree) without touching anything.
        #[arg(long)]
        preview: bool,
        /// Resume an interrupted join's teardown from the journal.
        #[arg(long = "continue")]
        continue_join: bool,
        /// Run the conflict resolution ladder ([P31]) — replay probe, rerere,
        /// re-merge, and a structured-merge driver — then land the result.
        #[arg(long)]
        resolve: bool,
    },
    /// Move a dash's rounds onto its base branch's current tip.
    ///
    /// Replays each round in memory and, when every one is clean, moves the
    /// branch under its live worktree — refusing rather than clobbering if the
    /// worktree is dirty, a join is in flight, or a round landed meanwhile. On a
    /// branch that already descends from the base tip it makes no motion and
    /// only repairs the record, which is how an agent finishes a rebase it did
    /// by hand.
    Replay {
        /// Dash name.
        name: String,
    },
    /// Discard a dash: delete its worktree + branch without merging.
    Discard {
        /// Dash name.
        name: String,
    },
    /// Reverse the most recent join, replay, or discard.
    ///
    /// Every reversal is a compare-and-swap: it verifies the world still
    /// matches what the operation left, and refuses by name rather than forcing
    /// if anything landed since. Restores git state only — a restored dash
    /// reads as unbound until a session binds it again.
    Undo {
        /// Dash name; without one, the newest operation on any dash.
        name: Option<String>,
        /// Print the operation log and exit, changing nothing.
        #[arg(long)]
        list: bool,
    },
    /// Report the project's `[tugtool.dash]` declarations.
    ///
    /// One reader for the seam a project uses to say how its own tree is
    /// hydrated, checked, and built: `post_create`, `verify`, `build`. Takes no
    /// dash name — the declaration belongs to the project, not to one dash. A
    /// project that declares nothing (or has no config file at all) is not an
    /// error: every key reports as undeclared and the verb exits 0.
    Config,
    /// Report where this project keeps its dash paperwork — briefs and plans —
    /// or record it.
    ///
    /// The directory is the project's to choose: there is no blessed name.
    /// Undeclared is not an error; the report says so and exits 0, which is
    /// what lets an authoring skill ask once and record the answer with
    /// `--set` instead of asking on every invocation.
    DocsDir {
        /// Record the declaration (a project-root-relative directory),
        /// creating the directory if it does not exist. Without this flag the
        /// verb only reports.
        #[arg(long)]
        set: Option<String>,
    },
    /// List every active dash, derived from git.
    List,
    /// Show one dash's metadata, rounds, and worktree dirt.
    Show {
        /// Dash name.
        name: String,
    },
    /// Report one dash's lifecycle: stage, rounds, worktree dirt, draft,
    /// interrupted landing, and the sessions working on it.
    Status {
        /// Dash name.
        name: String,
    },
    /// Drive a plan's Step Status Ledger and the dash-log in one gesture.
    ///
    /// The ledger row and the log line move together, which is what lets
    /// `dash status` and the Changes card report `implementing (i/N)` without
    /// re-parsing markdown. A plan that does not strictly parse is refused,
    /// never guessed at.
    Step {
        /// Dash name.
        name: String,
        #[command(subcommand)]
        action: StepAction,
    },
    /// Declare a lifecycle stage git cannot see.
    ///
    /// One dash-log line and nothing else: `built` after a debug instance is
    /// up, `audited` after an audit finds the work in good shape.
    Mark {
        /// Dash name.
        name: String,
        /// The stage to declare.
        #[arg(value_enum)]
        stage: CliMarkStage,
        /// Free-form note recorded alongside the declaration.
        #[arg(long)]
        note: Option<String>,
    },
    /// Mate the calling session to a dash, so surfaces can say which session
    /// is working on which dash.
    Bind {
        /// Dash name.
        name: String,
        /// Project directory (default: cwd). Travels as your own spelling —
        /// the server canonicalizes it ([L29]).
        #[arg(long)]
        project: Option<std::path::PathBuf>,
    },
    /// Drop the calling session's dash binding.
    Unbind {
        /// Project directory (default: cwd).
        #[arg(long)]
        project: Option<std::path::PathBuf>,
    },
}

/// Clap-facing mirror of {@link MarkStage} — the closed declaration vocabulary.
#[derive(Copy, Clone, Debug, ValueEnum)]
pub enum CliMarkStage {
    Built,
    Audited,
}

impl From<CliMarkStage> for MarkStage {
    fn from(s: CliMarkStage) -> Self {
        match s {
            CliMarkStage::Built => MarkStage::Built,
            CliMarkStage::Audited => MarkStage::Audited,
        }
    }
}

#[derive(Subcommand)]
pub enum StepAction {
    /// Move the step's ledger row to `in progress`.
    ///
    /// Idempotent on a row already `in progress`, so an interrupted run
    /// re-enters the step it was on.
    Start {
        /// Step number, matching the ledger's `#step-<n>` anchor.
        step: u32,
        /// The plan to drive, absolute or relative to the dash worktree.
        /// Required the first time; recorded and reused after that.
        #[arg(long)]
        plan: Option<String>,
        /// The final step of this run's selection. Required: the join arc arms
        /// from it, so a run that does not say where it ends cannot be told
        /// from one that stopped early.
        #[arg(long)]
        through: Option<u32>,
    },
    /// Move the step's ledger row to `done` and record its commit.
    Done {
        /// Step number, matching the ledger's `#step-<n>` anchor.
        step: u32,
        /// Commit to record (default: the dash branch's tip).
        #[arg(long)]
        commit: Option<String>,
    },
}

#[derive(Subcommand)]
pub enum HostCommands {
    /// Initialize a tugutil project in current directory
    ///
    /// Creates .tugtool/ directory with skeleton template and config.
    /// Idempotent: safe to run multiple times (creates only missing files).
    #[command(
        long_about = "Initialize a tugutil project in current directory.\n\nCreates:\n  .tugtool/config.toml  Project configuration (dash hydration hook)\n\nIdempotent: if .tugtool/ already exists, creates only missing files without overwriting.\nWith --force, removes and recreates everything.\nWith --check, performs a lightweight verification of initialization status without side effects."
    )]
    Init {
        /// Overwrite existing .tug directory
        #[arg(long, conflicts_with = "check")]
        force: bool,

        /// Check if project is initialized (no side effects)
        #[arg(long, conflicts_with = "force")]
        check: bool,
    },

    /// Ask the human a question in the Session card and print their answer
    ///
    /// Blocks until someone answers. Use before doing something the developer
    /// will feel, so they get a say rather than a surprise.
    #[command(
        long_about = "Ask the human a question in the Session card and print their answer.\n\nRaises an inline dialog in the session named by $TUG_SESSION_ID (or the\nactive session) and blocks until it is answered. The chosen option's value\nis printed to stdout; everything else goes to stderr.\n\nExit codes:\n  0  answered — the choice is on stdout\n  2  declined, timed out, or the deck disconnected\n  3  no route to a dialog — there was nobody to ask\n\nExit 3 is deliberately distinct from a refusal: it means the question could\nnot be put, not that the answer was no. Callers decide what to do about it.\n\n--unattended turns the wait into a chance to intervene rather than a block:\nthe dialog counts --timeout-secs down in view of the developer, commits the\nselected option when it reaches zero, and exits 0 with that choice. Use it\nwhen going ahead unasked is the right thing to do at an empty keyboard.\n\nExamples:\n  tugutil host ask --title 'Run the slow tests?' \\\n      --option run:Run --option cancel:Cancel\n  tugutil host ask --title 'Take the screen?' --description '3 of 12 tests' \\\n      --option run-all:'Run all':'Includes the 3 that take the screen' \\\n      --option cancel:Cancel\n  tugutil host ask --title 'Take the screen?' --timeout-secs 30 \\\n      --unattended run-all \\\n      --option run-all:'Run them' --option skip:'Skip them'"
    )]
    Ask {
        /// The question, shown as the dialog's title
        #[arg(long)]
        title: String,

        /// Optional supporting detail shown below the title
        #[arg(long)]
        description: Option<String>,

        /// A selectable answer, as value:label[:description] (repeatable)
        #[arg(long = "option", value_name = "VALUE:LABEL[:DESC]")]
        option: Vec<String>,

        /// How long to wait for an answer before giving up
        #[arg(long, value_name = "N", default_value_t = 600)]
        timeout_secs: u64,

        /// The option value to answer with if nobody answers in time
        ///
        /// Must match one of --option's values. Turns the timeout from a
        /// refusal into an answer: the dialog counts down in view of the
        /// developer, and an unanswered question exits 0 with this value.
        #[arg(long, value_name = "VALUE")]
        unattended: Option<String>,

        /// Tugcast server port (overrides --instance and CLI discovery).
        #[arg(long)]
        port: Option<u16>,

        /// Target a specific instance by ID.
        #[arg(long, value_name = "ID")]
        instance: Option<String>,
    },

    /// Send an action to tugcast via HTTP POST
    ///
    /// Posts a JSON action to the tugcast /api/tell endpoint.
    #[command(
        long_about = "Send an action to tugcast via HTTP POST.\n\nPosts a JSON body to http://127.0.0.1:<port>/api/tell.\nThe body contains {\"action\": \"<ACTION>\", ...params}.\n\nParameters are specified with -p KEY=VALUE (repeatable).\nValues are auto-coerced: true/false -> bool, null -> null,\nintegers -> number, floats -> number, everything else -> string.\n\nExamples:\n  tugutil host tell restart\n  tugutil host tell show-card -p component=about\n  tugutil host tell toggle-lens"
    )]
    Tell {
        /// Action name (e.g., reload, show-card, toggle-lens)
        action: String,

        /// Tugcast server port (overrides --instance and CLI discovery).
        #[arg(long)]
        port: Option<u16>,

        /// Target a specific instance by ID (resolves to its
        /// registered port via $TMPDIR/tug-instances.json).
        #[arg(long, value_name = "ID")]
        instance: Option<String>,

        /// Parameters as KEY=VALUE pairs (repeatable)
        #[arg(short = 'p', long = "param", value_name = "KEY=VALUE")]
        param: Vec<String>,
    },

    /// Per-instance discovery and lifecycle management.
    ///
    /// Backed by $TMPDIR/tug-instances.json and the per-instance
    /// data dirs under ~/Library/Application Support/Tug/instances/.
    /// Subcommands: list, stop, current, remove, prune.
    #[command(subcommand)]
    Instance(InstanceCommands),

    /// Reclaim leaked runtime debris machine-wide.
    ///
    /// Every runtime resource has an owner that releases it on graceful
    /// shutdown, but the routine ending for an app-test instance is
    /// SIGKILL, which skips every owner epilogue — and since each launch
    /// mints a unique name, a leak never collides with a future run, so
    /// nothing ever notices it. One audited machine had accumulated
    /// 9,833 dead control sockets, 726 MB of orphaned data dirs, and a
    /// tmux server idling for 20 hours.
    #[command(
        long_about = "Reclaim leaked runtime debris machine-wide.\n\nSweeps, in order: dead control/notify sockets, orphaned app-test tmux\nservers, aged $TMPDIR test litter, finished app-test data dirs,\ntugcode/claude processes reparented to launchd, and finally the\nbundle-missing data dirs `instance prune` owns.\n\nNothing is deleted by name pattern alone. Sockets must fail a connect\nprobe AND not belong to a live registered instance; tmux servers and\ndata dirs must have no live registry entry; and every registry-gated\ndeletion also has a minimum-age floor, because a booting instance is\ninvisible to the registry until after its port bind.\n\nWithout --yes the report is printed and confirmed once. With --json the\nreport is emitted and nothing is removed."
    )]
    Sweep {
        /// Sweep without confirming.
        #[arg(long)]
        yes: bool,

        /// Emit the report as JSON without removing anything.
        #[arg(long)]
        json: bool,

        /// Report what would be swept and stop. Never prompts.
        #[arg(long, conflicts_with = "yes")]
        dry_run: bool,

        /// Print section counts only, not every item.
        #[arg(long)]
        quiet: bool,
    },

    /// Machine-wide mutual exclusion via a localhost port bind.
    ///
    /// Holding a listener on the gate's reserved port is the mutex;
    /// the kernel frees it on any holder death — no lock file.
    /// Used to serialize whole `just app-test` invocations.
    #[command(subcommand)]
    Gate(GateCommands),

    /// Print the per-project runtime-state directory
    ///
    /// Resolves the out-of-repo directory for per-user runtime state.
    #[command(
        long_about = "Print the per-project runtime-state directory.\n\nResolves <data_dir>/Tug/projects/<slug>/ for the current repository — the\nout-of-repo home for per-user runtime state (the dash-log, the code-sign\nsentinel, future side-command output). Creates the directory if absent, so\nshell consumers (the Justfile, the host) can write into it without re-deriving\nthe path."
    )]
    StateDir,

    /// Dump the live changeset aggregate (observability).
    ///
    /// GETs http://127.0.0.1:<port>/api/changesets — the same compose the
    /// Changes view reads, freshly recomputed over every open project. Plain
    /// output is one line per project with dirty/unattributed/changeset counts;
    /// --json emits the full snapshot. Ground truth for diagnosing a stale or
    /// empty Changes view against the actual working-tree scan.
    Changesets {
        /// Tugcast server port (overrides --instance and CLI discovery).
        #[arg(long)]
        port: Option<u16>,

        /// Target a specific instance by ID.
        #[arg(long, value_name = "ID")]
        instance: Option<String>,
    },
}

/// Get the command args for use in the application
pub fn parse() -> Cli {
    Cli::parse()
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn verify_cli() {
        // `debug_assert` is clap's own structural validator — catches
        // overlapping flag names, missing subcommand attrs, malformed
        // arg derives.
        Cli::command().debug_assert();
    }
}
