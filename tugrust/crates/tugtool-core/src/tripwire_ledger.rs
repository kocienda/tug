//! The standing-tripwire ledger — every tripwire laid on this machine, and every
//! firing any instance has claimed.
//!
//! **Machine-global**, beside `changes.db` rather than inside an instance
//! directory (`tugcore::instance::tripwires_db_path`), and for a stronger
//! reason than the other shared ledgers have. Two tugcasts watching the same
//! workspace see the same commit, and the thing that stops both of them
//! firing one tripwire twice is the `UNIQUE(tripwire_id, event_key)` constraint on
//! `trips`: the first insert wins, the second gets a constraint violation and
//! stops. That is only arbitration if both writers are in the same table.
//!
//! **Multi-writer by design, with no writer lock.** The claim *requires*
//! concurrent inserts from independent processes, so a single-writer contract
//! would need cross-instance routing that does not exist machine-globally.
//! WAL plus `busy_timeout` carries this write pattern — small rows, no
//! cross-row invariants — and the constraint is the only arbitration there is.
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
pub const TRIPWIRE_SCHEMA_VERSION: i64 = 6;

/// How many trips are kept per tripwire. Older rows are deleted at record
/// time — the regime the app-test results ledger already runs. A tripwire that
/// fires on every landing would otherwise grow its log without bound, and the
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

/// v4 → v5: the work unit is an arc, so the value a swallow records is too.
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

/// How much of a probe's output a trip row keeps. The tail, because a probe
/// that failed says why at the end.
pub const PROBE_TAIL_CAP: usize = 8 * 1024;

/// The schema spells the feature's own noun. `tripwires`, `tripwire_marks`
/// and `trips.tripwire_id` are what a reader of this ledger — in `sqlite3`, in
/// a dossier, in a query somebody writes at three in the morning — finds, and
/// they are the same word the card, the CLI and every other surface use.
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
        branch          TEXT    NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS trips (
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
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tripwire_marks (
        tripwire_id    INTEGER NOT NULL REFERENCES tripwires(id) ON DELETE CASCADE,
        session_id     TEXT    NOT NULL,
        max_fact_rowid INTEGER NOT NULL,
        PRIMARY KEY (tripwire_id, session_id)
    );
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
        "tripwire {0} names no base branch. A tripwire fires on a landing onto a branch, so the branch is what it watches — give it --branch <name>"
    )]
    MissingBranch(String),
    #[error(
        "the brief for tripwire {0} says nothing for the AI to do: {1}. A brief is the whole instruction a trip runs on, so a placeholder buys a model run per firing and a trip log full of `no further detail available to assess significance` — say what to look at and what to report."
    )]
    EmptyBrief(String, &'static str),
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

// MARK: - Rows

/// Why a claim was refused before the predicate ever ran. Free text in the
/// column, named constants here, because a reason a reader sees on a row and a
/// reason the engine writes have to be the same word.
pub const SWALLOW_BUSY: &str = "busy";

/// The landing is a join of an arc this very tripwire created ([P06]).
pub const SWALLOW_OWN_ARC: &str = "own-arc";

/// The landing's lineage carried nothing the tripwire is watching for. A row
/// rather than a silence, so a tripwire that has looked at fifty landings and
/// found nothing does not read like a tripwire nobody ever landed onto.
pub const SWALLOW_NO_MATCH: &str = "no-match";

/// Where a trip stands. The whole life of one firing, and every value is
/// written down — a swallowed trip is a row, not a silence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TripStatus {
    /// This instance won the insert and owns the firing.
    Claimed,
    /// Refused before any work: a tripwire already busy, a landing of the tripwire's
    /// own arc, a paused tripwire.
    Swallowed,
    /// Serviceable, but the machine is at its ceiling or the tripwire is busy.
    Queued,
    /// A newer queued event for this tripwire replaced this one.
    Superseded,
    /// An agent or a probe is working it now.
    Running,
    /// Finished, with an outcome.
    Settled,
    /// Finished with something the user should see, and holding until they
    /// see it ([P07]). The one settled state that keeps the tripwire's live-run
    /// slot, because the question it raised is still open.
    Awaiting,
    /// Finished without one — a session that died, or ended without the verb.
    Failed,
    /// Held: a deck card took the trip's session over and the user is working
    /// in it. Not finished — the session is alive and may still run the verb,
    /// which settles the trip from here — and not running either, because the
    /// engine has stopped watching it. It carries no `settled_at_ms`, and it
    /// deliberately does **not** hold the tripwire's live-run slot: the
    /// tripwire may fire again while the user works ([B05]).
    Adopted,
}

impl TripStatus {
    pub fn parse(s: &str) -> Option<TripStatus> {
        match s {
            "claimed" => Some(TripStatus::Claimed),
            "swallowed" => Some(TripStatus::Swallowed),
            "queued" => Some(TripStatus::Queued),
            "superseded" => Some(TripStatus::Superseded),
            "running" => Some(TripStatus::Running),
            "settled" => Some(TripStatus::Settled),
            "awaiting" => Some(TripStatus::Awaiting),
            "failed" => Some(TripStatus::Failed),
            "adopted" => Some(TripStatus::Adopted),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            TripStatus::Claimed => "claimed",
            TripStatus::Swallowed => "swallowed",
            TripStatus::Queued => "queued",
            TripStatus::Superseded => "superseded",
            TripStatus::Running => "running",
            TripStatus::Settled => "settled",
            TripStatus::Awaiting => "awaiting",
            TripStatus::Failed => "failed",
            TripStatus::Adopted => "adopted",
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
    /// The base branch a landing has to be onto for this tripwire to be evaluated
    /// ([P02]). Required, because a tripwire that watches every branch watches its
    /// own arc branches too.
    pub branch: String,
    pub permission_mode: String,
    pub paused: bool,
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
    pub branch: String,
    pub permission_mode: String,
}

impl NewTripwire {
    /// A tripwire with the schema's defaults, needing only what it watches and
    /// what to say about it. The branch is not among the defaults: there is no
    /// branch a tripwire could sensibly watch that a caller has not named ([P02]),
    /// so it is a parameter and [`lay`] refuses an empty one.
    pub fn new(
        name: impl Into<String>,
        trigger: impl Into<String>,
        brief: impl Into<String>,
        branch: impl Into<String>,
    ) -> Self {
        NewTripwire {
            name: name.into(),
            trigger: trigger.into(),
            scope: None,
            probe: None,
            brief: brief.into(),
            model: None,
            branch: branch.into(),
            permission_mode: "acceptEdits".to_string(),
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
    pub branch: Option<String>,
    pub permission_mode: Option<String>,
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
    pub swallow_reason: Option<String>,
    pub event_payload: Option<String>,
    pub probe_exit: Option<i64>,
    pub probe_tail: Option<String>,
    pub session_id: Option<String>,
    pub arc: Option<String>,
    pub headline: Option<String>,
    pub refs: Option<String>,
    pub settled_at_ms: Option<i64>,
    /// What a resolution asked to have authored, when it asked for anything
    /// ([P04]). `None` on a resolution that settled the firing outright.
    pub author_ask: Option<String>,
}

/// What a claim attempt found. `AlreadyClaimed` is the ordinary outcome of two
/// instances seeing one event, not an error: the loser stops, silently.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Claim {
    Claimed { trip_id: i64 },
    AlreadyClaimed,
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
    migrate_tripwire_names(conn)?;
    // And the backfill follows the rename, because it reads the table by the
    // name the rename gave it.
    if on_disk > 0 && on_disk < TRIPWIRE_SCHEMA_VERSION {
        backfill_branches(conn)?;
    }
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
    for (old, new) in [("wires", "tripwires"), ("wire_marks", "tripwire_marks")] {
        if table_exists(conn, old)? && !table_exists(conn, new)? {
            conn.execute_batch(&format!("ALTER TABLE {old} RENAME TO {new};"))?;
        }
    }
    for table in ["trips", "tripwire_marks"] {
        let columns = columns_of(conn, table)?;
        if columns.iter().any(|c| c == "wire_id") && !columns.iter().any(|c| c == "tripwire_id") {
            conn.execute_batch(&format!(
                "ALTER TABLE {table} RENAME COLUMN wire_id TO tripwire_id;"
            ))?;
        }
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

/// Give every migrated row a branch, since v1 rows carry none.
///
/// A tripwire's scope is a checkout, so the branch it was implicitly watching is
/// that checkout's default branch — asked of git, because the answer lives
/// there and nowhere in this ledger. A scopeless tripwire, or one whose scope git
/// cannot answer for, gets `main`: a row left with no branch would be silently
/// unfireable, whereas a tripwire watching the wrong branch says so the first time
/// somebody reads `tripwire list`.
fn backfill_branches(conn: &Connection) -> Result<(), TripwireLedgerError> {
    let mut stmt = conn.prepare("SELECT id, scope FROM tripwires WHERE branch = ''")?;
    let rows: Vec<(i64, Option<String>)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    for (id, scope) in rows {
        let branch = scope
            .as_deref()
            .and_then(default_branch_of)
            .unwrap_or_else(|| "main".to_string());
        conn.execute(
            "UPDATE tripwires SET branch = ?1 WHERE id = ?2",
            params![branch, id],
        )?;
    }
    Ok(())
}

/// The default branch of the checkout at `path`, as git reports it, or `None`
/// when the path is not a repository this build can ask.
fn default_branch_of(path: &str) -> Option<String> {
    let symref = std::process::Command::new("git")
        .args([
            "-C",
            path,
            "symbolic-ref",
            "--short",
            "refs/remotes/origin/HEAD",
        ])
        .output()
        .ok()?;
    if symref.status.success() {
        let text = String::from_utf8_lossy(&symref.stdout);
        let branch = text.trim().rsplit('/').next().unwrap_or_default();
        if !branch.is_empty() {
            return Some(branch.to_string());
        }
    }
    for candidate in ["main", "master"] {
        let verified = std::process::Command::new("git")
            .args(["-C", path, "rev-parse", "--verify", "--quiet", candidate])
            .output()
            .ok()?;
        if verified.status.success() {
            return Some(candidate.to_string());
        }
    }
    None
}

// MARK: - Tripwires

const TRIPWIRE_COLUMNS: &str = "id, name, created_at, trigger, scope, probe, brief, model, \
                            permission_mode, paused, branch";

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
        branch: row.get(10)?,
    })
}

/// Lay a tripwire. The name is its address, so a second tripwire under one name is a
/// refusal rather than a silent overwrite.
pub fn lay(
    conn: &Connection,
    tripwire: &NewTripwire,
    now_ms: i64,
) -> Result<Tripwire, TripwireLedgerError> {
    // A tripwire fires on a landing onto a named branch, so a tripwire with no branch
    // is a tripwire nothing can ever trip. Refused at the arming gesture rather
    // than at the firing: finding that out from an empty trip log weeks later
    // is finding out too late [B07].
    if tripwire.branch.trim().is_empty() {
        return Err(TripwireLedgerError::MissingBranch(tripwire.name.clone()));
    }
    check_brief(&tripwire.name, &tripwire.brief)?;
    let inserted = conn.execute(
        "INSERT OR IGNORE INTO tripwires
           (name, created_at, trigger, scope, probe, brief, model, permission_mode, paused,
            branch)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9)",
        params![
            tripwire.name,
            now_ms,
            tripwire.trigger,
            tripwire.scope,
            tripwire.probe,
            tripwire.brief,
            tripwire.model,
            tripwire.permission_mode,
            tripwire.branch.trim(),
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
    let Some(before) = get(conn, name)? else {
        return Err(TripwireLedgerError::NoSuchTripwire(name.to_string()));
    };
    // The same rule as `lay`, against the row the edit would produce: an edit
    // that blanks the branch is the same unrunnable tripwire arriving by another
    // door.
    let after_branch = edit.branch.clone().unwrap_or(before.branch.clone());
    if after_branch.trim().is_empty() {
        return Err(TripwireLedgerError::MissingBranch(name.to_string()));
    }
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
    if let Some(v) = &edit.branch {
        set("branch", Value::Text(v.trim().to_string()))?;
    }
    if let Some(v) = &edit.permission_mode {
        set("permission_mode", Value::Text(v.clone()))?;
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

/// Remove a tripwire and, by cascade, its trips.
pub fn remove(conn: &Connection, name: &str) -> Result<(), TripwireLedgerError> {
    let removed = conn.execute("DELETE FROM tripwires WHERE name = ?1", params![name])?;
    if removed == 0 {
        return Err(TripwireLedgerError::NoSuchTripwire(name.to_string()));
    }
    Ok(())
}

// MARK: - Trips

const TRIP_COLUMNS: &str = "id, tripwire_id, event_key, at_ms, instance, status, swallow_reason, \
                            event_payload, probe_exit, probe_tail, session_id, arc, headline, \
                            refs, settled_at_ms, author_ask";

fn trip_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Trip> {
    Ok(Trip {
        id: row.get(0)?,
        tripwire_id: row.get(1)?,
        event_key: row.get(2)?,
        at_ms: row.get(3)?,
        instance: row.get(4)?,
        status: row.get(5)?,
        swallow_reason: row.get(6)?,
        event_payload: row.get(7)?,
        probe_exit: row.get(8)?,
        probe_tail: row.get(9)?,
        session_id: row.get(10)?,
        arc: row.get(11)?,
        headline: row.get(12)?,
        refs: row.get(13)?,
        settled_at_ms: row.get(14)?,
        author_ask: row.get(15)?,
    })
}

/// Try to claim one firing.
///
/// This is the whole of the arbitration between instances: the insert either
/// wins or violates `UNIQUE(tripwire_id, event_key)`, and the loser stops. It is
/// one statement on purpose — anything wider would be a lock, and a lock is
/// what this design does without.
///
/// A won claim then prunes the tripwire's log back to
/// [`MAX_TRIPS_PER_TRIPWIRE`]. The prune is a second statement rather than a
/// wider one: it touches only rows this tripwire already lost interest in, so
/// a racing claim on another tripwire is unaffected and neither statement
/// waits on the other.
///
/// **Only a settled row is ever pruned.** A `claimed`, `queued`, `running`,
/// `awaiting` or `adopted` trip is state rather than log: an awaiting one is
/// holding a question the user has not answered ([P07]) and may hold it for
/// weeks, and a tripwire that fires on every landing would otherwise delete
/// that question — and orphan the arc it authored, which nothing then settles
/// because [`awaiting_trips_with_arcs`]'s sweep reads rows that exist. So the
/// cap is on what the log remembers, and a held trip outlives it. The list is
/// the terminal statuses by name rather than the live ones negated: a status
/// this build has not learned is left alone, which costs a row and cannot
/// cost a question.
pub fn claim_trip(
    conn: &Connection,
    tripwire_id: i64,
    event_key: &str,
    at_ms: i64,
    instance: &str,
    event_payload: Option<&str>,
) -> Result<Claim, TripwireLedgerError> {
    let inserted = conn.execute(
        "INSERT OR IGNORE INTO trips (tripwire_id, event_key, at_ms, instance, status, event_payload)
         VALUES (?1, ?2, ?3, ?4, 'claimed', ?5)",
        params![tripwire_id, event_key, at_ms, instance, event_payload],
    )?;
    if inserted == 0 {
        return Ok(Claim::AlreadyClaimed);
    }
    let trip_id = conn.last_insert_rowid();
    conn.execute(
        "DELETE FROM trips
          WHERE tripwire_id = ?1
            AND status IN ('settled', 'failed', 'swallowed', 'superseded')
            AND id NOT IN (
                SELECT id FROM trips WHERE tripwire_id = ?1
                 ORDER BY id DESC LIMIT ?2
            )",
        params![tripwire_id, MAX_TRIPS_PER_TRIPWIRE],
    )?;
    Ok(Claim::Claimed { trip_id })
}

/// Move a trip to a status, leaving everything else alone.
///
/// This is how a firing is refused: every guard runs *after* the claim, so a
/// swallow is a transition on the row the claim made rather than a second row
/// beside it. One event is one row per tripwire, which is what the unique
/// constraint already promises — and a refusal that wrote its own row would
/// quietly break that promise the first time two instances raced.
pub fn set_status(
    conn: &Connection,
    trip_id: i64,
    status: TripStatus,
    swallow_reason: Option<&str>,
) -> Result<(), TripwireLedgerError> {
    conn.execute(
        "UPDATE trips SET status = ?1, swallow_reason = COALESCE(?2, swallow_reason) WHERE id = ?3",
        params![status.as_str(), swallow_reason, trip_id],
    )?;
    Ok(())
}

/// Queue a trip the machine cannot serve yet, superseding any older queued
/// trip on the same tripwire.
///
/// One slot per tripwire, because coalescing to the newest pending event is what
/// a tripwire actually wants: a CI tripwire asked to verdict five commits in a storm
/// wants the last one's verdict, not five worktrees. The superseded row stays
/// in the log — the coalescing is visible, which is the point.
pub fn queue_trip(
    conn: &Connection,
    tripwire_id: i64,
    trip_id: i64,
) -> Result<(), TripwireLedgerError> {
    conn.execute(
        "UPDATE trips SET status = 'superseded', swallow_reason = 'superseded'
         WHERE tripwire_id = ?1 AND status = 'queued' AND id != ?2",
        params![tripwire_id, trip_id],
    )?;
    conn.execute(
        "UPDATE trips SET status = 'queued' WHERE id = ?1",
        params![trip_id],
    )?;
    Ok(())
}

/// Fire a tripwire by hand: mint a manual event key, claim the trip, and queue
/// it. Answers the trip id and the key it was claimed under.
///
/// A manual key is unique by construction, so a hand-fired trip bypasses the
/// guard a real landing meets: the permanent `landing:<sha>` claim, which
/// would let a tripwire be hand-fired on one commit exactly once. Firing by
/// hand is how a tripwire is tested, and a test that could be swallowed would
/// test nothing.
///
/// Shared rather than the CLI's own because the HTTP surface fires a tripwire
/// the same way, and two spellings of one verb is how the two answers drift.
pub fn queue_manual_trip(
    conn: &Connection,
    tripwire_id: i64,
    now_ms: i64,
    instance: &str,
) -> Result<(i64, String), TripwireLedgerError> {
    let event_key = format!("manual:{}", uuid::Uuid::new_v4());
    let Claim::Claimed { trip_id } =
        claim_trip(conn, tripwire_id, &event_key, now_ms, instance, None)?
    else {
        unreachable!("a v4 uuid event key cannot collide with a claimed row");
    };
    queue_trip(conn, tripwire_id, trip_id)?;
    Ok((trip_id, event_key))
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

/// The oldest queued trip, or `None`. What the engine starts when one of its
/// own runs settles.
pub fn oldest_queued(conn: &Connection) -> Result<Option<Trip>, TripwireLedgerError> {
    let sql = format!(
        "SELECT {TRIP_COLUMNS} FROM trips WHERE status = 'queued' ORDER BY at_ms, id LIMIT 1"
    );
    Ok(conn.query_row(&sql, [], trip_from_row).optional()?)
}

/// The tripwire's live trip, if it has one — the whole of the busy guard ([P06]).
///
/// `running` and `awaiting` both count. An awaiting trip holds no process, but
/// it holds a question the user has not answered and an arc they may still
/// join, and firing the tripwire again underneath that would replace the question
/// with a newer one nobody asked for.
///
/// `adopted` is deliberately absent, and that absence is the decision ([B05]):
/// a trip whose session a user has taken over is the user's, not a hold on the
/// tripwire. The tripwire goes on watching and may fire again while they work.
/// This is the one read where `adopted` and the live set part company — see
/// [`live_event_keys`], which does count it.
pub fn live_trip(conn: &Connection, tripwire_id: i64) -> Result<Option<Trip>, TripwireLedgerError> {
    let sql = format!(
        "SELECT {TRIP_COLUMNS} FROM trips
         WHERE tripwire_id = ?1 AND status IN ('running', 'awaiting')
         ORDER BY at_ms DESC, id DESC LIMIT 1"
    );
    Ok(conn
        .query_row(&sql, params![tripwire_id], trip_from_row)
        .optional()?)
}

/// Every event key with a `running`, `awaiting` or `adopted` trip on it,
/// whatever tripwire or instance claimed it.
///
/// What the inspection-tree sweep measures against (Risk R04): a tree on disk
/// whose landing appears nowhere in this set belongs to a run that is over,
/// however it ended. Machine-wide rather than per-instance, because the trees
/// are and the ledger is.
///
/// `adopted` counts here and does not count in [`live_trip`], and the two
/// reads have stopped being one set on purpose ([B10]). The busy guard asks
/// "may the tripwire fire again?", and an adopted trip is no reason it may
/// not. This asks "is anything still using the tree?", and an adopted session
/// is a user working in that very directory — sweeping it would delete the
/// worktree out from under them.
pub fn live_event_keys(conn: &Connection) -> Result<Vec<String>, TripwireLedgerError> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT event_key FROM trips
             WHERE status IN ('running', 'awaiting', 'adopted')",
    )?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Any trip claimed for one event key, newest first — what the sweep reads a
/// landing's repository off when it needs to remove that landing's tree.
pub fn any_trip_for_event_key(
    conn: &Connection,
    event_key: &str,
) -> Result<Option<Trip>, TripwireLedgerError> {
    let sql = format!(
        "SELECT {TRIP_COLUMNS} FROM trips WHERE event_key = ?1 ORDER BY at_ms DESC, id DESC LIMIT 1"
    );
    Ok(conn
        .query_row(&sql, params![event_key], trip_from_row)
        .optional()?)
}

/// Every `awaiting` trip that is holding an arc, machine-wide.
///
/// What the awaiting sweep reads ([P07]): an awaiting trip resolves when its
/// arc stops existing, because joining or discarding that arc *is* the
/// answer to the question the trip asked. A trip awaiting with no arc has
/// nothing that can disappear, so it is not swept and holds until the user
/// dismisses it.
pub fn awaiting_trips_with_arcs(conn: &Connection) -> Result<Vec<Trip>, TripwireLedgerError> {
    let sql = format!(
        "SELECT {TRIP_COLUMNS} FROM trips
         WHERE status = 'awaiting' AND arc IS NOT NULL
         ORDER BY at_ms, id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], trip_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Settle one trip by id, but only while it is still `awaiting` — the sweep's
/// half of the race the dismiss verb is also on.
pub fn settle_if_awaiting(
    conn: &Connection,
    trip_id: i64,
    settlement: &Settlement,
    at_ms: i64,
) -> Result<bool, TripwireLedgerError> {
    let changed = conn.execute(
        "UPDATE trips SET status = 'settled', headline = ?1, settled_at_ms = ?2
         WHERE id = ?3 AND status = 'awaiting'",
        params![settlement.headline, at_ms, trip_id],
    )?;
    Ok(changed > 0)
}

/// The highest fact rowid this tripwire has already considered for one session
/// ([P05]), or `None` when it has never evaluated that session.
///
/// The mark is per `(tripwire, session)` rather than one global rowid because
/// sessions run concurrently: a session that started before the last landing
/// can land afterwards carrying facts whose rowids are *below* a global mark,
/// and a global mark would spend them without anyone ever evaluating that
/// lineage.
pub fn fact_mark(
    conn: &Connection,
    tripwire_id: i64,
    session_id: &str,
) -> Result<Option<i64>, TripwireLedgerError> {
    Ok(conn
        .query_row(
            "SELECT max_fact_rowid FROM tripwire_marks WHERE tripwire_id = ?1 AND session_id = ?2",
            params![tripwire_id, session_id],
            |r| r.get(0),
        )
        .optional()?)
}

/// Advance a tripwire's mark for one session, which only an evaluation may do.
///
/// `MAX` rather than a plain assignment: marks only ever move forward, so a
/// landing evaluated out of order cannot un-spend facts an earlier one already
/// considered.
pub fn set_fact_mark(
    conn: &Connection,
    tripwire_id: i64,
    session_id: &str,
    max_fact_rowid: i64,
) -> Result<(), TripwireLedgerError> {
    conn.execute(
        "INSERT INTO tripwire_marks (tripwire_id, session_id, max_fact_rowid)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(tripwire_id, session_id)
           DO UPDATE SET max_fact_rowid = MAX(max_fact_rowid, excluded.max_fact_rowid)",
        params![tripwire_id, session_id, max_fact_rowid],
    )?;
    Ok(())
}

/// Attach the evidence a claimed trip was evaluated against.
///
/// Written after the claim rather than with it, because the evidence is what
/// the tripwire's guards let it look at: a landing refused as `busy` or `own-arc`
/// looked at nothing, and a row carrying a fact set it never read would be a
/// record of an evaluation that did not happen.
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

/// What a trip finished with.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Settlement {
    pub headline: Option<String>,
    /// The refs, already serialized — the ledger stores what it is handed.
    pub refs: Option<String>,
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
        "UPDATE trips SET status = ?1, headline = ?2, refs = ?3, settled_at_ms = ?4
         WHERE id = ?5",
        params![
            status.as_str(),
            settlement.headline,
            settlement.refs,
            at_ms,
            trip_id,
        ],
    )?;
    Ok(())
}

/// What a resolution attempt found ([P07], Spec S02).
///
/// `NoLiveTrip` names the state it found instead, because a session told only
/// "refused" cannot tell a tripwire that already settled from a tripwire that never
/// fired, and those want different things done about them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    Resolved { trip_id: i64, arc: Option<String> },
    NoLiveTrip { state: Option<String> },
}

/// Settle a tripwire's `running` trip — the whole of what `tripwire resolve` does
/// (Spec S02).
///
/// Compare-and-set, and that is the entire concurrency story: the settle
/// ceiling and the session's own verb race for the same row on every run, and
/// the `AND status = 'running'` clause is what admits exactly one of them. The
/// loser reads `NoLiveTrip` and reports the state the winner left, rather than
/// overwriting a settle that already happened.
pub fn resolve_running(
    conn: &Connection,
    tripwire_id: i64,
    status: TripStatus,
    settlement: &Settlement,
    author_ask: Option<&str>,
    at_ms: i64,
) -> Result<Resolution, TripwireLedgerError> {
    resolve_from(
        conn,
        tripwire_id,
        "running",
        status,
        settlement,
        author_ask,
        at_ms,
    )
}

/// Settle a tripwire's `adopted` trip — the fall-through both `tripwire
/// resolve` and `tripwire dismiss` take when no live trip answered.
///
/// A session a user took over can still run the verb, and dismissing an
/// adopted trip is the user's way out of a hold they no longer want. Both
/// callers try their own state first, so a genuinely running or awaiting trip
/// wins over an older adopted one.
pub fn resolve_adopted(
    conn: &Connection,
    tripwire_id: i64,
    status: TripStatus,
    settlement: &Settlement,
    author_ask: Option<&str>,
    at_ms: i64,
) -> Result<Resolution, TripwireLedgerError> {
    resolve_from(
        conn,
        tripwire_id,
        "adopted",
        status,
        settlement,
        author_ask,
        at_ms,
    )
}

/// Settle a tripwire's `awaiting` trip — what `tripwire dismiss` does. The arc
/// the trip is holding comes back with it, because discarding that arc is the
/// other half of the dismissal ([P09]) and the caller cannot read the row
/// afterwards without racing the next firing.
pub fn resolve_awaiting(
    conn: &Connection,
    tripwire_id: i64,
    at_ms: i64,
) -> Result<Resolution, TripwireLedgerError> {
    let settlement = Settlement {
        headline: Some("dismissed".to_string()),
        ..Settlement::default()
    };
    resolve_from(
        conn,
        tripwire_id,
        "awaiting",
        TripStatus::Settled,
        &settlement,
        None,
        at_ms,
    )
}

fn resolve_from(
    conn: &Connection,
    tripwire_id: i64,
    from: &str,
    status: TripStatus,
    settlement: &Settlement,
    author_ask: Option<&str>,
    at_ms: i64,
) -> Result<Resolution, TripwireLedgerError> {
    let sql = format!(
        "SELECT {TRIP_COLUMNS} FROM trips
         WHERE tripwire_id = ?1 AND status = ?2 ORDER BY at_ms DESC, id DESC LIMIT 1"
    );
    let found: Option<Trip> = conn
        .query_row(&sql, params![tripwire_id, from], trip_from_row)
        .optional()?;
    let Some(trip) = found else {
        return Ok(Resolution::NoLiveTrip {
            state: latest_state(conn, tripwire_id)?,
        });
    };
    let changed = conn.execute(
        "UPDATE trips SET status = ?1, headline = ?2, refs = ?3, author_ask = ?4,
                          settled_at_ms = ?5
         WHERE id = ?6 AND status = ?7",
        params![
            status.as_str(),
            settlement.headline,
            settlement.refs,
            author_ask,
            at_ms,
            trip.id,
            from,
        ],
    )?;
    if changed == 0 {
        return Ok(Resolution::NoLiveTrip {
            state: latest_state(conn, tripwire_id)?,
        });
    }
    Ok(Resolution::Resolved {
        trip_id: trip.id,
        arc: trip.arc,
    })
}

/// The status of a tripwire's newest trip, for a refusal that has to say what it
/// found instead.
fn latest_state(
    conn: &Connection,
    tripwire_id: i64,
) -> Result<Option<String>, TripwireLedgerError> {
    Ok(conn
        .query_row(
            "SELECT status FROM trips WHERE tripwire_id = ?1 ORDER BY at_ms DESC, id DESC LIMIT 1",
            params![tripwire_id],
            |row| row.get(0),
        )
        .optional()?)
}

/// Settle one trip by id, but only while it is still `running` — the engine's
/// half of the same race the verb is on (Risk R03).
///
/// The settle ceiling and a live session's `tripwire resolve` reach for the
/// same row on every run, and this is the clause that lets exactly one of them
/// have it. Answers whether this caller was the one.
pub fn settle_if_running(
    conn: &Connection,
    trip_id: i64,
    status: TripStatus,
    settlement: &Settlement,
    at_ms: i64,
) -> Result<bool, TripwireLedgerError> {
    let changed = conn.execute(
        "UPDATE trips SET status = ?1, headline = ?2, refs = ?3, settled_at_ms = ?4
         WHERE id = ?5 AND status = 'running'",
        params![
            status.as_str(),
            settlement.headline,
            settlement.refs,
            at_ms,
            trip_id,
        ],
    )?;
    Ok(changed > 0)
}

/// Hand one trip over, but only while it is still `running` — the same
/// compare-and-set [`settle_if_running`] uses, for the same reason.
///
/// Not a settle: `settled_at_ms` is deliberately not written, because an
/// adopted trip has not finished. The session is alive in a user's card and
/// may yet run the verb, which settles the row from `adopted`. `at_ms` is
/// accepted so this reads like its two siblings and is unwritten for that
/// reason. The headline says what happened, so a reader who opens the trip
/// finds out why it is held. Answers whether this caller was the one that
/// moved it.
pub fn adopt_if_running(
    conn: &Connection,
    trip_id: i64,
    headline: &str,
    _at_ms: i64,
) -> Result<bool, TripwireLedgerError> {
    let changed = conn.execute(
        "UPDATE trips SET status = 'adopted', headline = ?1
         WHERE id = ?2 AND status = 'running'",
        params![headline, trip_id],
    )?;
    Ok(changed > 0)
}

/// Put a running trip back in the queue, because the host was full rather than
/// the tripwire at fault.
///
/// The compare-and-set is the same one [`settle_if_running`] uses and for the
/// same reason: a resolution the verb landed in the gap must not be undone by
/// a refusal the engine met afterwards. What differs is that this is not a
/// settle — `settled_at_ms` is cleared, because the trip has not finished and
/// the drain is about to start it again. The headline stays, so a reader who
/// opens a queued trip finds out why it is waiting.
pub fn requeue_if_running(
    conn: &Connection,
    trip_id: i64,
    headline: &str,
) -> Result<bool, TripwireLedgerError> {
    let changed = conn.execute(
        "UPDATE trips SET status = 'queued', headline = ?1, settled_at_ms = NULL
         WHERE id = ?2 AND status = 'running'",
        params![headline, trip_id],
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
/// A `claimed` row is cleared rather than failed. Every normal path moves a
/// claim on at once, so one still standing is a crash between the claim and
/// its first transition — nothing ran, nothing was recorded, and the row's
/// only effect is to hold `UNIQUE(tripwire_id, event_key)` against every later
/// claim of the same commit. Deleting it is what lets that commit be
/// evaluated again. Answers how many rows were failed or cleared.
///
/// `adopted` is left alone, the way `awaiting` is: an adopted trip's session
/// belongs to a user's card rather than to this instance's engine, so it
/// survives a restart unfailed.
pub fn sweep_stale_running(
    conn: &Connection,
    instance: &str,
    at_ms: i64,
) -> Result<usize, TripwireLedgerError> {
    let failed = conn.execute(
        "UPDATE trips SET status = 'failed', swallow_reason = 'instance restarted',
                          settled_at_ms = ?1
         WHERE status = 'running' AND instance = ?2",
        params![at_ms, instance],
    )?;
    let cleared = conn.execute(
        "DELETE FROM trips WHERE status = 'claimed' AND instance = ?1",
        params![instance],
    )?;
    Ok(failed + cleared)
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

/// Fail every `running` trip another instance claimed before `before_ms`, and
/// clear every `claimed` row it left there.
///
/// [`sweep_stale_running`] is the clean half and cannot be the whole of it: an
/// instance only ever knows its own name, so a tugcast that crashed and never
/// came back leaves rows no boot sweep will ever reach. `running_count` is
/// machine-wide, so those rows spend the ceiling for every tripwire on the machine
/// — and nothing recovers on its own, because draining the queue is what a
/// settle does and no settle is coming for a dead instance's trip.
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
        "UPDATE trips SET status = 'failed', swallow_reason = 'abandoned',
                          settled_at_ms = ?1
         WHERE status = 'running' AND at_ms < ?1 AND instance != ?2",
        params![before_ms, instance],
    )?;
    let cleared = conn.execute(
        "DELETE FROM trips WHERE status = 'claimed' AND at_ms < ?1 AND instance != ?2",
        params![before_ms, instance],
    )?;
    Ok(failed + cleared)
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
                "main",
            ),
            1_000,
        )
        .unwrap()
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

    /// **The column a trip holds its work unit in, and the value a swallow
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
        // Put the table back into its v4 shape: the DDL above mints `arc`,
        // and v4 spelled it `dash`. Without this the probe under test finds
        // nothing to rename and the assertions below pass on a table that was
        // never old.
        conn.execute_batch("ALTER TABLE trips RENAME COLUMN arc TO dash;")
            .unwrap();
        conn.execute(
            "INSERT INTO tripwires (name, created_at, trigger, brief, branch)
             VALUES ('w', 1, '{\"fact\":{\"kind\":\"edit_failed\"}}', 'diagnose', 'main')",
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
        assert_eq!(held.swallow_reason.as_deref(), Some(SWALLOW_OWN_ARC));
        assert_eq!(held.headline.as_deref(), Some("held"), "the row is intact");

        let asked = trip(&conn, 2).unwrap().unwrap();
        assert_eq!(asked.arc.as_deref(), Some("tripwire-w-2"));
        assert_eq!(
            asked.swallow_reason, None,
            "a row that recorded no swallow is left alone"
        );

        // The sweep can find the awaiting trip, which is the reader the
        // column rename exists to keep working.
        assert_eq!(
            awaiting_trips_with_arcs(&conn)
                .unwrap()
                .iter()
                .map(|t| t.id)
                .collect::<Vec<_>>(),
            vec![2]
        );

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
            migrated.branch, "main",
            "a scopeless v1 row has no repository to read a default branch from"
        );
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
        assert!(columns.contains(&"branch".to_string()));

        // The marks table arrives with the migration, not only with the DDL.
        let w = get(&conn, "legacy").unwrap().unwrap();
        set_fact_mark(&conn, w.id, "session-a", 3).unwrap();
        assert_eq!(fact_mark(&conn, w.id, "session-a").unwrap(), Some(3));
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
        for (from, migrated) in [("v1", v1_ledger()), ("v5", v5_ledger())] {
            prepare(&migrated).unwrap();
            for table in ["tripwires", "trips", "settings", "tripwire_marks"] {
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

        for (old, new) in [("wires", "tripwires"), ("wire_marks", "tripwire_marks")] {
            assert!(table_exists(&conn, new).unwrap(), "`{new}` was not created");
            assert!(
                !table_exists(&conn, old).unwrap(),
                "`{old}` survived the rename"
            );
        }
        for table in ["trips", "tripwire_marks"] {
            let columns = columns_of(&conn, table).unwrap();
            assert!(
                columns.iter().any(|c| c == "tripwire_id"),
                "{table}: {columns:?}"
            );
            assert!(
                !columns.iter().any(|c| c == "wire_id"),
                "{table}: {columns:?}"
            );
        }
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
        assert_eq!(fact_mark(&conn, w.id, "sess-1").unwrap(), Some(7));
        assert_eq!(max_concurrent_trips(&conn).unwrap(), 3);

        // The child still follows the parent: the `REFERENCES` clause was
        // rewritten with the rename, not left pointing at a table that is gone.
        remove(&conn, "w").unwrap();
        let marks: i64 = conn
            .query_row("SELECT COUNT(*) FROM tripwire_marks", [], |r| r.get(0))
            .unwrap();
        let trips: i64 = conn
            .query_row("SELECT COUNT(*) FROM trips", [], |r| r.get(0))
            .unwrap();
        assert_eq!((trips, marks), (0, 0), "the cascade reaches both children");

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

        assert!(table_exists(&conn, "tripwire_marks").unwrap());
        assert!(!table_exists(&conn, "wire_marks").unwrap());
        for table in ["trips", "tripwire_marks"] {
            let columns = columns_of(&conn, table).unwrap();
            assert!(
                columns.iter().any(|c| c == "tripwire_id"),
                "{table}: {columns:?}"
            );
        }
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
        assert_eq!(laid.branch, "main");
        assert!(!laid.paused);
        assert_eq!(get(&conn, "tugedit").unwrap().as_ref(), Some(&laid));

        let again = lay(
            &conn,
            &NewTripwire::new(
                "tugedit",
                r#"{"fact":{"kind":"shell"}}"#,
                "report anything that looks wrong",
                "main",
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
                branch: Some("release".to_string()),
                probe: Some(Some("just ci".to_string())),
                scope: Some(Some("/repo".to_string())),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(edited.branch, "release");
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
        let placeholder = NewTripwire::new("w", r#"{"fact":{"kind":"shell"}}"#, "b", "main");
        assert!(matches!(
            lay(&conn, &placeholder, 1),
            Err(TripwireLedgerError::EmptyBrief(n, _)) if n == "w"
        ));
        assert!(matches!(
            lay(
                &conn,
                &NewTripwire::new("w", r#"{"fact":{"kind":"shell"}}"#, "   ", "main"),
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
                "main",
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

    /// A tripwire fires on a landing onto a named branch, so a tripwire with no branch
    /// is a tripwire nothing can ever trip. The refusal is at the arming gesture —
    /// both of them — rather than at the firing, because a tripwire nobody
    /// could have run is a tripwire that should never have been laid [B07].
    #[test]
    fn a_tripwire_cannot_arm_without_a_branch_to_watch() {
        let conn = ledger();
        let mut tripwire = NewTripwire::new(
            "w",
            r#"{"fact":{"kind":"edit_failed"}}"#,
            "diagnose the failure and propose a fix",
            "   ",
        );
        assert!(matches!(
            lay(&conn, &tripwire, 1),
            Err(TripwireLedgerError::MissingBranch(_))
        ));

        tripwire.branch = "main".to_string();
        lay(&conn, &tripwire, 1).unwrap();

        // And the same rule against the row an edit would produce: blanking
        // the branch is the same unrunnable tripwire arriving by another door.
        assert!(matches!(
            update(
                &conn,
                "w",
                &TripwireEdit {
                    branch: Some("  ".to_string()),
                    ..Default::default()
                },
            ),
            Err(TripwireLedgerError::MissingBranch(_))
        ));
        assert_eq!(
            get(&conn, "w").unwrap().unwrap().branch,
            "main",
            "a refused edit moves nothing"
        );
    }

    #[test]
    fn pausing_leaves_the_tripwire_and_its_log_and_takes_it_out_of_armed() {
        let conn = ledger();
        let w = lay_one(&conn, "w");
        claim_trip(&conn, w.id, "e1", 1, "inst", None).unwrap();
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
        claim_trip(&conn, w.id, "e1", 1, "inst", None).unwrap();
        remove(&conn, "w").unwrap();
        assert!(get(&conn, "w").unwrap().is_none());
        assert!(trips_for_tripwire(&conn, w.id, 10).unwrap().is_empty());
        assert!(matches!(
            remove(&conn, "w"),
            Err(TripwireLedgerError::NoSuchTripwire(_))
        ));
    }

    /// The whole of the arbitration between two instances that saw one event.
    #[test]
    fn one_event_key_is_claimed_once_and_the_second_claim_says_so() {
        let conn = ledger();
        let w = lay_one(&conn, "w");
        let first = claim_trip(&conn, w.id, "sha-abc", 10, "inst-a", Some("{}")).unwrap();
        let second = claim_trip(&conn, w.id, "sha-abc", 11, "inst-b", Some("{}")).unwrap();
        assert!(matches!(first, Claim::Claimed { .. }));
        assert_eq!(second, Claim::AlreadyClaimed);
        assert_eq!(trips_for_tripwire(&conn, w.id, 10).unwrap().len(), 1);
    }

    /// Two tripwires watching one commit are two firings, not one — the claim is
    /// per tripwire, not per event.
    #[test]
    fn two_tripwires_each_claim_the_same_event() {
        let conn = ledger();
        let a = lay_one(&conn, "a");
        let b = lay_one(&conn, "b");
        assert!(matches!(
            claim_trip(&conn, a.id, "sha", 1, "i", None).unwrap(),
            Claim::Claimed { .. }
        ));
        assert!(matches!(
            claim_trip(&conn, b.id, "sha", 1, "i", None).unwrap(),
            Claim::Claimed { .. }
        ));
    }

    /// Claim a trip and settle it, which is what a firing that ran and
    /// reported nothing leaves behind — and the only shape the log retains.
    fn settled_trip(conn: &Connection, tripwire_id: i64, key: &str, at_ms: i64) -> i64 {
        let Claim::Claimed { trip_id } =
            claim_trip(conn, tripwire_id, key, at_ms, "inst", None).unwrap()
        else {
            unreachable!("each event key is claimed once");
        };
        set_status(conn, trip_id, TripStatus::Settled, None).unwrap();
        trip_id
    }

    /// Retention is per tripwire and runs at claim time: the oldest row falls
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

    /// A trip that is still holding is state rather than log, and the cap is
    /// on the log: an awaiting trip asked the user a question and may wait
    /// weeks for the answer, and a tripwire firing on every landing must not
    /// delete the question — nor the row the awaiting sweep reads to release
    /// it when its arc goes.
    #[test]
    fn retention_spares_a_trip_that_is_still_holding() {
        let conn = ledger();
        let w = lay_one(&conn, "w");
        let Claim::Claimed { trip_id: held } =
            claim_trip(&conn, w.id, "held", 1, "inst", None).unwrap()
        else {
            unreachable!("the first claim on an empty log wins");
        };
        set_status(&conn, held, TripStatus::Awaiting, None).unwrap();

        for i in 0..(MAX_TRIPS_PER_TRIPWIRE + 5) {
            settled_trip(&conn, w.id, &format!("e{i}"), 1_000 + i);
        }

        let still = trip(&conn, held).unwrap().expect("the held trip outlives the cap");
        assert_eq!(still.status, "awaiting");
        assert_eq!(
            awaiting_trips_with_arcs(&conn).unwrap().len(),
            0,
            "this one authored no arc; the sweep's read is still over rows that exist"
        );
    }

    #[test]
    fn a_claim_contended_across_threads_is_won_exactly_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tripwires.db");
        let setup = open_ledger(&path).unwrap();
        let tripwire = lay_one(&setup, "w");
        drop(setup);

        let outcomes: Vec<Claim> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|i| {
                    let path = path.clone();
                    scope.spawn(move || {
                        let conn = open_ledger(&path).unwrap();
                        claim_trip(&conn, tripwire.id, "one-event", 100 + i, "inst", None).unwrap()
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });

        let won = outcomes
            .iter()
            .filter(|c| matches!(c, Claim::Claimed { .. }))
            .count();
        assert_eq!(won, 1, "exactly one writer owns the firing: {outcomes:?}");

        let conn = open_ledger(&path).unwrap();
        assert_eq!(
            trips_for_tripwire(&conn, tripwire.id, 100).unwrap().len(),
            1
        );
    }

    /// A swallowed firing keeps its row and its reason. A swallow is not a
    /// silence: the reason is what a reader of the trip log finds when they
    /// ask why a tripwire they armed never spoke.
    #[test]
    fn a_swallowed_claim_keeps_its_row_and_its_reason() {
        let conn = ledger();
        let w = lay_one(&conn, "w");
        claim_trip(&conn, w.id, "e1", 1_000, "inst", None).unwrap();
        let Claim::Claimed { trip_id } =
            claim_trip(&conn, w.id, "e2", 5_000, "inst", None).unwrap()
        else {
            panic!("claimed");
        };
        set_status(&conn, trip_id, TripStatus::Swallowed, Some(SWALLOW_BUSY)).unwrap();

        let trips = trips_for_tripwire(&conn, w.id, 10).unwrap();
        assert_eq!(trips[0].status, "swallowed");
        assert_eq!(trips[0].swallow_reason.as_deref(), Some(SWALLOW_BUSY));
    }

    /// The mark is per `(tripwire, session)`, and the case that decides it is the
    /// one a single global mark loses silently: two sessions running at once,
    /// the later-landing one carrying facts whose rowids sit *below* what the
    /// first landing already considered ([P05]).
    #[test]
    fn a_mark_is_per_session_so_a_concurrent_lineage_is_never_spent_unseen() {
        let conn = ledger();
        let w = lay_one(&conn, "w");

        // The first landing evaluates session A up to fact 90.
        set_fact_mark(&conn, w.id, "session-a", 90).unwrap();
        assert_eq!(fact_mark(&conn, w.id, "session-a").unwrap(), Some(90));

        // Session B started earlier and lands afterwards, carrying fact 40. A
        // global high-water mark of 90 would have spent it; its own mark is
        // absent, so every fact it carries is still to be evaluated.
        assert_eq!(fact_mark(&conn, w.id, "session-b").unwrap(), None);

        // Marks only move forward, so a landing evaluated out of order cannot
        // un-spend what an earlier one already considered.
        set_fact_mark(&conn, w.id, "session-a", 40).unwrap();
        assert_eq!(fact_mark(&conn, w.id, "session-a").unwrap(), Some(90));

        // And a mark belongs to its tripwire alone.
        let other = lay_one(&conn, "other");
        assert_eq!(fact_mark(&conn, other.id, "session-a").unwrap(), None);
    }

    /// Marks ride the same cascade the trips do: removing a tripwire takes the
    /// rows that only meant anything alongside it.
    #[test]
    fn removing_a_tripwire_takes_its_marks_with_it() {
        let conn = ledger();
        let w = lay_one(&conn, "w");
        set_fact_mark(&conn, w.id, "session-a", 7).unwrap();
        remove(&conn, "w").unwrap();
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM tripwire_marks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn queuing_supersedes_the_older_queued_trip_on_the_same_tripwire() {
        let conn = ledger();
        let w = lay_one(&conn, "w");
        let other = lay_one(&conn, "other");
        let Claim::Claimed { trip_id: first } =
            claim_trip(&conn, w.id, "e1", 1, "inst", None).unwrap()
        else {
            panic!("claimed");
        };
        let Claim::Claimed { trip_id: second } =
            claim_trip(&conn, w.id, "e2", 2, "inst", None).unwrap()
        else {
            panic!("claimed");
        };
        let Claim::Claimed { trip_id: elsewhere } =
            claim_trip(&conn, other.id, "e3", 3, "inst", None).unwrap()
        else {
            panic!("claimed");
        };
        queue_trip(&conn, w.id, first).unwrap();
        queue_trip(&conn, other.id, elsewhere).unwrap();
        queue_trip(&conn, w.id, second).unwrap();

        assert_eq!(trip(&conn, first).unwrap().unwrap().status, "superseded");
        assert_eq!(trip(&conn, second).unwrap().unwrap().status, "queued");
        assert_eq!(
            trip(&conn, elsewhere).unwrap().unwrap().status,
            "queued",
            "another tripwire's queue is its own"
        );
        assert_eq!(
            trip(&conn, first)
                .unwrap()
                .unwrap()
                .swallow_reason
                .as_deref(),
            Some("superseded"),
            "the coalescing is visible in the log"
        );
    }

    #[test]
    fn the_oldest_queued_trip_is_the_one_drained_next() {
        let conn = ledger();
        let a = lay_one(&conn, "a");
        let b = lay_one(&conn, "b");
        let Claim::Claimed { trip_id: newer } =
            claim_trip(&conn, a.id, "e1", 900, "inst", None).unwrap()
        else {
            panic!("claimed");
        };
        let Claim::Claimed { trip_id: older } =
            claim_trip(&conn, b.id, "e2", 100, "inst", None).unwrap()
        else {
            panic!("claimed");
        };
        queue_trip(&conn, a.id, newer).unwrap();
        queue_trip(&conn, b.id, older).unwrap();
        assert_eq!(oldest_queued(&conn).unwrap().unwrap().id, older);

        set_status(&conn, older, TripStatus::Running, None).unwrap();
        assert_eq!(oldest_queued(&conn).unwrap().unwrap().id, newer);
    }

    #[test]
    fn the_running_count_is_what_the_ceiling_is_read_against() {
        let conn = ledger();
        let w = lay_one(&conn, "w");
        assert_eq!(running_count(&conn).unwrap(), 0);
        let Claim::Claimed { trip_id } = claim_trip(&conn, w.id, "e1", 1, "inst", None).unwrap()
        else {
            panic!("claimed");
        };
        record_run(&conn, trip_id, Some("tug-1"), Some("tripwire-w-abc")).unwrap();
        assert_eq!(running_count(&conn).unwrap(), 1);

        settle(
            &conn,
            trip_id,
            TripStatus::Settled,
            &Settlement {
                headline: Some("it broke".to_string()),
                refs: Some(r#"[{"kind":"arc","target":"tripwire-w-abc"}]"#.to_string()),
            },
            9_000,
        )
        .unwrap();
        assert_eq!(running_count(&conn).unwrap(), 0);

        let settled = trip(&conn, trip_id).unwrap().unwrap();
        assert_eq!(settled.status, "settled");
        assert_eq!(settled.session_id.as_deref(), Some("tug-1"));
        assert_eq!(settled.arc.as_deref(), Some("tripwire-w-abc"));
        assert_eq!(settled.headline.as_deref(), Some("it broke"));
        assert_eq!(settled.settled_at_ms, Some(9_000));
    }

    #[test]
    fn a_probe_tail_is_kept_capped_and_the_cut_is_marked() {
        let conn = ledger();
        let w = lay_one(&conn, "w");
        let Claim::Claimed { trip_id } = claim_trip(&conn, w.id, "e1", 1, "inst", None).unwrap()
        else {
            panic!("claimed");
        };
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
        let Claim::Claimed { trip_id: mine } =
            claim_trip(&conn, w.id, "e1", 1, "me", None).unwrap()
        else {
            panic!("claimed");
        };
        let Claim::Claimed { trip_id: theirs } =
            claim_trip(&conn, w.id, "e2", 2, "them", None).unwrap()
        else {
            panic!("claimed");
        };
        record_run(&conn, mine, None, None).unwrap();
        record_run(&conn, theirs, None, None).unwrap();

        assert_eq!(sweep_stale_running(&conn, "me", 5_000).unwrap(), 1);
        assert_eq!(trip(&conn, mine).unwrap().unwrap().status, "failed");
        assert_eq!(
            trip(&conn, theirs).unwrap().unwrap().status,
            "running",
            "another instance's run is still alive"
        );
    }

    /// A `claimed` row a dead instance left behind is a crash between the
    /// claim and its first transition. It is cleared, and the commit it held
    /// can be claimed again.
    #[test]
    fn the_boot_sweep_clears_a_claimed_row_so_the_commit_can_be_claimed_again() {
        let conn = ledger();
        let w = lay_one(&conn, "w");
        assert!(matches!(
            claim_trip(&conn, w.id, "landing:abc", 1, "me", None).unwrap(),
            Claim::Claimed { .. }
        ));
        assert_eq!(
            claim_trip(&conn, w.id, "landing:abc", 2, "me", None).unwrap(),
            Claim::AlreadyClaimed,
            "the crashed claim poisons the commit until it is swept"
        );

        assert_eq!(sweep_stale_running(&conn, "me", 5_000).unwrap(), 1);
        assert!(
            matches!(
                claim_trip(&conn, w.id, "landing:abc", 3, "me", None).unwrap(),
                Claim::Claimed { .. }
            ),
            "the same commit can be evaluated again"
        );
    }

    /// The age sweep clears another instance's stale claim the same way, and
    /// leaves this instance's own rows alone however old they are: a session
    /// this instance is running has no clock on it.
    #[test]
    fn the_age_sweep_clears_another_instances_claim_and_never_this_instances_rows() {
        let conn = ledger();
        let w = lay_one(&conn, "w");
        assert!(matches!(
            claim_trip(&conn, w.id, "landing:theirs", 1, "them", None).unwrap(),
            Claim::Claimed { .. }
        ));
        let Claim::Claimed { trip_id: mine } =
            claim_trip(&conn, w.id, "landing:mine", 1, "me", None).unwrap()
        else {
            panic!("claimed");
        };
        record_run(&conn, mine, None, None).unwrap();

        assert_eq!(sweep_orphaned_running(&conn, 5_000, "me").unwrap(), 1);
        assert!(matches!(
            claim_trip(&conn, w.id, "landing:theirs", 6_000, "me", None).unwrap(),
            Claim::Claimed { .. }
        ));
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
                "main",
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
            TripStatus::Claimed,
            TripStatus::Swallowed,
            TripStatus::Queued,
            TripStatus::Superseded,
            TripStatus::Running,
            TripStatus::Settled,
            TripStatus::Awaiting,
            TripStatus::Failed,
            TripStatus::Adopted,
        ] {
            assert_eq!(TripStatus::parse(s.as_str()), Some(s));
        }
        assert_eq!(TripStatus::parse("nonsense"), None);
    }

    /// A card taking the session over moves the trip to `adopted` and writes
    /// no `settled_at_ms`, because an adopted trip has not finished. The
    /// compare-and-set is the whole guard: a trip the verb already settled is
    /// not dragged back out of its outcome.
    #[test]
    fn adopting_moves_a_running_trip_and_loses_to_a_settle_that_landed_first() {
        let conn = ledger();
        let tripwire = lay_one(&conn, "ci");
        let Claim::Claimed { trip_id } =
            claim_trip(&conn, tripwire.id, "landing:abc", 1, "inst-a", None).unwrap()
        else {
            panic!("claimed");
        };
        record_run(&conn, trip_id, Some("sess-a"), None).unwrap();

        assert!(adopt_if_running(&conn, trip_id, "a card took it over", 9).unwrap());
        let held = trip(&conn, trip_id).unwrap().unwrap();
        assert_eq!(held.status, "adopted");
        assert_eq!(held.headline.as_deref(), Some("a card took it over"));
        assert_eq!(
            held.settled_at_ms, None,
            "an adopted trip has not finished, so nothing stamps it settled",
        );

        // Against a trip that is no longer running, it changes nothing and
        // says it changed nothing.
        assert!(!adopt_if_running(&conn, trip_id, "again", 10).unwrap());
        assert_eq!(
            trip(&conn, trip_id).unwrap().unwrap().headline.as_deref(),
            Some("a card took it over"),
        );
    }

    /// The split [B10] made: the busy guard and the tree sweep stopped being
    /// one set. An adopted trip does not hold the tripwire's live-run slot —
    /// it may fire again while the user works — but its tree is a directory
    /// somebody is sitting in, so the sweep still sees its event key.
    #[test]
    fn an_adopted_trip_frees_the_busy_slot_and_keeps_its_tree() {
        let conn = ledger();
        let tripwire = lay_one(&conn, "ci");
        let Claim::Claimed { trip_id } =
            claim_trip(&conn, tripwire.id, "landing:abc", 1, "inst-a", None).unwrap()
        else {
            panic!("claimed");
        };
        record_run(&conn, trip_id, Some("sess-a"), None).unwrap();
        assert!(live_trip(&conn, tripwire.id).unwrap().is_some());

        adopt_if_running(&conn, trip_id, "a card took it over", 9).unwrap();

        assert!(
            live_trip(&conn, tripwire.id).unwrap().is_none(),
            "an adopted trip is the user's, not a hold on the tripwire",
        );
        assert_eq!(
            live_event_keys(&conn).unwrap(),
            vec!["landing:abc".to_string()],
            "the sweep must not delete a tree somebody is working in",
        );
    }

    /// An adopted session can still run the verb, and the trip settles from
    /// `adopted` the way it would have from `running`.
    #[test]
    fn an_adopted_trip_still_resolves() {
        let conn = ledger();
        let tripwire = lay_one(&conn, "ci");
        let Claim::Claimed { trip_id } =
            claim_trip(&conn, tripwire.id, "landing:abc", 1, "inst-a", None).unwrap()
        else {
            panic!("claimed");
        };
        record_run(&conn, trip_id, Some("sess-a"), Some("tripwire-ci-abc12345")).unwrap();
        adopt_if_running(&conn, trip_id, "a card took it over", 9).unwrap();

        // The running read finds nothing, which is the fall-through the CLI
        // verbs take.
        assert_eq!(
            resolve_running(
                &conn,
                tripwire.id,
                TripStatus::Settled,
                &Settlement::default(),
                None,
                10,
            )
            .unwrap(),
            Resolution::NoLiveTrip {
                state: Some("adopted".to_string())
            }
        );

        let settlement = Settlement {
            headline: Some("the user finished it themselves".to_string()),
            ..Settlement::default()
        };
        assert_eq!(
            resolve_adopted(
                &conn,
                tripwire.id,
                TripStatus::Settled,
                &settlement,
                None,
                11,
            )
            .unwrap(),
            Resolution::Resolved {
                trip_id,
                arc: Some("tripwire-ci-abc12345".to_string()),
            }
        );
        let settled = trip(&conn, trip_id).unwrap().unwrap();
        assert_eq!(settled.status, "settled");
        assert_eq!(settled.settled_at_ms, Some(11));
    }

    /// The resolution verb's whole grammar at the ledger ([P07], Spec S02):
    /// it settles the running trip, it carries the author ask forward, and it
    /// refuses on anything else while naming what it found instead.
    #[test]
    fn a_resolution_settles_the_running_trip_and_refuses_when_there_is_none() {
        let conn = ledger();
        let tripwire = lay_one(&conn, "ci");

        // Nothing has fired, so there is nothing to resolve and the refusal
        // says so with no state at all.
        assert_eq!(
            resolve_running(
                &conn,
                tripwire.id,
                TripStatus::Settled,
                &Settlement::default(),
                None,
                1,
            )
            .unwrap(),
            Resolution::NoLiveTrip { state: None }
        );

        let Claim::Claimed { trip_id } =
            claim_trip(&conn, tripwire.id, "landing:abc", 1, "inst-a", None).unwrap()
        else {
            panic!("claimed");
        };

        // Claimed is not running: a trip nobody started cannot be resolved,
        // and the refusal names the state rather than the fact of refusal.
        assert_eq!(
            resolve_running(
                &conn,
                tripwire.id,
                TripStatus::Settled,
                &Settlement::default(),
                None,
                2,
            )
            .unwrap(),
            Resolution::NoLiveTrip {
                state: Some("claimed".to_string())
            }
        );

        record_run(&conn, trip_id, Some("sess-a"), Some("tripwire-ci-abc12345")).unwrap();
        let settlement = Settlement {
            headline: Some("the assertion is stale".to_string()),
            ..Settlement::default()
        };
        assert_eq!(
            resolve_running(
                &conn,
                tripwire.id,
                TripStatus::Awaiting,
                &settlement,
                Some("update the expected string"),
                3,
            )
            .unwrap(),
            Resolution::Resolved {
                trip_id,
                arc: Some("tripwire-ci-abc12345".to_string()),
            }
        );

        let settled = trip(&conn, trip_id).unwrap().unwrap();
        assert_eq!(settled.status, "awaiting");
        assert_eq!(settled.headline.as_deref(), Some("the assertion is stale"));
        assert_eq!(
            settled.author_ask.as_deref(),
            Some("update the expected string"),
            "the ask has to survive the process that heard it ([P04])"
        );
        assert_eq!(settled.settled_at_ms, Some(3));
    }

    /// A dismissal settles the awaiting trip and hands back the arc it was
    /// holding, because discarding that arc is the dismissal's other half
    /// ([P07], [P09]).
    #[test]
    fn a_dismissal_settles_the_awaiting_trip_and_names_its_arc() {
        let conn = ledger();
        let tripwire = lay_one(&conn, "ci");
        let Claim::Claimed { trip_id } =
            claim_trip(&conn, tripwire.id, "landing:abc", 1, "inst-a", None).unwrap()
        else {
            panic!("claimed");
        };
        record_run(&conn, trip_id, Some("sess-a"), Some("tripwire-ci-abc12345")).unwrap();

        // A running trip is not a dismissable one.
        assert_eq!(
            resolve_awaiting(&conn, tripwire.id, 2).unwrap(),
            Resolution::NoLiveTrip {
                state: Some("running".to_string())
            }
        );

        resolve_running(
            &conn,
            tripwire.id,
            TripStatus::Awaiting,
            &Settlement {
                headline: Some("look at this".to_string()),
                ..Settlement::default()
            },
            None,
            3,
        )
        .unwrap();

        assert_eq!(
            resolve_awaiting(&conn, tripwire.id, 4).unwrap(),
            Resolution::Resolved {
                trip_id,
                arc: Some("tripwire-ci-abc12345".to_string()),
            }
        );
        assert_eq!(trip(&conn, trip_id).unwrap().unwrap().status, "settled");
        assert_eq!(
            live_trip(&conn, tripwire.id).unwrap(),
            None,
            "and the tripwire's live-run slot came back with it"
        );
    }

    /// The sweep and the dismiss verb reach for the same row, so the sweep's
    /// write is a compare-and-set too ([P07]).
    ///
    /// A dismissal that lands first has already discarded the arc, which is
    /// precisely the condition the sweep looks for — so without the guard the
    /// sweep would arrive behind every dismissal and overwrite its words with
    /// its own.
    #[test]
    fn the_sweep_loses_to_a_dismissal_that_already_landed() {
        let conn = ledger();
        let tripwire = lay_one(&conn, "ci");
        let Claim::Claimed { trip_id } =
            claim_trip(&conn, tripwire.id, "landing:abc", 1, "inst-a", None).unwrap()
        else {
            panic!("claimed");
        };
        record_run(&conn, trip_id, Some("sess-a"), Some("tripwire-ci-abc12345")).unwrap();
        resolve_running(
            &conn,
            tripwire.id,
            TripStatus::Awaiting,
            &Settlement {
                headline: Some("look at this".to_string()),
                ..Settlement::default()
            },
            None,
            2,
        )
        .unwrap();

        // The sweep finds it while it is still awaiting.
        assert_eq!(
            awaiting_trips_with_arcs(&conn)
                .unwrap()
                .iter()
                .map(|t| t.id)
                .collect::<Vec<_>>(),
            vec![trip_id]
        );

        // The dismissal gets there first.
        resolve_awaiting(&conn, tripwire.id, 3).unwrap();
        assert!(
            !settle_if_awaiting(
                &conn,
                trip_id,
                &Settlement {
                    headline: Some("the arc is gone".to_string()),
                    ..Settlement::default()
                },
                4,
            )
            .unwrap(),
            "the sweep must not overwrite a dismissal that already landed"
        );
        assert_eq!(
            trip(&conn, trip_id).unwrap().unwrap().headline.as_deref(),
            Some("dismissed")
        );
        assert!(
            awaiting_trips_with_arcs(&conn).unwrap().is_empty(),
            "and there is nothing left for the next sweep to find"
        );
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
