//! The standing-tripwire ledger — every tripwire laid on this machine, and
//! every trip any instance has run.
//!
//! The lifecycle these statuses spell out is argued in `tuglaws/tripwires.md`.
//!
//! **Machine-global**, beside `changes.db` rather than inside an instance
//! directory (`tugcore::instance::tripwires_db_path`), because a tripwire is a
//! standing condition on *the machine's* sessions: it is laid by a `tugtool`
//! in one process, read by whichever instances happen to be up, and expected
//! to still be there tomorrow when none of them are. Per-instance, a tripwire
//! would be laid in a window and vanish with it.
//!
//! **The machine ceiling is the one cross-instance invariant**, and the only
//! reason two engines need one table: `max_concurrent_trips` rations worktrees
//! across every instance at once, so a count that each instance kept to itself
//! would ration nothing. A *firing* is not arbitrated here and needs no
//! arbitration — each fact is recorded by one instance and evaluated by that
//! instance's engine, and the event key carries the instance id, so two
//! engines never meet on one row.
//!
//! **Multi-writer by design, with no writer lock.** Four independent processes
//! write here — this instance's engine and request surface, a `tugtool` in
//! another process, and another instance's engine — so a single-writer
//! contract would need cross-instance routing that does not exist
//! machine-globally. WAL plus `busy_timeout` carries this write pattern: small
//! rows, single statements, no cross-row invariants.
//!
//! **The rule that keeps it true: no API here may hold a transaction across a
//! network call, a subprocess, or an await point.** Every write below is a
//! single statement. A transaction held open while an agent runs would block
//! every other instance's claim for the length of a model turn, and the
//! reason the pattern works is that nothing here is ever open that long.
//!
//! Schema changes forever mean bumping [`TRIPWIRE_SCHEMA_VERSION`] with a
//! registered migration, never editing the DDL alone — the same regime as
//! `changes.db` and the app-test results ledger.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::tripwire_predicate::Predicate;

/// Current on-disk schema version, stamped into `PRAGMA user_version`.
pub const TRIPWIRE_SCHEMA_VERSION: i64 = 12;

/// How many trips are kept per tripwire. Older rows are deleted at record
/// time — the regime the app-test results ledger already runs. A tripwire that
/// fires on every commit fact would otherwise grow its log without bound, and the
/// card's older-trips cue would never bottom out. The rows a reader wants are
/// the newest ones, so the cap loses nothing anybody would page to.
///
/// This is a DELETE at write time rather than DDL, so it moves no schema
/// version and registers no migration.
pub const MAX_TRIPS_PER_TRIPWIRE: i64 = 500;

/// Registered migrations, each keyed by the on-disk version it upgrades
/// *from*. Every migration whose `from` is at or above the version found on
/// disk is applied in order. Empty at v1; a schema change adds an entry here
/// and bumps [`TRIPWIRE_SCHEMA_VERSION`] — never edits the DDL alone.
const TRIPWIRE_MIGRATIONS: &[(i64, &str)] = &[
    (1, MIGRATE_V1_TO_V2),
    (2, MIGRATE_V2_TO_V3),
    (3, MIGRATE_V3_TO_V4),
    (4, MIGRATE_V4_TO_V5),
    (5, MIGRATE_V5_TO_V6),
    (6, MIGRATE_V6_TO_V7),
    (7, MIGRATE_V7_TO_V8),
    (8, MIGRATE_V8_TO_V9),
    (9, MIGRATE_V9_TO_V10),
    (10, MIGRATE_V10_TO_V11),
    (11, MIGRATE_V11_TO_V12),
];

/// v1 → v2: a tripwire names the base branch it watches, the retired knobs go, and
/// the per-session fact marks get their table.
///
/// The order is load-bearing. `branch` is added *after* the drops so the
/// column order a migrated ledger ends up with is the one
/// [`CREATE_TRIPWIRES_SQL`] builds from scratch — the two shapes have to be
/// indistinguishable, and column order is part of the shape. The empty default
/// is a placeholder the backfill in [`prepare`] replaces, because the branch a
/// row should carry is a question about a git repository that SQL cannot ask.
const MIGRATE_V1_TO_V2: &str = "
    ALTER TABLE wires DROP COLUMN tier;
    ALTER TABLE wires DROP COLUMN post;
    ALTER TABLE wires DROP COLUMN cooldown_secs;
    ALTER TABLE wires ADD COLUMN branch TEXT NOT NULL DEFAULT '';
    CREATE TABLE IF NOT EXISTS wire_marks (
        wire_id        INTEGER NOT NULL REFERENCES wires(id) ON DELETE CASCADE,
        session_id     TEXT    NOT NULL,
        max_fact_rowid INTEGER NOT NULL,
        PRIMARY KEY (wire_id, session_id)
    );
";

/// v2 → v3: a resolution may ask for a change to be authored, and the ask has
/// to survive the process that heard it.
///
/// The diagnosis session and the authoring session are two spawns with a
/// ledger write between them ([P04]), so the ask cannot live in memory: the
/// engine that reads it may not be the one that wrote it. One nullable column,
/// appended, which is what `ALTER TABLE ADD COLUMN` does — so a migrated
/// ledger and a fresh one carry the same column order.
const MIGRATE_V2_TO_V3: &str = "
    ALTER TABLE trips ADD COLUMN author_ask TEXT;
";

/// v3 → v4: the prose scraper's vocabulary goes with the scraper ([P07]).
///
/// `interest` and `outcome` were the two fields the prose scraper filled in,
/// and the resolution verb replaced both — nothing has written either since
/// the rebuild, so they are columns a reader of the trip log could only ever
/// find empty. Dropped rather than left standing, because a column nothing
/// writes is a question every later reader has to answer for themselves.
const MIGRATE_V3_TO_V4: &str = "
    ALTER TABLE trips DROP COLUMN interest;
    ALTER TABLE trips DROP COLUMN outcome;
";

/// v4 → v5: the work unit is an arc, so the value a refusal records is too.
///
/// Only the stored *value* is here. The column rename that goes with it lives
/// in [`migrate_trips_arc_column`] rather than in this string, because
/// `ALTER TABLE … RENAME COLUMN` is not idempotent the way these statements
/// are, and because a pre-versioning ledger never reaches this list at all —
/// the probe covers both, and this `UPDATE` matching zero rows costs nothing
/// when it does.
const MIGRATE_V4_TO_V5: &str = "
    UPDATE trips SET swallow_reason = 'own-arc' WHERE swallow_reason = 'own-dash';
";

/// v5 → v6: the tables and the column spell the feature's own noun.
///
/// Registered so the list above is the whole record of what every schema
/// version was, and empty of statements because every statement v6 needs is a
/// rename: `ALTER TABLE … RENAME TO` and `RENAME COLUMN` both fail the second
/// time they run, and a crash between a batch's statements and the version
/// stamp re-runs the batch on the next open. So the renames live in
/// [`migrate_tripwire_names`], which probes the shape on disk and does nothing
/// when it is already the new one — the same reason and the same shape as
/// [`migrate_trips_arc_column`].
const MIGRATE_V5_TO_V6: &str = "
    -- Renames only; see `migrate_tripwire_names`.
";

/// v6 → v7: a tripwire says what it does in a sentence a person reads.
///
/// The brief is the prompt a trip runs on and has exactly one reader that is
/// not a display — the model ([B01]) — so the card's definition needs a line
/// of its own, appended — which is what `ALTER TABLE … ADD COLUMN` does, so a
/// migrated ledger and a fresh one carry the same column order.
///
/// Registered so the list above is the whole record of what every schema
/// version was, and empty of statements for the same two reasons
/// [`MIGRATE_V5_TO_V6`] is. `ADD COLUMN` fails the second time it runs, and a
/// crash between a batch's statements and the version stamp re-runs the
/// batch. And this list runs *before* [`migrate_tripwire_names`], so on a v1
/// or v5 ledger there is no table called `tripwires` here yet to add a column
/// to. The statement lives in [`migrate_tripwire_description`], which probes
/// the shape on disk and does nothing when the column is already there.
const MIGRATE_V6_TO_V7: &str = "
    -- One appended column; see `migrate_tripwire_description`.
";

/// v7 → v8: the trigger is the fact, so the status vocabulary shrinks to six
/// words, the branch gate goes, the per-session marks go, and the row carries
/// the checkout it stood in (Spec S03).
///
/// The four statuses that arbitrated one event between two instances collapse
/// to the one word that describes every one of them from a reader's side: the
/// trip did not run. `settled` becomes `quiet`, which says what it meant. The
/// marks table held a per-session ceiling over a fact lookback that no longer
/// happens.
///
/// Only the two value rewrites are here, and for the reason
/// [`MIGRATE_V6_TO_V7`] gives twice over. This list runs *before*
/// [`migrate_tripwire_names`], so on a v1 or v5 ledger there is no table
/// called `tripwires` yet to drop a column from; and `RENAME COLUMN`,
/// `ADD COLUMN` and `DROP COLUMN` all fail the second time they run, while a
/// crash between a batch's statements and the version stamp re-runs the batch.
/// So everything shape-changing lives in a probe:
/// [`migrate_trips_reason_column`], [`migrate_tripwire_branch_column`],
/// [`migrate_trips_repo_columns`] and [`migrate_drop_tripwire_marks`]. These
/// two `UPDATE`s are idempotent, name a table that has always been called
/// `trips`, and match zero rows the second time.
const MIGRATE_V7_TO_V8: &str = "
    UPDATE trips SET status = 'skipped' WHERE status IN ('claimed','swallowed','superseded','queued');
    UPDATE trips SET status = 'quiet'   WHERE status = 'settled';
";

/// v8 → v9: a trip is one session with hands, so the ask that opened a second
/// one goes ([P01]).
///
/// `author_ask` carried a diagnosis session's request to have a change
/// authored across the ledger write that separated it from the authoring
/// spawn. There is no second spawn any more — the tripwire's own session has
/// hands from its first turn — so the column is one nothing writes and no
/// reader of the trip log could ever find filled.
///
/// Registered so the list above is the whole record of what every schema
/// version was, and empty of statements for the reason [`MIGRATE_V5_TO_V6`]
/// gives: `DROP COLUMN` fails the second time it runs, and a crash between a
/// batch's statements and the version stamp re-runs the batch on the next
/// open. The statement lives in [`migrate_trips_author_ask`], which probes the
/// shape on disk and does nothing when the column is already gone.
const MIGRATE_V8_TO_V9: &str = "
    -- One dropped column; see `migrate_trips_author_ask`.
";

/// v9 → v10: a tripwire owns one arc in a recorded home checkout, and no trip
/// stands in a disposable tree cut at a sha ([P02], [P03]).
///
/// `tripwires.repo_root` is the checkout the arc lives in, resolved once at
/// `lay`. `trips.head_sha` named the commit a disposable tree was cut at, and
/// there is no such tree any more: a trip works in the tripwire's own
/// worktree, replayed onto the base's `HEAD` before it runs.
///
/// Registered so the list above is the whole record of what every schema
/// version was, and empty of statements for the reason [`MIGRATE_V5_TO_V6`]
/// gives twice over: `ADD COLUMN` and `DROP COLUMN` both fail the second time
/// they run, and a crash between a batch's statements and the version stamp
/// re-runs the batch. The statements live in
/// [`migrate_tripwire_repo_root`] and [`migrate_trips_head_sha`].
const MIGRATE_V9_TO_V10: &str = "
    -- One added column and one dropped; see `migrate_tripwire_repo_root`
    -- and `migrate_trips_head_sha`.
";

/// v10 → v11: a trip ends with a report rather than with a verb, and the six
/// words a trip could stand in become four ([P04], [P05]).
///
/// `quiet`, `awaiting` and `adopted` all named a finished trip — one that
/// found nothing, one holding a question until the user saw it, one whose
/// session a card had taken over. None of the three is a distinction the
/// engine can still draw: there is no verb for the model to choose a word
/// with, no live-run slot for a finished trip to hold, and no second owner of
/// a session the engine never stops watching. So they collapse into `done`,
/// and what a reader wants to know instead — what the trip found, and whether
/// it committed anything — is read off `report` and `rounds`.
///
/// The `UPDATE` is here rather than in a probe because it is idempotent on its
/// face: a second run matches no rows. The two added columns are not, and live
/// in [`migrate_trips_report_columns`] for the reason [`MIGRATE_V5_TO_V6`]
/// gives.
const MIGRATE_V10_TO_V11: &str = "
    UPDATE trips SET status = 'done'
     WHERE status IN ('quiet', 'awaiting', 'adopted');
";

/// v11 → v12: a tripwire says how long a trip of it may run and how many tool
/// calls it may spend ([P06]).
///
/// The cost of laying a tripwire was unknowable before it was laid: a session
/// with hands and no ceiling could grind for an afternoon, and nothing on the
/// row said otherwise. Both caps are columns rather than engine constants
/// because the right numbers are a question a week of armed tripwires answers,
/// and a rebuild should not be what it costs to change them.
///
/// Registered so the list above is the whole record of what every schema
/// version was, and empty of statements for the reason [`MIGRATE_V5_TO_V6`]
/// gives: `ADD COLUMN` fails the second time it runs, and a crash between a
/// batch's statements and the version stamp re-runs the batch. The statements
/// live in [`migrate_tripwire_caps`].
const MIGRATE_V11_TO_V12: &str = "
    -- Two appended columns; see `migrate_tripwire_caps`.
";

/// How long a trip's session may run before the engine interrupts it and
/// closes it ([P06], [Q01]).
///
/// A starting guess rather than a settled number, which is exactly why it is a
/// per-tripwire column with this as its default: a week of armed tripwires and
/// the `cap-seconds` rows they leave is the evidence that settles it, and
/// gathering that evidence costs no code change.
pub const MAX_TRIP_SECONDS_DEFAULT: i64 = 120;

/// How many tool calls a trip's session may spend before the same thing
/// happens ([P06], [Q01]). A starting guess, for the reason above.
pub const MAX_TRIP_TOOL_CALLS_DEFAULT: i64 = 30;

/// Default ceiling on `running` trips machine-wide, when the `settings` table
/// names none. A commit storm must not fan out one arc worktree per commit.
pub const DEFAULT_MAX_CONCURRENT_TRIPS: i64 = 2;

/// The hard bound the `settings` row is clamped to, whatever it says.
///
/// The default above rations arc worktrees; this rations the *host*. A trip's
/// session is an ordinary session and spends the supervisor's per-process
/// memory budget like every other, so a trip ceiling above that budget is a
/// number the machine could never honour — and a typo in a settings row must
/// not let a commit storm outrun the host any more than a malformed one may
/// stop every tripwire. It is the supervisor's `max_concurrent_sessions`,
/// written again here because this crate sits below `tugcast` and cannot read
/// it; `each_budget_says_what_it_rations_and_the_trip_ceiling_fits_the_hosts`
/// in `tugcast`'s tripwire engine is what fails if the two ever drift apart.
pub const MAX_CONCURRENT_TRIPS_LIMIT: i64 = 64;

/// The `settings` key holding the machine-wide concurrency ceiling.
pub const SETTING_MAX_CONCURRENT_TRIPS: &str = "max_concurrent_trips";

/// The arc a tripwire owns: `tripwire-<name>` ([P02]).
///
/// Here rather than beside either caller because three surfaces spell it — the
/// engine that runs a trip in it, the CLI that creates it at `lay`, and the
/// roster projection that has to say which worktree a trip's session is
/// standing in — and a tripwire whose arc two of them disagree about is a
/// tripwire with two arcs.
pub fn tripwire_arc(tripwire: &str) -> String {
    format!("tripwire-{tripwire}")
}

/// How much of a probe's output a trip row keeps. The tail, because a probe
/// that failed says why at the end.
pub const PROBE_TAIL_CAP: usize = 8 * 1024;

/// The schema spells the feature's own noun. `tripwires` and
/// `trips.tripwire_id` are what a reader of this ledger — in a query somebody
/// writes at three in the morning — finds, and they are the same word the
/// card, the CLI and every other surface use.
const CREATE_TRIPWIRES_SQL: &str = "
    CREATE TABLE IF NOT EXISTS tripwires (
        id              INTEGER PRIMARY KEY,
        name            TEXT    NOT NULL UNIQUE,
        created_at      INTEGER NOT NULL,
        trigger         TEXT    NOT NULL,
        scope           TEXT,
        probe           TEXT,
        brief           TEXT    NOT NULL,
        model           TEXT,
        permission_mode TEXT    NOT NULL DEFAULT 'acceptEdits',
        paused          INTEGER NOT NULL DEFAULT 0,
        description     TEXT    NOT NULL DEFAULT '',
        repo_root       TEXT    NOT NULL DEFAULT '',
        max_seconds     INTEGER NOT NULL DEFAULT 120,
        max_tool_calls  INTEGER NOT NULL DEFAULT 30
    );
    CREATE TABLE IF NOT EXISTS trips (
        id             INTEGER PRIMARY KEY,
        tripwire_id    INTEGER NOT NULL REFERENCES tripwires(id) ON DELETE CASCADE,
        event_key      TEXT    NOT NULL,
        at_ms          INTEGER NOT NULL,
        instance       TEXT    NOT NULL,
        status         TEXT    NOT NULL,
        reason         TEXT,
        event_payload  TEXT,
        probe_exit     INTEGER,
        probe_tail     TEXT,
        session_id     TEXT,
        arc            TEXT,
        headline       TEXT,
        refs           TEXT,
        settled_at_ms  INTEGER,
        repo_root      TEXT,
        report         TEXT,
        rounds         INTEGER,
        UNIQUE(tripwire_id, event_key)
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS trips_by_tripwire ON trips (tripwire_id, id);
    CREATE INDEX IF NOT EXISTS trips_by_status ON trips (status);
";

#[derive(Debug, thiserror::Error)]
pub enum TripwireLedgerError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("tripwires schema on disk is v{on_disk}, newer than this build's v{supported}")]
    SchemaTooNew { on_disk: i64, supported: i64 },
    #[error("a tripwire named {0} already exists")]
    DuplicateName(String),
    #[error("no tripwire named {0}")]
    NoSuchTripwire(String),
    #[error("{0}")]
    BadTrigger(String),
    #[error(
        "the brief for tripwire {0} says nothing for the AI to do: {1}. A brief is the whole instruction a trip runs on, so a placeholder buys a model run per firing and a trip log full of `no further detail available to assess significance` — say what to look at and what to report."
    )]
    EmptyBrief(String, &'static str),
    #[error(
        "the description for tripwire {0} says nothing a person could recognise it by: {1}. The description is the line the Tripwires card shows in place of the brief, so a placeholder leaves a row nobody can tell from its neighbours — say in one sentence what this tripwire does and when it will speak."
    )]
    EmptyDescription(String, &'static str),
    #[error(
        "tripwire {0} has a trip running, so it cannot be removed. A running trip is a session working in the tripwire's arc worktree; open it or wait for it to settle, and remove the tripwire after."
    )]
    TripRunning(String),
}

/// The floor a brief has to clear to be worth firing on.
///
/// Three words and twelve characters is deliberately low: it is a placeholder
/// filter, not a quality bar, and a terse real brief ("Say what broke") clears
/// it. What it stops is the shape that has actually happened — a tripwire laid
/// with `--brief b` during a shakedown, which then summoned a model on every
/// commit to report that it had been told nothing.
///
/// The character floor earns its place beside the word count rather than
/// duplicating it: `aa bb cc` is three words and still says nothing.
const BRIEF_MIN_WORDS: usize = 3;
const BRIEF_MIN_CHARS: usize = 12;

/// Whether a brief gives a trip anything to do, and if not, why not.
///
/// The same [B07] posture as the scope check above: a tripwire that
/// cannot possibly produce anything useful is refused at the arming gesture,
/// because the alternative is finding out from a trip log weeks later — and in
/// this case paying for a model run on every firing until you do.
fn brief_fault(brief: &str) -> Option<&'static str> {
    let trimmed = brief.trim();
    if trimmed.is_empty() {
        return Some("it is empty");
    }
    if trimmed.chars().count() < BRIEF_MIN_CHARS
        || trimmed.split_whitespace().count() < BRIEF_MIN_WORDS
    {
        return Some("it is a placeholder, not an instruction");
    }
    None
}

/// Refuse a brief that gives a trip nothing to do. Called by every write path
/// that sets one, so no route into the table can leave a no-op behind.
pub fn check_brief(name: &str, brief: &str) -> Result<(), TripwireLedgerError> {
    match brief_fault(brief) {
        Some(why) => Err(TripwireLedgerError::EmptyBrief(name.to_string(), why)),
        None => Ok(()),
    }
}

/// Refuse a description that tells a reader nothing. Called by every write
/// path that sets one, on the same footing as [`check_brief`] and against the
/// same placeholder floor: the point is to stop `--description d`, not to
/// grade prose.
pub fn check_description(name: &str, description: &str) -> Result<(), TripwireLedgerError> {
    match brief_fault(description) {
        Some(why) => Err(TripwireLedgerError::EmptyDescription(name.to_string(), why)),
        None => Ok(()),
    }
}

// MARK: - Rows

/// Why a trip did not run, or how one that ran was stopped. Free text in the
/// column, named constants here, because a reason a reader sees on a row and a
/// reason the engine writes have to be the same word.
///
/// The three skips are the whole list of them, and each is an engineering
/// guard rather than a judgment about the fact: the tripwire was already
/// working a trip, the machine was at its trip ceiling, or the host had no
/// room for a session. A fact that simply did not match writes no row at all
/// ([P04]) — there is nothing on disk to explain. The two caps below are the
/// other kind: a trip that ran and was stopped, which is a `failed` row rather
/// than a skip.
pub const SKIP_BUSY: &str = "busy";

/// The machine was already running its ceiling of trips.
pub const SKIP_CEILING: &str = "ceiling";

/// The host had no room to spawn the trip's session.
pub const SKIP_NO_ROOM: &str = "no-room";

/// The trip's session ran past the tripwire's wall-clock cap and the engine
/// stopped it ([P06]). A `failed` row's reason rather than a skip's: the trip
/// ran, and what is wrong is that it would not stop.
pub const FAIL_CAP_SECONDS: &str = "cap-seconds";

/// The trip's session spent the tripwire's whole tool-call budget and the
/// engine stopped it ([P06]).
pub const FAIL_CAP_TOOL_CALLS: &str = "cap-tool-calls";

/// Where a trip stands — four words, and the whole life of one firing ([P05]).
///
/// Every value here is a row somebody can read. The gates that write *no* row
/// — a fact that did not match, a fact outside the scope, a fact the tripwire's
/// own session recorded — are not statuses, because nothing happened that a
/// trip log should carry a line about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TripStatus {
    /// The fact matched and the trip did not run anyway: the tripwire was
    /// busy, the machine was at its ceiling, or the host had no room. The
    /// `reason` column says which.
    Skipped,
    /// An agent or a probe is working it now.
    Running,
    /// Finished. What it found is in `report`, and whether it committed
    /// anything is in `rounds` — neither of which is a word the model chose
    /// ([P04], [P05]). There is no second finished status because there is no
    /// second thing a finished trip can be: a trip that found nothing and a
    /// trip that found something both ran to the end and both left a report.
    Done,
    /// Finished without one — a session that died, or a run the engine could
    /// not start.
    Failed,
}

impl TripStatus {
    pub fn parse(s: &str) -> Option<TripStatus> {
        match s {
            "skipped" => Some(TripStatus::Skipped),
            "running" => Some(TripStatus::Running),
            "done" => Some(TripStatus::Done),
            "failed" => Some(TripStatus::Failed),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            TripStatus::Skipped => "skipped",
            TripStatus::Running => "running",
            TripStatus::Done => "done",
            TripStatus::Failed => "failed",
        }
    }
}

/// One standing tripwire, as the table holds it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Tripwire {
    pub id: i64,
    pub name: String,
    pub created_at: i64,
    /// The Spec S01 JSON, exactly as stored — the engine parses it with
    /// [`Tripwire::predicate`], and a row whose trigger this build cannot read is
    /// still a row it can list and remove.
    pub trigger: String,
    pub scope: Option<String>,
    pub probe: Option<String>,
    pub brief: String,
    pub model: Option<String>,
    pub permission_mode: String,
    pub paused: bool,
    /// The one sentence the Tripwires card shows in place of the brief
    /// ([B01]): what this tripwire does and when it will speak, written for
    /// the person reading the rail rather than for the model.
    pub description: String,
    /// The checkout the tripwire's arc lives in, resolved once at `lay`
    /// ([P02]). Empty on a row laid before the arc existed, which is a row
    /// whose trips have nowhere to stand.
    pub repo_root: String,
    /// How long a trip of this tripwire may run before the engine interrupts
    /// its session and closes it ([P06]).
    pub max_seconds: i64,
    /// How many tool calls a trip of this tripwire may spend before the same
    /// thing happens ([P06]).
    pub max_tool_calls: i64,
}

impl Tripwire {
    /// The parsed trigger, or the reason it could not be read. Parsed on
    /// demand rather than at load: a tripwire laid by a newer build against a
    /// grammar this one does not know must still list and remove cleanly.
    pub fn predicate(&self) -> Result<Predicate, TripwireLedgerError> {
        serde_json::from_str(&self.trigger)
            .map_err(|e| TripwireLedgerError::BadTrigger(format!("{}: {e}", self.name)))
    }
}

/// A tripwire to lay. Every field the CLI can set, with the defaults the schema
/// carries so one shape describes a tripwire whether it came from a command line
/// or a table.
#[derive(Debug, Clone, PartialEq)]
pub struct NewTripwire {
    pub name: String,
    pub trigger: String,
    pub scope: Option<String>,
    pub probe: Option<String>,
    pub brief: String,
    pub model: Option<String>,
    pub permission_mode: String,
    /// The sentence the card shows ([B01]).
    pub description: String,
    /// The checkout the tripwire's arc is created in ([P02]).
    pub repo_root: String,
    /// The two caps a trip of it runs under ([P06]). Defaulted rather than
    /// asked for at the arming gesture, unlike `description`: a cap has a
    /// right answer and a tripwire laid without naming one is not a tripwire
    /// missing anything.
    pub max_seconds: i64,
    pub max_tool_calls: i64,
}

impl NewTripwire {
    /// A tripwire with the schema's defaults, needing only what it watches and
    /// what to say about it.
    ///
    /// The description is a parameter rather than a default. A tripwire nobody
    /// can describe in a sentence is a tripwire nobody will recognise on the
    /// card ([B02]), so it is asked for at the arming gesture rather than
    /// defaulted to a blank the rail would then have to render.
    pub fn new(
        name: impl Into<String>,
        trigger: impl Into<String>,
        brief: impl Into<String>,
        description: impl Into<String>,
    ) -> Self {
        NewTripwire {
            name: name.into(),
            trigger: trigger.into(),
            scope: None,
            probe: None,
            brief: brief.into(),
            model: None,
            permission_mode: "acceptEdits".to_string(),
            description: description.into(),
            repo_root: String::new(),
            max_seconds: MAX_TRIP_SECONDS_DEFAULT,
            max_tool_calls: MAX_TRIP_TOOL_CALLS_DEFAULT,
        }
    }
}

/// The fields `tripwire edit` can move. `None` leaves a column alone, which is
/// what makes one verb able to change one thing without restating the rest.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TripwireEdit {
    pub trigger: Option<String>,
    pub scope: Option<Option<String>>,
    pub probe: Option<Option<String>>,
    pub brief: Option<String>,
    pub model: Option<Option<String>>,
    pub permission_mode: Option<String>,
    /// Settable, and deliberately not clearable: it is the line the card
    /// leads with, and a tripwire that has lost it is one the rail cannot
    /// name ([B02]).
    pub description: Option<String>,
    /// Settable, and deliberately not clearable for the same reason
    /// `description` is not: a tripwire that has lost its home checkout is one
    /// whose arc nothing can find ([P02]).
    pub repo_root: Option<String>,
    /// The caps, settable one at a time and not clearable: a cleared cap is a
    /// trip with no ceiling, which is the thing [P06] exists to end.
    pub max_seconds: Option<i64>,
    pub max_tool_calls: Option<i64>,
}

/// One firing, as the table holds it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Trip {
    pub id: i64,
    pub tripwire_id: i64,
    pub event_key: String,
    pub at_ms: i64,
    pub instance: String,
    pub status: String,
    /// Why the trip did not run, on a `skipped` row, or how it stopped on a
    /// `failed` one. `None` on a trip that ran.
    pub reason: Option<String>,
    pub event_payload: Option<String>,
    pub probe_exit: Option<i64>,
    pub probe_tail: Option<String>,
    pub session_id: Option<String>,
    pub arc: Option<String>,
    pub headline: Option<String>,
    pub refs: Option<String>,
    pub settled_at_ms: Option<i64>,
    /// The checkout the fact was recorded in — the repository the trip's
    /// fact happened in, which is not necessarily where the tripwire's arc
    /// lives ([P02]). Written at insert.
    pub repo_root: Option<String>,
    /// The session's last assistant message, read off its transcript when the
    /// run ends ([P04]). `None` on a trip that ran no session — a skip, a
    /// green probe — and on any trip taken before v11.
    pub report: Option<String>,
    /// How many rounds the trip committed on the tripwire's arc ([P04]).
    /// `None` where `report` is `None`, and for the same reason.
    pub rounds: Option<i64>,
}

// MARK: - Open

/// Open (creating if absent) the tripwires ledger at `path`.
pub fn open_ledger(path: impl AsRef<Path>) -> Result<Connection, TripwireLedgerError> {
    if let Some(dir) = path.as_ref().parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let conn = tugcore::ledger_db::open(path)?;
    prepare(&conn)?;
    Ok(conn)
}

/// Open the machine's ledger at its canonical path.
pub fn open() -> Result<Connection, TripwireLedgerError> {
    open_ledger(tugcore::instance::tripwires_db_path())
}

/// Bring a connection's schema to the current version. Split out so tests can
/// exercise it against an in-memory connection.
fn prepare(conn: &Connection) -> Result<(), TripwireLedgerError> {
    // `trips` cascades from `tripwires`, and SQLite leaves foreign keys off per
    // connection unless asked.
    conn.pragma_update(None, "foreign_keys", true)?;
    // A version newer than this build means a newer tugtool owns the shape:
    // refuse the open rather than laying tripwires against an unknown schema.
    let on_disk: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if on_disk > TRIPWIRE_SCHEMA_VERSION {
        return Err(TripwireLedgerError::SchemaTooNew {
            on_disk,
            supported: TRIPWIRE_SCHEMA_VERSION,
        });
    }
    if on_disk > 0 && on_disk < TRIPWIRE_SCHEMA_VERSION {
        for (from, sql) in TRIPWIRE_MIGRATIONS {
            if *from >= on_disk {
                conn.execute_batch(sql)?;
            }
        }
    }
    // The probes run whatever the stamp says, because the shapes they repair
    // are reachable from a stamp they never saw: a pre-versioning ledger is
    // stamped 0 and never enters the loop above at all.
    migrate_trips_arc_column(conn)?;
    // After the arc probe, which still spells the reason column by its v4 name
    // for the pre-versioning ledgers it exists for, and before anything below
    // reads the table by its v8 names.
    migrate_trips_reason_column(conn)?;
    migrate_tripwire_names(conn)?;
    // These three name `tripwires` or read its shape, so they follow the
    // rename that gives the table that name.
    migrate_tripwire_branch_column(conn)?;
    migrate_trips_repo_columns(conn)?;
    // After the two columns above are appended, so the drop cannot renumber
    // the shape they land in.
    migrate_trips_author_ask(conn)?;
    migrate_trips_head_sha(conn)?;
    // And after those two drops, so the appended pair lands at the end of the
    // shape a fresh ledger's DDL also puts them at.
    migrate_trips_report_columns(conn)?;
    migrate_drop_tripwire_marks(conn)?;
    // The description column follows the rename, because it names the table
    // by the name the rename gave it — and its backfill follows the column.
    migrate_tripwire_description(conn)?;
    // And the home checkout follows the description, because it is appended
    // after it in the DDL and column order is part of the shape.
    migrate_tripwire_repo_root(conn)?;
    // And the caps after the home checkout, appended last, which is where the
    // DDL puts them.
    migrate_tripwire_caps(conn)?;
    backfill_descriptions(conn)?;
    conn.execute_batch(CREATE_TRIPWIRES_SQL)?;
    conn.pragma_update(None, "user_version", TRIPWIRE_SCHEMA_VERSION)?;
    Ok(())
}

/// Rename the retired `trips` column to `trips.arc` when that is what is on
/// disk ([P03]).
///
/// A probe rather than a line in [`MIGRATE_V4_TO_V5`] for two reasons.
/// `ALTER TABLE … RENAME COLUMN` is not idempotent, and a crash between a
/// migration's statements and the version stamp re-runs the whole batch on the
/// next open. And `trips` is created by `CREATE TABLE IF NOT EXISTS`, so a
/// pre-versioning ledger — stamped 0, table already on disk — never enters the
/// registered-migration loop at all and would otherwise keep the retired
/// column forever while every query named the new one.
///
/// Runs before the DDL, so the create below finds the table in its current
/// shape and leaves it alone.
fn migrate_trips_arc_column(conn: &Connection) -> Result<(), TripwireLedgerError> {
    let mut stmt = conn.prepare("PRAGMA table_info(trips)")?;
    let columns: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    if columns.iter().any(|c| c == "arc") || !columns.iter().any(|c| c == "dash") {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE trips RENAME COLUMN dash TO arc;")?;
    // The value rewrite rides along for the pre-versioning case, which the
    // registered migration never reaches. Idempotent, so the versioned path
    // running it twice costs nothing.
    conn.execute_batch(
        "UPDATE trips SET swallow_reason = 'own-arc' WHERE swallow_reason = 'own-dash';",
    )?;
    Ok(())
}

/// Give the trip's reason column its v8 name when the old one is what is on
/// disk (Spec S03).
///
/// A probe rather than a line in [`MIGRATE_V7_TO_V8`], for both of the reasons
/// [`migrate_trips_arc_column`] is one: `RENAME COLUMN` is not idempotent, and
/// a pre-versioning ledger never enters the registered-migration loop at all.
///
/// The column stopped being about one refusal when the four statuses that meant
/// "refused" became the one word `skipped`, and it now carries a failed trip's
/// reason as well ([P04]) — so the name is the general one.
fn migrate_trips_reason_column(conn: &Connection) -> Result<(), TripwireLedgerError> {
    let columns = columns_of(conn, "trips")?;
    if columns.iter().any(|c| c == "reason") || !columns.iter().any(|c| c == "swallow_reason") {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE trips RENAME COLUMN swallow_reason TO reason;")?;
    Ok(())
}

/// Drop the branch column when v7 left one behind ([P02]).
///
/// A probe for the two reasons every shape change in this file is one, and for
/// a third: [`MIGRATE_V7_TO_V8`] runs before the table is called `tripwires` at
/// all on a v1 or v5 ledger.
fn migrate_tripwire_branch_column(conn: &Connection) -> Result<(), TripwireLedgerError> {
    if !columns_of(conn, "tripwires")?.iter().any(|c| c == "branch") {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE tripwires DROP COLUMN branch;")?;
    Ok(())
}

/// Give a migrated `trips` the column v8 appends ([P05]).
///
/// Appended at the end, which is where
/// [`CREATE_TRIPWIRES_SQL`] puts it: a migrated ledger and a fresh one have
/// to be indistinguishable, and column order is part of the shape.
///
/// `head_sha` was appended here too until v10 dropped it. It is **not** in the
/// list any more, and that is load-bearing rather than tidiness: this probe
/// runs unconditionally on every open, so a `head_sha` left in it would
/// re-add on the next open the column [`migrate_trips_head_sha`] had just
/// dropped, forever.
fn migrate_trips_repo_columns(conn: &Connection) -> Result<(), TripwireLedgerError> {
    let columns = columns_of(conn, "trips")?;
    if columns.is_empty() {
        return Ok(());
    }
    for column in ["repo_root"] {
        if !columns.iter().any(|c| c == column) {
            conn.execute_batch(&format!("ALTER TABLE trips ADD COLUMN {column} TEXT;"))?;
        }
    }
    Ok(())
}

/// Take v9's retired column off disk when a migrated ledger still carries it
/// ([P01]).
///
/// A probe rather than a statement in [`MIGRATE_V8_TO_V9`], for both of the
/// reasons every shape change in this file is one: `DROP COLUMN` fails the
/// second time it runs, and a pre-versioning ledger — stamped 0, table already
/// on disk — never enters the registered-migration loop at all. A v1 ledger
/// reaches here having just been *given* the column by
/// [`MIGRATE_V2_TO_V3`], which is why this runs after the loop rather than
/// inside it.
fn migrate_trips_author_ask(conn: &Connection) -> Result<(), TripwireLedgerError> {
    if !columns_of(conn, "trips")?.iter().any(|c| c == "author_ask") {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE trips DROP COLUMN author_ask;")?;
    Ok(())
}

/// Take v10's retired column off disk when a migrated ledger still carries it
/// ([P03]).
///
/// A probe for the reasons every shape change in this file is one, and it runs
/// after [`migrate_trips_repo_columns`] because that probe is what used to add
/// the column — running the two in the other order would drop it and then put
/// it straight back.
fn migrate_trips_head_sha(conn: &Connection) -> Result<(), TripwireLedgerError> {
    if !columns_of(conn, "trips")?.iter().any(|c| c == "head_sha") {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE trips DROP COLUMN head_sha;")?;
    Ok(())
}

/// Give a migrated `trips` the two columns a trip's ending is read off
/// ([P04]).
///
/// One probe for both, because they arrive together and a ledger carrying one
/// without the other never existed. A probe rather than statements in
/// [`MIGRATE_V10_TO_V11`] for the reason every shape change in this file is
/// one: `ADD COLUMN` fails the second time it runs, and a pre-versioning
/// ledger never enters the registered-migration loop at all.
///
/// Both are nullable, and that is the honest shape: nothing on disk says what
/// a trip taken before v11 reported or how many rounds it committed, and a
/// zero would claim it committed none rather than that nobody counted.
fn migrate_trips_report_columns(conn: &Connection) -> Result<(), TripwireLedgerError> {
    // The one probe in this file that *adds* to `trips`, so it is the one that
    // has to ask whether the table is there: a fresh ledger reaches here
    // before the DDL has created it, and the drops above return early on a
    // shape they cannot find.
    if !table_exists(conn, "trips")? {
        return Ok(());
    }
    let columns = columns_of(conn, "trips")?;
    for (column, ddl) in [("report", "TEXT"), ("rounds", "INTEGER")] {
        if columns.iter().any(|c| c == column) {
            continue;
        }
        conn.execute_batch(&format!("ALTER TABLE trips ADD COLUMN {column} {ddl};"))?;
    }
    Ok(())
}

/// Give a migrated `tripwires` the home checkout its arc lives in ([P02]).
///
/// A probe for the reasons [`migrate_tripwire_description`] is one, and
/// appended after `description` so a migrated ledger and a fresh one carry the
/// same column order. The empty default is what an old row gets, and it is
/// honest: nothing on disk says which checkout a tripwire laid before v10
/// belongs to, and inventing one would point an arc at a repository nobody
/// chose.
fn migrate_tripwire_repo_root(conn: &Connection) -> Result<(), TripwireLedgerError> {
    if !table_exists(conn, "tripwires")? {
        return Ok(());
    }
    if columns_of(conn, "tripwires")?
        .iter()
        .any(|c| c == "repo_root")
    {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE tripwires ADD COLUMN repo_root TEXT NOT NULL DEFAULT '';")?;
    Ok(())
}

/// Give a migrated `tripwires` the two caps a trip is bounded by ([P06]).
///
/// One probe for both, because they arrive together and a ledger carrying one
/// without the other never existed. A probe for the reasons every shape change
/// in this file is one: `ADD COLUMN` fails the second time it runs, and a
/// pre-versioning ledger never enters the registered-migration loop at all.
///
/// The defaults are the DDL's, so a tripwire laid before the caps existed is
/// bounded the same way one laid after them is. Not nullable, and that is the
/// difference between these and `report`/`rounds`: an absent cap is not a fact
/// about an old row, it is a row with no ceiling — the condition the caps
/// exist to end.
fn migrate_tripwire_caps(conn: &Connection) -> Result<(), TripwireLedgerError> {
    if !table_exists(conn, "tripwires")? {
        return Ok(());
    }
    let columns = columns_of(conn, "tripwires")?;
    for (column, default) in [
        ("max_seconds", MAX_TRIP_SECONDS_DEFAULT),
        ("max_tool_calls", MAX_TRIP_TOOL_CALLS_DEFAULT),
    ] {
        if columns.iter().any(|c| c == column) {
            continue;
        }
        conn.execute_batch(&format!(
            "ALTER TABLE tripwires ADD COLUMN {column} INTEGER NOT NULL DEFAULT {default};"
        ))?;
    }
    Ok(())
}

/// Take the retired per-session marks table off disk, under either of the two
/// names it has worn.
///
/// The marks held a ceiling over a per-session fact lookback, and the
/// lookback is what the fact-time trigger replaced: there is no window to
/// remember the end of. Both spellings, because this runs after
/// [`migrate_tripwire_names`] on a versioned ledger and before it ever runs on
/// a pre-versioning one.
fn migrate_drop_tripwire_marks(conn: &Connection) -> Result<(), TripwireLedgerError> {
    conn.execute_batch("DROP TABLE IF EXISTS tripwire_marks; DROP TABLE IF EXISTS wire_marks;")?;
    Ok(())
}

/// Give the two tables and the foreign-key column the feature's own noun when
/// the old ones are what is on disk.
///
/// A probe rather than statements in [`MIGRATE_V5_TO_V6`], for both of the
/// reasons [`migrate_trips_arc_column`] is one. `ALTER TABLE … RENAME TO` and
/// `RENAME COLUMN` are not idempotent, and a crash between a migration's
/// statements and the version stamp re-runs the whole batch on the next open.
/// And a pre-versioning ledger — stamped 0, tables already on disk — never
/// enters the registered-migration loop at all, so a rename left in the list
/// would never reach the ledgers that most need it.
///
/// The parent table goes first so the child's `REFERENCES` clause is rewritten
/// with it, which is what SQLite does with `legacy_alter_table` off. The old
/// index is dropped rather than renamed, because the DDL below mints the new
/// one and a migrated ledger and a fresh one have to be indistinguishable.
fn migrate_tripwire_names(conn: &Connection) -> Result<(), TripwireLedgerError> {
    if table_exists(conn, "wires")? && !table_exists(conn, "tripwires")? {
        conn.execute_batch("ALTER TABLE wires RENAME TO tripwires;")?;
    }
    let columns = columns_of(conn, "trips")?;
    if columns.iter().any(|c| c == "wire_id") && !columns.iter().any(|c| c == "tripwire_id") {
        conn.execute_batch("ALTER TABLE trips RENAME COLUMN wire_id TO tripwire_id;")?;
    }
    conn.execute_batch("DROP INDEX IF EXISTS trips_by_wire;")?;
    Ok(())
}

/// Whether a table of that name is on disk.
fn table_exists(conn: &Connection, table: &str) -> Result<bool, TripwireLedgerError> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![table],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        .is_some())
}

/// The column names a table has, or none at all when there is no such table.
fn columns_of(conn: &Connection, table: &str) -> Result<Vec<String>, TripwireLedgerError> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(columns)
}

/// Give every row that predates v7 a description, since none of them carry one.
///
/// The first sentence of the brief, which is the only thing in the row that
/// says what the tripwire is for. It is a placeholder and it is meant to be:
/// the brief is written to the model as a question ([B01]), so its first
/// sentence often reads as one, and the `/tripwire` skill writes a real
/// description from here on. What it buys is a card that still names its rows
/// on the next launch rather than showing a column of blanks ([B02]).
///
/// Unconditional, because it costs one query
/// against rows that have already been filled and because a pre-versioning
/// ledger — stamped 0, never entering the migration loop — reaches it no
/// other way. A row whose brief is itself empty keeps its empty description;
/// there is nothing to make one out of, and inventing one would be worse.
fn backfill_descriptions(conn: &Connection) -> Result<(), TripwireLedgerError> {
    if !table_exists(conn, "tripwires")? {
        return Ok(());
    }
    let mut stmt = conn.prepare("SELECT id, brief FROM tripwires WHERE description = ''")?;
    let rows: Vec<(i64, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    for (id, brief) in rows {
        let description = first_sentence(&brief);
        if description.is_empty() {
            continue;
        }
        conn.execute(
            "UPDATE tripwires SET description = ?1 WHERE id = ?2",
            params![description, id],
        )?;
    }
    Ok(())
}

/// How much of a brief the backfill will take. A brief with no sentence
/// terminator in it at all is a whole prompt, and putting that on the card is
/// the wall of text this column exists to retire.
const DESCRIPTION_BACKFILL_CAP: usize = 200;

/// The first sentence of `text`, capped, or the whole of it when it has no
/// terminator. Cut on a word boundary and marked when it cut, so the reader
/// can tell a sentence from a fragment.
fn first_sentence(text: &str) -> String {
    let trimmed = text.trim();
    let mut end = trimmed.len();
    let bytes = trimmed.as_bytes();
    for (i, c) in trimmed.char_indices() {
        if matches!(c, '.' | '!' | '?') {
            let after = i + c.len_utf8();
            if after == trimmed.len() || bytes[after].is_ascii_whitespace() {
                end = after;
                break;
            }
        }
    }
    let sentence = trimmed[..end].trim();
    if sentence.chars().count() <= DESCRIPTION_BACKFILL_CAP {
        return sentence.to_string();
    }
    let mut cut = sentence
        .char_indices()
        .nth(DESCRIPTION_BACKFILL_CAP)
        .map_or(sentence.len(), |(i, _)| i);
    if let Some(space) = sentence[..cut].rfind(char::is_whitespace) {
        cut = space;
    }
    format!("{}…", sentence[..cut].trim_end())
}

/// Add the v7 description column when the table on disk does not carry one.
///
/// A probe rather than a statement in [`MIGRATE_V6_TO_V7`], for the reasons
/// that constant gives: `ADD COLUMN` is not idempotent, and the migration list
/// runs before the table is called `tripwires` at all. Runs before the DDL, so
/// the create below finds the table in its current shape and leaves it alone,
/// and does nothing on a fresh ledger where there is no table yet.
fn migrate_tripwire_description(conn: &Connection) -> Result<(), TripwireLedgerError> {
    if !table_exists(conn, "tripwires")? {
        return Ok(());
    }
    let columns = columns_of(conn, "tripwires")?;
    if columns.iter().any(|c| c == "description") {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE tripwires ADD COLUMN description TEXT NOT NULL DEFAULT '';")?;
    Ok(())
}

// MARK: - Tripwires

const TRIPWIRE_COLUMNS: &str = "id, name, created_at, trigger, scope, probe, brief, model, \
                            permission_mode, paused, description, repo_root, \
                            max_seconds, max_tool_calls";

fn tripwire_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Tripwire> {
    Ok(Tripwire {
        id: row.get(0)?,
        name: row.get(1)?,
        created_at: row.get(2)?,
        trigger: row.get(3)?,
        scope: row.get(4)?,
        probe: row.get(5)?,
        brief: row.get(6)?,
        model: row.get(7)?,
        permission_mode: row.get(8)?,
        paused: row.get::<_, i64>(9)? != 0,
        description: row.get(10)?,
        repo_root: row.get(11)?,
        max_seconds: row.get(12)?,
        max_tool_calls: row.get(13)?,
    })
}

/// Lay a tripwire. The name is its address, so a second tripwire under one name is a
/// refusal rather than a silent overwrite.
pub fn lay(
    conn: &Connection,
    tripwire: &NewTripwire,
    now_ms: i64,
) -> Result<Tripwire, TripwireLedgerError> {
    check_brief(&tripwire.name, &tripwire.brief)?;
    check_description(&tripwire.name, &tripwire.description)?;
    let inserted = conn.execute(
        "INSERT OR IGNORE INTO tripwires
           (name, created_at, trigger, scope, probe, brief, model, permission_mode, paused,
            description, repo_root, max_seconds, max_tool_calls)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?10, ?11, ?12)",
        params![
            tripwire.name,
            now_ms,
            tripwire.trigger,
            tripwire.scope,
            tripwire.probe,
            tripwire.brief,
            tripwire.model,
            tripwire.permission_mode,
            tripwire.description.trim(),
            tripwire.repo_root,
            tripwire.max_seconds,
            tripwire.max_tool_calls,
        ],
    )?;
    if inserted == 0 {
        return Err(TripwireLedgerError::DuplicateName(tripwire.name.clone()));
    }
    get(conn, &tripwire.name)?
        .ok_or_else(|| TripwireLedgerError::NoSuchTripwire(tripwire.name.clone()))
}

/// One tripwire by name, or `None`.
pub fn get(conn: &Connection, name: &str) -> Result<Option<Tripwire>, TripwireLedgerError> {
    let sql = format!("SELECT {TRIPWIRE_COLUMNS} FROM tripwires WHERE name = ?1");
    Ok(conn
        .query_row(&sql, params![name], tripwire_from_row)
        .optional()?)
}

/// Every tripwire, oldest first — the order they were laid in, which is the order
/// a reader who laid them expects.
pub fn list(conn: &Connection) -> Result<Vec<Tripwire>, TripwireLedgerError> {
    let sql = format!("SELECT {TRIPWIRE_COLUMNS} FROM tripwires ORDER BY id");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], tripwire_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Every tripwire that is armed — not paused. What the engine re-reads on each
/// event, so `pause` and `edit` apply on the next firing with no notification
/// plumbing at all.
pub fn armed(conn: &Connection) -> Result<Vec<Tripwire>, TripwireLedgerError> {
    let sql = format!("SELECT {TRIPWIRE_COLUMNS} FROM tripwires WHERE paused = 0 ORDER BY id");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], tripwire_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Move the fields an edit names and leave the rest. Each column is its own
/// single-statement update, which is what keeps a writer from holding the
/// table while it decides.
pub fn update(
    conn: &Connection,
    name: &str,
    edit: &TripwireEdit,
) -> Result<Tripwire, TripwireLedgerError> {
    let Some(_before) = get(conn, name)? else {
        return Err(TripwireLedgerError::NoSuchTripwire(name.to_string()));
    };
    let set = |column: &str, value: rusqlite::types::Value| -> Result<(), TripwireLedgerError> {
        let sql = format!("UPDATE tripwires SET {column} = ?1 WHERE name = ?2");
        conn.execute(&sql, params![value, name])?;
        Ok(())
    };
    use rusqlite::types::Value;
    if let Some(v) = &edit.trigger {
        set("trigger", Value::Text(v.clone()))?;
    }
    if let Some(v) = &edit.scope {
        set("scope", v.clone().map_or(Value::Null, Value::Text))?;
    }
    if let Some(v) = &edit.probe {
        set("probe", v.clone().map_or(Value::Null, Value::Text))?;
    }
    if let Some(v) = &edit.brief {
        check_brief(name, v)?;
        set("brief", Value::Text(v.clone()))?;
    }
    if let Some(v) = &edit.model {
        set("model", v.clone().map_or(Value::Null, Value::Text))?;
    }
    if let Some(v) = &edit.permission_mode {
        set("permission_mode", Value::Text(v.clone()))?;
    }
    if let Some(v) = &edit.description {
        check_description(name, v)?;
        set("description", Value::Text(v.trim().to_string()))?;
    }
    if let Some(v) = &edit.repo_root {
        set("repo_root", Value::Text(v.clone()))?;
    }
    if let Some(v) = edit.max_seconds {
        set("max_seconds", Value::Integer(v))?;
    }
    if let Some(v) = edit.max_tool_calls {
        set("max_tool_calls", Value::Integer(v))?;
    }
    get(conn, name)?.ok_or_else(|| TripwireLedgerError::NoSuchTripwire(name.to_string()))
}

/// Pause or arm a tripwire. Paused is a column rather than a deletion, so the
/// trip log a tripwire earned survives being taken out of service.
pub fn set_paused(
    conn: &Connection,
    name: &str,
    paused: bool,
) -> Result<Tripwire, TripwireLedgerError> {
    let moved = conn.execute(
        "UPDATE tripwires SET paused = ?1 WHERE name = ?2",
        params![i64::from(paused), name],
    )?;
    if moved == 0 {
        return Err(TripwireLedgerError::NoSuchTripwire(name.to_string()));
    }
    get(conn, name)?.ok_or_else(|| TripwireLedgerError::NoSuchTripwire(name.to_string()))
}

/// Remove a tripwire and, by cascade, its trips — unless one of them is
/// running.
///
/// **The guard and the `DELETE` are one statement, and that is the whole of
/// the concurrency story here** ([B07]). A running trip is a session working
/// in the tripwire's arc worktree against a row that is about to vanish under
/// it, and the two doors that remove a tripwire — the card and
/// `tugtool tripwire rm` — are separate processes that can reach for the same
/// row at the same time. A read followed by a delete would leave a window
/// between them wide enough for a claim to land in; `NOT EXISTS` closes it,
/// at the cost of one read afterwards to say *why* nothing moved.
///
/// What the engine would do if a row did vanish under it is a separate
/// question, and the answer is that it is already harmless: every settle path
/// — [`settle`], [`settle_if_running`], [`record_run`], [`record_report`] —
/// is an `UPDATE … WHERE id = ?`, which matches nothing and reports no
/// error. The compare-and-set ones answer `false`, which their callers
/// already read as "somebody else had the row". So the
/// guard is not here to stop a crash; it is here to stop a run's *arc* being
/// orphaned, which nothing else would notice.
///
/// A finished trip is deliberately not guarded. The arc a removal has to
/// discard is the tripwire's own ([P02]), not a trip's, and discarding it
/// before the delete is `tugarc_core::tripwire_remove`'s job — which is the
/// caller this refusal is written for.
pub fn remove(conn: &Connection, name: &str) -> Result<(), TripwireLedgerError> {
    let removed = conn.execute(
        "DELETE FROM tripwires
           WHERE name = ?1
             AND NOT EXISTS (
                 SELECT 1 FROM trips
                  WHERE trips.tripwire_id = tripwires.id AND trips.status = 'running'
             )",
        params![name],
    )?;
    if removed == 0 {
        // Nothing moved for one of two reasons, and the reader wants
        // different words for each. The row still being there is the
        // refusal; the row being gone is a name that was never here.
        if get(conn, name)?.is_some() {
            return Err(TripwireLedgerError::TripRunning(name.to_string()));
        }
        return Err(TripwireLedgerError::NoSuchTripwire(name.to_string()));
    }
    Ok(())
}

/// The tripwire's running trip, when it has one.
///
/// The read [`remove`]'s caller takes *before* it discards anything: a
/// tripwire that is going to refuse the delete must not first have its arc
/// thrown away. `remove`'s own `NOT EXISTS` is the backstop for the race this
/// read cannot close; this is the ordering.
pub fn running_trip(
    conn: &Connection,
    tripwire_id: i64,
) -> Result<Option<Trip>, TripwireLedgerError> {
    let sql = format!(
        "SELECT {TRIP_COLUMNS} FROM trips
         WHERE tripwire_id = ?1 AND status = 'running'
         ORDER BY at_ms DESC, id DESC LIMIT 1"
    );
    Ok(conn
        .query_row(&sql, params![tripwire_id], trip_from_row)
        .optional()?)
}

// MARK: - Trips

const TRIP_COLUMNS: &str = "id, tripwire_id, event_key, at_ms, instance, status, reason, \
                            event_payload, probe_exit, probe_tail, session_id, arc, headline, \
                            refs, settled_at_ms, repo_root, report, rounds";

fn trip_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Trip> {
    Ok(Trip {
        id: row.get(0)?,
        tripwire_id: row.get(1)?,
        event_key: row.get(2)?,
        at_ms: row.get(3)?,
        instance: row.get(4)?,
        status: row.get(5)?,
        reason: row.get(6)?,
        event_payload: row.get(7)?,
        probe_exit: row.get(8)?,
        probe_tail: row.get(9)?,
        session_id: row.get(10)?,
        arc: row.get(11)?,
        headline: row.get(12)?,
        refs: row.get(13)?,
        settled_at_ms: row.get(14)?,
        repo_root: row.get(15)?,
        report: row.get(16)?,
        rounds: row.get(17)?,
    })
}

/// A trip to write. The row's whole first state: a fact the tripwire matched
/// either ran or did not, and [`insert_trip`] writes whichever it was ([P03]).
#[derive(Debug, Clone, PartialEq)]
pub struct NewTrip {
    pub tripwire_id: i64,
    /// `fact:<instance>:<rowid>` for a fact, `manual:<uuid>` for a hand-fired
    /// trip. Unique per tripwire, which is what makes a replayed rowid write
    /// nothing rather than a second row.
    pub event_key: String,
    pub at_ms: i64,
    pub instance: String,
    pub status: TripStatus,
    /// One of [`SKIP_BUSY`], [`SKIP_CEILING`], [`SKIP_NO_ROOM`] on a skip.
    pub reason: Option<String>,
    pub event_payload: Option<String>,
    /// The checkout the fact was recorded in ([P05]).
    pub repo_root: Option<String>,
}

/// Write one trip in the state it is already in, and prune the tripwire's log.
///
/// There is no claim to make and no queue to join: a fact is recorded by one
/// instance and evaluated by one engine, so the gates run *before* anything is
/// on disk and the row arrives knowing whether it ran ([P03]). A gate that
/// writes no row — a fact that did not match, one outside the scope, one the
/// tripwire's own session recorded — simply never reaches here.
///
/// `INSERT OR IGNORE` against the surviving `UNIQUE(tripwire_id, event_key)`,
/// answering `None` when the tripwire already has a row for this fact. That is
/// the case the constraint exists for — a replayed rowid — and `None` reads as
/// "nothing to do" rather than as an error with nowhere to go.
///
/// An inserted row then prunes the tripwire's log back to
/// [`MAX_TRIPS_PER_TRIPWIRE`]. The prune is a second statement rather than a
/// wider one: it touches only rows this tripwire already lost interest in, so
/// an insert on another tripwire is unaffected and neither statement
/// waits on the other.
///
/// **Only a terminal row is ever pruned.** A `running` trip is state rather
/// than log — a session is working in it this second, and a tripwire that
/// fires on every fact would otherwise delete the row that session is about to
/// settle. The list is the three terminal statuses by name rather than
/// `running` negated: a status this build has not learned is left alone, which
/// costs a row and cannot cost a live trip.
pub fn insert_trip(conn: &Connection, trip: &NewTrip) -> Result<Option<i64>, TripwireLedgerError> {
    let inserted = conn.execute(
        "INSERT OR IGNORE INTO trips
           (tripwire_id, event_key, at_ms, instance, status, reason, event_payload, repo_root)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            trip.tripwire_id,
            trip.event_key,
            trip.at_ms,
            trip.instance,
            trip.status.as_str(),
            trip.reason,
            trip.event_payload,
            trip.repo_root,
        ],
    )?;
    if inserted == 0 {
        return Ok(None);
    }
    let trip_id = conn.last_insert_rowid();
    conn.execute(
        "DELETE FROM trips
          WHERE tripwire_id = ?1
            AND status IN ('done', 'failed', 'skipped')
            AND id NOT IN (
                SELECT id FROM trips WHERE tripwire_id = ?1
                 ORDER BY id DESC LIMIT ?2
            )",
        params![trip.tripwire_id, MAX_TRIPS_PER_TRIPWIRE],
    )?;
    Ok(Some(trip_id))
}

/// Whether this session is one *this* tripwire spawned for a trip ([B03]).
///
/// The own-session gate, and the whole of it: a tripwire never fires on facts
/// its own trip's session recorded, or every shell command a trip runs would
/// fire the tripwire that started it. Per tripwire on purpose ([Q01]) — another
/// tripwire's session is an ordinary session as far as this one is concerned,
/// and widening this is dropping one clause when the first cross-tripwire loop
/// is actually observed.
pub fn is_trip_session(
    conn: &Connection,
    tripwire_id: i64,
    session_id: &str,
) -> Result<bool, TripwireLedgerError> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM trips WHERE tripwire_id = ?1 AND session_id = ?2 LIMIT 1",
            params![tripwire_id, session_id],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        .is_some())
}

/// The checkout one trip stood in, by id ([P05]).
pub fn repo_root_of_trip(
    conn: &Connection,
    trip_id: i64,
) -> Result<Option<String>, TripwireLedgerError> {
    Ok(conn
        .query_row(
            "SELECT repo_root FROM trips WHERE id = ?1",
            params![trip_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

/// How many trips a tripwire has that actually ran — the number the card's
/// band shows ([P10]).
///
/// `skipped` rows are excluded: a broad tripwire writes one per busy fact, and
/// a count dominated by "didn't run" would say nothing about the tripwire's
/// work.
pub fn trip_count(conn: &Connection, tripwire_id: i64) -> Result<i64, TripwireLedgerError> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM trips WHERE tripwire_id = ?1 AND status != 'skipped'",
        params![tripwire_id],
        |r| r.get(0),
    )?)
}

/// How many trips are running machine-wide. Read immediately before a run
/// starts, and deliberately not cached: another instance's count is as real
/// as this one's.
pub fn running_count(conn: &Connection) -> Result<i64, TripwireLedgerError> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM trips WHERE status = 'running'",
        [],
        |r| r.get(0),
    )?)
}

/// The tripwire's running trip, if it has one — the whole of the busy guard
/// ([P06]).
///
/// `running` and nothing else, because `running` is the only status a trip can
/// stand in without having finished ([P05]). The status that used to share
/// this read held a question the user had not answered and an arc they might
/// still join; a trip that always leaves a report holds neither, so the guard
/// is exactly "is a session working this tripwire right now".
pub fn live_trip(conn: &Connection, tripwire_id: i64) -> Result<Option<Trip>, TripwireLedgerError> {
    let sql = format!(
        "SELECT {TRIP_COLUMNS} FROM trips
         WHERE tripwire_id = ?1 AND status = 'running'
         ORDER BY at_ms DESC, id DESC LIMIT 1"
    );
    Ok(conn
        .query_row(&sql, params![tripwire_id], trip_from_row)
        .optional()?)
}

/// Attach the evidence a trip was evaluated against.
///
/// [`insert_trip`] writes the payload with the row; this is for the hand-fired
/// path, which composes its synthetic fact after the row exists.
pub fn record_event_payload(
    conn: &Connection,
    trip_id: i64,
    event_payload: Option<&str>,
) -> Result<(), TripwireLedgerError> {
    conn.execute(
        "UPDATE trips SET event_payload = ?1 WHERE id = ?2",
        params![event_payload, trip_id],
    )?;
    Ok(())
}

/// Record what a probe did. The tail is capped — a probe that failed says why
/// at the end, and the whole of a red `just ci` is not evidence, it is a log.
pub fn record_probe(
    conn: &Connection,
    trip_id: i64,
    exit: i64,
    output_tail: &str,
) -> Result<(), TripwireLedgerError> {
    conn.execute(
        "UPDATE trips SET probe_exit = ?1, probe_tail = ?2 WHERE id = ?3",
        params![exit, tail(output_tail, PROBE_TAIL_CAP), trip_id],
    )?;
    Ok(())
}

/// Attach the session and arc a running trip is working in.
pub fn record_run(
    conn: &Connection,
    trip_id: i64,
    session_id: Option<&str>,
    arc: Option<&str>,
) -> Result<(), TripwireLedgerError> {
    conn.execute(
        "UPDATE trips SET status = 'running', session_id = ?1, arc = ?2 WHERE id = ?3",
        params![session_id, arc, trip_id],
    )?;
    Ok(())
}

/// Name the session a *running* trip was just seated in, and nothing else.
///
/// The seat happens the moment the supervisor has a session id, long before
/// the phase it opens returns, and the whole point of writing it then is that
/// the card can show a trip's session while the trip is still working. So this
/// write touches one column and guards on `status = 'running'`: a trip the
/// session's own verb has already settled keeps its settle (Risk R03), and a
/// seat notification that arrives after it changes nothing. `record_run` would
/// put such a row back to `running`, which is why the seat does not go through
/// it.
///
/// Answers whether a row moved.
pub fn record_session_if_running(
    conn: &Connection,
    trip_id: i64,
    session_id: &str,
) -> Result<bool, TripwireLedgerError> {
    let changed = conn.execute(
        "UPDATE trips SET session_id = ?1 WHERE id = ?2 AND status = 'running'",
        params![session_id, trip_id],
    )?;
    Ok(changed > 0)
}

/// What a trip finished with.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Settlement {
    pub headline: Option<String>,
    /// The refs, already serialized — the ledger stores what it is handed.
    pub refs: Option<String>,
    /// Why, in one word, when the outcome has a word for it: a skip's
    /// [`SKIP_NO_ROOM`], a failure's `instance restarted` or `abandoned`
    /// ([P04]). `None` leaves whatever the row already carries.
    pub reason: Option<String>,
}

/// Settle a trip, with `failed` for a run that produced no outcome.
pub fn settle(
    conn: &Connection,
    trip_id: i64,
    status: TripStatus,
    settlement: &Settlement,
    at_ms: i64,
) -> Result<(), TripwireLedgerError> {
    conn.execute(
        "UPDATE trips SET status = ?1, headline = ?2, refs = ?3,
                          reason = COALESCE(?4, reason), settled_at_ms = ?5
         WHERE id = ?6",
        params![
            status.as_str(),
            settlement.headline,
            settlement.refs,
            settlement.reason,
            at_ms,
            trip_id,
        ],
    )?;
    Ok(())
}

/// Write what the trip's session said and what it committed ([P04]).
///
/// Its own statement rather than a field on [`Settlement`], because the two
/// are written at different moments and for different reasons: the report is
/// what the session produced, read off its transcript the instant the run
/// ends, and the settle is the engine's judgment about that run. A trip whose
/// settle loses the compare-and-set below still has its report on disk, which
/// is the whole point of [P04] — the words are never the casualty of a race.
pub fn record_report(
    conn: &Connection,
    trip_id: i64,
    report: &str,
    rounds: i64,
) -> Result<(), TripwireLedgerError> {
    conn.execute(
        "UPDATE trips SET report = ?1, rounds = ?2 WHERE id = ?3",
        params![report, rounds, trip_id],
    )?;
    Ok(())
}

/// Settle one trip by id, but only while it is still `running` — the guard
/// against a second writer reaching the same row (Risk R03).
///
/// The settle ceiling and the run's own ending can reach for the same row, and
/// this is the clause that lets exactly one of them have it. Answers whether
/// this caller was the one.
pub fn settle_if_running(
    conn: &Connection,
    trip_id: i64,
    status: TripStatus,
    settlement: &Settlement,
    at_ms: i64,
) -> Result<bool, TripwireLedgerError> {
    let changed = conn.execute(
        "UPDATE trips SET status = ?1, headline = ?2, refs = ?3,
                          reason = COALESCE(?4, reason), settled_at_ms = ?5
         WHERE id = ?6 AND status = 'running'",
        params![
            status.as_str(),
            settlement.headline,
            settlement.refs,
            settlement.reason,
            at_ms,
            trip_id,
        ],
    )?;
    Ok(changed > 0)
}

/// One trip by id.
pub fn trip(conn: &Connection, trip_id: i64) -> Result<Option<Trip>, TripwireLedgerError> {
    let sql = format!("SELECT {TRIP_COLUMNS} FROM trips WHERE id = ?1");
    Ok(conn
        .query_row(&sql, params![trip_id], trip_from_row)
        .optional()?)
}

/// A tripwire's trips, newest first, capped. `limit` is the reader's window;
/// the ledger's own memory is [`MAX_TRIPS_PER_TRIPWIRE`], pruned at claim
/// time, so a reader that pages to the end of a log reaches it.
pub fn trips_for_tripwire(
    conn: &Connection,
    tripwire_id: i64,
    limit: i64,
) -> Result<Vec<Trip>, TripwireLedgerError> {
    let sql = format!(
        "SELECT {TRIP_COLUMNS} FROM trips WHERE tripwire_id = ?1 ORDER BY id DESC LIMIT ?2"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![tripwire_id, limit], trip_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Every trip this instance left `running` or `claimed` when it died. Swept at
/// engine boot: their processes went with the previous tugcast, and a row
/// that reads `running` forever holds a concurrency slot nothing will free.
///
/// Answers how many rows were failed. There is no half-made row to clear any
/// more: a trip is inserted in the state it is already in ([P03]), so the only
/// thing a crash can leave behind is a `running` one.
///
/// Nothing else is swept, because nothing else is unfinished: the other three
/// statuses are all endings ([P05]).
pub fn sweep_stale_running(
    conn: &Connection,
    instance: &str,
    at_ms: i64,
) -> Result<usize, TripwireLedgerError> {
    let failed = conn.execute(
        "UPDATE trips SET status = 'failed', reason = 'instance restarted',
                          settled_at_ms = ?1
         WHERE status = 'running' AND instance = ?2",
        params![at_ms, instance],
    )?;
    Ok(failed)
}

/// This instance's `running` trips — what [`sweep_stale_running`] is about to
/// fail, read before it does so the arcs those rows name can be judged rather
/// than lost.
pub fn running_trips_of(
    conn: &Connection,
    instance: &str,
) -> Result<Vec<Trip>, TripwireLedgerError> {
    let sql = format!(
        "SELECT {TRIP_COLUMNS} FROM trips
         WHERE status = 'running' AND instance = ?1
         ORDER BY at_ms, id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![instance], trip_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Replace the headline on a trip that has already settled `failed`.
///
/// The failure's settle and the decision about its arc happen in that order,
/// and the second has something to say the first could not: that the arc was
/// kept, and how much it holds. Only a `failed` row is touched, so a row a
/// verb settled in the meantime keeps the verb's words. Answers whether the
/// row was amended.
pub fn amend_failed_headline(
    conn: &Connection,
    trip_id: i64,
    headline: &str,
) -> Result<bool, TripwireLedgerError> {
    let changed = conn.execute(
        "UPDATE trips SET headline = ?1 WHERE id = ?2 AND status = 'failed'",
        params![headline, trip_id],
    )?;
    Ok(changed > 0)
}

/// Fail every `running` trip another instance started before `before_ms`.
///
/// [`sweep_stale_running`] is the clean half and cannot be the whole of it: an
/// instance only ever knows its own name, so a tugcast that crashed and never
/// came back leaves rows no boot sweep will ever reach. `running_count` is
/// machine-wide, so those rows spend the ceiling for every tripwire on the machine
/// — and nothing recovers on its own, because no settle is coming for a dead
/// instance's trip.
///
/// Age is the only evidence available about another instance, so the caller's
/// bound is what stands between an abandoned run and a long one. This
/// instance's own rows are never touched here: it knows its runs are live,
/// and no session it is running is bounded by a clock.
pub fn sweep_orphaned_running(
    conn: &Connection,
    before_ms: i64,
    instance: &str,
) -> Result<usize, TripwireLedgerError> {
    let failed = conn.execute(
        "UPDATE trips SET status = 'failed', reason = 'abandoned',
                          settled_at_ms = ?1
         WHERE status = 'running' AND at_ms < ?1 AND instance != ?2",
        params![before_ms, instance],
    )?;
    Ok(failed)
}

// MARK: - Settings

/// One setting, or `None`.
pub fn setting(conn: &Connection, key: &str) -> Result<Option<String>, TripwireLedgerError> {
    Ok(conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |r| r.get(0),
        )
        .optional()?)
}

/// Write one setting.
pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), TripwireLedgerError> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// The machine-wide ceiling on concurrent runs. An absent or unreadable
/// setting is the default rather than an error: a typo in a settings row must
/// not stop every tripwire on the machine.
///
/// And a settings row is trusted only within [`MAX_CONCURRENT_TRIPS_LIMIT`],
/// for the same reason: the row is a number somebody typed, and a ceiling the
/// host could not admit is not a ceiling at all.
pub fn max_concurrent_trips(conn: &Connection) -> Result<i64, TripwireLedgerError> {
    Ok(setting(conn, SETTING_MAX_CONCURRENT_TRIPS)?
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(DEFAULT_MAX_CONCURRENT_TRIPS)
        .min(MAX_CONCURRENT_TRIPS_LIMIT))
}

/// The last `cap` bytes, on a character boundary, marked when it cut.
fn tail(text: &str, cap: usize) -> String {
    if text.len() <= cap {
        return text.to_string();
    }
    let mut start = text.len() - cap;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &text[start..])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ledger() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        prepare(&conn).unwrap();
        conn
    }

    fn lay_one(conn: &Connection, name: &str) -> Tripwire {
        lay(
            conn,
            &NewTripwire::new(
                name,
                r#"{"fact":{"kind":"edit_failed"}}"#,
                "diagnose the failure and propose a fix",
                "Says what broke when an edit fails on main",
            ),
            1_000,
        )
        .unwrap()
    }

    /// A trip in the state the engine would have written it in, and the id it
    /// got. Every test below goes through the one verb that writes a row
    /// ([P03]), so a shape the engine cannot produce is one no fixture here
    /// can produce either.
    fn write_trip(
        conn: &Connection,
        tripwire_id: i64,
        key: &str,
        at_ms: i64,
        instance: &str,
        status: TripStatus,
        reason: Option<&str>,
    ) -> Option<i64> {
        insert_trip(
            conn,
            &NewTrip {
                tripwire_id,
                event_key: key.to_string(),
                at_ms,
                instance: instance.to_string(),
                status,
                reason: reason.map(str::to_owned),
                event_payload: None,
                repo_root: None,
            },
        )
        .unwrap()
    }

    /// A trip that fired and is running — the ordinary shape.
    fn fire(conn: &Connection, tripwire_id: i64, key: &str, at_ms: i64) -> i64 {
        write_trip(
            conn,
            tripwire_id,
            key,
            at_ms,
            "inst",
            TripStatus::Running,
            None,
        )
        .expect("this tripwire has no row for that key yet")
    }

    #[test]
    fn a_fresh_ledger_stamps_its_version_and_a_reopen_leaves_it() {
        let conn = ledger();
        let stamped: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stamped, TRIPWIRE_SCHEMA_VERSION);
        prepare(&conn).unwrap();
        let again: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(again, TRIPWIRE_SCHEMA_VERSION);
    }

    /// A newer build owns a shape this one cannot read, so the open refuses
    /// rather than writing rows against an unknown schema.
    #[test]
    fn a_newer_schema_on_disk_refuses_the_open() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", TRIPWIRE_SCHEMA_VERSION + 1)
            .unwrap();
        assert!(matches!(
            prepare(&conn),
            Err(TripwireLedgerError::SchemaTooNew { .. })
        ));
    }

    /// The v1 DDL, verbatim, so the migration is exercised against the shape
    /// that is actually on disk on somebody's machine rather than against a
    /// paraphrase of it.
    const V1_LEDGER_SQL: &str = "
        CREATE TABLE wires (
            id              INTEGER PRIMARY KEY,
            name            TEXT    NOT NULL UNIQUE,
            created_at      INTEGER NOT NULL,
            trigger         TEXT    NOT NULL,
            scope           TEXT,
            probe           TEXT,
            brief           TEXT    NOT NULL,
            model           TEXT,
            tier            TEXT    NOT NULL DEFAULT 'auto',
            permission_mode TEXT    NOT NULL DEFAULT 'acceptEdits',
            post            TEXT    NOT NULL DEFAULT 'auto',
            paused          INTEGER NOT NULL DEFAULT 0,
            cooldown_secs   INTEGER NOT NULL DEFAULT 60
        );
        CREATE TABLE trips (
            id             INTEGER PRIMARY KEY,
            wire_id        INTEGER NOT NULL REFERENCES wires(id) ON DELETE CASCADE,
            event_key      TEXT    NOT NULL,
            at_ms          INTEGER NOT NULL,
            instance       TEXT    NOT NULL,
            status         TEXT    NOT NULL,
            swallow_reason TEXT,
            event_payload  TEXT,
            probe_exit     INTEGER,
            probe_tail     TEXT,
            session_id     TEXT,
            dash           TEXT,
            interest       TEXT,
            outcome        TEXT,
            headline       TEXT,
            refs           TEXT,
            settled_at_ms  INTEGER,
            UNIQUE(wire_id, event_key)
        );
    ";

    /// A ledger as v1 left it: the old `wires` and `trips` shapes, one row, and
    /// the version stamp that sends it through the migrations on the next
    /// open. The old names are the point — they are what is on somebody's
    /// disk, and a fixture that spelled them the new way would exercise
    /// nothing.
    ///
    /// `trips` is here rather than left to the DDL because the v2 → v3
    /// migration alters it: a fixture without it would exercise the
    /// `CREATE TABLE IF NOT EXISTS` path instead of the migration, which is
    /// the one thing this fixture exists to avoid.
    fn v1_ledger() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(V1_LEDGER_SQL).unwrap();
        conn.execute(
            "INSERT INTO wires (name, created_at, trigger, scope, probe, brief, model, tier, post,
                                cooldown_secs)
             VALUES ('legacy', 1, '{\"fact\":{\"kind\":\"edit_failed\"}}', NULL, 'just ci',
                     'diagnose the failure', 'opus', 'work', 'always', 120)",
            [],
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();
        conn
    }

    /// The columns a table has, in the order it has them.
    fn table_info(conn: &Connection, table: &str) -> Vec<(String, String, i64, Option<String>)> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        let rows = stmt
            .query_map([], |r| Ok((r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
            .unwrap();
        rows.collect::<rusqlite::Result<Vec<_>>>().unwrap()
    }

    /// **The column a trip holds its work unit in, and the value a refusal
    /// records, move to the arc together.**
    ///
    /// Two halves of one rename, and both are checked here because they fail
    /// differently: a column that did not move errors every `SELECT` naming
    /// the new one, while a value that did not move is read back silently and
    /// simply never matches. The row is asserted intact besides — a rename is
    /// not a chance to lose a trip.
    #[test]
    fn a_v4_ledger_renames_the_trip_arc_column_and_its_swallow_value() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(CREATE_TRIPWIRES_SQL).unwrap();
        // Put the table back into its v4 shape: the DDL above mints `arc` and
        // `reason`, and v4 spelled them `dash` and `swallow_reason`. Without
        // this the probes under test find nothing to rename and the assertions
        // below pass on a table that was never old.
        conn.execute_batch(
            "ALTER TABLE trips RENAME COLUMN arc TO dash;
             ALTER TABLE trips RENAME COLUMN reason TO swallow_reason;",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tripwires (name, created_at, trigger, brief)
             VALUES ('w', 1, '{\"fact\":{\"kind\":\"edit_failed\"}}', 'diagnose')",
            [],
        )
        .unwrap();
        conn.execute_batch(
            "INSERT INTO trips (tripwire_id, event_key, at_ms, instance, status, swallow_reason,
                                session_id, dash, headline)
             VALUES
                (1, 'e1', 10, 'i', 'swallowed', 'own-dash', 'sess-1', 'tripwire-w-1', 'held'),
                (1, 'e2', 20, 'i', 'awaiting',  NULL,       'sess-2', 'tripwire-w-2', 'asked');",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 4).unwrap();

        prepare(&conn).unwrap();

        let stamped: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stamped, TRIPWIRE_SCHEMA_VERSION);

        let columns: Vec<String> = table_info(&conn, "trips")
            .into_iter()
            .map(|(name, _, _, _)| name)
            .collect();
        assert!(columns.iter().any(|c| c == "arc"), "{columns:?}");
        assert!(!columns.iter().any(|c| c == "dash"), "{columns:?}");

        let held = trip(&conn, 1).unwrap().unwrap();
        assert_eq!(held.arc.as_deref(), Some("tripwire-w-1"));
        assert_eq!(
            held.reason.as_deref(),
            Some("own-arc"),
            "the value the v4 rename wrote is read back for life, whatever the \
             guard that wrote it became"
        );
        assert_eq!(held.headline.as_deref(), Some("held"), "the row is intact");

        let asked = trip(&conn, 2).unwrap().unwrap();
        assert_eq!(asked.arc.as_deref(), Some("tripwire-w-2"));
        assert_eq!(
            asked.reason, None,
            "a row that recorded no reason is left alone"
        );

        // And v11 collapsed the word it stood in, keeping the row and its arc.
        assert_eq!(asked.status, "done");

        // Twice is once.
        prepare(&conn).unwrap();
        assert_eq!(
            trip(&conn, 1).unwrap().unwrap().arc.as_deref(),
            Some("tripwire-w-1")
        );
    }

    /// An old-shape ledger opens, keeps what survived, loses what was retired,
    /// and comes back stamped current.
    #[test]
    fn a_v1_ledger_migrates_its_rows_and_drops_the_retired_columns() {
        let conn = v1_ledger();
        prepare(&conn).unwrap();

        let stamped: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stamped, TRIPWIRE_SCHEMA_VERSION);

        let migrated = get(&conn, "legacy").unwrap().unwrap();
        assert_eq!(
            migrated.probe.as_deref(),
            Some("just ci"),
            "the probe was never on the deletion list ([P10])"
        );
        assert_eq!(migrated.model.as_deref(), Some("opus"));
        assert_eq!(migrated.brief, "diagnose the failure");

        let columns: Vec<String> = table_info(&conn, "tripwires")
            .into_iter()
            .map(|(name, ..)| name)
            .collect();
        for retired in ["tier", "post", "cooldown_secs"] {
            assert!(
                !columns.contains(&retired.to_string()),
                "`{retired}` survived the migration"
            );
        }
        assert!(
            !columns.contains(&"branch".to_string()),
            "v8 drops the branch column wherever it is found ([P02])"
        );
        assert!(
            !table_exists(&conn, "tripwire_marks").unwrap()
                && !table_exists(&conn, "wire_marks").unwrap(),
            "the marks table goes under either name it has worn"
        );
    }

    /// The one assertion that catches the DDL and the migration drifting apart.
    ///
    /// `CREATE_TRIPWIRES_SQL` is `CREATE TABLE IF NOT EXISTS` and runs *after*
    /// the migration list, so a fresh ledger is built from the DDL alone and an
    /// existing one from the migration alone. Editing either without the other
    /// ships two different schemas under one `user_version`, and nothing else
    /// in this file would notice.
    #[test]
    fn a_fresh_ledger_and_a_migrated_one_have_the_same_shape() {
        let fresh = ledger();
        for (from, migrated) in [
            ("v1", v1_ledger()),
            ("v5", v5_ledger()),
            ("v6", v6_ledger()),
            ("v8", v8_ledger()),
            ("v9", v9_ledger()),
            ("v10", v10_ledger()),
            ("v11", v11_ledger()),
        ] {
            prepare(&migrated).unwrap();
            for table in ["tripwires", "trips", "settings"] {
                assert_eq!(
                    table_info(&fresh, table),
                    table_info(&migrated, table),
                    "`{table}` differs between a fresh ledger and one migrated from {from}"
                );
            }
            // The named indexes too: a rename that drops the old index
            // without the DDL minting the new one leaves the migrated ledger
            // slower than a fresh one, and nothing else would say so.
            assert_eq!(
                named_indexes(&fresh),
                named_indexes(&migrated),
                "the indexes differ between a fresh ledger and one migrated from {from}"
            );
        }
    }

    /// The v5 DDL, verbatim — the last shape to spell the tables `wires` and
    /// `wire_marks` and the column `wire_id`, and what is on disk on any
    /// machine that laid a tripwire before the rename. Old names on purpose:
    /// a fixture spelled the new way exercises nothing.
    const V5_LEDGER_SQL: &str = "
        CREATE TABLE wires (
            id              INTEGER PRIMARY KEY,
            name            TEXT    NOT NULL UNIQUE,
            created_at      INTEGER NOT NULL,
            trigger         TEXT    NOT NULL,
            scope           TEXT,
            probe           TEXT,
            brief           TEXT    NOT NULL,
            model           TEXT,
            permission_mode TEXT    NOT NULL DEFAULT 'acceptEdits',
            paused          INTEGER NOT NULL DEFAULT 0,
            branch          TEXT    NOT NULL DEFAULT ''
        );
        CREATE TABLE trips (
            id             INTEGER PRIMARY KEY,
            wire_id        INTEGER NOT NULL REFERENCES wires(id) ON DELETE CASCADE,
            event_key      TEXT    NOT NULL,
            at_ms          INTEGER NOT NULL,
            instance       TEXT    NOT NULL,
            status         TEXT    NOT NULL,
            swallow_reason TEXT,
            event_payload  TEXT,
            probe_exit     INTEGER,
            probe_tail     TEXT,
            session_id     TEXT,
            arc            TEXT,
            headline       TEXT,
            refs           TEXT,
            settled_at_ms  INTEGER,
            author_ask     TEXT,
            UNIQUE(wire_id, event_key)
        );
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE wire_marks (
            wire_id        INTEGER NOT NULL REFERENCES wires(id) ON DELETE CASCADE,
            session_id     TEXT    NOT NULL,
            max_fact_rowid INTEGER NOT NULL,
            PRIMARY KEY (wire_id, session_id)
        );
        CREATE INDEX trips_by_wire ON trips (wire_id, id);
        CREATE INDEX trips_by_status ON trips (status);
    ";

    /// A ledger as v5 left it, with a row in every table the rename touches,
    /// stamped so the next open sends it through the v5 → v6 migration.
    fn v5_ledger() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(V5_LEDGER_SQL).unwrap();
        conn.execute_batch(
            "INSERT INTO wires (name, created_at, trigger, brief, branch)
             VALUES ('w', 1, '{\"fact\":{\"kind\":\"edit_failed\"}}', 'diagnose the failure', 'main');
             INSERT INTO trips (wire_id, event_key, at_ms, instance, status, headline)
             VALUES (1, 'landing:abc', 10, 'inst-a', 'settled', 'looked');
             INSERT INTO wire_marks (wire_id, session_id, max_fact_rowid) VALUES (1, 'sess-1', 7);
             INSERT INTO settings (key, value) VALUES ('max_concurrent_trips', '3');",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 5).unwrap();
        conn
    }

    /// The v6 DDL, verbatim — the shape after the rename and before the
    /// description column, and what is on disk on any machine that laid a
    /// tripwire between the two.
    const V6_LEDGER_SQL: &str = "
        CREATE TABLE tripwires (
            id              INTEGER PRIMARY KEY,
            name            TEXT    NOT NULL UNIQUE,
            created_at      INTEGER NOT NULL,
            trigger         TEXT    NOT NULL,
            scope           TEXT,
            probe           TEXT,
            brief           TEXT    NOT NULL,
            model           TEXT,
            permission_mode TEXT    NOT NULL DEFAULT 'acceptEdits',
            paused          INTEGER NOT NULL DEFAULT 0,
            branch          TEXT    NOT NULL DEFAULT ''
        );
        CREATE TABLE trips (
            id             INTEGER PRIMARY KEY,
            tripwire_id    INTEGER NOT NULL REFERENCES tripwires(id) ON DELETE CASCADE,
            event_key      TEXT    NOT NULL,
            at_ms          INTEGER NOT NULL,
            instance       TEXT    NOT NULL,
            status         TEXT    NOT NULL,
            swallow_reason TEXT,
            event_payload  TEXT,
            probe_exit     INTEGER,
            probe_tail     TEXT,
            session_id     TEXT,
            arc            TEXT,
            headline       TEXT,
            refs           TEXT,
            settled_at_ms  INTEGER,
            author_ask     TEXT,
            UNIQUE(tripwire_id, event_key)
        );
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE tripwire_marks (
            tripwire_id    INTEGER NOT NULL REFERENCES tripwires(id) ON DELETE CASCADE,
            session_id     TEXT    NOT NULL,
            max_fact_rowid INTEGER NOT NULL,
            PRIMARY KEY (tripwire_id, session_id)
        );
        CREATE INDEX trips_by_tripwire ON trips (tripwire_id, id);
        CREATE INDEX trips_by_status ON trips (status);
    ";

    /// A ledger as v6 left it, with two tripwires — one whose brief ends its
    /// first sentence and one that is a single unterminated line — stamped so
    /// the next open sends it through the v6 → v7 migration.
    fn v6_ledger() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(V6_LEDGER_SQL).unwrap();
        conn.execute_batch(
            "INSERT INTO tripwires (name, created_at, trigger, brief, branch)
             VALUES
                ('ci', 1, '{\"fact\":{\"kind\":\"edit_failed\"}}',
                 'Did the fact break the suite? Say which check went red and whether the change under it is what broke it.',
                 'main'),
                ('edits', 2, '{\"fact\":{\"kind\":\"edit_failed\"}}',
                 'report anything that looks wrong',
                 'main');
             INSERT INTO trips (tripwire_id, event_key, at_ms, instance, status, headline)
             VALUES (1, 'fact:inst-a:7', 10, 'inst-a', 'settled', 'looked');",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 6).unwrap();
        conn
    }

    /// A ledger as v8 left it: the shape this file shipped before `author_ask`
    /// was retired, with the column filled on a settled row so the drop has
    /// something to lose.
    const V8_LEDGER_SQL: &str = "
        CREATE TABLE tripwires (
            id              INTEGER PRIMARY KEY,
            name            TEXT    NOT NULL UNIQUE,
            created_at      INTEGER NOT NULL,
            trigger         TEXT    NOT NULL,
            scope           TEXT,
            probe           TEXT,
            brief           TEXT    NOT NULL,
            model           TEXT,
            permission_mode TEXT    NOT NULL DEFAULT 'acceptEdits',
            paused          INTEGER NOT NULL DEFAULT 0,
            description     TEXT    NOT NULL DEFAULT ''
        );
        CREATE TABLE trips (
            id             INTEGER PRIMARY KEY,
            tripwire_id    INTEGER NOT NULL REFERENCES tripwires(id) ON DELETE CASCADE,
            event_key      TEXT    NOT NULL,
            at_ms          INTEGER NOT NULL,
            instance       TEXT    NOT NULL,
            status         TEXT    NOT NULL,
            reason         TEXT,
            event_payload  TEXT,
            probe_exit     INTEGER,
            probe_tail     TEXT,
            session_id     TEXT,
            arc            TEXT,
            headline       TEXT,
            refs           TEXT,
            settled_at_ms  INTEGER,
            author_ask     TEXT,
            repo_root      TEXT,
            head_sha       TEXT,
            UNIQUE(tripwire_id, event_key)
        );
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE INDEX trips_by_tripwire ON trips (tripwire_id, id);
        CREATE INDEX trips_by_status ON trips (status);
    ";

    fn v8_ledger() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(V8_LEDGER_SQL).unwrap();
        conn.execute_batch(
            "INSERT INTO tripwires (name, created_at, trigger, brief, description)
             VALUES ('ci', 1, '{\"fact\":{\"kind\":\"edit_failed\"}}', 'diagnose the failure', 'ci');
             INSERT INTO trips (tripwire_id, event_key, at_ms, instance, status, headline, author_ask)
             VALUES
                (1, 'fact:inst-a:7', 10, 'inst-a', 'quiet', 'looked', 'update the expected string'),
                (1, 'fact:inst-a:8', 20, 'inst-a', 'awaiting', 'a fix is waiting', NULL);",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 8).unwrap();
        conn
    }

    /// A ledger as v9 left it: the shape after `author_ask` went and before a
    /// tripwire owned an arc, with a trip carrying the sha its disposable tree
    /// stood at.
    const V9_LEDGER_SQL: &str = "
        CREATE TABLE tripwires (
            id              INTEGER PRIMARY KEY,
            name            TEXT    NOT NULL UNIQUE,
            created_at      INTEGER NOT NULL,
            trigger         TEXT    NOT NULL,
            scope           TEXT,
            probe           TEXT,
            brief           TEXT    NOT NULL,
            model           TEXT,
            permission_mode TEXT    NOT NULL DEFAULT 'acceptEdits',
            paused          INTEGER NOT NULL DEFAULT 0,
            description     TEXT    NOT NULL DEFAULT ''
        );
        CREATE TABLE trips (
            id             INTEGER PRIMARY KEY,
            tripwire_id    INTEGER NOT NULL REFERENCES tripwires(id) ON DELETE CASCADE,
            event_key      TEXT    NOT NULL,
            at_ms          INTEGER NOT NULL,
            instance       TEXT    NOT NULL,
            status         TEXT    NOT NULL,
            reason         TEXT,
            event_payload  TEXT,
            probe_exit     INTEGER,
            probe_tail     TEXT,
            session_id     TEXT,
            arc            TEXT,
            headline       TEXT,
            refs           TEXT,
            settled_at_ms  INTEGER,
            repo_root      TEXT,
            head_sha       TEXT,
            UNIQUE(tripwire_id, event_key)
        );
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE INDEX trips_by_tripwire ON trips (tripwire_id, id);
        CREATE INDEX trips_by_status ON trips (status);
    ";

    fn v9_ledger() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(V9_LEDGER_SQL).unwrap();
        conn.execute_batch(
            "INSERT INTO tripwires (name, created_at, trigger, brief, description)
             VALUES ('ci', 1, '{\"fact\":{\"kind\":\"edit_failed\"}}', 'diagnose the failure', 'ci');
             INSERT INTO trips (tripwire_id, event_key, at_ms, instance, status, headline, repo_root, head_sha)
             VALUES (1, 'fact:inst-a:7', 10, 'inst-a', 'quiet', 'looked', '/src/tug', 'abc1234');",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 9).unwrap();
        conn
    }

    /// **The tripwire gains its home checkout and the trip loses the sha its
    /// disposable tree stood at.**
    ///
    /// The empty default on `repo_root` is asserted rather than glossed: a row
    /// laid before the arc existed has no checkout anybody chose, and a
    /// migration that guessed one would point an arc at a repository the user
    /// never named.
    #[test]
    fn a_v9_ledger_gains_the_home_checkout_and_drops_the_head_sha() {
        let conn = v9_ledger();
        prepare(&conn).unwrap();

        let stamped: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stamped, TRIPWIRE_SCHEMA_VERSION);

        let trip_columns: Vec<String> = table_info(&conn, "trips")
            .into_iter()
            .map(|(name, ..)| name)
            .collect();
        assert!(
            !trip_columns.contains(&"head_sha".to_string()),
            "the disposable tree's sha survived the migration: {trip_columns:?}"
        );

        let migrated = get(&conn, "ci").unwrap().unwrap();
        assert_eq!(
            migrated.repo_root, "",
            "a row laid before the arc existed names no checkout, and none is invented"
        );

        let kept = trip(&conn, 1).unwrap().unwrap();
        assert_eq!(kept.headline.as_deref(), Some("looked"));
        assert_eq!(
            kept.repo_root.as_deref(),
            Some("/src/tug"),
            "the checkout the fact was recorded in is a different column and stays"
        );

        // Twice is once. The `head_sha` probe and the `repo_root` probe both
        // run on every open, and the pair must not fight: one drops the column
        // and the other must not put it back.
        prepare(&conn).unwrap();
        let again: Vec<String> = table_info(&conn, "trips")
            .into_iter()
            .map(|(name, ..)| name)
            .collect();
        assert_eq!(trip_columns, again, "a second open moved the shape");
    }

    /// A ledger as v10 left it: a tripwire with its home checkout, trips with
    /// no `head_sha`, and rows standing in the three words v11 collapses.
    const V10_LEDGER_SQL: &str = "
        CREATE TABLE tripwires (
            id              INTEGER PRIMARY KEY,
            name            TEXT    NOT NULL UNIQUE,
            created_at      INTEGER NOT NULL,
            trigger         TEXT    NOT NULL,
            scope           TEXT,
            probe           TEXT,
            brief           TEXT    NOT NULL,
            model           TEXT,
            permission_mode TEXT    NOT NULL DEFAULT 'acceptEdits',
            paused          INTEGER NOT NULL DEFAULT 0,
            description     TEXT    NOT NULL DEFAULT '',
            repo_root       TEXT    NOT NULL DEFAULT ''
        );
        CREATE TABLE trips (
            id             INTEGER PRIMARY KEY,
            tripwire_id    INTEGER NOT NULL REFERENCES tripwires(id) ON DELETE CASCADE,
            event_key      TEXT    NOT NULL,
            at_ms          INTEGER NOT NULL,
            instance       TEXT    NOT NULL,
            status         TEXT    NOT NULL,
            reason         TEXT,
            event_payload  TEXT,
            probe_exit     INTEGER,
            probe_tail     TEXT,
            session_id     TEXT,
            arc            TEXT,
            headline       TEXT,
            refs           TEXT,
            settled_at_ms  INTEGER,
            repo_root      TEXT,
            UNIQUE(tripwire_id, event_key)
        );
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE INDEX trips_by_tripwire ON trips (tripwire_id, id);
        CREATE INDEX trips_by_status ON trips (status);
    ";

    fn v10_ledger() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(V10_LEDGER_SQL).unwrap();
        conn.execute_batch(
            "INSERT INTO tripwires (name, created_at, trigger, brief, description, repo_root)
             VALUES ('ci', 1, '{\"fact\":{\"kind\":\"edit_failed\"}}', 'diagnose the failure', 'ci', '/src/tug');
             INSERT INTO trips (tripwire_id, event_key, at_ms, instance, status, headline, arc)
             VALUES
                (1, 'fact:inst-a:1', 10, 'inst-a', 'quiet',    'looked',      NULL),
                (1, 'fact:inst-a:2', 20, 'inst-a', 'awaiting', 'look at this', 'tripwire-ci'),
                (1, 'fact:inst-a:3', 30, 'inst-a', 'adopted',  'taken over',  'tripwire-ci'),
                (1, 'fact:inst-a:4', 40, 'inst-a', 'failed',   'it died',     NULL),
                (1, 'fact:inst-a:5', 50, 'inst-a', 'running',  NULL,          NULL);",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 10).unwrap();
        conn
    }

    /// **The three finished words become one and no row is lost** ([P05]).
    ///
    /// The assertion is both halves, as every collapse's is: each migrated row
    /// stands in `done` with the words it carried, and the two statuses that
    /// were never part of the collapse — `running` and `failed` — are left
    /// exactly where they were. A migration that moved `running` would settle a
    /// trip whose session is still working.
    #[test]
    fn a_v10_ledger_collapses_its_statuses_and_keeps_every_row() {
        let conn = v10_ledger();
        prepare(&conn).unwrap();

        let stamped: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stamped, TRIPWIRE_SCHEMA_VERSION);

        let statuses: Vec<String> = (1..=5)
            .map(|id| trip(&conn, id).unwrap().unwrap().status)
            .collect();
        assert_eq!(
            statuses,
            vec!["done", "done", "done", "failed", "running"],
            "the three finished words collapse and the other two are left alone"
        );

        let held = trip(&conn, 2).unwrap().unwrap();
        assert_eq!(held.headline.as_deref(), Some("look at this"));
        assert_eq!(
            held.arc.as_deref(),
            Some("tripwire-ci"),
            "the arc the row named is not what the collapse was about"
        );
        assert_eq!(
            held.report, None,
            "nothing on disk says what a pre-v11 trip reported, and none is invented"
        );
        assert_eq!(held.rounds, None);

        // Twice is once: the `UPDATE` matches no rows the second time, and the
        // two added columns are probed rather than re-added.
        prepare(&conn).unwrap();
        assert_eq!(trip(&conn, 5).unwrap().unwrap().status, "running");
    }

    /// A ledger as v11 left it: the four statuses and the report columns, and
    /// a tripwire with no ceiling on what a trip of it may spend.
    const V11_LEDGER_SQL: &str = "
        CREATE TABLE tripwires (
            id              INTEGER PRIMARY KEY,
            name            TEXT    NOT NULL UNIQUE,
            created_at      INTEGER NOT NULL,
            trigger         TEXT    NOT NULL,
            scope           TEXT,
            probe           TEXT,
            brief           TEXT    NOT NULL,
            model           TEXT,
            permission_mode TEXT    NOT NULL DEFAULT 'acceptEdits',
            paused          INTEGER NOT NULL DEFAULT 0,
            description     TEXT    NOT NULL DEFAULT '',
            repo_root       TEXT    NOT NULL DEFAULT ''
        );
        CREATE TABLE trips (
            id             INTEGER PRIMARY KEY,
            tripwire_id    INTEGER NOT NULL REFERENCES tripwires(id) ON DELETE CASCADE,
            event_key      TEXT    NOT NULL,
            at_ms          INTEGER NOT NULL,
            instance       TEXT    NOT NULL,
            status         TEXT    NOT NULL,
            reason         TEXT,
            event_payload  TEXT,
            probe_exit     INTEGER,
            probe_tail     TEXT,
            session_id     TEXT,
            arc            TEXT,
            headline       TEXT,
            refs           TEXT,
            settled_at_ms  INTEGER,
            repo_root      TEXT,
            report         TEXT,
            rounds         INTEGER,
            UNIQUE(tripwire_id, event_key)
        );
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE INDEX trips_by_tripwire ON trips (tripwire_id, id);
        CREATE INDEX trips_by_status ON trips (status);
    ";

    fn v11_ledger() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(V11_LEDGER_SQL).unwrap();
        conn.execute_batch(
            "INSERT INTO tripwires (name, created_at, trigger, brief, description, repo_root)
             VALUES ('ci', 1, '{\"fact\":{\"kind\":\"edit_failed\"}}', 'diagnose the failure', 'ci', '/src/tug');
             INSERT INTO trips (tripwire_id, event_key, at_ms, instance, status, headline, report, rounds)
             VALUES (1, 'fact:inst-a:1', 10, 'inst-a', 'done', NULL, 'the suite is green again', 2);",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 11).unwrap();
        conn
    }

    /// **A tripwire laid before the caps existed gets them, and gets the same
    /// ones a tripwire laid today does** ([P06]).
    ///
    /// Not nullable, which is the point of asserting the values rather than
    /// the columns: an absent cap would be a tripwire that can still grind for
    /// an afternoon, and the whole reason for the schema change is that there
    /// is no such tripwire any more.
    #[test]
    fn a_v11_ledger_gains_both_caps_at_their_defaults() {
        let conn = v11_ledger();
        prepare(&conn).unwrap();

        let stamped: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stamped, TRIPWIRE_SCHEMA_VERSION);

        let migrated = get(&conn, "ci").unwrap().unwrap();
        assert_eq!(migrated.max_seconds, MAX_TRIP_SECONDS_DEFAULT);
        assert_eq!(migrated.max_tool_calls, MAX_TRIP_TOOL_CALLS_DEFAULT);

        let kept = trip(&conn, 1).unwrap().unwrap();
        assert_eq!(
            kept.report.as_deref(),
            Some("the suite is green again"),
            "the trip log is not what the caps were about"
        );
        assert_eq!(kept.rounds, Some(2));

        // Twice is once: the probe finds both columns the second time and
        // adds neither.
        prepare(&conn).unwrap();
        let again = get(&conn, "ci").unwrap().unwrap();
        assert_eq!(again.max_seconds, MAX_TRIP_SECONDS_DEFAULT);
    }

    /// The DDL's literal defaults and the constants beside them are one
    /// number, read two ways.
    ///
    /// A fresh ledger takes its defaults from `CREATE_TRIPWIRES_SQL` and a
    /// migrated one from [`migrate_tripwire_caps`], which interpolates the
    /// constants. Editing one without the other would give a tripwire laid on
    /// a new machine a different ceiling from one laid on an old one, under
    /// the same `user_version`, and nothing else here would notice.
    #[test]
    fn the_ddls_cap_defaults_are_the_constants() {
        let conn = ledger();
        let defaults: Vec<Option<String>> = table_info(&conn, "tripwires")
            .into_iter()
            .filter(|(name, ..)| name == "max_seconds" || name == "max_tool_calls")
            .map(|(_, _, _, default)| default)
            .collect();
        assert_eq!(
            defaults,
            vec![
                Some(MAX_TRIP_SECONDS_DEFAULT.to_string()),
                Some(MAX_TRIP_TOOL_CALLS_DEFAULT.to_string()),
            ],
            "the DDL and the constants disagree about what a tripwire is capped at"
        );
    }

    /// **The retired column goes and every row survives it.**
    ///
    /// A drop is the one migration that can lose data, so the assertion is both
    /// halves: the column is gone from the shape, and the rows a reader of the
    /// trip log would open are still there with the values that were never
    /// about the ask.
    #[test]
    fn a_v8_ledger_drops_the_author_ask_column_and_keeps_its_rows() {
        let conn = v8_ledger();
        prepare(&conn).unwrap();

        let stamped: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stamped, TRIPWIRE_SCHEMA_VERSION);

        let columns: Vec<String> = table_info(&conn, "trips")
            .into_iter()
            .map(|(name, ..)| name)
            .collect();
        assert!(
            !columns.contains(&"author_ask".to_string()),
            "the ask that opened a second session survived the migration: {columns:?}"
        );

        // Both rows come out `done`: the run this fixture carries goes through
        // v11's collapse on the way here, and what matters to this test is
        // that the words on them survived the drop.
        let looked = trip(&conn, 1).unwrap().unwrap();
        assert_eq!(looked.status, "done");
        assert_eq!(looked.headline.as_deref(), Some("looked"));
        let asked = trip(&conn, 2).unwrap().unwrap();
        assert_eq!(asked.status, "done");
        assert_eq!(asked.headline.as_deref(), Some("a fix is waiting"));

        // Twice is once: the probe finds no column the second time.
        prepare(&conn).unwrap();
        assert_eq!(trip(&conn, 1).unwrap().unwrap().status, "done");
    }

    /// **A migrated row arrives with a description, and it is the brief's
    /// first sentence.**
    ///
    /// The column's default is empty and the card leads with it ([B04]), so a
    /// migration that only added the column would put a row of blanks on the
    /// rail at the next launch. The backfill is a placeholder by design
    /// ([B02]) — what it has to be is *something a reader recognises the row
    /// by*, which is why it is asserted as the sentence rather than as
    /// non-empty.
    #[test]
    fn a_v6_ledger_gains_a_description_backfilled_from_the_brief() {
        let conn = v6_ledger();
        prepare(&conn).unwrap();

        let stamped: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stamped, TRIPWIRE_SCHEMA_VERSION);

        let ci = get(&conn, "ci").unwrap().unwrap();
        assert_eq!(
            ci.description, "Did the fact break the suite?",
            "the first sentence, and not the rest of the prompt behind it"
        );
        let edits = get(&conn, "edits").unwrap().unwrap();
        assert_eq!(
            edits.description, "report anything that looks wrong",
            "a brief with no terminator is one sentence, whole"
        );
        assert_eq!(
            ci.brief.lines().count(),
            1,
            "the brief is left exactly where it was"
        );

        // The trip the tripwire earned is still hanging off it: `ADD COLUMN`
        // rewrites no rows, and a migration that lost the log would be a
        // migration nobody could tell had run.
        assert_eq!(trips_for_tripwire(&conn, ci.id, 10).unwrap().len(), 1);

        // Twice is once: the probe finds the column and the backfill finds
        // nothing left to fill.
        prepare(&conn).unwrap();
        assert_eq!(
            get(&conn, "ci").unwrap().unwrap().description,
            "Did the fact break the suite?"
        );
    }

    /// **A description that says nothing is refused at the arming gesture.**
    ///
    /// The same [B07] posture as the brief's guard, for a different reader: a
    /// description is the only thing the card has to tell one row from
    /// another ([B02]), and a row laid with `--description d` is a row nobody
    /// will recognise. Refused where it is cheap to fix rather than found on
    /// the rail weeks later.
    #[test]
    fn a_description_that_says_nothing_is_refused_when_a_tripwire_is_laid() {
        let conn = ledger();
        for placeholder in ["", "   ", "d"] {
            let tripwire = NewTripwire::new(
                "w",
                r#"{"fact":{"kind":"shell"}}"#,
                "Flag anything red.",
                placeholder,
            );
            assert!(
                matches!(
                    lay(&conn, &tripwire, 1),
                    Err(TripwireLedgerError::EmptyDescription(n, _)) if n == "w"
                ),
                "`{placeholder}` was accepted as a description"
            );
        }

        // And the same guard on the other door, so an edit cannot blank what
        // the lay insisted on.
        let real = lay(
            &conn,
            &NewTripwire::new(
                "w",
                r#"{"fact":{"kind":"shell"}}"#,
                "Flag anything red.",
                "Flags a red shell fact on main",
            ),
            1,
        )
        .unwrap();
        assert_eq!(real.description, "Flags a red shell fact on main");
        assert!(matches!(
            update(
                &conn,
                "w",
                &TripwireEdit {
                    description: Some("  ".to_string()),
                    ..Default::default()
                },
            ),
            Err(TripwireLedgerError::EmptyDescription(_, _))
        ));
        assert_eq!(
            get(&conn, "w").unwrap().unwrap().description,
            "Flags a red shell fact on main",
            "a refused edit moves nothing"
        );
    }

    /// Every index somebody named, in name order. The autoindexes SQLite mints
    /// for `UNIQUE` and `PRIMARY KEY` are left out because their names are
    /// SQLite's own and follow the table's.
    fn named_indexes(conn: &Connection) -> Vec<(String, String)> {
        let mut stmt = conn
            .prepare(
                "SELECT name, tbl_name FROM sqlite_master
                 WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'
                 ORDER BY name",
            )
            .unwrap();
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        rows.collect::<rusqlite::Result<Vec<_>>>().unwrap()
    }

    /// The whole schema as SQLite records it, for saying that a second open
    /// changed nothing.
    fn schema_of(conn: &Connection) -> Vec<(String, String, Option<String>)> {
        let mut stmt = conn
            .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
            .unwrap();
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap();
        rows.collect::<rusqlite::Result<Vec<_>>>().unwrap()
    }

    /// **The tables and the column take the feature's own noun, and every row
    /// comes through.**
    ///
    /// Three renames, each checked by name because each fails on its own:
    /// a table that did not move errors every query, a column that did not
    /// move errors every `SELECT` naming it, and a child table whose
    /// `REFERENCES` clause was not rewritten cascades to nothing. The rows are
    /// asserted intact through the readers the engine uses, and the second open
    /// is asserted to change nothing at all — which is what makes a rename that
    /// `ALTER TABLE` refuses to run twice safe to reach from a stamp it never
    /// saw.
    #[test]
    fn a_v5_ledger_renames_its_tables_and_column_and_keeps_every_row() {
        let conn = v5_ledger();
        prepare(&conn).unwrap();

        let stamped: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stamped, TRIPWIRE_SCHEMA_VERSION);

        assert!(
            table_exists(&conn, "tripwires").unwrap(),
            "`tripwires` was not created"
        );
        assert!(
            !table_exists(&conn, "wires").unwrap(),
            "`wires` survived the rename"
        );
        assert!(
            !table_exists(&conn, "wire_marks").unwrap()
                && !table_exists(&conn, "tripwire_marks").unwrap(),
            "v8 drops the marks table under either name it has worn"
        );
        let columns = columns_of(&conn, "trips").unwrap();
        assert!(columns.iter().any(|c| c == "tripwire_id"), "{columns:?}");
        assert!(!columns.iter().any(|c| c == "wire_id"), "{columns:?}");
        let indexes = named_indexes(&conn);
        assert!(
            indexes.iter().any(|(name, _)| name == "trips_by_tripwire"),
            "{indexes:?}"
        );
        assert!(
            !indexes.iter().any(|(name, _)| name == "trips_by_wire"),
            "{indexes:?}"
        );

        // The rows, through the readers.
        let w = get(&conn, "w").unwrap().expect("the tripwire came through");
        assert_eq!(w.brief, "diagnose the failure");
        let t = trip(&conn, 1).unwrap().expect("the trip came through");
        assert_eq!(t.tripwire_id, w.id);
        assert_eq!(t.headline.as_deref(), Some("looked"));
        assert_eq!(max_concurrent_trips(&conn).unwrap(), 3);

        // The child still follows the parent: the `REFERENCES` clause was
        // rewritten with the rename, not left pointing at a table that is gone.
        remove(&conn, "w").unwrap();
        let trips: i64 = conn
            .query_row("SELECT COUNT(*) FROM trips", [], |r| r.get(0))
            .unwrap();
        assert_eq!(trips, 0, "the cascade reaches the trips");

        // Twice is once.
        let before = schema_of(&conn);
        prepare(&conn).unwrap();
        assert_eq!(schema_of(&conn), before, "a second open moved the schema");
    }

    /// A crash between the renames and the version stamp leaves a ledger that
    /// is half-moved and still stamped 5. The next open has to finish the job
    /// rather than fail on the half that already ran.
    #[test]
    fn a_rename_interrupted_before_the_stamp_is_finished_on_the_next_open() {
        let conn = v5_ledger();
        // The parent table moved; nothing else did, and the stamp still says 5.
        conn.execute_batch("ALTER TABLE wires RENAME TO tripwires;")
            .unwrap();

        prepare(&conn).unwrap();

        assert!(!table_exists(&conn, "wire_marks").unwrap());
        let columns = columns_of(&conn, "trips").unwrap();
        assert!(columns.iter().any(|c| c == "tripwire_id"), "{columns:?}");
        assert_eq!(trip(&conn, 1).unwrap().unwrap().tripwire_id, 1);
        assert_eq!(
            table_info(&ledger(), "trips"),
            table_info(&conn, "trips"),
            "the finished ledger has the fresh shape"
        );
    }

    #[test]
    fn a_tripwire_lays_reads_back_and_refuses_a_second_under_one_name() {
        let conn = ledger();
        let laid = lay_one(&conn, "tugedit");
        assert_eq!(laid.name, "tugedit");
        assert!(!laid.paused);
        assert_eq!(get(&conn, "tugedit").unwrap().as_ref(), Some(&laid));

        let again = lay(
            &conn,
            &NewTripwire::new(
                "tugedit",
                r#"{"fact":{"kind":"shell"}}"#,
                "report anything that looks wrong",
                "Watches shell facts on main and reports what looks wrong",
            ),
            2_000,
        );
        assert!(matches!(again, Err(TripwireLedgerError::DuplicateName(n)) if n == "tugedit"));
        assert_eq!(
            get(&conn, "tugedit").unwrap().unwrap().brief,
            "diagnose the failure and propose a fix",
            "the refusal left the original alone"
        );
    }

    #[test]
    fn an_edit_moves_only_the_fields_it_names() {
        let conn = ledger();
        lay_one(&conn, "w");
        let edited = update(
            &conn,
            "w",
            &TripwireEdit {
                probe: Some(Some("just ci".to_string())),
                scope: Some(Some("/repo".to_string())),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(edited.probe.as_deref(), Some("just ci"));
        assert_eq!(
            edited.brief, "diagnose the failure and propose a fix",
            "untouched"
        );
        assert_eq!(edited.trigger, r#"{"fact":{"kind":"edit_failed"}}"#);

        let cleared = update(
            &conn,
            "w",
            &TripwireEdit {
                probe: Some(None),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(cleared.probe.is_none(), "Some(None) clears the column");
    }

    /// A brief that gives the AI nothing to do is refused at both arming
    /// gestures, for the same [B07] reason the scope check is: the
    /// tripwire this rules out is not merely useless, it is expensive. The `w`
    /// tripwire laid with `--brief b` during a shakedown summoned a model on
    /// every commit for days, and every one of them reported that it had been
    /// told nothing.
    #[test]
    fn a_brief_that_says_nothing_is_refused_at_both_arming_gestures() {
        let conn = ledger();
        let placeholder = NewTripwire::new(
            "w",
            r#"{"fact":{"kind":"shell"}}"#,
            "b",
            "Watches shell facts on main",
        );
        assert!(matches!(
            lay(&conn, &placeholder, 1),
            Err(TripwireLedgerError::EmptyBrief(n, _)) if n == "w"
        ));
        assert!(matches!(
            lay(
                &conn,
                &NewTripwire::new(
                    "w",
                    r#"{"fact":{"kind":"shell"}}"#,
                    "   ",
                    "Watches shell facts on main",
                ),
                1
            ),
            Err(TripwireLedgerError::EmptyBrief(_, _))
        ));

        // The bar is a placeholder filter, not a quality bar: the shortest real
        // brief anybody has written clears it.
        let real = lay(
            &conn,
            &NewTripwire::new(
                "w",
                r#"{"fact":{"kind":"shell"}}"#,
                "Flag anything red.",
                "Flags a red shell fact on main",
            ),
            1,
        )
        .unwrap();
        assert_eq!(real.brief, "Flag anything red.");

        // And the second door: editing a good brief down to a placeholder is
        // the same no-op tripwire arriving another way.
        let edit = TripwireEdit {
            brief: Some("b".to_string()),
            ..Default::default()
        };
        assert!(matches!(
            update(&conn, "w", &edit),
            Err(TripwireLedgerError::EmptyBrief(_, _))
        ));
        assert_eq!(
            get(&conn, "w").unwrap().unwrap().brief,
            "Flag anything red."
        );
    }

    #[test]
    fn pausing_leaves_the_tripwire_and_its_log_and_takes_it_out_of_armed() {
        let conn = ledger();
        let w = lay_one(&conn, "w");
        fire(&conn, w.id, "e1", 1);
        assert_eq!(armed(&conn).unwrap().len(), 1);

        set_paused(&conn, "w", true).unwrap();
        assert!(armed(&conn).unwrap().is_empty());
        assert_eq!(list(&conn).unwrap().len(), 1, "still laid, just not armed");
        assert_eq!(trips_for_tripwire(&conn, w.id, 10).unwrap().len(), 1);

        set_paused(&conn, "w", false).unwrap();
        assert_eq!(armed(&conn).unwrap().len(), 1);
    }

    #[test]
    fn removing_a_tripwire_takes_its_trips_with_it() {
        let conn = ledger();
        let w = lay_one(&conn, "w");
        // A settled trip, because a *running* one refuses the delete — that
        // guard has a test of its own below.
        settled_trip(&conn, w.id, "e1", 1);
        remove(&conn, "w").unwrap();
        assert!(get(&conn, "w").unwrap().is_none());
        assert!(trips_for_tripwire(&conn, w.id, 10).unwrap().is_empty());
        assert!(matches!(
            remove(&conn, "w"),
            Err(TripwireLedgerError::NoSuchTripwire(_))
        ));
    }

    /// **A running trip refuses the delete, in one statement.**
    ///
    /// The refusal and the `DELETE` are one `NOT EXISTS`, because the two
    /// doors that remove a tripwire are separate processes and a read followed
    /// by a delete leaves a window a claim can land in. What the guard is
    /// protecting is the run's *arc*: the settle paths survive a vanished row
    /// on their own, and an orphaned worktree is the thing nothing else would
    /// notice.
    #[test]
    fn a_running_trip_refuses_the_delete_and_a_settled_one_does_not() {
        let conn = ledger();
        let w = lay_one(&conn, "w");
        let trip_id = fire(&conn, w.id, "e1", 1);
        record_run(&conn, trip_id, Some("sess-1"), Some("tripwire-w-abcd1234")).unwrap();

        assert!(matches!(
            remove(&conn, "w"),
            Err(TripwireLedgerError::TripRunning(n)) if n == "w"
        ));
        assert!(
            get(&conn, "w").unwrap().is_some(),
            "a refused delete moves nothing"
        );
        assert_eq!(
            running_trip(&conn, w.id).unwrap().map(|t| t.id),
            Some(trip_id)
        );

        // A finished trip is not guarded here: the arc a removal discards is
        // the tripwire's own, and discarding it before the delete belongs to
        // the caller that knows how — `tugarc_core::tripwire_remove`.
        settle(&conn, trip_id, TripStatus::Done, &Settlement::default(), 2).unwrap();
        assert_eq!(running_trip(&conn, w.id).unwrap(), None);
        remove(&conn, "w").unwrap();
        assert!(get(&conn, "w").unwrap().is_none());
    }

    /// A replayed fact writes no second row: the tripwire already has one for
    /// that key, and `INSERT OR IGNORE` against the surviving unique
    /// constraint is what makes that a no-op rather than an error with nowhere
    /// to go (Spec S03).
    #[test]
    fn a_replayed_event_key_writes_no_second_row() {
        let conn = ledger();
        let w = lay_one(&conn, "w");
        let first = write_trip(
            &conn,
            w.id,
            "fact:i:7",
            10,
            "inst-a",
            TripStatus::Running,
            None,
        );
        let second = write_trip(
            &conn,
            w.id,
            "fact:i:7",
            11,
            "inst-a",
            TripStatus::Running,
            None,
        );
        assert!(first.is_some());
        assert_eq!(second, None, "the second insert is refused, not an error");
        assert_eq!(trips_for_tripwire(&conn, w.id, 10).unwrap().len(), 1);
    }

    /// Two tripwires watching one fact are two trips, not one — the key is
    /// unique per tripwire, not machine-wide.
    #[test]
    fn two_tripwires_each_write_a_row_for_one_fact() {
        let conn = ledger();
        let a = lay_one(&conn, "a");
        let b = lay_one(&conn, "b");
        assert!(write_trip(&conn, a.id, "fact:i:1", 1, "i", TripStatus::Running, None).is_some());
        assert!(write_trip(&conn, b.id, "fact:i:1", 1, "i", TripStatus::Running, None).is_some());
    }

    /// Write a trip and settle it, which is what a firing that ran and
    /// reported nothing leaves behind — and the only shape the log retains.
    fn settled_trip(conn: &Connection, tripwire_id: i64, key: &str, at_ms: i64) -> i64 {
        write_trip(
            conn,
            tripwire_id,
            key,
            at_ms,
            "inst",
            TripStatus::Done,
            None,
        )
        .expect("each event key is this tripwire's first")
    }

    /// Retention is per tripwire and runs at insert time: the oldest row falls
    /// out as the five-hundred-and-first arrives, and a neighbour's log is not
    /// touched by it.
    #[test]
    fn retention_keeps_the_newest_trips_per_tripwire() {
        let conn = ledger();
        let w = lay_one(&conn, "w");
        let other = lay_one(&conn, "other");
        settled_trip(&conn, other.id, "neighbour", 1);

        let ids: Vec<i64> = (0..(MAX_TRIPS_PER_TRIPWIRE + 1))
            .map(|i| settled_trip(&conn, w.id, &format!("e{i}"), 1_000 + i))
            .collect();

        let kept = trips_for_tripwire(&conn, w.id, MAX_TRIPS_PER_TRIPWIRE * 2).unwrap();
        assert_eq!(kept.len() as i64, MAX_TRIPS_PER_TRIPWIRE);
        assert!(trip(&conn, ids[0]).unwrap().is_none());
        assert!(trip(&conn, ids[1]).unwrap().is_some());
        assert!(trip(&conn, *ids.last().unwrap()).unwrap().is_some());
        assert_eq!(trips_for_tripwire(&conn, other.id, 10).unwrap().len(), 1);
    }

    /// A running trip is state rather than log, and the cap is on the log: a
    /// session is working in that row this second, and a tripwire firing on
    /// every fact must not delete the row it is about to settle.
    #[test]
    fn retention_spares_a_trip_that_is_still_running() {
        let conn = ledger();
        let w = lay_one(&conn, "w");
        let held = write_trip(&conn, w.id, "held", 1, "inst", TripStatus::Running, None)
            .expect("the first row on an empty log is written");

        for i in 0..(MAX_TRIPS_PER_TRIPWIRE + 5) {
            settled_trip(&conn, w.id, &format!("e{i}"), 1_000 + i);
        }

        let still = trip(&conn, held)
            .unwrap()
            .expect("the running trip outlives the cap");
        assert_eq!(still.status, "running");
    }

    /// **Only the three terminal statuses are pruned**, and the list is by
    /// name rather than `running` negated: a status this build has not learned
    /// costs a row and can never cost a live trip.
    #[test]
    fn retention_prunes_only_the_three_terminal_statuses() {
        let conn = ledger();
        let w = lay_one(&conn, "w");
        let live: Vec<i64> = [TripStatus::Running]
            .into_iter()
            .enumerate()
            .map(|(i, status)| {
                write_trip(
                    &conn,
                    w.id,
                    &format!("live{i}"),
                    1 + i as i64,
                    "inst",
                    status,
                    None,
                )
                .expect("each key is its tripwire's first")
            })
            .collect();
        let skipped = write_trip(
            &conn,
            w.id,
            "old-skip",
            9,
            "inst",
            TripStatus::Skipped,
            Some(SKIP_BUSY),
        )
        .expect("written");

        for i in 0..(MAX_TRIPS_PER_TRIPWIRE + 5) {
            settled_trip(&conn, w.id, &format!("e{i}"), 1_000 + i);
        }

        for id in live {
            assert!(
                trip(&conn, id).unwrap().is_some(),
                "a live trip is state rather than log and outlives the cap"
            );
        }
        assert!(
            trip(&conn, skipped).unwrap().is_none(),
            "a skipped row is log, and the oldest log falls out"
        );
    }

    /// The own-session gate's one read ([B03]): a session this tripwire's own
    /// trip ran in, and no other tripwire's.
    #[test]
    fn an_own_session_is_recognised_by_tripwire_and_session_id() {
        let conn = ledger();
        let mine = lay_one(&conn, "mine");
        let theirs = lay_one(&conn, "theirs");
        let trip_id = fire(&conn, mine.id, "fact:i:1", 1);
        record_session_if_running(&conn, trip_id, "sess-trip").unwrap();

        assert!(is_trip_session(&conn, mine.id, "sess-trip").unwrap());
        assert!(
            !is_trip_session(&conn, theirs.id, "sess-trip").unwrap(),
            "another tripwire's trip session is an ordinary session to this one ([Q01])"
        );
        assert!(!is_trip_session(&conn, mine.id, "sess-somebody-else").unwrap());
    }

    /// The band's count is of trips that ran ([P10]): a broad tripwire's
    /// busy-skips must not drown it.
    #[test]
    fn trip_count_excludes_skipped_rows() {
        let conn = ledger();
        let w = lay_one(&conn, "w");
        assert_eq!(trip_count(&conn, w.id).unwrap(), 0);
        fire(&conn, w.id, "ran", 1);
        settled_trip(&conn, w.id, "done", 2);
        write_trip(
            &conn,
            w.id,
            "busy",
            3,
            "inst",
            TripStatus::Skipped,
            Some(SKIP_BUSY),
        )
        .expect("written");
        assert_eq!(trip_count(&conn, w.id).unwrap(), 2);
    }

    #[test]
    fn the_running_count_is_what_the_ceiling_is_read_against() {
        let conn = ledger();
        let w = lay_one(&conn, "w");
        assert_eq!(running_count(&conn).unwrap(), 0);
        let trip_id = fire(&conn, w.id, "e1", 1);
        record_run(&conn, trip_id, Some("tug-1"), Some("tripwire-w-abc")).unwrap();
        assert_eq!(running_count(&conn).unwrap(), 1);

        settle(
            &conn,
            trip_id,
            TripStatus::Done,
            &Settlement {
                headline: Some("it broke".to_string()),
                refs: Some(r#"[{"kind":"arc","target":"tripwire-w-abc"}]"#.to_string()),
                ..Settlement::default()
            },
            9_000,
        )
        .unwrap();
        assert_eq!(running_count(&conn).unwrap(), 0);

        let settled = trip(&conn, trip_id).unwrap().unwrap();
        assert_eq!(settled.status, "done");
        assert_eq!(settled.session_id.as_deref(), Some("tug-1"));
        assert_eq!(settled.arc.as_deref(), Some("tripwire-w-abc"));
        assert_eq!(settled.headline.as_deref(), Some("it broke"));
        assert_eq!(settled.settled_at_ms, Some(9_000));
    }

    #[test]
    fn a_probe_tail_is_kept_capped_and_the_cut_is_marked() {
        let conn = ledger();
        let w = lay_one(&conn, "w");
        let trip_id = fire(&conn, w.id, "e1", 1);
        record_probe(&conn, trip_id, 1, "short output").unwrap();
        assert_eq!(
            trip(&conn, trip_id).unwrap().unwrap().probe_tail.as_deref(),
            Some("short output")
        );

        let huge = format!("{}THE END", "x".repeat(PROBE_TAIL_CAP * 2));
        record_probe(&conn, trip_id, 1, &huge).unwrap();
        let kept = trip(&conn, trip_id).unwrap().unwrap().probe_tail.unwrap();
        assert!(kept.starts_with('…'), "the cut is marked");
        assert!(
            kept.ends_with("THE END"),
            "the tail is the end, not the head"
        );
        assert!(kept.len() <= PROBE_TAIL_CAP + '…'.len_utf8());
        assert_eq!(trip(&conn, trip_id).unwrap().unwrap().probe_exit, Some(1));
    }

    /// A row left `running` by a dead tugcast holds a concurrency slot
    /// nothing will ever free.
    #[test]
    fn the_boot_sweep_fails_this_instances_orphaned_runs_and_no_others() {
        let conn = ledger();
        let w = lay_one(&conn, "w");
        let mine =
            write_trip(&conn, w.id, "e1", 1, "me", TripStatus::Running, None).expect("written");
        let theirs =
            write_trip(&conn, w.id, "e2", 2, "them", TripStatus::Running, None).expect("written");

        assert_eq!(sweep_stale_running(&conn, "me", 5_000).unwrap(), 1);
        assert_eq!(trip(&conn, mine).unwrap().unwrap().status, "failed");
        assert_eq!(
            trip(&conn, theirs).unwrap().unwrap().status,
            "running",
            "another instance's run is still alive"
        );
    }

    /// The age sweep fails another instance's abandoned run, and
    /// leaves this instance's own rows alone however old they are: a session
    /// this instance is running has no clock on it.
    #[test]
    fn the_age_sweep_fails_another_instances_run_and_never_this_instances_rows() {
        let conn = ledger();
        let w = lay_one(&conn, "w");
        let theirs = write_trip(
            &conn,
            w.id,
            "fact:t:1",
            1,
            "them",
            TripStatus::Running,
            None,
        )
        .expect("written");
        let mine = write_trip(&conn, w.id, "fact:m:1", 1, "me", TripStatus::Running, None)
            .expect("written");

        assert_eq!(sweep_orphaned_running(&conn, 5_000, "me").unwrap(), 1);
        let swept = trip(&conn, theirs).unwrap().unwrap();
        assert_eq!(swept.status, "failed");
        assert_eq!(
            swept.reason.as_deref(),
            Some("abandoned"),
            "the row says what became of it"
        );
        assert_eq!(
            trip(&conn, mine).unwrap().unwrap().status,
            "running",
            "this instance's long run is not an orphan"
        );
    }

    #[test]
    fn the_ceiling_falls_back_to_the_default_rather_than_failing() {
        let conn = ledger();
        assert_eq!(
            max_concurrent_trips(&conn).unwrap(),
            DEFAULT_MAX_CONCURRENT_TRIPS
        );
        set_setting(&conn, SETTING_MAX_CONCURRENT_TRIPS, "5").unwrap();
        assert_eq!(max_concurrent_trips(&conn).unwrap(), 5);
        set_setting(&conn, SETTING_MAX_CONCURRENT_TRIPS, "not a number").unwrap();
        assert_eq!(
            max_concurrent_trips(&conn).unwrap(),
            DEFAULT_MAX_CONCURRENT_TRIPS,
            "a typo must not stop every tripwire on the machine"
        );
        set_setting(&conn, SETTING_MAX_CONCURRENT_TRIPS, "0").unwrap();
        assert_eq!(
            max_concurrent_trips(&conn).unwrap(),
            DEFAULT_MAX_CONCURRENT_TRIPS
        );
    }

    /// A tripwire laid by a newer build against a grammar this one cannot read is
    /// still a tripwire this one can list and remove.
    #[test]
    fn an_unreadable_trigger_costs_the_predicate_never_the_row() {
        let conn = ledger();
        lay(
            &conn,
            &NewTripwire::new(
                "future",
                r#"{"portent":{"omen":"raven"}}"#,
                "diagnose the failure and propose a fix",
                "Reads a trigger this build does not know",
            ),
            1,
        )
        .unwrap();
        let listed = list(&conn).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(matches!(
            listed[0].predicate(),
            Err(TripwireLedgerError::BadTrigger(_))
        ));
        remove(&conn, "future").unwrap();
    }

    #[test]
    fn every_status_spelling_round_trips() {
        for s in [
            TripStatus::Skipped,
            TripStatus::Running,
            TripStatus::Done,
            TripStatus::Failed,
        ] {
            assert_eq!(TripStatus::parse(s.as_str()), Some(s));
        }
        assert_eq!(TripStatus::parse("nonsense"), None);
    }

    /// The seat write names the session on a running row and refuses a
    /// settled one, which is how a trip whose own verb won the poll keeps its
    /// settle while still being reachable (Risk R03).
    #[test]
    fn record_session_if_running_writes_only_a_running_row() {
        let conn = ledger();
        let tripwire = lay_one(&conn, "ci");
        let trip_id = fire(&conn, tripwire.id, "fact:i:1", 1);
        record_run(&conn, trip_id, None, None).unwrap();

        assert!(record_session_if_running(&conn, trip_id, "sess-seated").unwrap());
        let seated = trip(&conn, trip_id).unwrap().unwrap();
        assert_eq!(seated.session_id.as_deref(), Some("sess-seated"));
        assert_eq!(seated.status, "running", "the seat settles nothing");

        // A second trip, settled before anything seats it: the write is
        // refused and the row keeps its null.
        let settled = fire(&conn, tripwire.id, "fact:i:2", 2);
        settle(
            &conn,
            settled,
            TripStatus::Done,
            &Settlement {
                headline: Some("nothing to report".to_string()),
                ..Settlement::default()
            },
            5,
        )
        .unwrap();

        assert!(!record_session_if_running(&conn, settled, "sess-late").unwrap());
        let held = trip(&conn, settled).unwrap().unwrap();
        assert_eq!(held.session_id, None);
        assert_eq!(held.status, "done");
    }
    #[test]
    fn editing_or_pausing_a_tripwire_that_is_not_there_refuses() {
        let conn = ledger();
        assert!(matches!(
            update(&conn, "ghost", &TripwireEdit::default()),
            Err(TripwireLedgerError::NoSuchTripwire(_))
        ));
        assert!(matches!(
            set_paused(&conn, "ghost", true),
            Err(TripwireLedgerError::NoSuchTripwire(_))
        ));
    }
}
