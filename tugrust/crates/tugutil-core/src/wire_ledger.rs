//! The standing-wire ledger — every wire laid on this machine, and every
//! firing any instance has claimed.
//!
//! **Machine-global**, beside `changes.db` rather than inside an instance
//! directory (`tugcore::instance::tripwires_db_path`), and for a stronger
//! reason than the other shared ledgers have. Two tugcasts watching the same
//! workspace see the same commit, and the thing that stops both of them
//! firing one wire twice is the `UNIQUE(wire_id, event_key)` constraint on
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
//! Schema changes forever mean bumping [`WIRE_SCHEMA_VERSION`] with a
//! registered migration, never editing the DDL alone — the same regime as
//! `changes.db` and the app-test results ledger.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::wire_predicate::Predicate;

/// Current on-disk schema version, stamped into `PRAGMA user_version`.
pub const WIRE_SCHEMA_VERSION: i64 = 1;

/// Registered migrations, each keyed by the on-disk version it upgrades
/// *from*. Every migration whose `from` is at or above the version found on
/// disk is applied in order. Empty at v1; a schema change adds an entry here
/// and bumps [`WIRE_SCHEMA_VERSION`] — never edits the DDL alone.
const WIRE_MIGRATIONS: &[(i64, &str)] = &[];

/// Default seconds a wire waits before it will fire again. A flapping trigger
/// — the same edit program failing in a retry loop — is exactly what this
/// swallows, and the swallow is written down rather than dropped.
pub const DEFAULT_COOLDOWN_SECS: i64 = 60;

/// Default ceiling on `running` trips machine-wide, when the `settings` table
/// names none. A commit storm must not fan out one dash worktree per commit.
pub const DEFAULT_MAX_CONCURRENT_TRIPS: i64 = 2;

/// The `settings` key holding the machine-wide concurrency ceiling.
pub const SETTING_MAX_CONCURRENT_TRIPS: &str = "max_concurrent_trips";

/// How much of a probe's output a trip row keeps. The tail, because a probe
/// that failed says why at the end.
pub const PROBE_TAIL_CAP: usize = 8 * 1024;

const CREATE_TRIPWIRES_SQL: &str = "
    CREATE TABLE IF NOT EXISTS wires (
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
    CREATE TABLE IF NOT EXISTS trips (
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
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS trips_by_wire ON trips (wire_id, id);
    CREATE INDEX IF NOT EXISTS trips_by_status ON trips (status);
";

#[derive(Debug, thiserror::Error)]
pub enum WireLedgerError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("tripwires schema on disk is v{on_disk}, newer than this build's v{supported}")]
    SchemaTooNew { on_disk: i64, supported: i64 },
    #[error("a wire named {0} already exists")]
    DuplicateName(String),
    #[error("no wire named {0}")]
    NoSuchWire(String),
    #[error("{0}")]
    BadTrigger(String),
    #[error(
        "wire {0} runs at the work tier, which stages its work on a dash, and a dash lives in a checkout — give it --scope <path>"
    )]
    WorkWireNeedsScope(String),
}

// MARK: - Rows

/// Which tier a trip runs at, before the probe resolves `auto`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Auto,
    Verdict,
    Work,
}

impl Tier {
    pub fn parse(s: &str) -> Option<Tier> {
        match s {
            "auto" => Some(Tier::Auto),
            "verdict" => Some(Tier::Verdict),
            "work" => Some(Tier::Work),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Tier::Auto => "auto",
            Tier::Verdict => "verdict",
            Tier::Work => "work",
        }
    }
}

/// When a trip's outcome is posted to the Overview.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PostPolicy {
    Auto,
    Always,
    Never,
}

impl PostPolicy {
    pub fn parse(s: &str) -> Option<PostPolicy> {
        match s {
            "auto" => Some(PostPolicy::Auto),
            "always" => Some(PostPolicy::Always),
            "never" => Some(PostPolicy::Never),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            PostPolicy::Auto => "auto",
            PostPolicy::Always => "always",
            PostPolicy::Never => "never",
        }
    }
}

/// Where a trip stands. The whole life of one firing, and every value is
/// written down — a swallowed trip is a row, not a silence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TripStatus {
    /// This instance won the insert and owns the firing.
    Claimed,
    /// Refused before any work: cooldown, a paused wire, a wire's own session.
    Swallowed,
    /// Serviceable, but the machine is at its ceiling or the wire is busy.
    Queued,
    /// A newer queued event for this wire replaced this one.
    Superseded,
    /// An agent or a probe is working it now.
    Running,
    /// Finished, with an outcome.
    Settled,
    /// Finished without one — a timeout, a missing envelope, a dead tugcast.
    Failed,
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
            "failed" => Some(TripStatus::Failed),
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
            TripStatus::Failed => "failed",
        }
    }
}

/// One standing wire, as the table holds it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Wire {
    pub id: i64,
    pub name: String,
    pub created_at: i64,
    /// The Spec S01 JSON, exactly as stored — the engine parses it with
    /// [`Wire::predicate`], and a row whose trigger this build cannot read is
    /// still a row it can list and remove.
    pub trigger: String,
    pub scope: Option<String>,
    pub probe: Option<String>,
    pub brief: String,
    pub model: Option<String>,
    pub tier: String,
    pub permission_mode: String,
    pub post: String,
    pub paused: bool,
    pub cooldown_secs: i64,
}

impl Wire {
    /// The parsed trigger, or the reason it could not be read. Parsed on
    /// demand rather than at load: a wire laid by a newer build against a
    /// grammar this one does not know must still list and remove cleanly.
    pub fn predicate(&self) -> Result<Predicate, WireLedgerError> {
        serde_json::from_str(&self.trigger)
            .map_err(|e| WireLedgerError::BadTrigger(format!("{}: {e}", self.name)))
    }

    /// Which tier this wire runs at, resolving `auto` against the probe: a
    /// probe may write, so a wire that has one needs the dash worktree.
    /// "Read-only brief" is not machine-decidable; the probe is.
    pub fn resolved_tier(&self) -> Tier {
        resolve_tier(
            Tier::parse(&self.tier).unwrap_or(Tier::Auto),
            self.probe.is_some(),
        )
    }

    pub fn post_policy(&self) -> PostPolicy {
        PostPolicy::parse(&self.post).unwrap_or(PostPolicy::Auto)
    }
}

/// Resolve `auto` against whether a probe exists: a probe may write, so a wire
/// that has one needs the dash worktree. Stated once, because a laid wire and
/// a wire about to be laid must resolve identically or the arming refusal and
/// the firing would disagree about which tier a wire is.
fn resolve_tier(declared: Tier, has_probe: bool) -> Tier {
    match declared {
        Tier::Auto if has_probe => Tier::Work,
        Tier::Auto => Tier::Verdict,
        explicit => explicit,
    }
}

/// A wire to lay. Every field the CLI can set, with the defaults the schema
/// carries so one shape describes a wire whether it came from a command line
/// or a table.
#[derive(Debug, Clone, PartialEq)]
pub struct NewWire {
    pub name: String,
    pub trigger: String,
    pub scope: Option<String>,
    pub probe: Option<String>,
    pub brief: String,
    pub model: Option<String>,
    pub tier: Tier,
    pub permission_mode: String,
    pub post: PostPolicy,
    pub cooldown_secs: i64,
}

impl NewWire {
    /// Which tier this wire will run at once laid — the same resolution
    /// [`Wire::resolved_tier`] does, available before the row exists, which is
    /// where the arming refusal has to read it.
    pub fn resolved_tier(&self) -> Tier {
        resolve_tier(self.tier, self.probe.is_some())
    }

    /// A wire with the schema's defaults, needing only what it watches and
    /// what to say about it.
    pub fn new(
        name: impl Into<String>,
        trigger: impl Into<String>,
        brief: impl Into<String>,
    ) -> Self {
        NewWire {
            name: name.into(),
            trigger: trigger.into(),
            scope: None,
            probe: None,
            brief: brief.into(),
            model: None,
            tier: Tier::Auto,
            permission_mode: "acceptEdits".to_string(),
            post: PostPolicy::Auto,
            cooldown_secs: DEFAULT_COOLDOWN_SECS,
        }
    }
}

/// The fields `wire edit` can move. `None` leaves a column alone, which is
/// what makes one verb able to change one thing without restating the rest.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WireEdit {
    pub trigger: Option<String>,
    pub scope: Option<Option<String>>,
    pub probe: Option<Option<String>>,
    pub brief: Option<String>,
    pub model: Option<Option<String>>,
    pub tier: Option<Tier>,
    pub permission_mode: Option<String>,
    pub post: Option<PostPolicy>,
    pub cooldown_secs: Option<i64>,
}

/// One firing, as the table holds it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Trip {
    pub id: i64,
    pub wire_id: i64,
    pub event_key: String,
    pub at_ms: i64,
    pub instance: String,
    pub status: String,
    pub swallow_reason: Option<String>,
    pub event_payload: Option<String>,
    pub probe_exit: Option<i64>,
    pub probe_tail: Option<String>,
    pub session_id: Option<String>,
    pub dash: Option<String>,
    pub interest: Option<String>,
    pub outcome: Option<String>,
    pub headline: Option<String>,
    pub refs: Option<String>,
    pub settled_at_ms: Option<i64>,
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
pub fn open_ledger(path: impl AsRef<Path>) -> Result<Connection, WireLedgerError> {
    if let Some(dir) = path.as_ref().parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let conn = tugcore::ledger_db::open(path)?;
    prepare(&conn)?;
    Ok(conn)
}

/// Open the machine's ledger at its canonical path.
pub fn open() -> Result<Connection, WireLedgerError> {
    open_ledger(tugcore::instance::tripwires_db_path())
}

/// Bring a connection's schema to the current version. Split out so tests can
/// exercise it against an in-memory connection.
fn prepare(conn: &Connection) -> Result<(), WireLedgerError> {
    // `trips` cascades from `wires`, and SQLite leaves foreign keys off per
    // connection unless asked.
    conn.pragma_update(None, "foreign_keys", true)?;
    // A version newer than this build means a newer tugutil owns the shape:
    // refuse the open rather than laying wires against an unknown schema.
    let on_disk: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if on_disk > WIRE_SCHEMA_VERSION {
        return Err(WireLedgerError::SchemaTooNew {
            on_disk,
            supported: WIRE_SCHEMA_VERSION,
        });
    }
    if on_disk > 0 && on_disk < WIRE_SCHEMA_VERSION {
        for (from, sql) in WIRE_MIGRATIONS {
            if *from >= on_disk {
                conn.execute_batch(sql)?;
            }
        }
    }
    conn.execute_batch(CREATE_TRIPWIRES_SQL)?;
    conn.pragma_update(None, "user_version", WIRE_SCHEMA_VERSION)?;
    Ok(())
}

// MARK: - Wires

const WIRE_COLUMNS: &str = "id, name, created_at, trigger, scope, probe, brief, model, tier, \
                            permission_mode, post, paused, cooldown_secs";

fn wire_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Wire> {
    Ok(Wire {
        id: row.get(0)?,
        name: row.get(1)?,
        created_at: row.get(2)?,
        trigger: row.get(3)?,
        scope: row.get(4)?,
        probe: row.get(5)?,
        brief: row.get(6)?,
        model: row.get(7)?,
        tier: row.get(8)?,
        permission_mode: row.get(9)?,
        post: row.get(10)?,
        paused: row.get::<_, i64>(11)? != 0,
        cooldown_secs: row.get(12)?,
    })
}

/// Lay a wire. The name is its address, so a second wire under one name is a
/// refusal rather than a silent overwrite.
pub fn lay(conn: &Connection, wire: &NewWire, now_ms: i64) -> Result<Wire, WireLedgerError> {
    // A work-tier wire commits on a dash, and `create_in` needs a checkout to
    // cut it from. Refused at the arming gesture rather than at the firing:
    // a wire that cannot possibly run is a wire that should never have been
    // laid, and finding that out from a trip log weeks later is finding out
    // too late [B07].
    if wire.resolved_tier() == Tier::Work && wire.scope.is_none() {
        return Err(WireLedgerError::WorkWireNeedsScope(wire.name.clone()));
    }
    let inserted = conn.execute(
        "INSERT OR IGNORE INTO wires
           (name, created_at, trigger, scope, probe, brief, model, tier, permission_mode, post,
            paused, cooldown_secs)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?11)",
        params![
            wire.name,
            now_ms,
            wire.trigger,
            wire.scope,
            wire.probe,
            wire.brief,
            wire.model,
            wire.tier.as_str(),
            wire.permission_mode,
            wire.post.as_str(),
            wire.cooldown_secs,
        ],
    )?;
    if inserted == 0 {
        return Err(WireLedgerError::DuplicateName(wire.name.clone()));
    }
    get(conn, &wire.name)?.ok_or_else(|| WireLedgerError::NoSuchWire(wire.name.clone()))
}

/// One wire by name, or `None`.
pub fn get(conn: &Connection, name: &str) -> Result<Option<Wire>, WireLedgerError> {
    let sql = format!("SELECT {WIRE_COLUMNS} FROM wires WHERE name = ?1");
    Ok(conn
        .query_row(&sql, params![name], wire_from_row)
        .optional()?)
}

/// Every wire, oldest first — the order they were laid in, which is the order
/// a reader who laid them expects.
pub fn list(conn: &Connection) -> Result<Vec<Wire>, WireLedgerError> {
    let sql = format!("SELECT {WIRE_COLUMNS} FROM wires ORDER BY id");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], wire_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Every wire that is armed — not paused. What the engine re-reads on each
/// event, so `pause` and `edit` apply on the next firing with no notification
/// plumbing at all.
pub fn armed(conn: &Connection) -> Result<Vec<Wire>, WireLedgerError> {
    let sql = format!("SELECT {WIRE_COLUMNS} FROM wires WHERE paused = 0 ORDER BY id");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], wire_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Move the fields an edit names and leave the rest. Each column is its own
/// single-statement update, which is what keeps a writer from holding the
/// table while it decides.
pub fn update(conn: &Connection, name: &str, edit: &WireEdit) -> Result<Wire, WireLedgerError> {
    let Some(before) = get(conn, name)? else {
        return Err(WireLedgerError::NoSuchWire(name.to_string()));
    };
    // The same rule as `lay`, against the row the edit would produce: an edit
    // that clears a work wire's scope, or promotes a scopeless wire to the
    // work tier, is the same unrunnable wire arriving by another door.
    let after_scope = edit.scope.clone().unwrap_or(before.scope.clone());
    let after_probe = edit.probe.clone().unwrap_or(before.probe.clone());
    let after_tier = edit
        .tier
        .unwrap_or_else(|| Tier::parse(&before.tier).unwrap_or(Tier::Auto));
    if resolve_tier(after_tier, after_probe.is_some()) == Tier::Work && after_scope.is_none() {
        return Err(WireLedgerError::WorkWireNeedsScope(name.to_string()));
    }
    let set = |column: &str, value: rusqlite::types::Value| -> Result<(), WireLedgerError> {
        let sql = format!("UPDATE wires SET {column} = ?1 WHERE name = ?2");
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
        set("brief", Value::Text(v.clone()))?;
    }
    if let Some(v) = &edit.model {
        set("model", v.clone().map_or(Value::Null, Value::Text))?;
    }
    if let Some(v) = edit.tier {
        set("tier", Value::Text(v.as_str().to_string()))?;
    }
    if let Some(v) = &edit.permission_mode {
        set("permission_mode", Value::Text(v.clone()))?;
    }
    if let Some(v) = edit.post {
        set("post", Value::Text(v.as_str().to_string()))?;
    }
    if let Some(v) = edit.cooldown_secs {
        set("cooldown_secs", Value::Integer(v))?;
    }
    get(conn, name)?.ok_or_else(|| WireLedgerError::NoSuchWire(name.to_string()))
}

/// Pause or arm a wire. Paused is a column rather than a deletion, so the
/// trip log a wire earned survives being taken out of service.
pub fn set_paused(conn: &Connection, name: &str, paused: bool) -> Result<Wire, WireLedgerError> {
    let moved = conn.execute(
        "UPDATE wires SET paused = ?1 WHERE name = ?2",
        params![i64::from(paused), name],
    )?;
    if moved == 0 {
        return Err(WireLedgerError::NoSuchWire(name.to_string()));
    }
    get(conn, name)?.ok_or_else(|| WireLedgerError::NoSuchWire(name.to_string()))
}

/// Remove a wire and, by cascade, its trips.
pub fn remove(conn: &Connection, name: &str) -> Result<(), WireLedgerError> {
    let removed = conn.execute("DELETE FROM wires WHERE name = ?1", params![name])?;
    if removed == 0 {
        return Err(WireLedgerError::NoSuchWire(name.to_string()));
    }
    Ok(())
}

// MARK: - Trips

const TRIP_COLUMNS: &str = "id, wire_id, event_key, at_ms, instance, status, swallow_reason, \
                            event_payload, probe_exit, probe_tail, session_id, dash, interest, \
                            outcome, headline, refs, settled_at_ms";

fn trip_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Trip> {
    Ok(Trip {
        id: row.get(0)?,
        wire_id: row.get(1)?,
        event_key: row.get(2)?,
        at_ms: row.get(3)?,
        instance: row.get(4)?,
        status: row.get(5)?,
        swallow_reason: row.get(6)?,
        event_payload: row.get(7)?,
        probe_exit: row.get(8)?,
        probe_tail: row.get(9)?,
        session_id: row.get(10)?,
        dash: row.get(11)?,
        interest: row.get(12)?,
        outcome: row.get(13)?,
        headline: row.get(14)?,
        refs: row.get(15)?,
        settled_at_ms: row.get(16)?,
    })
}

/// Try to claim one firing.
///
/// This is the whole of the arbitration between instances: the insert either
/// wins or violates `UNIQUE(wire_id, event_key)`, and the loser stops. It is
/// one statement on purpose — anything wider would be a lock, and a lock is
/// what this design does without.
pub fn claim_trip(
    conn: &Connection,
    wire_id: i64,
    event_key: &str,
    at_ms: i64,
    instance: &str,
    event_payload: Option<&str>,
) -> Result<Claim, WireLedgerError> {
    let inserted = conn.execute(
        "INSERT OR IGNORE INTO trips (wire_id, event_key, at_ms, instance, status, event_payload)
         VALUES (?1, ?2, ?3, ?4, 'claimed', ?5)",
        params![wire_id, event_key, at_ms, instance, event_payload],
    )?;
    if inserted == 0 {
        return Ok(Claim::AlreadyClaimed);
    }
    Ok(Claim::Claimed {
        trip_id: conn.last_insert_rowid(),
    })
}

/// Move a trip to a status, leaving everything else alone.
///
/// This is how a firing is refused: every guard runs *after* the claim, so a
/// swallow is a transition on the row the claim made rather than a second row
/// beside it. One event is one row per wire, which is what the unique
/// constraint already promises — and a refusal that wrote its own row would
/// quietly break that promise the first time two instances raced.
pub fn set_status(
    conn: &Connection,
    trip_id: i64,
    status: TripStatus,
    swallow_reason: Option<&str>,
) -> Result<(), WireLedgerError> {
    conn.execute(
        "UPDATE trips SET status = ?1, swallow_reason = COALESCE(?2, swallow_reason) WHERE id = ?3",
        params![status.as_str(), swallow_reason, trip_id],
    )?;
    Ok(())
}

/// Queue a trip the machine cannot serve yet, superseding any older queued
/// trip on the same wire.
///
/// One slot per wire, because coalescing to the newest pending event is what
/// a wire actually wants: a CI wire asked to verdict five commits in a storm
/// wants the last one's verdict, not five worktrees. The superseded row stays
/// in the log — the coalescing is visible, which is the point.
pub fn queue_trip(conn: &Connection, wire_id: i64, trip_id: i64) -> Result<(), WireLedgerError> {
    conn.execute(
        "UPDATE trips SET status = 'superseded', swallow_reason = 'superseded'
         WHERE wire_id = ?1 AND status = 'queued' AND id != ?2",
        params![wire_id, trip_id],
    )?;
    conn.execute(
        "UPDATE trips SET status = 'queued' WHERE id = ?1",
        params![trip_id],
    )?;
    Ok(())
}

/// How many trips are running machine-wide. Read immediately before a run
/// starts, and deliberately not cached: another instance's count is as real
/// as this one's.
pub fn running_count(conn: &Connection) -> Result<i64, WireLedgerError> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM trips WHERE status = 'running'",
        [],
        |r| r.get(0),
    )?)
}

/// The oldest queued trip, or `None`. What the engine starts when one of its
/// own runs settles.
pub fn oldest_queued(conn: &Connection) -> Result<Option<Trip>, WireLedgerError> {
    let sql = format!(
        "SELECT {TRIP_COLUMNS} FROM trips WHERE status = 'queued' ORDER BY at_ms, id LIMIT 1"
    );
    Ok(conn.query_row(&sql, [], trip_from_row).optional()?)
}

/// When this wire last fired for real, ignoring the trip that is asking.
///
/// The exclusion is not a convenience: every guard runs *after* the claim, so
/// by the time the cooldown is read the asking trip is already a row of its
/// own, and a window measured against it would read zero every time and
/// swallow nothing.
///
/// `swallowed` and `superseded` rows are deliberately not counted: a swallow
/// is not work, and counting it would extend the window every time the wire
/// declined to fire, which is a wire that goes quiet permanently.
pub fn previous_active_trip_at(
    conn: &Connection,
    wire_id: i64,
    this_trip: i64,
) -> Result<Option<i64>, WireLedgerError> {
    Ok(conn.query_row(
        "SELECT MAX(at_ms) FROM trips
             WHERE wire_id = ?1 AND id != ?2 AND status NOT IN ('swallowed', 'superseded')",
        params![wire_id, this_trip],
        |r| r.get::<_, Option<i64>>(0),
    )?)
}

/// Record what a probe did. The tail is capped — a probe that failed says why
/// at the end, and the whole of a red `just ci` is not evidence, it is a log.
pub fn record_probe(
    conn: &Connection,
    trip_id: i64,
    exit: i64,
    output_tail: &str,
) -> Result<(), WireLedgerError> {
    conn.execute(
        "UPDATE trips SET probe_exit = ?1, probe_tail = ?2 WHERE id = ?3",
        params![exit, tail(output_tail, PROBE_TAIL_CAP), trip_id],
    )?;
    Ok(())
}

/// Attach the session and dash a running trip is working in.
pub fn record_run(
    conn: &Connection,
    trip_id: i64,
    session_id: Option<&str>,
    dash: Option<&str>,
) -> Result<(), WireLedgerError> {
    conn.execute(
        "UPDATE trips SET status = 'running', session_id = ?1, dash = ?2 WHERE id = ?3",
        params![session_id, dash, trip_id],
    )?;
    Ok(())
}

/// What a trip finished with.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Settlement {
    pub interest: Option<String>,
    pub outcome: Option<String>,
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
) -> Result<(), WireLedgerError> {
    conn.execute(
        "UPDATE trips SET status = ?1, interest = ?2, outcome = ?3, headline = ?4, refs = ?5,
                          settled_at_ms = ?6
         WHERE id = ?7",
        params![
            status.as_str(),
            settlement.interest,
            settlement.outcome,
            settlement.headline,
            settlement.refs,
            at_ms,
            trip_id,
        ],
    )?;
    Ok(())
}

/// One trip by id.
pub fn trip(conn: &Connection, trip_id: i64) -> Result<Option<Trip>, WireLedgerError> {
    let sql = format!("SELECT {TRIP_COLUMNS} FROM trips WHERE id = ?1");
    Ok(conn
        .query_row(&sql, params![trip_id], trip_from_row)
        .optional()?)
}

/// A wire's trips, newest first, capped. The log is the record — no retention
/// policy trims it, and `limit` is the reader's window rather than the
/// ledger's memory.
pub fn trips_for_wire(
    conn: &Connection,
    wire_id: i64,
    limit: i64,
) -> Result<Vec<Trip>, WireLedgerError> {
    let sql =
        format!("SELECT {TRIP_COLUMNS} FROM trips WHERE wire_id = ?1 ORDER BY id DESC LIMIT ?2");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![wire_id, limit], trip_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Every trip this instance left `running` when it died. Swept to `failed` at
/// engine boot: their processes went with the previous tugcast, and a row
/// that reads `running` forever holds a concurrency slot nothing will free.
pub fn sweep_stale_running(
    conn: &Connection,
    instance: &str,
    at_ms: i64,
) -> Result<usize, WireLedgerError> {
    Ok(conn.execute(
        "UPDATE trips SET status = 'failed', swallow_reason = 'instance restarted',
                          settled_at_ms = ?1
         WHERE status = 'running' AND instance = ?2",
        params![at_ms, instance],
    )?)
}

// MARK: - Settings

/// One setting, or `None`.
pub fn setting(conn: &Connection, key: &str) -> Result<Option<String>, WireLedgerError> {
    Ok(conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |r| r.get(0),
        )
        .optional()?)
}

/// Write one setting.
pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), WireLedgerError> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// The machine-wide ceiling on concurrent runs. An absent or unreadable
/// setting is the default rather than an error: a typo in a settings row must
/// not stop every wire on the machine.
pub fn max_concurrent_trips(conn: &Connection) -> Result<i64, WireLedgerError> {
    Ok(setting(conn, SETTING_MAX_CONCURRENT_TRIPS)?
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(DEFAULT_MAX_CONCURRENT_TRIPS))
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

    fn lay_one(conn: &Connection, name: &str) -> Wire {
        lay(
            conn,
            &NewWire::new(name, r#"{"fact":{"kind":"edit_failed"}}"#, "diagnose it"),
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
        assert_eq!(stamped, WIRE_SCHEMA_VERSION);
        prepare(&conn).unwrap();
        let again: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(again, WIRE_SCHEMA_VERSION);
    }

    /// A newer build owns a shape this one cannot read, so the open refuses
    /// rather than writing rows against an unknown schema.
    #[test]
    fn a_newer_schema_on_disk_refuses_the_open() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", WIRE_SCHEMA_VERSION + 1)
            .unwrap();
        assert!(matches!(
            prepare(&conn),
            Err(WireLedgerError::SchemaTooNew { .. })
        ));
    }

    #[test]
    fn a_wire_lays_reads_back_and_refuses_a_second_under_one_name() {
        let conn = ledger();
        let laid = lay_one(&conn, "tugedit");
        assert_eq!(laid.name, "tugedit");
        assert_eq!(laid.cooldown_secs, DEFAULT_COOLDOWN_SECS);
        assert!(!laid.paused);
        assert_eq!(get(&conn, "tugedit").unwrap().as_ref(), Some(&laid));

        let again = lay(
            &conn,
            &NewWire::new("tugedit", r#"{"commit":{}}"#, "other"),
            2_000,
        );
        assert!(matches!(again, Err(WireLedgerError::DuplicateName(n)) if n == "tugedit"));
        assert_eq!(
            get(&conn, "tugedit").unwrap().unwrap().brief,
            "diagnose it",
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
            &WireEdit {
                cooldown_secs: Some(5),
                probe: Some(Some("just ci".to_string())),
                // The probe promotes the wire to the work tier, which cannot
                // arm without somewhere to stage its work.
                scope: Some(Some("/repo".to_string())),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(edited.cooldown_secs, 5);
        assert_eq!(edited.probe.as_deref(), Some("just ci"));
        assert_eq!(edited.brief, "diagnose it", "untouched");
        assert_eq!(edited.trigger, r#"{"fact":{"kind":"edit_failed"}}"#);

        let cleared = update(
            &conn,
            "w",
            &WireEdit {
                probe: Some(None),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(cleared.probe.is_none(), "Some(None) clears the column");
    }

    /// A work-tier wire stages on a dash, and a dash lives in a checkout. The
    /// refusal is at the arming gesture — both of them — rather than at the
    /// firing, because a wire nobody could have run is a wire that should
    /// never have been laid [B07].
    #[test]
    fn a_work_tier_wire_cannot_arm_without_somewhere_to_work() {
        let conn = ledger();
        let mut wire = NewWire::new("w", r#"{"commit":{}}"#, "b");
        wire.probe = Some("just ci".to_string());
        assert!(matches!(
            lay(&conn, &wire, 1),
            Err(WireLedgerError::WorkWireNeedsScope(_))
        ));

        wire.scope = Some("/repo".to_string());
        lay(&conn, &wire, 1).unwrap();

        // And the same rule against the row an edit would produce: clearing
        // the scope of a wire that is already at the work tier is the same
        // unrunnable wire arriving by another door.
        assert!(matches!(
            update(
                &conn,
                "w",
                &WireEdit {
                    scope: Some(None),
                    ..Default::default()
                },
            ),
            Err(WireLedgerError::WorkWireNeedsScope(_))
        ));
        assert_eq!(
            get(&conn, "w").unwrap().unwrap().scope.as_deref(),
            Some("/repo"),
            "a refused edit moves nothing"
        );
    }

    #[test]
    fn pausing_leaves_the_wire_and_its_log_and_takes_it_out_of_armed() {
        let conn = ledger();
        let w = lay_one(&conn, "w");
        claim_trip(&conn, w.id, "e1", 1, "inst", None).unwrap();
        assert_eq!(armed(&conn).unwrap().len(), 1);

        set_paused(&conn, "w", true).unwrap();
        assert!(armed(&conn).unwrap().is_empty());
        assert_eq!(list(&conn).unwrap().len(), 1, "still laid, just not armed");
        assert_eq!(trips_for_wire(&conn, w.id, 10).unwrap().len(), 1);

        set_paused(&conn, "w", false).unwrap();
        assert_eq!(armed(&conn).unwrap().len(), 1);
    }

    #[test]
    fn removing_a_wire_takes_its_trips_with_it() {
        let conn = ledger();
        let w = lay_one(&conn, "w");
        claim_trip(&conn, w.id, "e1", 1, "inst", None).unwrap();
        remove(&conn, "w").unwrap();
        assert!(get(&conn, "w").unwrap().is_none());
        assert!(trips_for_wire(&conn, w.id, 10).unwrap().is_empty());
        assert!(matches!(
            remove(&conn, "w"),
            Err(WireLedgerError::NoSuchWire(_))
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
        assert_eq!(trips_for_wire(&conn, w.id, 10).unwrap().len(), 1);
    }

    /// Two wires watching one commit are two firings, not one — the claim is
    /// per wire, not per event.
    #[test]
    fn two_wires_each_claim_the_same_event() {
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

    #[test]
    fn a_claim_contended_across_threads_is_won_exactly_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tripwires.db");
        let setup = open_ledger(&path).unwrap();
        let wire = lay_one(&setup, "w");
        drop(setup);

        let outcomes: Vec<Claim> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|i| {
                    let path = path.clone();
                    scope.spawn(move || {
                        let conn = open_ledger(&path).unwrap();
                        claim_trip(&conn, wire.id, "one-event", 100 + i, "inst", None).unwrap()
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
        assert_eq!(trips_for_wire(&conn, wire.id, 100).unwrap().len(), 1);
    }

    /// A swallowed firing keeps its row and its reason — and stops counting
    /// toward the window, because a wire whose every refusal reset the clock
    /// would go quiet permanently.
    #[test]
    fn a_swallowed_claim_keeps_its_reason_and_stops_counting_toward_the_window() {
        let conn = ledger();
        let w = lay_one(&conn, "w");
        claim_trip(&conn, w.id, "e1", 1_000, "inst", None).unwrap();
        let Claim::Claimed { trip_id } =
            claim_trip(&conn, w.id, "e2", 5_000, "inst", None).unwrap()
        else {
            panic!("claimed");
        };
        set_status(&conn, trip_id, TripStatus::Swallowed, Some("cooldown")).unwrap();

        let trips = trips_for_wire(&conn, w.id, 10).unwrap();
        assert_eq!(trips[0].status, "swallowed");
        assert_eq!(trips[0].swallow_reason.as_deref(), Some("cooldown"));
        assert_eq!(
            previous_active_trip_at(&conn, w.id, trip_id).unwrap(),
            Some(1_000),
            "the swallow did not push the window forward"
        );

        let Claim::Claimed { trip_id: third } =
            claim_trip(&conn, w.id, "e3", 9_000, "inst", None).unwrap()
        else {
            panic!("claimed");
        };
        assert_eq!(
            previous_active_trip_at(&conn, w.id, third).unwrap(),
            Some(1_000),
            "the asking trip is never its own window"
        );

        let fresh = lay_one(&conn, "fresh");
        assert_eq!(previous_active_trip_at(&conn, fresh.id, 0).unwrap(), None);
    }

    #[test]
    fn queuing_supersedes_the_older_queued_trip_on_the_same_wire() {
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
            "another wire's queue is its own"
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
        record_run(&conn, trip_id, Some("tug-1"), Some("wire-w-abc")).unwrap();
        assert_eq!(running_count(&conn).unwrap(), 1);

        settle(
            &conn,
            trip_id,
            TripStatus::Settled,
            &Settlement {
                interest: Some("interesting".to_string()),
                outcome: Some("verdict".to_string()),
                headline: Some("it broke".to_string()),
                refs: Some(r#"[{"kind":"dash","target":"wire-w-abc"}]"#.to_string()),
            },
            9_000,
        )
        .unwrap();
        assert_eq!(running_count(&conn).unwrap(), 0);

        let settled = trip(&conn, trip_id).unwrap().unwrap();
        assert_eq!(settled.status, "settled");
        assert_eq!(settled.session_id.as_deref(), Some("tug-1"));
        assert_eq!(settled.dash.as_deref(), Some("wire-w-abc"));
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
            "a typo must not stop every wire on the machine"
        );
        set_setting(&conn, SETTING_MAX_CONCURRENT_TRIPS, "0").unwrap();
        assert_eq!(
            max_concurrent_trips(&conn).unwrap(),
            DEFAULT_MAX_CONCURRENT_TRIPS
        );
    }

    /// A probe may write, so a wire that has one needs the dash worktree.
    #[test]
    fn auto_resolves_to_work_when_the_wire_has_a_probe() {
        let conn = ledger();
        let mut wire = NewWire::new("w", r#"{"commit":{}}"#, "b");
        let verdict = lay(&conn, &wire, 1).unwrap();
        assert_eq!(verdict.resolved_tier(), Tier::Verdict);

        wire.name = "p".to_string();
        wire.probe = Some("just ci".to_string());
        wire.scope = Some("/repo".to_string());
        assert_eq!(lay(&conn, &wire, 1).unwrap().resolved_tier(), Tier::Work);

        wire.name = "forced".to_string();
        wire.tier = Tier::Verdict;
        assert_eq!(
            lay(&conn, &wire, 1).unwrap().resolved_tier(),
            Tier::Verdict,
            "an explicit tier is a capability boundary, not an optimization"
        );
    }

    /// A wire laid by a newer build against a grammar this one cannot read is
    /// still a wire this one can list and remove.
    #[test]
    fn an_unreadable_trigger_costs_the_predicate_never_the_row() {
        let conn = ledger();
        lay(
            &conn,
            &NewWire::new("future", r#"{"portent":{"omen":"raven"}}"#, "b"),
            1,
        )
        .unwrap();
        let listed = list(&conn).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(matches!(
            listed[0].predicate(),
            Err(WireLedgerError::BadTrigger(_))
        ));
        remove(&conn, "future").unwrap();
    }

    #[test]
    fn every_status_and_tier_spelling_round_trips() {
        for s in [
            TripStatus::Claimed,
            TripStatus::Swallowed,
            TripStatus::Queued,
            TripStatus::Superseded,
            TripStatus::Running,
            TripStatus::Settled,
            TripStatus::Failed,
        ] {
            assert_eq!(TripStatus::parse(s.as_str()), Some(s));
        }
        for t in [Tier::Auto, Tier::Verdict, Tier::Work] {
            assert_eq!(Tier::parse(t.as_str()), Some(t));
        }
        for p in [PostPolicy::Auto, PostPolicy::Always, PostPolicy::Never] {
            assert_eq!(PostPolicy::parse(p.as_str()), Some(p));
        }
        assert_eq!(TripStatus::parse("nonsense"), None);
    }

    #[test]
    fn editing_or_pausing_a_wire_that_is_not_there_refuses() {
        let conn = ledger();
        assert!(matches!(
            update(&conn, "ghost", &WireEdit::default()),
            Err(WireLedgerError::NoSuchWire(_))
        ));
        assert!(matches!(
            set_paused(&conn, "ghost", true),
            Err(WireLedgerError::NoSuchWire(_))
        ));
    }
}
