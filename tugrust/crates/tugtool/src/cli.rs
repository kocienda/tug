//! CLI argument parsing for the unified `tugtool` binary.
//!
//! One command tree over three surfaces: the top-level git verbs
//! (`changes`/`preflight`/`commit`/`log`/`diff`/`draft`, backed by
//! `tugchanges_core`), the `arc` namespace (worktree work units, backed by
//! `tugarc_core`), and the `host` namespace (instance/gate/state-dir/tell/init
//! plumbing).

use std::path::PathBuf;

use clap::{Parser, Subcommand, ValueEnum};

use tugarc_core::{JoinStrategy, MarkStage};

use crate::commands::{GateCommands, InstanceCommands};

/// `tugtool file` — the git-aware file lifecycle verbs. Each mutating verb
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
    /// attributed. Either an edit program — a multi-line, multi-file edit that
    /// resolves every address against original bytes before writing anything —
    /// or a unified diff (`--patch`).
    Edit {
        /// Show the diff the edit would produce and write nothing.
        #[arg(long)]
        preview: bool,
        /// Unified diff to apply (`-` for stdin). Multi-file diffs are fine.
        #[arg(long, conflicts_with = "file")]
        patch: Option<String>,
        /// The edit program to run (default: stdin, or `-`).
        file: Option<String>,
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
    /// Run a command that rewrites files in place and receipt exactly what it
    /// moved — the attributable form of `cargo fmt`, `rustfmt`, `prettier
    /// --write`, `eslint --fix`, and any codegen step whose write targets are
    /// not in the command text. The inverse of `probe`, which restores.
    Run {
        /// Limit the watched universe to these paths (default: the whole repo).
        #[arg(long = "scope")]
        scopes: Vec<String>,
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

/// tugtool — the unified Tug developer CLI.
#[derive(Parser)]
#[command(name = "tugtool")]
#[command(version = VERSION)]
#[command(about = "tugtool — changes & commits, arcs, and host plumbing")]
#[command(
    long_about = "tugtool — the unified Tug developer CLI.\n\nTop-level verbs own this session's git surface: changes (which files this\nsession changed), preflight (the one-shot readout a landing starts from),\ncommit (stage → commit → structured receipt), draft (the maintained landing\ndraft), log, and diff. `tugtool arc …` drives worktree-isolated work units;\n`tugtool host …` is instance/project plumbing (instance, gate, state-dir,\ntell, init)."
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
    /// text still says `tugtool context`.)
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

    /// Worktree-isolated units of work — an arc, of either kind.
    #[command(subcommand)]
    Arc(ArcCommands),

    /// Plan documents — mechanical conformance against the devise skeleton.
    #[command(subcommand)]
    Plan(PlanCommands),

    /// Briefs — the working paper a conversation settles into.
    #[command(subcommand)]
    Brief(BriefCommands),

    /// Instance discovery, the build gate, project state, and the tell bridge.
    #[command(subcommand)]
    Host(HostCommands),

    /// The running deck — ask the page about itself.
    #[command(subcommand)]
    Deck(DeckCommands),

    /// The app-test results ledger — what every run leaves behind, and what
    /// a red file's history says about it.
    #[command(subcommand)]
    Apptest(ApptestCommands),

    /// The unit-test results ledger — every recorded suite run, and the
    /// failures the last one named.
    #[command(subcommand)]
    Test(TestCommands),

    /// Tell the block this command runs under how far it has got.
    ///
    /// Silent and always exits 0: a report that cannot be delivered changes
    /// nothing about the command reporting it, and with no calling session
    /// nothing is sent at all.
    Progress {
        /// The run's short name (`rust`, `app-test`).
        #[arg(long)]
        label: Option<String>,
        /// Units finished so far.
        #[arg(long)]
        done: Option<u64>,
        /// Units the run will finish in all.
        #[arg(long)]
        total: Option<u64>,
        /// Failures so far.
        #[arg(long)]
        failures: Option<u64>,
        /// Text the running command contains, for matching the report to it
        /// when the session has several calls open.
        #[arg(long = "needle")]
        needles: Vec<String>,
        /// The progress line.
        text: String,
    },

    /// This card's claude session — ask the wheel to seat a fresh one.
    #[command(subcommand)]
    Session(SessionCommands),

    /// The plugin's Claude Code hooks — payload in on stdin, decision out.
    #[command(subcommand)]
    Hook(crate::commands::HookCommands),
}

#[derive(Subcommand)]
pub enum SessionCommands {
    /// Rotate this card onto a fresh claude session, at this turn's end.
    ///
    /// The rotation is recorded and this returns; the card rotates when the
    /// turn you are in ends. It cannot happen sooner: a rotation retires the
    /// claude session it runs on, so performing one now would kill the model
    /// that asked for it. Run outside a turn, it lands at the end of the
    /// session's next one.
    ///
    /// The card, its transcript, its durable ink, and its callsign all stay
    /// where they are — a rotation seats a new session under the same card. The
    /// retiring session's context does not carry across; that is `/compact`'s
    /// job, not this one's.
    ///
    /// With `--model` omitted, a `--stage` of `devise`, `review`, or
    /// `implement` resolves the model the project declared for that stage in
    /// `[tugtool.arc]`; any other label means the account default. A rotation
    /// onto a named model hands the card back to your own model one turn later.
    Rotate {
        /// What the fresh session opens on. Required unless `--cancel`.
        #[arg(long)]
        prompt: Option<String>,
        /// The stage label the transcript's divider renders (default: `rotate`).
        #[arg(long)]
        stage: Option<String>,
        /// The model selector to seat the fresh session on.
        #[arg(long)]
        model: Option<String>,
        /// The reasoning effort to seat it at.
        #[arg(long)]
        effort: Option<String>,
        /// Project dir (default: cwd) — where the stage models are declared.
        #[arg(long)]
        project: Option<PathBuf>,
        /// Withdraw this session's pending rotation. Takes no other flags.
        #[arg(long)]
        cancel: bool,
    },

    /// Say where a session reference points, on this machine.
    ///
    /// A reference is a session uuid, its 8-character short id, a callsign
    /// (`curly-apple`), or `<project>/<callsign>`. The answer is one line:
    /// `here` for a session this app instance holds, `elsewhere` for one
    /// another instance on this machine holds (or one whose transcript is
    /// simply on disk), and `absent` for a reference nothing here answers
    /// to — which most often means it was minted on another machine.
    ///
    /// Exits 0 for here and elsewhere, 3 for absent, 1 for an error.
    Find {
        /// The reference to place.
        reference: String,
    },

    /// Print a session's transcript as markdown — the model's way to read
    /// a session other than the one it is running in.
    ///
    /// Read-only in every sense: it opens nothing for writing, resumes
    /// nothing, and works the same for a session this instance holds and
    /// one it does not. Exits 3 when the reference is absent.
    Show {
        /// The reference to read, in `find`'s grammar.
        reference: String,
        /// Keep only the last N turns.
        #[arg(long)]
        last: Option<usize>,
        /// Keep turn K alone (1-based, numbered over the whole transcript).
        #[arg(long)]
        turn: Option<usize>,
        /// Keep turns containing this text (case-insensitive substring).
        #[arg(long)]
        grep: Option<String>,
    },

    /// Write one machine-wide session-index row. Fixtures only.
    ///
    /// Hidden because it is not a verb anybody should reach for: tugcast
    /// owns the index, and this exists so a test can seed a row that looks
    /// like another instance's. It writes and reads nothing back.
    #[command(hide = true)]
    IndexPut {
        #[arg(long)]
        uuid: String,
        #[arg(long)]
        callsign: Option<String>,
        #[arg(long)]
        project_dir: String,
        #[arg(long)]
        instance: Option<String>,
        #[arg(long)]
        title: Option<String>,
    },
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
    /// and `WEDGED` rows are excluded — a file the runner skipped, or killed
    /// at its cap because the app stopped answering, says nothing about
    /// whether it works.
    History {
        /// The root the run executed in (default: cwd). Resolved to its base
        /// checkout, so an arc worktree and its checkout share one history.
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
    /// Record or read which functions each test file executed.
    ///
    /// One map per test file per base checkout, written by an instrumented
    /// app-test run and read by the selector to rank candidates.
    Reach {
        #[command(subcommand)]
        command: ReachCommands,
    },
}

#[derive(Subcommand)]
pub enum ReachCommands {
    /// Store each file's map, read as JSON on stdin; a later record for the
    /// same file replaces the earlier one.
    Record,
    /// Print the stored map for each named file that has one.
    Show {
        /// The root the run executed in (default: cwd). Resolved to its base
        /// checkout, so an arc worktree and its checkout share one map.
        #[arg(long)]
        root: Option<PathBuf>,
        /// Test files to answer for, as the report names them.
        #[arg(required = true, num_args = 1..)]
        files: Vec<String>,
    },
}

#[derive(Subcommand)]
pub enum TestCommands {
    /// Record one suite run from its junit document.
    ///
    /// The run is keyed under the project root of `--root` (default: cwd) and
    /// that root's base checkout, so a run recorded from a subdirectory or an
    /// arc worktree answers a read made at the checkout's root. A document
    /// that is missing or unreadable still records the run, marked as having
    /// no per-test record.
    Record {
        /// The suite's name, e.g. `tugdeck` or `rust`.
        #[arg(long)]
        suite: String,
        /// The junit document the run wrote.
        #[arg(long)]
        junit: PathBuf,
        /// Where the run happened (default: cwd).
        #[arg(long)]
        root: Option<PathBuf>,
        /// The command's exit status (default: 0).
        #[arg(long, default_value_t = 0)]
        exit_code: i64,
        /// When the run started, in epoch seconds (default: now).
        #[arg(long)]
        started_at: Option<i64>,
        /// The command that ran, as text.
        #[arg(long)]
        command: Option<String>,
    },
    /// Run a test command, copying its output through, and record the run.
    ///
    /// The command's stdout and stderr pass through as they arrive and its
    /// exit status is this verb's. Progress is followed from stderr, and at
    /// exit the run's junit document is recorded, so `test last --failures`
    /// names a red run's failures whatever happened to its output.
    Run {
        /// The suite's name in the ledger, e.g. `tugdeck` or `rust`.
        #[arg(long)]
        suite: String,
        /// Which runner the command is.
        #[arg(long, value_enum)]
        kind: crate::test_run::RunKind,
        /// The junit document the command writes (required for nextest; bun
        /// is pointed at a temporary one).
        #[arg(long)]
        junit: Option<PathBuf>,
        /// The label progress is shown under.
        #[arg(long)]
        label: Option<String>,
        /// Text the running command contains, for matching progress to it.
        #[arg(long = "needle")]
        needles: Vec<String>,
        /// The command to run.
        #[arg(last = true, required = true, allow_hyphen_values = true)]
        command: Vec<String>,
    },
    /// The latest recorded run of each suite, and the failures it named.
    ///
    /// Always exits 0: it is a reader, and "nothing recorded" is an answer.
    Last {
        /// Print only the failing tests, across suites.
        #[arg(long)]
        failures: bool,
        /// Only this suite.
        #[arg(long)]
        suite: Option<String>,
        /// The checkout to read for (default: cwd), resolved the same way a
        /// run's root is.
        #[arg(long)]
        root: Option<PathBuf>,
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
pub enum BriefCommands {
    /// Print the directory a brief is written to.
    ///
    /// The project's own `briefs/` unless the Briefs Directory setting names
    /// another; a setting that cannot be read is a default, never a refusal.
    Dir {
        /// Create the directory if it does not exist.
        #[arg(long)]
        ensure: bool,
    },
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
        /// Owner: `session` (the calling session, resolved to its
        /// live segment), `session:<id>`, `arc:<name>`, or `unattributed`.
        /// Default: the arc whose worktree holds the project, else the
        /// calling session.
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
        /// Owner: `session` (the calling session, resolved to its
        /// live segment), `session:<id>`, `arc:<name>`, or `unattributed`.
        /// Default: the arc whose worktree holds the project, else the
        /// calling session.
        #[arg(long)]
        owner: Option<String>,
        /// Project dir (default: cwd).
        #[arg(long)]
        project: Option<PathBuf>,
    },
    /// Delete the maintained draft for an owner.
    Clear {
        /// Owner: `session` (the calling session, resolved to its
        /// live segment), `session:<id>`, `arc:<name>`, or `unattributed`.
        /// Default: the arc whose worktree holds the project, else the
        /// calling session.
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
pub enum ArcCommands {
    /// Create a new arc (branch + worktree, hydrated via the post_create hook).
    Create {
        /// Arc name (lowercase letters, digits, hyphens; 2+ chars).
        name: String,
        /// Description of the work.
        #[arg(long)]
        description: Option<String>,
        /// Move the base checkout's uncommitted work into the new worktree,
        /// leaving it uncommitted there — for when work already under way on
        /// the base turns out to belong to this arc. Content is carried, not
        /// index state: a staged edit arrives unstaged. Without this flag the
        /// base is reported and left exactly as it is.
        #[arg(long)]
        carry: bool,
        /// Branch the arc forks from and lands back onto. Defaults to the
        /// repository's default branch; name it explicitly when the checkout
        /// is parked somewhere else and the arc belongs to *that* branch.
        /// Ignored when the arc already exists — a base is set at birth.
        #[arg(long)]
        base: Option<String>,
    },
    /// Commit the arc's worktree (if dirty) and append an arc log line.
    ///
    /// Reads round metadata (instruction/summary) from stdin as JSON.
    Commit {
        /// Arc name.
        name: String,
        /// Git commit message (the conventional-commit subject).
        #[arg(long)]
        message: String,
    },
    /// Join an arc into its base branch, then tear down ([P14]).
    Join {
        /// Arc name.
        name: String,
        /// Custom commit message (default: the maintained draft, else the
        /// arc's description).
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
        /// Proceed although the arc's conflict chain says a resolve may still
        /// be running, tearing down whatever it had reached. The op log keeps
        /// the resolver's checkpoints; `tugtool arc undo` restores them.
        #[arg(long = "break-lease")]
        break_lease: bool,
    },
    /// Move an arc's rounds onto its base branch's current tip.
    ///
    /// Replays each round in memory and, when every one is clean, moves the
    /// branch under its live worktree — refusing rather than clobbering if the
    /// worktree is dirty, a join is in flight, or a round landed meanwhile. On a
    /// branch that already descends from the base tip it makes no motion and
    /// only repairs the record, which is how an agent finishes a rebase it did
    /// by hand.
    Replay {
        /// Arc name.
        name: String,
    },
    /// Clear the base-side work that is blocking this arc's join.
    ///
    /// Base copies the arc already carries byte for byte are dropped —
    /// nothing is lost, because those bytes are on the arc's branch. The user's
    /// own divergent edits are committed onto the base as one commit of their
    /// own, so a collision with the arc's work becomes an ordinary join
    /// conflict and reaches the resolution ladder. An edit another live session
    /// holds is refused by name and nothing moves.
    ///
    /// It clears the block and stops; joining stays a separate gesture.
    /// `tugtool arc undo` reverses the commit and leaves the same content
    /// uncommitted.
    ResolveBase {
        /// Arc name.
        name: String,
    },
    /// Verify the fit: check the tree a join would land against the surfaces
    /// this project declares.
    ///
    /// Resolves every path the arc would land to the surface claiming the
    /// longest matching prefix, refuses — naming the paths, before running a
    /// single check — when one resolves to no surface, then runs what the
    /// matched surfaces declare from the worktree root. A green run records
    /// the head it verified and the base it verified onto; it gates nothing.
    Verify {
        /// Arc name.
        name: String,
        /// Verify from this commit instead of `merge-base(<base>, <branch>)`.
        #[arg(long)]
        base: Option<String>,
        /// Verify up to this commit instead of the arc branch's tip.
        #[arg(long)]
        head: Option<String>,
    },
    /// Discard an arc: delete its worktree + branch without merging.
    Discard {
        /// Arc name.
        name: String,
        /// Proceed although the arc's conflict chain says a resolve may still
        /// be running, tearing down whatever it had reached. The op log keeps
        /// the resolver's checkpoints; `tugtool arc undo` restores them.
        #[arg(long = "break-lease")]
        break_lease: bool,
    },
    /// Delete an arc's documents — `.tug/arcs/<name>/` — and nothing else.
    ///
    /// Not a discard: this touches no branch, no worktree, and no arc-log
    /// record. It is the verb for the paperwork a discard deliberately keeps
    /// ([P11]) and for a door abandoned before it cut a branch — the cases
    /// `arc discard` refuses, because it is about an arc's git state and those
    /// names have none.
    ///
    /// **The delete is permanent.** `.tug/` is excluded from git, so the brief
    /// is in no commit and no reflog: nothing gives it back. An arc that still
    /// has a branch or a worktree is refused by name.
    DeleteDocuments {
        /// Arc name.
        name: String,
    },
    /// Reverse the most recent join, replay, or discard.
    ///
    /// Every reversal is a compare-and-swap: it verifies the world still
    /// matches what the operation left, and refuses by name rather than forcing
    /// if anything landed since. Restores git state only — a restored arc
    /// reads as unbound until a session binds it again.
    Undo {
        /// Arc name; without one, the newest operation on any arc.
        name: Option<String>,
        /// Print the operation log and exit, changing nothing.
        #[arg(long)]
        list: bool,
    },
    /// Re-apply the operation the most recent undo reversed.
    ///
    /// Undo's partner, with the same compare-and-swap discipline: it verifies
    /// the world still matches what the undo left and refuses by name —
    /// `nothing-to-redo`, `superseded`, `tip-moved`, `worktree-dirty` — rather
    /// than forcing. Redoing an undo makes the original undoable again, so
    /// `undo, redo, undo` toggles one operation instead of descending through
    /// bookkeeping records.
    Redo {
        /// Arc name; without one, the newest undo on any arc.
        name: Option<String>,
        /// Print the operation log and exit, changing nothing.
        #[arg(long)]
        list: bool,
    },
    /// Report the project's `[tugtool.arc]` declarations.
    ///
    /// One reader for the seam a project uses to say how its own tree is
    /// hydrated, checked, and built: `post_create`, `verify`, `build`. Takes no
    /// arc name — the declaration belongs to the project, not to one arc. A
    /// project that declares nothing (or has no config file at all) is not an
    /// error: every key reports as undeclared and the verb exits 0.
    Config,
    /// List every active arc, derived from git.
    List,
    /// Show one arc's metadata, rounds, and worktree dirt.
    Show {
        /// Arc name.
        name: String,
    },
    /// Report one arc's lifecycle: stage, rounds, worktree dirt, draft,
    /// interrupted landing, and the sessions working on it.
    Status {
        /// Arc name.
        name: String,
    },
    /// Compare the five records an arc keeps and name every disagreement.
    ///
    /// An arc records itself five ways — the plan's Step Status Ledger, the
    /// arc log's declarations, the sqlite session binding, the arc record,
    /// and the seat its branch and worktree make — and no two are written by
    /// the same act. The split that
    /// matters: **status and join-arming derive from the log, while the arc's
    /// resume pointer and the changeset feed's closed count derive from the
    /// table.** So a hand-edited table does not desync a display from the
    /// truth; it desyncs where a run will resume from whether it may be
    /// landed.
    ///
    /// Detection is free and always safe — its read-only core also runs
    /// inside `arc status`. Repair is opt-in. A log repair is always an
    /// *append*, never a rewrite: the log is append-only, and the table is
    /// the authored document, so a reconcilable disagreement is fixed by
    /// catching the log up to the table. The seat's repair is the only other
    /// one, and it makes the branch and worktree where doing so cannot lose
    /// a round. Disagreements that need a judgment are named and left.
    ///
    /// Exit 0 when the records agree, 1 when they do not.
    Doctor {
        /// Arc name.
        name: String,
        /// Append the reconciling arc log lines the findings offer.
        #[arg(long)]
        repair: bool,
    },
    /// Drive a plan's Step Status Ledger and the arc log in one gesture.
    ///
    /// The ledger row and the log line move together, which is what lets
    /// `arc status` and the Changes card report `implementing (i/N)` without
    /// re-parsing markdown. A plan that does not strictly parse is refused,
    /// never guessed at.
    Step {
        /// Arc name.
        name: String,
        #[command(subcommand)]
        action: StepAction,
    },
    /// Declare a lifecycle stage git cannot see.
    ///
    /// One arc log line and nothing else: `built` after a debug instance is
    /// up, `audited` after an audit finds the work in good shape.
    Mark {
        /// Arc name.
        name: String,
        /// The stage to declare.
        #[arg(value_enum)]
        stage: CliMarkStage,
        /// Free-form note recorded alongside the declaration.
        #[arg(long)]
        note: Option<String>,
    },
    /// Hand this arc's documents to the wheel: record that its
    /// work runs as rotating devise / review / implement stages on the calling
    /// card.
    ///
    /// Opens on the arc's brief, or on its plan when only that exists. An arc
    /// that stopped is resumed instead — the documents hold the progress,
    /// so a resume re-runs the stopped stage and never restarts from the top.
    ///
    /// The kind is read off those same documents and recorded once: a task
    /// list beside the brief opens a plain arc at implement, and a brief
    /// alone or a plan opens a planned one at devise. There is no flag,
    /// because the documents already say which shape the door settled on.
    ///
    /// The arc runs *on a card*, so the verb refuses without a calling
    /// session: there would be nowhere for a stage to rotate.
    Run {
        /// Arc name — its key, valid before any branch exists.
        name: String,
        /// Project directory (default: cwd). Travels as your own spelling —
        /// the server canonicalizes it ([L29]).
        #[arg(long)]
        project: Option<std::path::PathBuf>,
        /// Calling session (default: $TUG_SESSION_ID). Resolved to its
        /// line's live segment either way — a typed id goes stale the same
        /// way an inherited one does.
        #[arg(long)]
        session: Option<String>,
    },
    /// Report where an arc's documents live and which of them exist.
    ///
    /// An arc with no documents directory is a state, not an error: the verb
    /// exits 0 and says every one is absent. `--ensure` creates the directory
    /// (and keeps `.tug/` out of git), so a skill can write into it after one
    /// call. The three addresses are the brief, the devised plan, and the
    /// `/arc` door's task list.
    Documents {
        /// Arc name.
        name: String,
        /// Create the documents directory if it does not exist.
        #[arg(long)]
        ensure: bool,
        /// After ensuring the directory, bind the calling session to the arc —
        /// the door's first act, so the arc reads as running from its first
        /// keystroke rather than from its last command. Requires `--ensure`.
        #[arg(long, requires = "ensure")]
        bind: bool,
    },
    /// Report one arc's record — document, plan, kind, owner, stages, stopped
    /// reason, done.
    ///
    /// An arc with no record is a state, not an error: the verb exits 0 and
    /// says so, which is every arc created by hand.
    Record {
        /// Arc name.
        name: String,
        /// Project directory (default: cwd).
        #[arg(long)]
        project: Option<std::path::PathBuf>,
    },
    /// Mate the calling session to an arc, so surfaces can say which session
    /// is working on which arc.
    Bind {
        /// Arc name.
        name: String,
        /// Project directory (default: cwd). Travels as your own spelling —
        /// the server canonicalizes it ([L29]).
        #[arg(long)]
        project: Option<std::path::PathBuf>,
        /// Calling session (default: $TUG_SESSION_ID), resolved to its
        /// line's live segment.
        #[arg(long)]
        session: Option<String>,
        /// Print the segment this bind would land on and its ledger state,
        /// and write nothing.
        ///
        /// The question a session asks before binding is "which session am I,
        /// really" — the id in its environment was frozen at spawn and the
        /// Wheel rotates on purpose. Answering it by binding and reading the
        /// receipt makes a write out of a read.
        #[arg(long)]
        dry_run: bool,
    },
    /// Stop the arc, keep its branch and worktree.
    ///
    /// Deliberately not a `pause`: a stopped arc is already resumable with
    /// `tugtool arc run <name>`, so a second word for the same record would
    /// be a lie about the record. Before this verb existed the only way to
    /// reach a stopped-and-resumable arc was to make something fail.
    Stop {
        /// Arc name.
        name: String,
        /// Project directory (default: cwd). Travels as your own spelling —
        /// the server canonicalizes it ([L29]).
        #[arg(long)]
        project: Option<std::path::PathBuf>,
        /// Calling session (default: $TUG_SESSION_ID), resolved to its
        /// line's live segment.
        #[arg(long)]
        session: Option<String>,
    },
    /// Stop the arc because the stage met a decision that is the user's.
    ///
    /// The gesture that replaced a mid-arc `AskUserQuestion`. A stage
    /// running under the wheel has no user in front of it — the run is meant
    /// to walk unattended, and a stage parked on a dialog is a run that has
    /// stopped without saying so: no record, no receipt, no resume, and the
    /// question lost the moment the card rotates. So the stage stops instead,
    /// and the question it stopped over becomes the arc's last note and the
    /// tail of the receipt on the card.
    ///
    /// `tugtool arc run <name>` picks the work back up once it is answered,
    /// exactly as it does after any other stop.
    Ask {
        /// Arc name.
        name: String,
        /// The decision, in one sentence, in the stage's own words. It is the
        /// whole of what the user has to go on, so it names the choice rather
        /// than the fact that a choice exists.
        question: String,
        /// Project directory (default: cwd). Travels as your own spelling —
        /// the server canonicalizes it ([L29]).
        #[arg(long)]
        project: Option<std::path::PathBuf>,
        /// Calling session (default: $TUG_SESSION_ID), resolved to its
        /// line's live segment.
        #[arg(long)]
        session: Option<String>,
    },
    /// Drop the calling session's arc binding.
    Unbind {
        /// Project directory (default: cwd).
        #[arg(long)]
        project: Option<std::path::PathBuf>,
        /// Calling session (default: $TUG_SESSION_ID), resolved to its
        /// line's live segment.
        #[arg(long)]
        session: Option<String>,
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
        /// The final step of this run's selection. Required: the join arms
        /// from it, so a run that does not say where it ends cannot be told
        /// from one that stopped early.
        #[arg(long)]
        through: Option<u32>,
    },
    /// Move the step's ledger row to `done` and record its commit.
    Done {
        /// Step number, matching the ledger's `#step-<n>` anchor.
        step: u32,
        /// Commit to record (default: the arc branch's tip).
        #[arg(long)]
        commit: Option<String>,
    },
    /// Move the step's ledger row to `withdrawn`: a step the run decided not
    /// to walk.
    ///
    /// Records no commit, because none was made. It closes the step and
    /// counts toward the run's completion exactly as a `done` does, so
    /// withdrawing the run's final declared step arms the join. Reversible:
    /// `start` re-opens a withdrawn row.
    Withdraw {
        /// Step number, matching the ledger's `#step-<n>` anchor.
        step: u32,
    },
    /// Park a step: the ledger row goes back to `pending` and its commit cell
    /// is cleared.
    ///
    /// The gesture for "we opened this and are putting it down", which
    /// `withdraw` does not mean — a withdrawal closes the step, advances the
    /// run, and can arm the join. A park claims nothing about the step and
    /// leaves the run where it was. Refused on a `done` row; that is `reopen`.
    Reset {
        /// Step number, matching the ledger's `#step-<n>` anchor.
        step: u32,
        /// Why the step is being parked. Recorded in the arc log line.
        #[arg(long)]
        why: Option<String>,
    },
    /// Reopen a finished step: `done` back to `in progress`, commit kept.
    ///
    /// For work an audit rejected. The arc log line un-arms the join until
    /// the step closes again, so an arc with rejected work in it cannot be
    /// offered for landing while the re-walk is outstanding.
    Reopen {
        /// Step number, matching the ledger's `#step-<n>` anchor.
        step: u32,
        /// Why the step is being reopened — what the re-walk is answering.
        /// Required: a reopen with no reason is the hand-edit this verb
        /// exists to replace, wearing a verb's clothes.
        #[arg(long)]
        why: String,
    },
}

/// The running deck. One family so far: what is moving, and what it costs.
#[derive(Subcommand)]
pub enum DeckCommands {
    /// Read and steer the deck's motion — census, render cost, bisect.
    #[command(subcommand)]
    Motion(DeckMotionCommands),
}

/// `tugtool deck motion …` — every reading rides `POST /api/eval` and the
/// `window.__tugMotion` handle the deck binds in every build.
///
/// The verb exists because the shipping app keeps the Web Inspector off in
/// every build by decision, so the one build a user actually runs is the one
/// nobody can ask what is ticking. `enable` and `disable` are the door: they
/// set and clear the per-instance `diag/eval` opt-in that the eval handler
/// gates on. Everything else is loopback-only, and reads a page that is
/// measuring itself with public platform API.
#[derive(Subcommand)]
pub enum DeckMotionCommands {
    /// Every long-running animation: name, target, properties, violations.
    List {
        /// Census only animations inside this CSS selector.
        #[arg(long)]
        within: Option<String>,
        #[command(flatten)]
        target: DeckTarget,
    },
    /// Measure the frame's style-layout-compositing cost, now.
    Cost {
        /// How many frames to sample.
        #[arg(long, default_value_t = 30)]
        frames: u32,
        #[command(flatten)]
        target: DeckTarget,
    },
    /// Count the rendering updates per second that hold the main thread at rest.
    Rest {
        /// How long to watch, in milliseconds.
        #[arg(long)]
        window: Option<u32>,
        #[command(flatten)]
        target: DeckTarget,
    },
    /// The element population the compositing walk pays for.
    Layers {
        #[command(flatten)]
        target: DeckTarget,
    },
    /// Pause every animation whose target matches a selector.
    Pause {
        /// CSS selector. Matched against each animation's target and its ancestors.
        selector: String,
        #[command(flatten)]
        target: DeckTarget,
    },
    /// Resume them.
    Resume {
        /// CSS selector. Matched against each animation's target and its ancestors.
        selector: String,
        #[command(flatten)]
        target: DeckTarget,
    },
    /// Pause each loop group in turn and report whose absence is felt.
    Bisect {
        /// Frames per group.
        #[arg(long)]
        frames: Option<u32>,
        /// Read at most this many groups.
        #[arg(long)]
        cap: Option<u32>,
        #[command(flatten)]
        target: DeckTarget,
    },
    /// Input-to-next-paint, where the engine reports it.
    Input {
        #[command(flatten)]
        target: DeckTarget,
    },
    /// What the render-cost probe is doing right now.
    Probe {
        #[command(flatten)]
        target: DeckTarget,
    },
    /// Still every long-running loop, or let them run again.
    Demote {
        /// `on` or `off`.
        #[arg(value_parser = ["on", "off"])]
        state: String,
        #[command(flatten)]
        target: DeckTarget,
    },
    /// The read→write→read chains under a gesture, by call site.
    ///
    /// `arm` before the gesture, `read` after it, `disarm` to put the wrapped
    /// descriptors back. An armed probe captures a stack per geometry read, so
    /// it is armed around the gesture under study rather than left on.
    Chains {
        /// `arm`, `read` or `disarm`.
        #[arg(long, value_parser = ["arm", "read", "disarm"])]
        mode: String,
        /// Arm without the per-read stack capture, so the reading's ms do not
        /// carry the probe's own price. Chains still count; their site reads
        /// `<no stack>`. Only `arm` takes it.
        #[arg(long)]
        no_stacks: bool,
        #[command(flatten)]
        target: DeckTarget,
    },
    /// The frames a gesture actually delivered, recorded from outside it.
    ///
    /// `arm` BEFORE the gesture — that is the whole point, and what separates
    /// this from the deck's own `settle-frames` record, which opens when the
    /// canvas arms and so cannot contain the gesture's own preamble. Then
    /// perform the gesture, `read`, and `disarm`. The chain stops itself after
    /// `--window` so a forgotten `read` cannot leave a loop running at rest.
    Gesture {
        /// `arm`, `read` or `disarm`.
        #[arg(long, value_parser = ["arm", "read", "disarm"])]
        mode: String,
        /// How long an armed chain runs before stopping itself, in ms.
        #[arg(long)]
        window: Option<u32>,
        #[command(flatten)]
        target: DeckTarget,
    },
    /// Drive the flow slide and read what it delivered.
    ///
    /// Clicks a session row in the Cards card `--count` times in each
    /// direction between `--from` and `--to`, and reports per click and in
    /// aggregate: frames in the first 200 ms, the first frame's offset, the
    /// early gaps, every long frame with its time, main-thread blocking in the
    /// click's first 260 ms, and the settle mark's on and off times — beside a
    /// census of the deck, without which no two readings compare.
    Slide {
        /// The session row the slide starts from: its title, exact or else a
        /// unique substring, case-insensitive.
        #[arg(long)]
        from: String,
        /// The session row the slide goes to, matched the same way.
        #[arg(long)]
        to: String,
        /// Clicks in each direction.
        #[arg(long, default_value_t = 8)]
        count: u32,
        /// Also run `/usr/bin/sample` at 1 ms on the Tug host and its WebKit
        /// WebContent and GPU processes across the clicks, and report each
        /// busy thread's phases and heaviest frames.
        #[arg(long)]
        sample: bool,
        /// Also record every selector query the deck makes in each click's
        /// window — `querySelector`, `querySelectorAll`, `closest`, `matches` —
        /// and report each selector's calls, time, and caller.
        #[arg(long)]
        queries: bool,
        /// Also attribute the click's lead from inside the page: every timer,
        /// frame callback, microtask, promise reaction, port message and
        /// observer callback that ran, how long, and what queued it — and
        /// every React commit, by the components that asked for it, with its
        /// React time, its span from the previous commit, its passive-effect
        /// time, and the store changes or flushSyncs that caused it; and how
        /// many commits ran in the click's own task. The
        /// recorder has to be in the page before the deck's bundle loads, so
        /// the first run on a page reloads the deck to install it.
        #[arg(long)]
        tasks: bool,
        #[command(flatten)]
        target: DeckTarget,
    },
    /// Drive one settle gesture and name every React commit in its window.
    ///
    /// Drives the gesture through the deck's own gesture door,
    /// `window.tugdeck.lab.drive`, and reports every commit between the
    /// settle mark going on and off, 60 ms either side: its React time, the
    /// fibers it performed and mounted, the components that asked for it, the
    /// store changes that caused it, and why each pane-chrome component
    /// rendered — beside a census of the deck and an at-rest check. A deck
    /// that is not at rest is reported and not read.
    ///
    /// `--count` repeats the gesture, undoing it in between: `fold`/`unfold`
    /// alternate, `split` alternates the mode, `switch` and `flip` go back to
    /// where the deck stood, `rails` hides before each show it reads (so start
    /// with the rails showing), and a pane closes once. `slot` sends the card
    /// to `--slot` and back to the slot it stood in; `go` travels to `--slot`
    /// and back to slot 0; `bullseye` toggles the pane each time; `sidebar`
    /// hides `--component`'s sidebar, then shows it; `slide` alternates like
    /// `flip` and is refused when the strip does not travel; `fit` resizes
    /// once, whatever the count; and `appear` brings a session picker card in
    /// and closes it, unread, before the next. A release deck walks React
    /// commits only with `--tasks`.
    ///
    /// Every reading also prints the frame lead (the drive to the first frame
    /// after it), the longest gap the outside recorder saw up to the settle
    /// mark's off, the lead included, and each settle beat's start delay and
    /// declared breaches. And it prints the window's main-thread time: React's
    /// time summed over the window's commits, plus — with `--chains` — the
    /// longest forced-layout chain outside every commit.
    Settle {
        /// The gesture to drive.
        #[arg(long, value_parser = crate::commands::deck_motion_settle::GESTURE_NAMES)]
        gesture: String,
        /// The card `flip`, `fold`, `unfold`, `slot` and `slide` act on.
        #[arg(long)]
        card: Option<String>,
        /// The pane `close` closes and `bullseye` toggles.
        #[arg(long)]
        pane: Option<String>,
        /// The slot `split` sets the column mode of, `slot` sends the card to,
        /// and `go` travels to, 0-based.
        #[arg(long)]
        slot: Option<u32>,
        /// The column mode `split` sets first.
        #[arg(long, value_parser = ["split", "stack"])]
        mode: Option<String>,
        /// The workspace `switch` activates.
        #[arg(long)]
        space: Option<String>,
        /// The sidebar card component `sidebar` hides and shows.
        #[arg(long)]
        component: Option<String>,
        /// Gestures read.
        #[arg(long, default_value_t = 3)]
        count: u32,
        /// Also install the lead recorder and attribute each commit: its React
        /// time from the render's first store read, and the store changes or
        /// flushSyncs that caused it. The first run on a page reloads the deck
        /// to install the recorder.
        #[arg(long)]
        tasks: bool,
        /// Arm the forced-layout chain probe around each read drive, without
        /// stacks so its ms are the gesture's own, and print each reading's
        /// chain count, longest and total ms. One extra drive, ahead of the
        /// readings, carries stacks and is printed as the chain census by call
        /// site; a gesture that drives once (`close`, `fit`) reads its one
        /// drive with stacks instead.
        #[arg(long)]
        chains: bool,
        #[command(flatten)]
        target: DeckTarget,
    },
    /// Price the compositing walk with a named subtree skipped or removed.
    ///
    /// A frame with nothing dirty runs no walk, so this drives one: inside
    /// every sampled frame it toggles the width (or transform) of a hidden
    /// fixed 1px element, and reads the walk as the driven frames' p50 above
    /// the undriven floor's. Each arm is read paired with a baseline taken
    /// just before it, over `--rounds`, with the deck's running loops paused
    /// for each burst; the report is the walk each arm saved, per thousand
    /// elements, stacking contexts and render-layer candidates it removed,
    /// beside a census of the deck.
    ///
    /// Every arm is an inline-style write restored when its reading ends, and
    /// every run ends by checking nothing was left behind. Removing a parked
    /// workspace with `display: none` throws its render state away, so the
    /// re-show after `parked-absent` rebuilds that layer once. Take a reading
    /// with the Tug window in front: a covered window stops the frames.
    Walk {
        /// The arms to read, comma-separated, in the order given.
        #[arg(
            long,
            value_delimiter = ',',
            value_parser = crate::commands::deck_motion_walk::ARM_NAMES,
            default_values = crate::commands::deck_motion_walk::ARM_NAMES
        )]
        arms: Vec<String>,
        /// How many times each arm is read, each paired with its own baseline.
        #[arg(long, default_value_t = 3)]
        rounds: u32,
        /// Frames sampled per burst.
        #[arg(long, default_value_t = 30)]
        frames: u32,
        /// The style change written in every driven frame: `width` toggles a
        /// layout property, `transform` a transform-family one.
        #[arg(long, value_parser = ["width", "transform"], default_value = "width")]
        driver: String,
        /// Read nothing: put back whatever an interrupted reading left on the
        /// deck, and say what that was.
        #[arg(long)]
        restore: bool,
        #[command(flatten)]
        target: DeckTarget,
    },
    /// Open the `diag/eval` door on this instance (loopback only).
    Enable {
        #[command(flatten)]
        target: DeckTarget,
    },
    /// Close it again.
    Disable {
        #[command(flatten)]
        target: DeckTarget,
    },
}

/// Which deck to talk to. Every `deck motion` subcommand takes these.
#[derive(clap::Args)]
pub struct DeckTarget {
    /// tugcast port (skips instance discovery).
    #[arg(long)]
    pub port: Option<u16>,
    /// Instance id to resolve the port from.
    #[arg(long)]
    pub instance: Option<String>,
}

#[derive(Subcommand)]
pub enum HostCommands {
    /// Initialize a tugtool project in current directory
    ///
    /// Creates .tugtool/ directory with skeleton template and config.
    /// Idempotent: safe to run multiple times (creates only missing files).
    #[command(
        long_about = "Initialize a tugtool project in current directory.\n\nCreates:\n  .tugtool/config.toml  Project configuration (arc hydration hook)\n\nIdempotent: if .tugtool/ already exists, creates only missing files without overwriting.\nWith --force, removes and recreates everything.\nWith --check, performs a lightweight verification of initialization status without side effects."
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
        long_about = "Ask the human a question in the Session card and print their answer.\n\nRaises an inline dialog in the session named by $TUG_SESSION_ID (or the\nactive session) and blocks until it is answered. The chosen option's value\nis printed to stdout; everything else goes to stderr.\n\nExit codes:\n  0  answered — the choice is on stdout\n  2  declined, timed out, or the deck disconnected\n  3  no route to a dialog — there was nobody to ask\n\nExit 3 is deliberately distinct from a refusal: it means the question could\nnot be put, not that the answer was no. Callers decide what to do about it.\n\n--unattended turns the wait into a chance to intervene rather than a block:\nthe dialog counts --timeout-secs down in view of the developer, commits the\nselected option when it reaches zero, and exits 0 with that choice. Use it\nwhen going ahead unasked is the right thing to do at an empty keyboard.\n\nExamples:\n  tugtool host ask --title 'Run the slow tests?' \\\n      --option run:Run --option cancel:Cancel\n  tugtool host ask --title 'Take the screen?' --description '3 of 12 tests' \\\n      --option run-all:'Run all':'Includes the 3 that take the screen' \\\n      --option cancel:Cancel\n  tugtool host ask --title 'Take the screen?' --timeout-secs 30 \\\n      --unattended run-all \\\n      --option run-all:'Run them' --option skip:'Skip them'"
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
        long_about = "Send an action to tugcast via HTTP POST.\n\nPosts a JSON body to http://127.0.0.1:<port>/api/tell.\nThe body contains {\"action\": \"<ACTION>\", ...params}.\n\nParameters are specified with -p KEY=VALUE (repeatable).\nValues are auto-coerced: true/false -> bool, null -> null,\nintegers -> number, floats -> number, everything else -> string.\n\nExamples:\n  tugtool host tell restart\n  tugtool host tell show-card -p component=about\n  tugtool host tell toggle-cards"
    )]
    Tell {
        /// Action name (e.g., reload, show-card, toggle-cards)
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
        long_about = "Print the per-project runtime-state directory.\n\nResolves <data_dir>/Tug/projects/<slug>/ for the current repository — the\nout-of-repo home for per-user runtime state (the arc log, the code-sign\nsentinel, future side-command output). Creates the directory if absent, so\nshell consumers (the Justfile, the host) can write into it without re-deriving\nthe path."
    )]
    StateDir,

    /// Put back the session rows a lost user-set name needs to be reachable.
    ///
    /// A name the user typed lives on the line and outlives every session id
    /// the line wears, but the listings walked sessions — so a deleted last
    /// segment left the name in the database with nothing able to reach it.
    #[command(
        long_about = "Put back the session rows a lost user-set name needs to be reachable.\n\nA name the user typed lives on the `lines` table and outlives every session\nid the line wears. Every listing path walked `sessions`, though, so a line\nwhose last segment was deleted kept its name with nothing left that could\nreach it.\n\nFor each per-instance `sessions.db` this machine holds (or the one named\nby --db), finds every line carrying a user-set name and no\nsurviving session, reads the session that line owned out of `minted_tags`\n(append-only by Spec S08, so the pairing is a record rather than a guess),\ncounts the corroborating rows in `facts`, and checks the transcript is on\ndisk. It prints that plan, then writes.\n\nA line whose transcript is gone keeps its name and stays unrestored — a\nrestored row the picker cannot open is worse than the loss. A ledger with no `lines`\ntable predates the migration and is skipped rather than failed on.\nRe-running writes nothing: a line with a segment is not stranded."
    )]
    RestoreNames {
        /// Repair one ledger by path instead of every instance's.
        #[arg(long, value_name = "PATH")]
        db: Option<std::path::PathBuf>,

        /// Print the plan and stop without writing.
        #[arg(long)]
        dry_run: bool,
    },

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

    #[test]
    fn arc_stop_takes_a_name_and_an_optional_project() {
        let cli = Cli::parse_from([
            "tugtool",
            "arc",
            "stop",
            "interruption",
            "--project",
            "/tmp/p",
        ]);
        match cli.command {
            Some(Commands::Arc(ArcCommands::Stop {
                name,
                project,
                session,
            })) => {
                assert_eq!(name, "interruption");
                assert_eq!(project.as_deref(), Some(std::path::Path::new("/tmp/p")));
                assert!(session.is_none(), "--session defaults to the environment");
            }
            _ => panic!("arc stop did not parse"),
        }

        let cli = Cli::parse_from(["tugtool", "arc", "stop", "interruption"]);
        match cli.command {
            Some(Commands::Arc(ArcCommands::Stop { project, .. })) => {
                assert!(project.is_none(), "--project defaults to the cwd")
            }
            _ => panic!("arc stop did not parse"),
        }
    }

    /// **`--plan` is gone, and its absence is a refusal rather than a
    /// shrug.** The kind is derived from the arc's documents now, so a flag
    /// naming one would be a second source of truth; clap saying so out loud
    /// is the visible reason [L31] asks for.
    #[test]
    fn arc_run_refuses_the_retired_plan_flag() {
        let err = Cli::try_parse_from(["tugtool", "arc", "run", "demo", "--plan"])
            .err()
            .expect("--plan must not parse");
        assert_eq!(err.kind(), clap::error::ErrorKind::UnknownArgument);

        Cli::try_parse_from(["tugtool", "arc", "run", "demo"]).expect("the bare verb still parses");
    }
}
