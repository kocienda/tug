//! Configuration handling for tug

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::TugError;

/// Tug configuration
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Config {
    /// Tugtool-specific settings
    #[serde(default, alias = "tug")]
    pub tugtool: TugConfig,
}

/// Core tug settings
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TugConfig {
    /// Arc settings.
    #[serde(default)]
    pub arc: ArcConfig,

    /// The runners this project declares, beside the ones tugtool knows.
    #[serde(default)]
    pub report: ReportConfig,

    /// The retired `[tugtool.dash]` table, bound only so the loader can see it
    /// and refuse. Nothing reads its value: a project whose declarations are
    /// still under the old key would look configured while declaring nothing
    /// this build reads, so it is a refusal rather than a silent default.
    #[serde(default, rename = "dash")]
    pub retired_dash: Option<toml::Value>,

    /// The retired `[tugtool.run]` table — the runner rows before they were
    /// `[tugtool.report]` — bound for the same reason and refused the same
    /// way: a project still spelling it the old way declares runners nothing
    /// reads, and would otherwise learn that only from a panel that stays
    /// dark.
    #[serde(default, rename = "run")]
    pub retired_run: Option<toml::Value>,
}

/// Arc configuration.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ArcConfig {
    /// Shell commands run from the new worktree root immediately after
    /// `arc create` adds it — e.g. `bun install --cwd tugdeck`. A git
    /// worktree never inherits gitignored files, so deps are always absent in
    /// a fresh worktree; this hydrates it. A non-zero exit rolls the new
    /// worktree+branch back and fails `create`.
    #[serde(default)]
    pub post_create: Vec<String>,

    /// Documents, relative to the project root, that carry this project's own
    /// supplement to the arc doctrine — its test commands, its build and debug
    /// recipes, the shapes its tests may not take. The implement, audit and
    /// review stages read each one after the doctrine the plugin ships. The
    /// plugin's doctrine is complete without them, so an empty list is the
    /// whole doctrine with nothing added, not a degraded mode.
    #[serde(default)]
    pub doctrine: Vec<String>,

    /// The project's law documents, relative to the project root: the ones the
    /// review stage cross-checks a plan against and the audit's fit check
    /// cites specific laws from. An empty list declares none, and the stages
    /// that would cite one say the axis was skipped.
    #[serde(default)]
    pub laws: Vec<String>,

    /// The retired `verify` key, bound only so the loader can see it and
    /// refuse. Nothing reads its value: a project declares the surfaces it is
    /// made of, and the fit check runs what those surfaces declare. A config
    /// still carrying this key would look like coverage while providing none,
    /// so it is a refusal rather than a silently ignored field.
    #[serde(default, rename = "verify")]
    pub retired_verify: Option<String>,

    /// The surfaces this project is made of: what each claims, and what
    /// checking it means. `tugtool arc verify` resolves every path an arc
    /// would land to exactly one of these, refuses when a path resolves to
    /// none, and runs what the matched surfaces declare. An empty table is the
    /// declared-none state, not an error.
    #[serde(default, rename = "surface")]
    pub surfaces: Vec<Surface>,

    /// The command that produces an inspectable instance from the worktree.
    /// Absent means no build is offered.
    #[serde(default)]
    pub build: Option<String>,

    /// The model the arc's devise stage runs on ([P13]). Absent means the
    /// account default — a project declares a stage model, it never inherits
    /// one, and the arc's receipt says which stages ran unspecified rather
    /// than implying a choice nobody made ([D151]).
    #[serde(default)]
    pub devise_model: Option<String>,

    /// The model the arc's review stage runs on. Absent means the account
    /// default.
    #[serde(default)]
    pub review_model: Option<String>,

    /// The model the arc's implement stage runs on. Absent means the account
    /// default.
    #[serde(default)]
    pub implement_model: Option<String>,

    /// The model the arc's audit stage runs on. Absent means the account
    /// default.
    #[serde(default)]
    pub audit_model: Option<String>,

    /// The context size, in tokens, above which a seated implement stage is
    /// compacted at a step boundary. Absent means
    /// [`IMPLEMENT_COMPACT_TOKENS_DEFAULT`], which
    /// [`ArcConfig::compact_tokens`] applies.
    #[serde(default)]
    pub implement_compact_tokens: Option<u64>,

    /// The share of the model's context window at which a seated implement
    /// stage is told to yield mid-step: finish its round on committed bytes,
    /// leave a `yield:` line, and end the turn so the wheel can compact it.
    /// Absent means [`IMPLEMENT_YIELD_SHARE_DEFAULT`], which
    /// [`ArcConfig::yield_share`] applies.
    ///
    /// A second line beside `implement_compact_tokens`, not a replacement for
    /// it ([P07] stands): the token line says when a context has grown long
    /// enough to work badly, and is read at a step boundary; this one says
    /// when a step is at risk of meeting the harness's own forced compaction,
    /// and is read inside a step.
    #[serde(default)]
    pub implement_yield_share: Option<f64>,

    /// The share of the model's context window passed to the harness's own
    /// autocompact override when an implement stage is spawned — the backstop
    /// for a step that runs past the yield line between two readings. Absent
    /// means [`IMPLEMENT_BACKSTOP_SHARE_DEFAULT`], which
    /// [`ArcConfig::backstop_share`] applies. Claude Code reads its override
    /// as a percent, so a share of `0.85` is passed as `85`.
    #[serde(default)]
    pub implement_backstop_share: Option<f64>,

    /// How long an arc may go without motion of any kind before it stops and
    /// hands the card back — the arc's clock, in seconds. Absent means
    /// [`ARC_STALL_SECS_DEFAULT`], which [`ArcConfig::stall_timeout`]
    /// applies; `0` turns the clock off.
    ///
    /// Every other thing the arc decides is decided on an edge: a turn
    /// ending, a document changing. A stage that hangs mid-turn produces no
    /// edge at all, and one that ends a single turn and then goes silent
    /// leaves the quiet-turn horizon at 1 forever, because the horizon also
    /// counts turns that end. This is the only fact in the machine measured
    /// against a wall clock rather than against an edge.
    #[serde(default)]
    pub arc_stall_secs: Option<u64>,

    /// How long an idle reading must stay idle before the runner will spend it
    /// on an act, in seconds. Absent means [`IDLE_SETTLE_SECS_DEFAULT`], which
    /// [`ArcConfig::idle_settle`] applies; `0` turns the settle off.
    ///
    /// The runner is the one consumer that spends a reading on something
    /// irreversible — a rotation, a prompt, a stop — and an idle reading is
    /// only ever a claim about an instant. A turn ending and the wake that
    /// answers it are 120 ms apart, and in that gap a session is genuinely
    /// idle and genuinely still working; the arc that was stopped on the night
    /// of 2026-09-03 was stopped inside exactly one of those. No order of SDK
    /// edges produces a gap this wide, so a reading that survives it is a
    /// reading about the session rather than about the instant it was taken.
    ///
    /// It gates the runner alone. `is_quiet` still answers Z2, the beat and the
    /// join offer unsettled, because none of them acts on the answer.
    #[serde(default)]
    pub idle_settle_secs: Option<u64>,

    /// How long a step boundary the wheel cannot read idle may stand before
    /// the wheel prompts past it, in seconds. Absent means
    /// [`BOUNDARY_HORIZON_SECS_DEFAULT`], which
    /// [`ArcConfig::boundary_horizon`] applies; `0` turns the horizon off.
    ///
    /// A boundary is the one place the wheel may prompt, and a step that
    /// closed with a background job still running leaves one the busy latch
    /// cannot read idle: the turn has ended, the step is closed, and a job
    /// nobody is reading holds the reading busy. The close ends the session's
    /// jobs, so this is the residue that edge cannot reach — a job the turn
    /// opened after it reported the close, and a close whose edge reached no
    /// supervisor at all. Both used to sit until a person typed.
    ///
    /// Mid-turn is untouched: there the wheel may only wait or stop.
    #[serde(default)]
    pub boundary_horizon_secs: Option<u64>,

    /// How long a stop's quiesce may take before it gives up and reports the
    /// rung it stalled on, in seconds. Absent means
    /// [`ARC_STOP_CEILING_SECS_DEFAULT`], which [`ArcConfig::stop_ceiling`]
    /// applies.
    ///
    /// The stop is a protocol with an end: it interrupts the turn, asks
    /// tugcode to end the session's work and sweep its process group, and
    /// waits for the session to go genuinely quiet before it answers. That
    /// wait has to be bounded, because a missed edge would otherwise hold the
    /// press open forever — a late `arc_stop_err` naming the rung is the one
    /// direction this wait is allowed to fail in. There is no off switch: a
    /// stop that never ends is worse than one that reports late.
    #[serde(default)]
    pub arc_stop_ceiling_secs: Option<u64>,
}

/// One surface of a project: the paths it claims, and what checking it means.
///
/// Declared as `[[tugtool.arc.surface]]` in `.tugtool/config.toml`. A surface
/// either declares its own `check` commands, borrows another surface's with
/// `checked_by`, or declares neither — `check = []` being the claim that these
/// paths are accounted for and there is nothing to run.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Surface {
    /// A short identifier a human reads on a report line. Unique across the
    /// table; not a path, and carrying no meaning beyond naming this surface.
    pub name: String,

    /// The repo-relative prefixes and exact paths this surface claims. A
    /// touched path goes to the surface declaring the longest claiming path.
    pub paths: Vec<String>,

    /// The shell commands that check this surface, run in declaration order
    /// from the worktree root. Empty means claimed with nothing to run.
    #[serde(default)]
    pub check: Vec<String>,

    /// Other surfaces whose own `check` commands run as this surface's. One
    /// level deep: a borrowed surface may not itself borrow.
    #[serde(default)]
    pub checked_by: Vec<String>,

    /// Shell commands `tugtool arc commit` runs from the worktree root over the
    /// round's paths this surface claims, before anything is staged. `{paths}`
    /// expands to those paths, shell-quoted. A non-zero exit refuses the commit.
    #[serde(default)]
    pub commit_check: Vec<String>,

    /// Glob patterns (matched against the path's file name, `*.ts` style) a
    /// claimed path must match for `commit_check` to run; `{paths}` carries only
    /// the matching ones. Empty means every claimed path counts.
    #[serde(default)]
    pub commit_check_only: Vec<String>,
}

/// The `[tugtool.report]` table: the commands this project runs that the
/// report panel should draw, beside the runners tugtool already knows.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ReportConfig {
    /// One row per runner, declared as `[[tugtool.report.runner]]`.
    #[serde(default, rename = "runner")]
    pub runners: Vec<Runner>,
}

/// One declared runner: the command head it answers for, and how its run
/// reaches the panel.
///
/// A row with a `kind` is wrapped by the PreToolUse hook in
/// `tugtool test run --kind <kind>`, which parses its output. A row with only
/// a `unit` is a command that reports itself — a recipe calling
/// `tugtool report` — and the hook puts nothing in front of it but the
/// call id, so its reports attach to the block exactly. On a `kind` row,
/// `unit` is the word the panel counts in.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Runner {
    /// The command head, as typed: whole words, space-separated.
    pub r#match: String,
    /// A `tugtool test run --kind` — one of [`RUN_KIND_NAMES`].
    #[serde(default)]
    pub kind: Option<String>,
    /// The unit the run counts. Alone, it declares a self-reporting command.
    #[serde(default)]
    pub unit: Option<String>,
    /// The test ledger's key for the run; the head's last word when absent.
    #[serde(default)]
    pub suite: Option<String>,
    /// The panel's label; the head when absent.
    #[serde(default)]
    pub label: Option<String>,
    /// For `kind = "lines"`: the regex one item's line matches, with `name`
    /// and `status` named groups.
    #[serde(default)]
    pub item: Option<String>,
    /// For `kind = "lines"`: the regex the run's total matches, with a
    /// `total` named group.
    #[serde(default)]
    pub total: Option<String>,
    /// Which stream a `lines` run reads: one of [`RUN_STREAMS`].
    #[serde(default)]
    pub stream: Option<String>,
}

/// The `tugtool test run --kind` names a declared runner may name. The kinds
/// are a `clap::ValueEnum` in tugtool, which this crate cannot see, so the
/// names are spelled here and a tugtool test holds the two lists equal.
pub const RUN_KIND_NAMES: &[&str] = &[
    "bun",
    "nextest",
    "cargo-test",
    "tap",
    "junit",
    "lines",
    "go",
    "pytest",
    "jest",
    "vitest",
    "mocha",
    "swift",
    "ctest",
    "cargo",
    "tsc",
    "vite",
];

/// The streams a `lines` run may read.
pub const RUN_STREAMS: &[&str] = &["stdout", "stderr", "both"];

/// The context size, in tokens, a seated implement stage is compacted above
/// when a project declares none ([P07]).
///
/// A token count rather than a share of the model's window, because what makes
/// a stage work badly is a long context, and long is a number of tokens. The
/// share it happens to be of whatever model the stage is running on is not the
/// same judgement, and on a very large window it is not even close to it.
pub const IMPLEMENT_COMPACT_TOKENS_DEFAULT: u64 = 300_000;

/// The share of the window a seated implement stage yields at mid-step, when
/// a project declares none.
///
/// Sixty percent leaves the step room to finish the round it is in — a commit,
/// a test run, the hand-off line — before the backstop's line, and is well
/// above the fixed prefix (system prompt plus tools) of any window a stage
/// runs on.
pub const IMPLEMENT_YIELD_SHARE_DEFAULT: f64 = 0.60;

/// The share of the window passed to the harness's autocompact override as the
/// backstop, when a project declares none.
///
/// Above the yield line by enough that a cooperating stage never meets it, and
/// below the harness's own default line, so the backstop is the one that fires
/// for a step that runs away between readings.
pub const IMPLEMENT_BACKSTOP_SHARE_DEFAULT: f64 = 0.85;

/// A declared share taken at its word only when it is a share: above zero and
/// at most one. Anything else is the default, so a typo of `60` for `0.60`
/// cannot turn the line off or put it out of reach.
fn share_or(declared: Option<f64>, default: f64) -> f64 {
    declared
        .filter(|share| share.is_finite() && *share > 0.0 && *share <= 1.0)
        .unwrap_or(default)
}

/// How long an arc may go without motion before the clock stops it, when a
/// project declares nothing ([P07]).
///
/// Half an hour, and it can be that short because motion is not only a turn
/// *ending*: the seated session's context growing counts, and a turn that is
/// genuinely working — a stage running a full test sweep, a long build, a
/// wide read — reports usage as it goes. So a slow turn keeps the clock
/// reset and a hung one does not, which is the distinction the deadline
/// alone could never draw. Were the count the only signal, this would have to
/// outlast the longest legitimate turn, and the wedge would sit most of a
/// working day before anyone was told.
///
/// The clock is still the last resort under every other arm rather than a
/// pacing device: it exists so an arc that has genuinely gone silent says so.
pub const ARC_STALL_SECS_DEFAULT: u64 = 1_800;

/// How long an idle reading must hold before the runner acts on it, when a
/// project declares nothing ([P01]).
///
/// Five seconds, which is two orders of magnitude above the ~100 ms the
/// harness takes to re-invoke a model after a background job completes — the
/// gap the settle exists to outlast. It is a floor under one consumer's
/// irreversible acts, not a pacing device, so the cost is bounded: every wheel
/// act, including the first rotation after a door, lands this much later.
pub const IDLE_SETTLE_SECS_DEFAULT: u64 = 5;

/// How long a stop's quiesce may take before it reports the rung it stalled
/// on, when a project declares nothing ([P05]).
///
/// Thirty seconds, which is above the ladder the stop actually walks with
/// margin: tugcode's 5s EOF grace for a claude that exits politely, the 1.5s
/// fallback rung under it, the unconditional group sweep, and the respawn's
/// handshake. Not the escalate ladder's rungs, which belong to the wedge
/// recovery and not to this path.
pub const ARC_STOP_CEILING_SECS_DEFAULT: u64 = 30;

/// How long a step boundary the wheel cannot read idle may stand before the
/// wheel prompts past it, when a project declares nothing.
///
/// Two minutes, which is twenty-four settles and two sweeps: long enough that
/// a job genuinely about to report gets its wake and the ordinary idle path
/// answers the boundary, short enough that a held one costs minutes rather
/// than the half hour the job reaper takes to reach it.
pub const BOUNDARY_HORIZON_SECS_DEFAULT: u64 = 120;

impl ArcConfig {
    /// The compaction threshold to actually use: the declaration, or the
    /// default. The default lives at the consumer rather than in the parse so
    /// `arc config` can still report honestly that nothing was declared.
    pub fn compact_tokens(&self) -> u64 {
        self.implement_compact_tokens
            .unwrap_or(IMPLEMENT_COMPACT_TOKENS_DEFAULT)
    }

    /// The mid-step yield line to actually use: the declaration when it is a
    /// share in `(0, 1]`, or the default.
    pub fn yield_share(&self) -> f64 {
        share_or(self.implement_yield_share, IMPLEMENT_YIELD_SHARE_DEFAULT)
    }

    /// The backstop line to actually use: the declaration when it is a share
    /// in `(0, 1]`, or the default.
    pub fn backstop_share(&self) -> f64 {
        share_or(
            self.implement_backstop_share,
            IMPLEMENT_BACKSTOP_SHARE_DEFAULT,
        )
    }

    /// The clock's deadline to actually use: the declaration, or the default.
    /// `None` is the clock turned off — a declared `0`, which is the one way
    /// a project can ask for the old behaviour of waiting forever.
    pub fn stall_timeout(&self) -> Option<std::time::Duration> {
        let secs = self.arc_stall_secs.unwrap_or(ARC_STALL_SECS_DEFAULT);
        (secs > 0).then(|| std::time::Duration::from_secs(secs))
    }

    /// The settle to actually use: the declaration, or the default. `None` is
    /// the settle turned off — a declared `0`, which asks for the old
    /// behaviour of acting on the instant a reading was taken.
    pub fn idle_settle(&self) -> Option<std::time::Duration> {
        let secs = self.idle_settle_secs.unwrap_or(IDLE_SETTLE_SECS_DEFAULT);
        (secs > 0).then(|| std::time::Duration::from_secs(secs))
    }

    /// The boundary horizon to actually use: the declaration, or the default.
    /// `None` is the horizon turned off — a declared `0`, which asks for the
    /// old behaviour of a held boundary standing until the job reaper or a
    /// person reaches it.
    pub fn boundary_horizon(&self) -> Option<std::time::Duration> {
        let secs = self
            .boundary_horizon_secs
            .unwrap_or(BOUNDARY_HORIZON_SECS_DEFAULT);
        (secs > 0).then(|| std::time::Duration::from_secs(secs))
    }

    /// The stop's ceiling to actually use: the declaration, or the default.
    /// Unlike the clock and the settle there is no `0` that turns it off — a
    /// stop with no ceiling is a press that can hang forever, which is the one
    /// thing the wait must never do.
    pub fn stop_ceiling(&self) -> std::time::Duration {
        std::time::Duration::from_secs(
            self.arc_stop_ceiling_secs
                .unwrap_or(ARC_STOP_CEILING_SECS_DEFAULT),
        )
    }
}

/// The config file a project starts with: an empty hydration list and a
/// commented example for every optional declaration.
///
/// It lives here rather than beside `tugtool init` so the template has one
/// home; two copies would be two contracts free to drift.
pub const DEFAULT_CONFIG: &str = r#"[tugtool.arc]
# Commands run from a new arc worktree to hydrate it (deps, etc.).
# A git worktree never inherits gitignored files, so these install what a
# fresh checkout lacks. A non-zero exit rolls the worktree back.
post_create = []
# post_create = ["npm install"]

# Documents carrying this project's own supplement to the arc doctrine the
# plugin ships: its test commands, its build recipes, the shapes its tests may
# not take. The implement, audit and review stages read each after the
# plugin's doctrine. Declare none and the plugin's doctrine stands alone.
# doctrine = ["doc/arc-supplement.md"]

# The project's law documents. The review stage cross-checks a plan against
# them and the audit's fit check cites specific laws from them. Declare none
# and that axis is skipped, and the stage says so.
# laws = ["doc/architecture.md"]

# The surfaces this project is made of. `tugtool arc verify <arc>` resolves
# every path the arc would land to the surface declaring the longest matching
# path, and refuses — naming the paths — when one resolves to no surface. An
# empty table declares none: the ending falls back to the plan's own checkpoint
# commands over what the replay moved.
#
# `check` runs from the worktree root, in declaration order. `{base}`, `{head}`,
# and `{paths}` expand to the range's endpoints and to this surface's own
# touched paths, shell-quoted. `check = []` claims the paths and runs nothing.
# `checked_by` borrows another surface's commands, one level deep.
#
# [[tugtool.arc.surface]]
# name  = "src"
# paths = ["src/"]
# check = ["make check"]
#
# [[tugtool.arc.surface]]
# name  = "docs"
# paths = ["README.md", "doc/"]
# check = []

# The command that produces an inspectable instance from this worktree.
# Declare none and no build is offered.
# build = "make app"

# The models the server-driven arc runs each stage on. Declare none and a stage
# runs on the account default, which the arc's receipt says out loud.
# devise_model = "sonnet"
# review_model = "opus"
# implement_model = "sonnet"
# audit_model = "opus"

# The context size, in tokens, above which a seated implement stage is
# compacted at a step boundary. A stage a compaction cannot bring back under
# this line rotates to a fresh session instead. Declare none and it is 300000.
# implement_compact_tokens = 300000

# The share of the model's context window at which a seated implement stage
# is told, on its next tool call, to finish the round it is in, commit, leave a
# `yield:` line and end the turn, so the wheel can compact it mid-step. Declare
# none and it is 0.60.
# implement_yield_share = 0.60

# The share of the window handed to the harness's own autocompact as the
# backstop for a step that runs past the yield line between readings. Declare
# none and it is 0.85.
# implement_backstop_share = 0.85

# How long an idle reading must stay idle before the arc runner spends it on a
# rotation, a prompt or a stop. A turn ending and the wake that answers it are
# a fraction of a second apart, and in that gap a session reads idle while it
# is still working. Declare none and it is 5; declare 0 to act on the instant.
# idle_settle_secs = 5

# How long a step boundary the wheel cannot read idle may stand before the
# wheel prompts past it. A step that closed with a background job still
# running leaves the turn ended, the step closed, and a job nobody is reading
# holding the reading busy. Declare none and it is 120; declare 0 to let a
# held boundary stand.
# boundary_horizon_secs = 120

# How long a stop's quiesce may take — the interrupt, the teardown of the
# session's background work and process group, and the wait for it to go
# genuinely quiet — before the press is answered with the rung it stalled on.
# Declare none and it is 30.
# arc_stop_ceiling_secs = 30
"#;

/// Why a config file was refused. Every variant carries the offending value,
/// because a refusal a reader cannot act on is a refusal that gets worked
/// around rather than fixed.
///
/// Raised only by what a config *declares*: a missing file is validated not at
/// all, and an absent surface table is the declared-none state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigRefusal {
    /// The retired `verify` key, which a surface table replaces.
    RetiredVerify(String),
    /// The retired `[tugtool.dash]` table, which `[tugtool.arc]` replaces.
    RetiredDashTable,
    /// A surface with an empty `name`.
    EmptyName,
    /// Two surfaces sharing a `name`.
    DuplicateName(String),
    /// A surface declaring no paths, or an empty path string.
    EmptyPaths(String),
    /// A path that cannot be resolved against a repo root as written.
    IllegalPath { surface: String, path: String },
    /// Two surfaces claiming the same path, which no longest-prefix rule can
    /// disambiguate.
    DuplicatePath {
        first: String,
        second: String,
        path: String,
    },
    /// A `checked_by` naming a surface the table does not declare.
    UnknownLender { surface: String, lender: String },
    /// A `checked_by` naming a surface that itself borrows.
    LenderBorrows { surface: String, lender: String },
    /// A `checked_by` naming its own surface.
    SelfBorrow(String),
    /// A `commit_check_only` filter on a surface with no `commit_check` to filter.
    FilterWithoutCommitCheck(String),
    /// A config still carrying the retired `[tugtool.run]` table.
    RetiredRunTable,
    /// A runner with an empty `match`.
    EmptyRunnerMatch,
    /// A runner declaring neither a `kind` nor a `unit`.
    RunnerWithoutAction(String),
    /// A runner naming a `kind` tugtool does not have.
    UnknownRunnerKind { runner: String, kind: String },
    /// A `lines` runner with no `item` regex.
    LinesWithoutItem(String),
    /// A runner regex that does not compile.
    RunnerRegex {
        runner: String,
        field: &'static str,
        error: String,
    },
    /// A runner regex missing a named group its field requires.
    RunnerRegexGroup {
        runner: String,
        field: &'static str,
        group: &'static str,
    },
    /// A runner `stream` outside [`RUN_STREAMS`].
    UnknownRunnerStream { runner: String, stream: String },
    /// An `item`, `total` or `stream` on a row whose kind is not `lines` —
    /// the one kind that reads them.
    RuleOnOtherKind {
        runner: String,
        field: &'static str,
        kind: Option<String>,
    },
    /// Two runners declaring the same `match`, which the hook can honour
    /// only one of.
    DuplicateRunnerMatch(String),
}

impl std::fmt::Display for ConfigRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RetiredVerify(value) => write!(
                f,
                "[tugtool.arc].verify is retired (declared as {value:?}) — declare \
                 [[tugtool.arc.surface]] entries instead, and run `tugtool arc verify <arc>`"
            ),
            Self::RetiredDashTable => f.write_str(
                "[tugtool.dash] is retired — the table is [tugtool.arc] now, and its values \
                 are not read until it is renamed",
            ),
            Self::EmptyName => f.write_str("a [[tugtool.arc.surface]] declares an empty name"),
            Self::DuplicateName(name) => {
                write!(f, "two surfaces are both named {name:?}")
            }
            Self::EmptyPaths(surface) => write!(
                f,
                "surface {surface:?} declares no paths — a surface claims at least one path"
            ),
            Self::IllegalPath { surface, path } => write!(
                f,
                "surface {surface:?} declares the path {path:?} — paths are repo-relative, \
                 without `..`, and match by prefix rather than by glob"
            ),
            Self::DuplicatePath {
                first,
                second,
                path,
            } => write!(
                f,
                "surfaces {first:?} and {second:?} both claim {path:?} — a path belongs to \
                 exactly one surface"
            ),
            Self::UnknownLender { surface, lender } => write!(
                f,
                "surface {surface:?} is checked_by {lender:?}, which no surface declares"
            ),
            Self::LenderBorrows { surface, lender } => write!(
                f,
                "surface {surface:?} is checked_by {lender:?}, which itself declares \
                 checked_by — borrowing is one level deep"
            ),
            Self::SelfBorrow(name) => {
                write!(f, "surface {name:?} declares itself in its own checked_by")
            }
            Self::FilterWithoutCommitCheck(name) => write!(
                f,
                "surface {name:?} declares commit_check_only with no commit_check — the \
                 filter has nothing to run"
            ),
            Self::RetiredRunTable => f.write_str(
                "[tugtool.run] is retired — the runner table is [[tugtool.report.runner]] now, \
                 and its rows are not read until it is renamed",
            ),
            Self::EmptyRunnerMatch => {
                f.write_str("a [[tugtool.report.runner]] declares an empty match")
            }
            Self::RunnerWithoutAction(runner) => write!(
                f,
                "runner {runner:?} declares neither a kind nor a unit — a runner is wrapped \
                 by its kind, or reports itself in its unit"
            ),
            Self::UnknownRunnerKind { runner, kind } => write!(
                f,
                "runner {runner:?} declares the kind {kind:?} — the kinds are {}",
                RUN_KIND_NAMES.join(", ")
            ),
            Self::LinesWithoutItem(runner) => write!(
                f,
                "runner {runner:?} is kind \"lines\" and declares no item regex"
            ),
            Self::RunnerRegex {
                runner,
                field,
                error,
            } => write!(
                f,
                "runner {runner:?} declares a {field} regex that does not compile: {error}"
            ),
            Self::RunnerRegexGroup {
                runner,
                field,
                group,
            } => write!(
                f,
                "runner {runner:?} declares a {field} regex with no (?P<{group}>…) group"
            ),
            Self::UnknownRunnerStream { runner, stream } => write!(
                f,
                "runner {runner:?} declares the stream {stream:?} — the streams are {}",
                RUN_STREAMS.join(", ")
            ),
            Self::RuleOnOtherKind {
                runner,
                field,
                kind: Some(kind),
            } => write!(
                f,
                "runner {runner:?} is kind {kind:?} and declares {field} — item, total and \
                 stream belong to kind \"lines\", which reads the run's own lines; a {kind} run \
                 is read by tugtool's parser for it"
            ),
            Self::RuleOnOtherKind {
                runner,
                field,
                kind: None,
            } => write!(
                f,
                "runner {runner:?} reports itself in its unit and declares {field} — item, \
                 total and stream belong to kind \"lines\"; a self-reporting row needs only \
                 its unit"
            ),
            Self::DuplicateRunnerMatch(head) => write!(
                f,
                "two runners declare the match {head:?} — the hook honours one row per head; \
                 merge them into one row, or give one a longer head"
            ),
        }
    }
}

impl TugConfig {
    /// Check the table the arc declarations live under, then the declarations
    /// themselves. A config still carrying `[tugtool.dash]` is refused here
    /// rather than read: its values reach nothing this build looks at.
    pub fn validate(&self) -> Result<(), ConfigRefusal> {
        if self.retired_dash.is_some() {
            return Err(ConfigRefusal::RetiredDashTable);
        }
        if self.retired_run.is_some() {
            return Err(ConfigRefusal::RetiredRunTable);
        }
        self.arc.validate()?;
        self.report.validate()?;
        Ok(())
    }
}

impl ArcConfig {
    /// Check everything this table declares, before anything believes it.
    ///
    /// Runs after the parse, on a config that was actually read from a file.
    /// A project declaring no surfaces passes trivially — absence is a state,
    /// and the only thing refused here is a declaration that cannot mean what
    /// it says.
    pub fn validate(&self) -> Result<(), ConfigRefusal> {
        if let Some(value) = &self.retired_verify {
            return Err(ConfigRefusal::RetiredVerify(value.clone()));
        }

        for (index, surface) in self.surfaces.iter().enumerate() {
            if surface.name.trim().is_empty() {
                return Err(ConfigRefusal::EmptyName);
            }
            if self.surfaces[..index]
                .iter()
                .any(|s| s.name == surface.name)
            {
                return Err(ConfigRefusal::DuplicateName(surface.name.clone()));
            }
            if surface.paths.is_empty() || surface.paths.iter().any(|p| p.trim().is_empty()) {
                return Err(ConfigRefusal::EmptyPaths(surface.name.clone()));
            }
            for path in &surface.paths {
                if Path::new(path).is_absolute()
                    || path.split('/').any(|c| c == "..")
                    || path.contains(['*', '?', '['])
                {
                    return Err(ConfigRefusal::IllegalPath {
                        surface: surface.name.clone(),
                        path: path.clone(),
                    });
                }
                if let Some(other) = self.surfaces[..index]
                    .iter()
                    .find(|s| s.paths.iter().any(|p| p == path))
                {
                    return Err(ConfigRefusal::DuplicatePath {
                        first: other.name.clone(),
                        second: surface.name.clone(),
                        path: path.clone(),
                    });
                }
            }
        }

        // Borrowing is checked against the whole table, so a surface may
        // legally borrow one declared after it.
        for surface in &self.surfaces {
            for lender in &surface.checked_by {
                if *lender == surface.name {
                    return Err(ConfigRefusal::SelfBorrow(surface.name.clone()));
                }
                match self.surfaces.iter().find(|s| s.name == *lender) {
                    None => {
                        return Err(ConfigRefusal::UnknownLender {
                            surface: surface.name.clone(),
                            lender: lender.clone(),
                        });
                    }
                    Some(found) if !found.checked_by.is_empty() => {
                        return Err(ConfigRefusal::LenderBorrows {
                            surface: surface.name.clone(),
                            lender: lender.clone(),
                        });
                    }
                    Some(_) => {}
                }
            }
        }

        for surface in &self.surfaces {
            if !surface.commit_check_only.is_empty() && surface.commit_check.is_empty() {
                return Err(ConfigRefusal::FilterWithoutCommitCheck(
                    surface.name.clone(),
                ));
            }
        }

        Ok(())
    }
}

impl ReportConfig {
    /// Check every declared runner, so a row that cannot mean what it says
    /// is refused at load rather than wrapped into a command that fails.
    ///
    /// A `kind` row may name a `unit` too — the word its run counts in. Only
    /// a row with neither has nothing for the hook to do. `item`, `total` and
    /// `stream` are a `lines` row's alone, and a head is one row's alone:
    /// a row the hook would accept and then silently not honour is refused
    /// here, where the refusal can say what to write instead.
    pub fn validate(&self) -> Result<(), ConfigRefusal> {
        let mut heads: Vec<String> = Vec::new();
        for runner in &self.runners {
            let name = runner.r#match.trim();
            if name.is_empty() {
                return Err(ConfigRefusal::EmptyRunnerMatch);
            }
            let name = name.to_string();
            let head = name.split_whitespace().collect::<Vec<_>>().join(" ");
            if heads.contains(&head) {
                return Err(ConfigRefusal::DuplicateRunnerMatch(head));
            }
            heads.push(head);
            match (&runner.kind, &runner.unit) {
                (None, None) => return Err(ConfigRefusal::RunnerWithoutAction(name)),
                (Some(kind), _) if !RUN_KIND_NAMES.contains(&kind.as_str()) => {
                    return Err(ConfigRefusal::UnknownRunnerKind {
                        runner: name,
                        kind: kind.clone(),
                    });
                }
                (Some(kind), _) if kind == "lines" && runner.item.is_none() => {
                    return Err(ConfigRefusal::LinesWithoutItem(name));
                }
                _ => {}
            }
            if runner.kind.as_deref() != Some("lines") {
                let rules = [
                    ("item", &runner.item),
                    ("total", &runner.total),
                    ("stream", &runner.stream),
                ];
                if let Some((field, _)) = rules.into_iter().find(|(_, value)| value.is_some()) {
                    return Err(ConfigRefusal::RuleOnOtherKind {
                        runner: name,
                        field,
                        kind: runner.kind.clone(),
                    });
                }
            }
            let fields: [(&'static str, &Option<String>, &[&'static str]); 2] = [
                ("item", &runner.item, &["name", "status"]),
                ("total", &runner.total, &["total"]),
            ];
            for (field, pattern, groups) in fields {
                let Some(pattern) = pattern else { continue };
                let regex = regex::Regex::new(pattern).map_err(|e| ConfigRefusal::RunnerRegex {
                    runner: name.clone(),
                    field,
                    error: e.to_string(),
                })?;
                for group in groups {
                    if !regex.capture_names().flatten().any(|n| n == *group) {
                        return Err(ConfigRefusal::RunnerRegexGroup {
                            runner: name.clone(),
                            field,
                            group,
                        });
                    }
                }
            }
            if let Some(stream) = &runner.stream
                && !RUN_STREAMS.contains(&stream.as_str())
            {
                return Err(ConfigRefusal::UnknownRunnerStream {
                    runner: name,
                    stream: stream.clone(),
                });
            }
        }
        Ok(())
    }
}

impl Config {
    /// Load configuration from a file
    pub fn load(path: &Path) -> Result<Self, TugError> {
        let content = fs::read_to_string(path)
            .map_err(|e| TugError::Config(format!("failed to read config file: {}", e)))?;
        let config: Self = toml::from_str(&content)
            .map_err(|e| TugError::Config(format!("failed to parse config file: {}", e)))?;
        config
            .tugtool
            .validate()
            .map_err(|e| TugError::Config(format!("{}: {}", path.display(), e)))?;
        Ok(config)
    }

    /// Load configuration from .tug/config.toml in the given project root
    pub fn load_from_project(project_root: &Path) -> Result<Self, TugError> {
        let config_path = project_root.join(".tugtool").join("config.toml");
        if config_path.exists() {
            Self::load(&config_path)
        } else {
            Ok(Config::default())
        }
    }
}

/// Find the project root by searching upward for `.tug/` directory
///
/// Per [D07], commands search upward from current working directory to find
/// `.tug/` directory, stopping at filesystem root.
pub fn find_project_root() -> Result<PathBuf, TugError> {
    find_project_root_from(
        std::env::current_dir()
            .map_err(|e| TugError::Config(format!("failed to get current directory: {}", e)))?,
    )
}

/// Find the project root starting from a specific directory
///
/// A `.tugtool/` directory marks the root outright. Without one, the nearest
/// enclosing git checkout is the project: a project that declares nothing has
/// no `.tugtool/` at all, and `load_from_project` already answers for it with
/// the defaults. Only a directory inside neither is uninitialized.
pub fn find_project_root_from(start: PathBuf) -> Result<PathBuf, TugError> {
    let mut current = start;
    let mut checkout: Option<PathBuf> = None;
    loop {
        if current.join(".tugtool").is_dir() {
            return Ok(current);
        }
        if checkout.is_none() && current.join(".git").exists() {
            checkout = Some(current.clone());
        }
        match current.parent() {
            Some(parent) => current = parent.to_path_buf(),
            None => return checkout.ok_or(TugError::NotInitialized),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A table's refusals, each with the offending value named — and, beside
    /// each, a neighbouring config that differs only in being legal, so a
    /// refusal that fired too broadly is caught here rather than by a project
    /// whose config stopped loading.
    #[test]
    fn surface_table_refusals_each_name_the_offending_value() {
        let cases: &[(&str, &str, &[&str])] = &[
            (
                "the retired verify key",
                "[tugtool.arc]\nverify = \"sh scripts/check.sh {base} {head}\"\n",
                &["verify", "[[tugtool.arc.surface]]"],
            ),
            (
                "an empty name",
                "[[tugtool.arc.surface]]\nname = \"\"\npaths = [\"src/\"]\n",
                &["empty name"],
            ),
            (
                "two surfaces sharing a name",
                "[[tugtool.arc.surface]]\nname = \"a\"\npaths = [\"x/\"]\n\n[[tugtool.arc.surface]]\nname = \"a\"\npaths = [\"y/\"]\n",
                &["\"a\""],
            ),
            (
                "no paths at all",
                "[[tugtool.arc.surface]]\nname = \"a\"\npaths = []\n",
                &["\"a\"", "no paths"],
            ),
            (
                "an empty path string",
                "[[tugtool.arc.surface]]\nname = \"a\"\npaths = [\"\"]\n",
                &["\"a\""],
            ),
            (
                "an absolute path",
                "[[tugtool.arc.surface]]\nname = \"a\"\npaths = [\"/etc/\"]\n",
                &["\"a\"", "/etc/"],
            ),
            (
                "a path escaping the root",
                "[[tugtool.arc.surface]]\nname = \"a\"\npaths = [\"../elsewhere/\"]\n",
                &["\"a\"", "../elsewhere/"],
            ),
            (
                "a glob",
                "[[tugtool.arc.surface]]\nname = \"a\"\npaths = [\"src/*.rs\"]\n",
                &["\"a\"", "src/*.rs"],
            ),
            (
                "two surfaces claiming the same path",
                "[[tugtool.arc.surface]]\nname = \"a\"\npaths = [\"src/\"]\n\n[[tugtool.arc.surface]]\nname = \"b\"\npaths = [\"src/\"]\n",
                &["\"a\"", "\"b\"", "src/"],
            ),
            (
                "a checked_by naming nothing",
                "[[tugtool.arc.surface]]\nname = \"a\"\npaths = [\"x/\"]\nchecked_by = [\"ghost\"]\n",
                &["\"a\"", "ghost"],
            ),
            (
                "a checked_by naming a borrower",
                "[[tugtool.arc.surface]]\nname = \"a\"\npaths = [\"x/\"]\nchecked_by = [\"b\"]\n\n[[tugtool.arc.surface]]\nname = \"b\"\npaths = [\"y/\"]\nchecked_by = [\"c\"]\n\n[[tugtool.arc.surface]]\nname = \"c\"\npaths = [\"z/\"]\ncheck = [\"true\"]\n",
                &["\"a\"", "\"b\"", "one level"],
            ),
            (
                "a surface borrowing itself",
                "[[tugtool.arc.surface]]\nname = \"a\"\npaths = [\"x/\"]\nchecked_by = [\"a\"]\n",
                &["\"a\""],
            ),
            (
                "a commit_check_only with no commit_check",
                "[[tugtool.arc.surface]]\nname = \"a\"\npaths = [\"x/\"]\ncommit_check_only = [\"*.ts\"]\n",
                &["\"a\"", "commit_check_only", "no commit_check"],
            ),
        ];

        for (label, toml_text, fragments) in cases {
            let config: Config =
                toml::from_str(toml_text).unwrap_or_else(|e| panic!("{label} should parse: {e}"));
            let refusal = config
                .tugtool
                .arc
                .validate()
                .expect_err(&format!("{label} must be refused"));
            let message = refusal.to_string();
            for fragment in *fragments {
                assert!(
                    message.contains(fragment),
                    "{label}: the refusal must name {fragment:?}, said: {message}"
                );
            }
        }

        // The neighbour: everything the cases above got wrong, done right.
        let legal: Config = toml::from_str(
            "[tugtool.arc]\npost_create = []\n\n[[tugtool.arc.surface]]\nname = \"a\"\npaths = [\"src/\", \"README.md\"]\ncheck = [\"make check\"]\n\n[[tugtool.arc.surface]]\nname = \"b\"\npaths = [\"proto/\"]\nchecked_by = [\"a\"]\n",
        )
        .expect("the legal neighbour should parse");
        legal
            .tugtool
            .arc
            .validate()
            .expect("the legal neighbour must still load");
    }

    /// The runner table's refusals, in the same shape as the surface table's:
    /// each names the offending row and value, beside a legal neighbour.
    #[test]
    fn runner_table_refusals_each_name_the_offending_value() {
        let cases: &[(&str, &str, &[&str])] = &[
            (
                "an empty match",
                "[[tugtool.report.runner]]\nmatch = \" \"\nkind = \"cargo-test\"\n",
                &["empty match"],
            ),
            (
                "neither a kind nor a unit",
                "[[tugtool.report.runner]]\nmatch = \"make check\"\n",
                &["\"make check\"", "neither a kind nor a unit"],
            ),
            (
                "an unknown kind",
                "[[tugtool.report.runner]]\nmatch = \"make check\"\nkind = \"pyunit\"\n",
                &["\"make check\"", "\"pyunit\"", "cargo-test"],
            ),
            (
                "a stream outside the three",
                "[[tugtool.report.runner]]\nmatch = \"make check\"\nkind = \"lines\"\nitem = '^(?P<status>ok) (?P<name>\\S+)'\nstream = \"stdin\"\n",
                &["\"make check\"", "\"stdin\"", "stdout, stderr, both"],
            ),
            (
                "an item on a junit row",
                "[[tugtool.report.runner]]\nmatch = \"make check\"\nkind = \"junit\"\nitem = '^(?P<status>ok) (?P<name>\\S+)'\n",
                &[
                    "\"make check\"",
                    "\"junit\"",
                    "declares item",
                    "belong to kind \"lines\"",
                ],
            ),
            (
                "a total on a cargo-test row",
                "[[tugtool.report.runner]]\nmatch = \"make check\"\nkind = \"cargo-test\"\ntotal = '^running (?P<total>\\d+)'\n",
                &[
                    "\"make check\"",
                    "\"cargo-test\"",
                    "declares total",
                    "belong to kind \"lines\"",
                ],
            ),
            (
                "a stream on a self-reporting row",
                "[[tugtool.report.runner]]\nmatch = \"just app-test\"\nunit = \"file\"\nstream = \"stdout\"\n",
                &[
                    "\"just app-test\"",
                    "reports itself",
                    "declares stream",
                    "needs only its unit",
                ],
            ),
            (
                "a unit row and a kind row with the same match",
                "[[tugtool.report.runner]]\nmatch = \"just app-test\"\nunit = \"file\"\n\n[[tugtool.report.runner]]\nmatch = \"just  app-test\"\nkind = \"bun\"\n",
                &["two runners", "\"just app-test\"", "one row per head"],
            ),
            (
                "two kind rows with the same match",
                "[[tugtool.report.runner]]\nmatch = \"make check\"\nkind = \"bun\"\n\n[[tugtool.report.runner]]\nmatch = \"make check\"\nkind = \"junit\"\n",
                &["two runners", "\"make check\"", "one row per head"],
            ),
            (
                "a lines row with no item",
                "[[tugtool.report.runner]]\nmatch = \"make check\"\nkind = \"lines\"\n",
                &["\"make check\"", "no item regex"],
            ),
            (
                "an item with no status group",
                "[[tugtool.report.runner]]\nmatch = \"make check\"\nkind = \"lines\"\nitem = '^(?P<name>\\S+) ok'\n",
                &["\"make check\"", "item regex", "(?P<status>"],
            ),
            (
                "an item with no name group",
                "[[tugtool.report.runner]]\nmatch = \"make check\"\nkind = \"lines\"\nitem = '^(?P<status>ok) \\S+'\n",
                &["\"make check\"", "item regex", "(?P<name>"],
            ),
            (
                "a total with no total group",
                "[[tugtool.report.runner]]\nmatch = \"make check\"\nkind = \"lines\"\nitem = '^(?P<status>ok) (?P<name>\\S+)'\ntotal = '^running \\d+'\n",
                &["\"make check\"", "total regex", "(?P<total>"],
            ),
            (
                "an item that does not compile",
                "[[tugtool.report.runner]]\nmatch = \"make check\"\nkind = \"lines\"\nitem = '^(?P<status>ok'\n",
                &["\"make check\"", "item regex that does not compile"],
            ),
        ];

        for (label, toml_text, fragments) in cases {
            let config: Config =
                toml::from_str(toml_text).unwrap_or_else(|e| panic!("{label} should parse: {e}"));
            let refusal = config
                .tugtool
                .validate()
                .expect_err(&format!("{label} must be refused"));
            let message = refusal.to_string();
            for fragment in *fragments {
                assert!(
                    message.contains(fragment),
                    "{label}: the refusal must name {fragment:?}, said: {message}"
                );
            }
        }

        // The neighbour: a wrapped row, a self-reporting row, a wrapped row
        // that names the unit it counts in, and a `lines` row whose regexes
        // carry every group they need and which alone names a stream.
        let legal: Config = toml::from_str(
            "[[tugtool.report.runner]]\nmatch = \"make check\"\nkind = \"cargo-test\"\nsuite = \"checks\"\nlabel = \"checks\"\n\n[[tugtool.report.runner]]\nmatch = \"just app-test\"\nunit = \"file\"\n\n[[tugtool.report.runner]]\nmatch = \"bun run check\"\nkind = \"bun\"\nunit = \"file\"\n\n[[tugtool.report.runner]]\nmatch = \"make lint\"\nkind = \"lines\"\nitem = '^(?P<status>PASS|FAIL): (?P<name>\\S+)'\ntotal = '^running (?P<total>\\d+) checks'\nstream = \"both\"\nunit = \"check\"\n",
        )
        .expect("the legal neighbour should parse");
        legal
            .tugtool
            .validate()
            .expect("the legal neighbour must still load");
        assert_eq!(legal.tugtool.report.runners.len(), 4);
        assert_eq!(
            legal.tugtool.report.runners[1].unit.as_deref(),
            Some("file")
        );
    }

    /// The runner table's old spelling is refused by name rather than read as
    /// a project that declared no runners — the silent default is the one
    /// outcome a cutover with no aliases must not have.
    #[test]
    fn the_retired_run_table_is_refused_and_names_the_new_one() {
        let config: Config = toml::from_str(
            "[[tugtool.run.runner]]\nmatch = \"make check\"\nkind = \"cargo-test\"\n",
        )
        .expect("the old shape still parses");
        let message = config
            .tugtool
            .validate()
            .expect_err("the retired table must be refused")
            .to_string();
        assert!(message.contains("[tugtool.run] is retired"), "{message}");
        assert!(message.contains("[[tugtool.report.runner]]"), "{message}");
        assert!(
            config.tugtool.report.runners.is_empty(),
            "the old rows reach nothing this build reads"
        );
    }

    /// Overlap is not ambiguity: a longer prefix shadowing a shorter one is
    /// the resolution rule working, and only an *identical* claim is refused.
    #[test]
    fn overlapping_prefixes_are_legal_and_identical_ones_are_not() {
        let overlapping: Config = toml::from_str(
            "[[tugtool.arc.surface]]\nname = \"deck\"\npaths = [\"tugdeck/\"]\ncheck = [\"tsc\"]\n\n[[tugtool.arc.surface]]\nname = \"wasm\"\npaths = [\"tugdeck/crates/\"]\ncheck = [\"just wasm\"]\n",
        )
        .unwrap();
        overlapping
            .tugtool
            .arc
            .validate()
            .expect("a longer prefix shadowing a shorter one is legal");

        let identical: Config = toml::from_str(
            "[[tugtool.arc.surface]]\nname = \"deck\"\npaths = [\"tugdeck/\"]\n\n[[tugtool.arc.surface]]\nname = \"other\"\npaths = [\"tugdeck/\"]\n",
        )
        .unwrap();
        assert!(identical.tugtool.arc.validate().is_err());
    }

    /// A config file that declares the retired key does not merely fail an
    /// assertion — it stops loading, which is what makes the retirement real.
    #[test]
    fn a_config_declaring_the_retired_key_fails_to_load() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join(".tugtool")).unwrap();
        fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.arc]\nverify = \"sh scripts/check.sh {base} {head}\"\n",
        )
        .unwrap();

        let err = Config::load_from_project(root).expect_err("the retired key must refuse");
        let message = err.to_string();
        assert!(
            message.contains("[[tugtool.arc.surface]]"),
            "the refusal must point at the replacement: {message}"
        );
    }

    /// The refusals fire on what a config declares, so a project with no
    /// config file is not validated at all.
    #[test]
    fn a_missing_config_file_is_the_empty_table_and_no_error() {
        let tmp = tempfile::tempdir().unwrap();
        let config = Config::load_from_project(tmp.path()).expect("a missing file is not an error");
        assert!(config.tugtool.arc.surfaces.is_empty());
        assert!(config.tugtool.arc.retired_verify.is_none());
    }

    /// The template a fresh project starts from must itself survive the
    /// loader, and must document the table rather than the key it replaced.
    #[test]
    fn the_default_config_template_declares_a_legal_empty_table() {
        let config: Config =
            toml::from_str(DEFAULT_CONFIG).expect("the template must be valid TOML");
        config
            .tugtool
            .arc
            .validate()
            .expect("the template must validate clean");
        assert!(config.tugtool.arc.surfaces.is_empty());
        assert!(
            DEFAULT_CONFIG.contains("[[tugtool.arc.surface]]"),
            "the template must document the surface table"
        );
        for placeholder in ["{base}", "{head}", "{paths}"] {
            assert!(
                DEFAULT_CONFIG.contains(placeholder),
                "the template must document {placeholder}"
            );
        }
        assert!(
            !DEFAULT_CONFIG.contains("verify ="),
            "the template must not document the retired key"
        );
    }
    /// This repository's own committed config, through the real loader.
    ///
    /// Cheap, and it catches a hand-edit typo at commit time rather than at the
    /// next arc's ending — which is the moment a config that will not load is
    /// most expensive and least expected.
    #[test]
    fn this_repositorys_own_config_loads_and_validates() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .expect("the crate sits three levels under the repo root")
            .to_path_buf();
        let config_path = root.join(".tugtool/config.toml");
        if !config_path.exists() {
            // A checkout without one is not this repository; nothing to assert.
            return;
        }
        // Transitional, for the length of the arc that renamed this table:
        // this checkout's own file stays under the retired `[tugtool.dash]` so
        // the installed engine driving that arc keeps reading the project's
        // surfaces and stage models. The hand-edit typo this test exists to
        // catch lives in the declarations rather than in the table's name, so
        // the declarations are read under the name this build knows.
        let text = fs::read_to_string(&config_path)
            .expect("this repository's committed config must be readable")
            .replace("[tugtool.dash]", "[tugtool.arc]")
            .replace("[[tugtool.dash.surface]]", "[[tugtool.arc.surface]]");
        let staged = tempfile::tempdir().unwrap();
        let staged_path = staged.path().join("config.toml");
        fs::write(&staged_path, text).unwrap();
        let config = Config::load(&staged_path)
            .expect("this repository's committed config must load through the real loader");
        assert!(
            !config.tugtool.arc.surfaces.is_empty(),
            "this repository declares its surfaces"
        );
        assert!(
            config.tugtool.arc.retired_verify.is_none(),
            "the retired key would make this config unloadable"
        );
    }

    /// The retired `[tugtool.dash]` table is refused rather than ignored.
    ///
    /// Ignoring it would be the worst of the three outcomes: a project whose
    /// hydration, surfaces and stage models are all still under the old key
    /// would read as a project that declared none of them, and every one of
    /// those absences is silent at the moment it matters.
    #[test]
    fn the_retired_dash_table_is_refused_and_its_values_are_not_read() {
        let toml_text = "[tugtool.dash]\npost_create = [\"echo hi\"]\nbuild = \"make app\"\n\n[[tugtool.dash.surface]]\nname = \"src\"\npaths = [\"src/\"]\ncheck = [\"make check\"]\n";
        let config: Config = toml::from_str(toml_text).expect("the old shape still parses");

        let refusal = config
            .tugtool
            .validate()
            .expect_err("the retired table must be refused");
        assert_eq!(refusal, ConfigRefusal::RetiredDashTable);
        let message = refusal.to_string();
        for table in ["[tugtool.dash]", "[tugtool.arc]"] {
            assert!(
                message.contains(table),
                "the refusal must name both tables: {message}"
            );
        }

        // And nothing under the old key reached the arc declarations, so a
        // refusal that somebody worked around would not silently run them.
        assert!(config.tugtool.arc.post_create.is_empty());
        assert!(config.tugtool.arc.surfaces.is_empty());
        assert!(config.tugtool.arc.build.is_none());
    }

    /// The refusal reaches the real loader, which is where `run_post_create`
    /// and every other consumer gets its config from.
    #[test]
    fn a_project_under_the_retired_table_does_not_load() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join(".tugtool")).unwrap();
        fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.dash]\npost_create = [\"touch ran.sentinel\"]\n",
        )
        .unwrap();

        let err = Config::load_from_project(root).expect_err("the retired table must refuse");
        let message = err.to_string();
        assert!(
            message.contains("[tugtool.dash]") && message.contains("[tugtool.arc]"),
            "the refusal must name both tables: {message}"
        );
    }

    /// A checkout still carrying the retired `docs` declaration loads: serde
    /// ignores unknown keys, so nobody has to edit a config file to upgrade.
    #[test]
    fn a_stale_docs_key_is_ignored() {
        let config: Config = toml::from_str("[tugtool.arc]\ndocs = \"arc\"\n")
            .expect("a config carrying a retired key still parses");
        assert!(config.tugtool.arc.build.is_none());
    }

    #[test]
    fn test_default_config() {
        let config = Config::default();
        assert!(config.tugtool.arc.post_create.is_empty());
    }

    #[test]
    fn arc_declarations_parse() {
        let toml = "[tugtool.arc]\npost_create = [\"bun install\"]\nbuild = \"just app-debug\"\n\n[[tugtool.arc.surface]]\nname = \"deck\"\npaths = [\"tugdeck/\"]\ncheck = [\"bunx tsc --noEmit\"]\n";
        let config: Config = toml::from_str(toml).expect("declaring config should parse");
        assert_eq!(config.tugtool.arc.build.as_deref(), Some("just app-debug"));
        let surfaces = &config.tugtool.arc.surfaces;
        assert_eq!(surfaces.len(), 1);
        assert_eq!(surfaces[0].name, "deck");
        assert_eq!(surfaces[0].paths, vec!["tugdeck/".to_string()]);
        assert_eq!(surfaces[0].check, vec!["bunx tsc --noEmit".to_string()]);
        assert!(surfaces[0].checked_by.is_empty());
        config.tugtool.arc.validate().expect("a legal table loads");
    }

    #[test]
    fn arc_declarations_default_to_none() {
        // A project that declares only hydration leaves the ending undeclared.
        let toml = "[tugtool.arc]\npost_create = [\"echo hi\"]\n";
        let config: Config = toml::from_str(toml).expect("partial config should parse");
        assert!(config.tugtool.arc.surfaces.is_empty());
        assert!(config.tugtool.arc.build.is_none());

        // So does a project with no arc table at all.
        let empty: Config = toml::from_str("").expect("empty config should parse");
        assert!(empty.tugtool.arc.surfaces.is_empty());
        assert!(empty.tugtool.arc.build.is_none());
    }

    #[test]
    fn doctrine_and_laws_parse_as_lists() {
        let toml = "[tugtool.arc]\ndoctrine = [\"doc/arc.md\"]\nlaws = [\"doc/laws.md\", \"doc/decisions.md\"]\n";
        let config: Config =
            toml::from_str(toml).expect("declaring doctrine and laws should parse");
        let arc = &config.tugtool.arc;
        assert_eq!(arc.doctrine, vec!["doc/arc.md".to_string()]);
        assert_eq!(
            arc.laws,
            vec!["doc/laws.md".to_string(), "doc/decisions.md".to_string()]
        );
    }

    #[test]
    fn doctrine_and_laws_default_to_empty() {
        // Declaring neither is the plugin's doctrine standing alone, so the
        // parse is an empty list rather than an error or a missing table.
        let silent: Config = toml::from_str("[tugtool.arc]\npost_create = []\n").unwrap();
        assert!(silent.tugtool.arc.doctrine.is_empty());
        assert!(silent.tugtool.arc.laws.is_empty());
        let empty: Config = toml::from_str("").unwrap();
        assert!(empty.tugtool.arc.doctrine.is_empty());
        assert!(empty.tugtool.arc.laws.is_empty());
    }

    #[test]
    fn the_default_config_template_documents_doctrine_and_laws() {
        let config: Config = toml::from_str(DEFAULT_CONFIG).unwrap();
        assert!(config.tugtool.arc.doctrine.is_empty());
        assert!(config.tugtool.arc.laws.is_empty());
        assert!(DEFAULT_CONFIG.contains("# doctrine = ["));
        assert!(DEFAULT_CONFIG.contains("# laws = ["));
    }

    #[test]
    fn stage_declarations_parse() {
        let toml = "[tugtool.arc]\ndevise_model = \"sonnet\"\nreview_model = \"opus\"\nimplement_model = \"fable\"\nimplement_compact_tokens = 120000\n";
        let config: Config = toml::from_str(toml).expect("declaring stage models should parse");
        let arc = &config.tugtool.arc;
        assert_eq!(arc.devise_model.as_deref(), Some("sonnet"));
        assert_eq!(arc.review_model.as_deref(), Some("opus"));
        assert_eq!(arc.implement_model.as_deref(), Some("fable"));
        assert_eq!(arc.implement_compact_tokens, Some(120_000));
        assert_eq!(arc.compact_tokens(), 120_000);
    }

    #[test]
    fn yield_and_backstop_shares_parse_and_default() {
        let toml = "[tugtool.arc]\nimplement_yield_share = 0.5\nimplement_backstop_share = 0.9\n";
        let config: Config = toml::from_str(toml).expect("declared shares should parse");
        let arc = &config.tugtool.arc;
        assert_eq!(arc.implement_yield_share, Some(0.5));
        assert_eq!(arc.implement_backstop_share, Some(0.9));
        assert_eq!(arc.yield_share(), 0.5);
        assert_eq!(arc.backstop_share(), 0.9);

        // Undeclared stays `None` in the parse, so `arc config` can say so,
        // and the default is applied at the consumer.
        let silent: Config = toml::from_str("[tugtool.arc]\npost_create = []\n").unwrap();
        let arc = &silent.tugtool.arc;
        assert!(arc.implement_yield_share.is_none());
        assert!(arc.implement_backstop_share.is_none());
        assert_eq!(arc.yield_share(), IMPLEMENT_YIELD_SHARE_DEFAULT);
        assert_eq!(arc.backstop_share(), IMPLEMENT_BACKSTOP_SHARE_DEFAULT);
        assert_eq!(IMPLEMENT_YIELD_SHARE_DEFAULT, 0.60);
        assert_eq!(IMPLEMENT_BACKSTOP_SHARE_DEFAULT, 0.85);

        // The token line is untouched by either.
        assert_eq!(arc.compact_tokens(), IMPLEMENT_COMPACT_TOKENS_DEFAULT);
    }

    #[test]
    fn a_share_outside_zero_to_one_is_the_default() {
        for bad in [0.0, -0.2, 1.5, 60.0, f64::NAN] {
            let arc = ArcConfig {
                implement_yield_share: Some(bad),
                implement_backstop_share: Some(bad),
                ..ArcConfig::default()
            };
            assert_eq!(arc.yield_share(), IMPLEMENT_YIELD_SHARE_DEFAULT, "{bad}");
            assert_eq!(
                arc.backstop_share(),
                IMPLEMENT_BACKSTOP_SHARE_DEFAULT,
                "{bad}"
            );
        }
        let whole = ArcConfig {
            implement_yield_share: Some(1.0),
            ..ArcConfig::default()
        };
        assert_eq!(whole.yield_share(), 1.0, "one is a share");
    }

    #[test]
    fn stage_declarations_default_to_none_and_the_threshold_to_the_consumer() {
        // Undeclared stays `None` in the parse — that is what lets `arc
        // config` report honestly that the project chose nothing — and the
        // default is applied where the value is used.
        let silent: Config = toml::from_str("[tugtool.arc]\npost_create = []\n").unwrap();
        let arc = &silent.tugtool.arc;
        assert!(arc.devise_model.is_none());
        assert!(arc.review_model.is_none());
        assert!(arc.implement_model.is_none());
        assert!(arc.implement_compact_tokens.is_none());
        assert_eq!(arc.compact_tokens(), IMPLEMENT_COMPACT_TOKENS_DEFAULT);
        assert_eq!(IMPLEMENT_COMPACT_TOKENS_DEFAULT, 300_000);

        // So does a project with no arc table at all.
        let empty: Config = toml::from_str("").unwrap();
        assert_eq!(
            empty.tugtool.arc.compact_tokens(),
            IMPLEMENT_COMPACT_TOKENS_DEFAULT
        );
    }

    /// The settle's default is a real one and a declared `0` is the way to ask
    /// for the old behaviour — the same two-state shape the clock's deadline
    /// takes, and for the same reason: a project that wants the runner acting
    /// on the instant a reading was taken has to say so.
    #[test]
    fn idle_settle_zero_turns_the_settle_off() {
        assert_eq!(
            ArcConfig::default().idle_settle(),
            Some(std::time::Duration::from_secs(IDLE_SETTLE_SECS_DEFAULT)),
            "declaring nothing is the default settle, not none",
        );
        assert_eq!(
            ArcConfig {
                idle_settle_secs: Some(0),
                ..ArcConfig::default()
            }
            .idle_settle(),
            None,
            "a declared zero is the settle turned off",
        );
        assert_eq!(
            ArcConfig {
                idle_settle_secs: Some(12),
                ..ArcConfig::default()
            }
            .idle_settle(),
            Some(std::time::Duration::from_secs(12)),
            "and anything else is taken at its word",
        );
    }

    /// The horizon takes the settle's two-state shape for the same reason: a
    /// project that wants a held boundary to stand — until the job reaper or a
    /// person reaches it, which is where this arc found the machine — has to
    /// say so.
    #[test]
    fn boundary_horizon_zero_turns_it_off() {
        assert_eq!(
            ArcConfig::default().boundary_horizon(),
            Some(std::time::Duration::from_secs(
                BOUNDARY_HORIZON_SECS_DEFAULT
            )),
            "declaring nothing is the default horizon, not none",
        );
        assert_eq!(
            ArcConfig {
                boundary_horizon_secs: Some(0),
                ..ArcConfig::default()
            }
            .boundary_horizon(),
            None,
            "a declared zero is the horizon turned off",
        );
        assert_eq!(
            ArcConfig {
                boundary_horizon_secs: Some(1),
                ..ArcConfig::default()
            }
            .boundary_horizon(),
            Some(std::time::Duration::from_secs(1)),
            "and anything else is taken at its word",
        );
    }

    #[test]
    fn the_default_config_template_documents_every_stage_key() {
        let config: Config =
            toml::from_str(DEFAULT_CONFIG).expect("the template must be valid TOML");
        // The template documents the keys as comments, so a project starting
        // from it declares none of them.
        assert!(config.tugtool.arc.devise_model.is_none());
        for key in [
            "devise_model",
            "review_model",
            "implement_model",
            "implement_compact_tokens",
            "implement_yield_share",
            "implement_backstop_share",
            "idle_settle_secs",
            "boundary_horizon_secs",
        ] {
            assert!(
                DEFAULT_CONFIG.contains(key),
                "the template must document {key}"
            );
        }
    }

    #[test]
    fn test_unknown_keys_are_ignored() {
        // Stale checkouts carry the old validation fields; they must still parse.
        let toml = "[tugtool]\nvalidation_level = \"strict\"\nshow_info = true\n\n[tugtool.arc]\npost_create = [\"echo hi\"]\n";
        let config: Config = toml::from_str(toml).expect("legacy config should still parse");
        assert_eq!(config.tugtool.arc.post_create, vec!["echo hi".to_string()]);
    }

    /// A project that declares nothing has no `.tugtool/`; its git root is
    /// still its root, and its config is the defaults.
    #[test]
    fn a_checkout_without_tugtool_is_a_project_with_default_config() {
        let dir = tempfile::tempdir().expect("temp");
        let root = dir.path().canonicalize().expect("canonical");
        fs::create_dir_all(root.join(".git")).expect(".git");
        fs::create_dir_all(root.join("src/deep")).expect("src");

        let found = find_project_root_from(root.join("src/deep")).expect("a root");
        assert_eq!(found, root);
        let config = Config::load_from_project(&found).expect("defaults");
        assert!(config.tugtool.arc.build.is_none());

        fs::create_dir_all(root.join("src/.tugtool")).expect(".tugtool");
        let found = find_project_root_from(root.join("src/deep")).expect("a root");
        assert_eq!(found, root.join("src"), ".tugtool outranks the checkout");
    }

    #[test]
    fn a_directory_inside_no_checkout_is_uninitialized() {
        let dir = tempfile::tempdir().expect("temp");
        let err = find_project_root_from(dir.path().to_path_buf()).expect_err("no root");
        assert!(matches!(err, TugError::NotInitialized));
    }
}
