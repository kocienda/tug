//! SessionLedger — sqlite-backed per-session metadata for the tugcast supervisor.
//!
//! One row per claude session. Each row carries the workspace key, project dir,
//! created/last-used timestamps, turn count, first-prompt snippet, lifecycle
//! state, and (when the session is live) the bound card id. The ledger replaces
//! the previous tugbank-backed `sessions` map and `live-sessions` set with a
//! purpose-built store: row-level queries, atomic eviction, indexed lookup by
//! workspace, single source of truth for "is this session live, and where".
//!
//! # State machine
//!
//! `state` is one of `live` | `closed` | `failed`. Allowed transitions:
//!
//! - `INSERT  state="live", card_id=<card_id>` on `spawn_session_ok`.
//! - `UPDATE  state="closed"`                  on `close_session` or tugcode exit.
//! - `UPDATE  state="failed"`                  on `resume_failed` (replaces the previous row-removal).
//! - `DELETE` on the age sweep or explicit trash.
//!
//! `card_id` is set when the session first binds to a card and is preserved
//! across the row's lifetime — `mark_closed` and `mark_failed` retain it as
//! the "last bound" record so client-side restore can reconstruct the
//! card↔session mapping after a tugcast restart. Liveness is encoded
//! exclusively in `state`, not by nullity of `card_id`.
//!
//! # Eviction
//!
//! One policy, and it is age. **Age expiry** — `DEV_LEDGER_MAX_AGE_DAYS`
//! (90). Tugcast startup sweeps any non-live row whose `last_used_at` is
//! older than that.
//!
//! There is deliberately **no per-workspace cap**. One lived here for four
//! months, written when a session row was throwaway picker telemetry, and it
//! outlived that rationale: it evicted the last segment of a line the user
//! had named by hand. A bounded row count is not a resource this ledger
//! needs to defend, and no number is small enough to be worth a name.
//!
//! And the sweep cannot take a name either. Every *automatic* delete over
//! `sessions` goes through the `sparing_named_lines!` guard, which refuses to
//! remove the last surviving segment of a line whose name the user typed. The
//! guard sits beside the `DELETE` rather than in each caller, because the
//! caller is where this went wrong once already. `trash` — the user's own
//! explicit gesture — is deliberately not guarded: deleting a session on
//! purpose is the one act that may cost a name, and when it takes a line's
//! last segment the name goes with it rather than being left to strand.
//!
//! Live rows are never evicted. A long-pinned card keeps its ledger row
//! regardless of age.
//!
//! # Schema
//!
//! Two tables: `sessions` (one row per claude session, lifecycle state
//! and metadata) and `turns` (a *submission journal* — one row per
//! pending user submission, deleted as soon as claude acknowledges).
//! Cascade-on-`sessions`-DELETE for the journal is implemented via the
//! `turns_cascade_delete_on_session` trigger rather than a foreign-key
//! constraint: the supervisor inserts journal rows at user-message
//! dispatch time, before claude emits `session_init` and before the
//! bridge populates the `sessions` row, so an `INSERT`-time FK check
//! would chicken-and-egg. The trigger preserves the user-visible
//! "Trash cascades to journal" contract without coupling INSERT
//! ordering across the dispatch and bridge code paths.
//!
//! Bootstrap creates every table, index, and trigger via
//! `CREATE … IF NOT EXISTS`, and additive schema changes ride
//! **self-healing migrations**: idempotent `ALTER TABLE … ADD COLUMN`
//! passes (`migrate_sessions_add_name` and its siblings) that tolerate
//! the duplicate-column race, so an existing on-disk `sessions.db` is
//! upgraded in place on open. There is no `migrations` table and no
//! version counter — per-instance state needs neither, and **never
//! delete the database to "migrate" it**: `minted_tags` is an append-only
//! arbiter whose loss silently re-opens callsign recycling. (The shared `changes.db` is a different
//! regime entirely — its schema changes bump `CHANGES_SCHEMA_VERSION`
//! with a registered migration.)
//!
//! # Callsigns: permanence and stability ([D132])
//!
//! Every session wears a mnemonic `adjective-noun` **callsign** in
//! `sessions.tag`. Three rules govern it, and all are load-bearing because
//! commit trailers cite callsigns.
//!
//! **It is never recycled.** `sessions` rows are hard-`DELETE`d — trash, the
//! cascade paths, the age sweep — so the `sessions_tag` unique index frees a
//! callsign the moment its row dies, and a recycled callsign would make an old
//! commit's citation resolve to a *different* session: a confidently wrong
//! answer, strictly worse than an unresolvable one. So the arbiter is the
//! append-only **`minted_tags`** table. Every mint path inserts into it in the
//! same transaction as the row it names, its `PRIMARY KEY` violation is the
//! collision signal a mint retries against, and **nothing may ever delete from
//! it** — not trash, not the cascades, not eviction. Deleting rows there
//! silently restores recycling. The `lines.tag` unique index stays as the
//! live-row invariant beside it. The guarantee is per-ledger: `sessions.db` is
//! per-instance, so a trailer written on another machine simply misses, which
//! is safe.
//!
//! **A collision rerolls; it never suffixes.** The bare `-2`, `-3`… backstop is
//! retired, along with the silent NULL tag it landed on at exhaustion. On a
//! genuine collision the mint rolls a complete fresh pair and re-claims.
//!
//! **The callsign belongs to the line of work, and never moves.** A `sessions`
//! row is a **segment** of a [`LineRow`] ([P01]); the callsign, the user's
//! name, and the auto title live on the line, once, for however many session
//! ids that line lives through — a rotation, a rewind-fork, a `--continue`, a
//! crash respawn. So there is nothing on a segment to inherit, strand, or
//! displace, and every read of a `sessions` row picks the identity up through
//! a `LEFT JOIN lines` ([P02]). A line is born in exactly one place
//! ([`birth_line_in`]) and that is the only place a callsign is claimed.
//! Retired spellings — the `<root>-<Letter><Number>` lineage-suffix grammar
//! (`stocky-pixie-A1-B2`), and the pair a stage rotation used to roll for
//! itself — still *parse* ([`is_session_callsign`]) and still resolve, through
//! `minted_tags`, to the line that spent them. The only path to a fresh
//! callsign is a genuinely new line of work: a card's first spawn, a plain
//! `/new`, or a session the external scan has just discovered.
//!
//! # Concurrency
//!
//! Writes serialize through a single `Mutex<Connection>` inside the ledger.
//! Sqlite runs in WAL mode with a 5-second `busy_timeout`. The supervisor's
//! write cadence — one write per `session_init` / `turn_complete` /
//! `resume_failed` / close — fits comfortably under those settings.
//! Journal writes (`insert_pending_turn`,
//! `delete_oldest_pending_for_session`) are single-statement and don't
//! need explicit transactions; sqlite's per-statement implicit
//! transaction is enough.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::Notify;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tugcast_core::{OverviewAuthor, OverviewPost};

use crate::ledger_integrity;
use crate::path_resolver::resolve_to_claude_form;
use crate::search_tokens::subword_tokens;

/// The privacy exclusion, spelled once and pasted into every read that could
/// surface a private session's work ([P05]). The argument is the row's
/// session-id column.
///
/// **`NOT EXISTS`, never a join** — a correctness requirement, not a style
/// preference. `changes.file_events` lives in the machine-global shared
/// `changes.db` while `sessions` is per-instance, so a file event belonging to
/// *another instance's* session has no local `sessions` row at all. An
/// `INNER JOIN sessions` would silently drop those legitimate rows and quietly
/// shrink the Operator's answers. An absent row must read as not-private and
/// stay in the results, which is exactly what `NOT EXISTS` does.
macro_rules! not_private {
    ($col:literal) => {
        concat!(
            " AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = ",
            $col,
            " AND s.private = 1)"
        )
    };
}

/// The **named-line guard**, spelled once and wrapped around every *automatic*
/// delete over `sessions`. The argument is the SQL criterion naming the rows
/// that path wants gone; what comes back is that same set, minus any row whose
/// removal would strand a line the user named.
///
/// A `/rename` is the user's own word about their own work, and the ledger
/// treated it as cache: a per-workspace cap deleted the last segment of the
/// line named `lens-xp`, and the name — still intact on `lines` — became
/// unreachable, because every listing path walks `sessions`. The guard lives
/// here, beside the `DELETE`, rather than in each caller, because the caller
/// is exactly where that went wrong once already.
///
/// **Set-aware, not row-at-a-time** — which is why this is a CTE and not a
/// clause. A predicate asking each row on its own "is another segment of my
/// line still here?" answers yes for *both* segments of a two-segment line,
/// and then deletes both, stranding the name it was written to save. So the
/// criterion is materialized once as `doomed`, and a row is spared only when
/// its line is named, no segment of that line survives the criterion, and it
/// is the newest of the doomed ones. Exactly one segment is left standing per
/// named line, and it is the newest.
///
/// `trash` — the user's own explicit gesture — is deliberately not wrapped in
/// this. Deleting a session on purpose is the one act that may cost a name.
macro_rules! sparing_named_lines {
    ($doomed_criterion:literal) => {
        concat!(
            "WITH doomed AS (
                 SELECT session_id, line_id, last_used_at FROM sessions
                 WHERE ",
            $doomed_criterion,
            "
             )
             SELECT d.session_id FROM doomed d
             WHERE NOT (
                 EXISTS (
                     SELECT 1 FROM lines l
                     WHERE l.line_id = d.line_id AND l.name_user_set = 1
                 )
                 AND NOT EXISTS (
                     SELECT 1 FROM sessions s
                     WHERE s.line_id = d.line_id
                       AND s.session_id NOT IN (SELECT session_id FROM doomed)
                 )
                 AND NOT EXISTS (
                     SELECT 1 FROM doomed n
                     WHERE n.line_id = d.line_id
                       AND (n.last_used_at > d.last_used_at
                            OR (n.last_used_at = d.last_used_at
                                AND n.session_id > d.session_id))
                 )
             )"
        )
    };
}

/// Days since `last_used_at` after which a non-live row is age-evicted on
/// startup sweep.
pub const DEV_LEDGER_MAX_AGE_DAYS: i64 = 90;

/// Days a `.tug-trash/<deletedAt>/` directory survives before the startup
/// trash sweep removes it. Wired in step 8.
pub const DEV_TRASH_SWEEP_AGE_DAYS: i64 = 7;

/// Maximum number of characters of the most-recent user prompt the ledger
/// stores. The picker truncates further at display time.
pub const USER_PROMPT_MAX_CHARS: usize = 256;

/// Version stamp of the **shared** `changes.db` schema (`PRAGMA
/// changes.user_version`). Bumping this constant REQUIRES a registered
/// entry in [`CHANGES_MIGRATIONS`] and human review of the migration SQL —
/// an individual instance must never reshape the machine-global schema on
/// its own ([D112]). Builds seeing a *newer* on-disk version refuse to
/// write the shared tables entirely.
pub const CHANGES_SCHEMA_VERSION: i64 = 3;

/// Registered, human-approved migrations for the shared changes schema:
/// `(from_version, sql)` applied in order to reach `from_version + 1`.
/// Version 1 was the first stamped shape; version 2 adds the additive
/// `file_event_spans` child table ([P10]) and touches nothing existing;
/// version 3 adds the nullable `file_events.line_id` column ([P01]) —
/// stamped at write time, so a row stays attributed to its line of work
/// even after the `sessions` row it would have joined through is evicted
/// or lives in another instance's ledger ([Q01]).
const CHANGES_MIGRATIONS: &[(i64, &str)] = &[
    (1, CREATE_FILE_EVENT_SPANS_SQL),
    (2, ADD_FILE_EVENTS_LINE_ID_SQL),
];

/// The v2→v3 column add, in one place with the conditional bootstrap arm
/// that covers pre-versioning databases.
const ADD_FILE_EVENTS_LINE_ID_SQL: &str =
    "ALTER TABLE changes.file_events ADD COLUMN line_id TEXT;";

/// The `file_event_spans` DDL, in one place: the v1→v2 migration and the
/// idempotent bootstrap block both run it, so a migrated database and a
/// fresh one cannot end up with different shapes.
const CREATE_FILE_EVENT_SPANS_SQL: &str = "
    -- Sub-file evidence for a `file_events` row (Spec S04): what the tool
    -- call wrote *inside* the file, so two sessions editing disjoint
    -- regions of one path read as disjoint rather than contested. Rows are
    -- children of `file_events` — same first three key columns plus a
    -- per-row ordinal — and every applier that moves or removes the parent
    -- carries them along. `anchor` is content, never a line number ([P11]).
    CREATE TABLE IF NOT EXISTS changes.file_event_spans (
        tug_session_id TEXT NOT NULL,
        tool_use_id    TEXT NOT NULL,
        file_path      TEXT NOT NULL,
        seq            INTEGER NOT NULL,
        kind           TEXT NOT NULL,
        anchor         TEXT NOT NULL,
        PRIMARY KEY (tug_session_id, tool_use_id, file_path, seq)
    );
";

/// `<changes-db>.schema-version` — a plain-text sidecar stamped by every
/// owner that bootstraps or migrates the shared schema. It exists because
/// a corrupt database's `user_version` is unreadable: without it, an
/// older build quarantine-rebuilding a newer-schema `changes.db` would
/// silently stamp the OLD schema over the machine-global truth — exactly
/// the stray-build reshaping [D112]/[LR5] forbid.
fn changes_schema_sidecar_path(changes_db: &Path) -> PathBuf {
    let mut name = changes_db.as_os_str().to_owned();
    name.push(".schema-version");
    PathBuf::from(name)
}

/// The sidecar's recorded schema version, `None` when absent/unreadable.
fn read_changes_schema_sidecar(changes_db: &Path) -> Option<i64> {
    std::fs::read_to_string(changes_schema_sidecar_path(changes_db))
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// Record this build's schema version in the sidecar. Never lowers a
/// higher recorded version: after an upgrade-then-rollback the guard must
/// keep protecting the newer on-disk schema.
fn stamp_changes_schema_sidecar(changes_db: &Path) {
    if read_changes_schema_sidecar(changes_db).is_some_and(|v| v >= CHANGES_SCHEMA_VERSION) {
        return;
    }
    let path = changes_schema_sidecar_path(changes_db);
    // Temp-file + rename: a torn write would leave an unparseable sidecar,
    // and an unreadable sidecar disables the downgrade guard — the exact
    // hazard it exists to stop.
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let stamped = std::fs::write(&tmp, format!("{CHANGES_SCHEMA_VERSION}\n"))
        .and_then(|()| std::fs::rename(&tmp, &path));
    if let Err(err) = stamped {
        tracing::warn!(sidecar = %path.display(), error = %err, "cannot stamp changes schema sidecar");
    }
}

/// One database's `PRAGMA wal_checkpoint(PASSIVE)` verdict — see
/// [`SessionLedger::checkpoint_health`]. `log_frames == -1` means the
/// pragma itself failed (`error` carries the message), which on a WAL db
/// is itself an alarm.
#[derive(Debug, Clone)]
pub struct CheckpointHealth {
    pub db: &'static str,
    pub busy: bool,
    pub log_frames: i64,
    pub checkpointed_frames: i64,
    pub error: Option<String>,
}

/// Errors emitted by ledger operations.
#[derive(Debug, Error)]
pub enum LedgerError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("session not found: {0}")]
    NotFound(String),

    #[error("invalid session state in row: {0}")]
    InvalidState(String),

    /// No callsign could be claimed for a session. Reaching this means the
    /// reroll bound was exhausted, or a lineage tag collided (which the fork
    /// path must resolve by re-allocating its segment, never by rerolling).
    #[error("tag claim failed: {0}")]
    TagClaimFailed(String),

    /// A schema migration could not establish the invariant it exists to
    /// establish. The transaction rolls back and the open fails: a ledger
    /// this build cannot bring to a shape it understands is not one to serve.
    #[error("migration failed: {0}")]
    MigrationFailed(String),

    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),

    /// The instance owning the shared changes ledger answered this forwarded
    /// write with a refusal retrying cannot fix. The owner is healthy and the
    /// database is intact, so this is one gesture's failure and nothing more.
    #[error("the changes-ledger owner refused the write: {0}")]
    ForwardRejected(String),
}

/// Lifecycle state of a row in the ledger.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionState {
    Live,
    Closed,
    Failed,
}

impl SessionState {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionState::Live => "live",
            SessionState::Closed => "closed",
            SessionState::Failed => "failed",
        }
    }
}

impl std::str::FromStr for SessionState {
    type Err = LedgerError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "live" => Ok(SessionState::Live),
            "closed" => Ok(SessionState::Closed),
            "failed" => Ok(SessionState::Failed),
            other => Err(LedgerError::InvalidState(other.to_owned())),
        }
    }
}

/// One row of the `sessions` table, also the wire shape for the CONTROL
/// `list_sessions` response and the `session_updated` push.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionRow {
    pub session_id: String,
    pub workspace_key: String,
    pub project_dir: String,
    pub created_at: i64,
    pub last_used_at: i64,
    pub turn_count: i64,
    pub last_user_prompt: Option<String>,
    pub state: SessionState,
    /// The card this session is bound to. Set on `record_spawn` and never
    /// cleared by lifecycle transitions; combined with `state` it answers
    /// "which session was last bound to this card, and is it still live?"
    pub card_id: Option<String>,
    /// Session title, or `None` when untitled. Carries either the user's
    /// `/rename` choice or the auto-generated `aiTitle` scraped from the JSONL —
    /// see `name_user_set` to tell them apart. Survives re-spawn/resume (never
    /// cleared by lifecycle transitions); the chooser shows it as the row title.
    ///
    /// Owned by the **line**, not by this segment: it arrives through the
    /// `LEFT JOIN lines` every `sessions` query carries ([P02]).
    pub name: Option<String>,
    /// `true` only when `name` was set by the user via `/rename`; `false` when
    /// it's an auto `aiTitle` (or unset). The Z4B session chip shows the hash
    /// unless this is `true`, so an auto title never masquerades as a rename.
    ///
    /// The line's, by the same join.
    pub name_user_set: bool,
    /// Mnemonic `adjective-noun` callsign, minted client-side "from the drop"
    /// and made permanent by the append-only `minted_tags` arbiter (Spec S08):
    /// a tag any session ever minted is spent forever, so a collision rerolls a
    /// complete fresh pair rather than suffixing the taken one. `None` on
    /// a scan row whose line has not been named yet. The callsign belongs to
    /// the **line** and arrives by join, so every segment of one line of work
    /// reads the same spelling and nothing ever transfers it. Keep in lockstep
    /// with the TS `SessionRow.tag`.
    pub tag: Option<String>,
    /// The rolling generated description ([P07]) — a standing line saying what
    /// this session is about, composed on the SharedAgent's Summarize lane and
    /// re-composed as the work moves. `None` until the first one is written.
    /// Independent of `name` — a renamed session keeps being described, because
    /// the name is the title and this is the line beneath it ([D132]). Keep in
    /// lockstep with the TS `SessionRow.synopsis`.
    #[serde(default)]
    pub synopsis: Option<String>,
    /// The Overview privacy flag: `true` while this session is out of the fact
    /// base and out of the channel. It rides the row to the deck because
    /// privacy is a resting state — the chip shows the marker for as long as
    /// the flag is set, so the mode survives a reload instead of living only
    /// in the ack that set it. Keep in lockstep with the TS `SessionRow.private`.
    #[serde(default)]
    pub private: bool,
    /// The dash this session is working on, as its **owner key** ([P01]) —
    /// `tugdash/<name>#<tugid>`, or the bare branch ref for an id-less dash.
    /// This is the authority; `dash_name` is denormalized display.
    ///
    /// A binding is live-session state ([P08]): it is written at bind, cleared
    /// when the session closes ([L27]), and never reported for a row the
    /// ledger no longer calls live — a dash whose cards have all closed is
    /// *unbound*, not still mated.
    #[serde(default)]
    pub dash_id: Option<String>,
    /// The bound dash's name, denormalized so a display never needs a git
    /// read. `dash_id` is the authority.
    #[serde(default)]
    pub dash_name: Option<String>,
    /// The line of work this row is a **segment** of ([P01]). Every id change
    /// a card lives through — a rotation, a rewind-fork, a `--continue`, a
    /// crash respawn — writes another segment against the same line, and the
    /// line is what carries the callsign and the user's name. Keep in lockstep
    /// with the TS `SessionRow.line_id`.
    #[serde(default)]
    pub line_id: String,
}

/// One row of the `turns` submission journal. Authored by tugcast at
/// user-submit time (`insert_pending_turn`) and deleted by the merger's
/// `turn_complete` intercept (FIFO match) once claude acknowledges the
/// submission. While the row exists, the user submission is "pending" —
/// claude hasn't yet recorded it in JSONL. The journal's only durable
/// role is plugging the gap between user-submit and JSONL-acknowledge so
/// `runReplay` can render the submission as awaiting-response on
/// resume. See [DM08] in the mid-turn-replay plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JournalRow {
    pub journal_id: String,
    pub session_id: String,
    pub user_text: String,
    pub user_attachments: Vec<serde_json::Value>,
    pub created_at: i64,
}

/// One row of the `turn_telemetry` table — the per-turn cost + multi-
/// clock timing block. Written by `record_turn_telemetry` from the
/// supervisor's inbound handler; read by `list_turn_telemetry` at
/// resume time and inlined onto replayed `turn_complete` wire events
/// by the supervisor's replay path.
///
/// The shape is the wire-shape of tugdeck's `TurnTelemetry`
/// interface (see `tugdeck/src/lib/code-session-store/telemetry.ts`
/// `TurnTelemetry`) — every field is round-trippable. `ttft_ms` and
/// `ttftc_ms` are nullable per the tugdeck data model (a turn that
/// produced no assistant output or no tool calls has no first-event
/// timestamp).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TurnTelemetryRow {
    pub session_id: String,
    pub msg_id: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_input_tokens: i64,
    pub cache_read_input_tokens: i64,
    pub total_cost_usd: f64,
    pub wall_clock_ms: i64,
    pub awaiting_approval_ms: i64,
    pub transport_downtime_ms: i64,
    pub active_ms: i64,
    pub ttft_ms: Option<i64>,
    pub ttftc_ms: Option<i64>,
    pub reconnect_count: i64,
    pub max_stream_gap_ms: i64,
    pub ended_at: i64,
    /// `window(0)` — the session's resident context before any turn.
    /// Session-level rather than per-turn (every row of a session
    /// carries the same value); persisted here so a resumed session
    /// restores it. `None` for a session that never observed a first
    /// telemetry iteration, and for rows written before this field.
    pub session_init_tokens: Option<i64>,
}

/// One row of the `session_metadata` table — the LIVE-ONLY
/// `system_metadata` payload Claude Code emits on `session_init` and
/// that JSONL never preserves. Written by the bridge intercept on
/// every outbound `system_metadata` line (merged against the existing
/// row, then persisted); read on subsequent intercepts so the merge
/// has a current baseline.
///
/// `payload` is the raw JSON BLOB — the merge rule operates on the
/// parsed `serde_json::Value` rather than on per-column scalars, so
/// fields Anthropic adds in the future land here without a schema
/// change. `captured_at` is the wall-clock millisecond timestamp when
/// the row was last written (for debugging / staleness audits).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionMetadataRow {
    pub session_id: String,
    pub payload: Vec<u8>,
    pub captured_at: i64,
}

/// One row of the `session_capabilities` table — the most-recent turn-free
/// `initialize` handshake payload for a session (model list, command
/// catalog with plugin commands merged, version, effort), persisted as the
/// tagged wire frame the supervisor broadcast.
///
/// Written by the supervisor's sideband capture whenever a live
/// `session_capabilities` frame flows; read at session bind as the fallback
/// when the in-memory `latest_capabilities` slot is empty — the app-restart
/// case, where the slot died with the old process and the health-gated
/// resume handshake hasn't answered yet. Without this row a resumed card
/// has no `/` command catalog (and no version) until the handshake lands;
/// with it, the last-known catalog is on screen from the drop and the live
/// handshake replaces it wholesale seconds later.
///
/// Keyed by the **tug** session id — capabilities are a spawn-scoped fact
/// (what tugcode + claude reported for this session's spawn), unlike
/// `session_metadata`, which is keyed by claude's id (its JSONL identity).
/// One row per session — UPSERT semantics; JSON BLOB for the same reasons
/// as `session_metadata` (pure PK lookup, shape validated at the wire
/// boundary).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionCapabilitiesRow {
    pub session_id: String,
    pub payload: Vec<u8>,
    pub captured_at: i64,
}

/// One row of the `context_breakdown_latest` table — the most-recent
/// `/context`-style per-category token breakdown for a session,
/// persisted verbatim as the JSON wire frame tugcode emits. Written
/// by `record_context_breakdown` from the supervisor's inbound
/// handler when tugdeck dispatches the persist action; read at session
/// bind so the snapshot's `lastContextBreakdown` populates before the
/// popover opens.
///
/// One row per session — UPSERT semantics by `session_id`. The "latest"
/// shape (vs. an append-only history table) matches the popover's
/// access pattern: it only ever wants the current breakdown. A future
/// "context-growth over time" surface can add a separate
/// `context_breakdown_history` table without migrating this one.
///
/// Payload is stored as a JSON BLOB rather than per-column for the
/// same reason `session_metadata` is: the access pattern is pure PK
/// lookup, the consumer (popover renderer) reads a fixed-shape struct
/// from the parsed JSON, and the wire-frame TypeScript types already
/// validate the shape on both write and read. Per-column storage
/// would duplicate that validation without buying us indexed-field
/// queries we don't need. Promoting a new category in the future
/// becomes a TypeScript-only change. Trade-off: no `WHERE
/// messages_tokens > X` queries, but the only access pattern is `WHERE
/// session_id = ?`.
///
/// MCP is intentionally absent from the persisted payload — Tug
/// treats MCP as out of scope; the wire frame the renderer paints
/// carries no `mcp_tools` category. See the spike companion document
/// for the architectural decision.
///
/// `captured_at` is the wall-clock millisecond timestamp when the row
/// was last written (for debugging / staleness audits). Distinct from
/// any time-related field the payload itself may carry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextBreakdownRow {
    pub session_id: String,
    pub payload: Vec<u8>,
    pub captured_at: i64,
}

/// One row of the `session_state_changes` table — a single transition
/// of the indicator-tone triple `(phase, transport_state,
/// interrupt_in_flight)` for a given session. Persisted by
/// `record_session_state_change` from the supervisor's inbound handler
/// when tugdeck's dispatch-wrapper observes the triple change; read
/// by the popover (Step 20.4.9) via `list_session_state_changes`.
///
/// The persisted axes are exactly the props
/// [`TugStateIndicator`](#step-20-4-2) reads — see the parent step's
/// "Coverage and known collapses" note for the signals the indicator
/// tracks but this ledger intentionally does NOT capture
/// (transcript-length, `pendingApproval` vs `pendingQuestion`,
/// `queuedSends`, `turnEndReason`, DRILLDOWN_OPEN).
///
/// Append-only per session; retention is unbounded. Rows are deleted
/// when the parent session row is deleted, via the cascade trigger.
///
/// `at_ms` is the wall-clock millisecond when the new triple landed
/// on the snapshot; `id` is the sqlite-assigned autoincrement primary
/// key (preserves insertion order regardless of clock skew on `at_ms`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionStateChangeRow {
    pub id: i64,
    pub session_id: String,
    pub at_ms: i64,
    pub phase: String,
    pub transport_state: String,
    pub interrupt_in_flight: bool,
}

/// One row of the `pulse_lines` table — a single commentator line from
/// the app-scoped PULSE daemon. The table is a capped rolling log
/// (`record_pulse_line` prunes past the cap): the deck reads the tail
/// via the `list_pulse_lines` CONTROL verb on mount, and the daemon
/// re-seeds its inner session from the same tail after restarts.
///
/// App-scoped by design — no session-id column and no cascade: a line
/// may cover several scopes (carried in `scopes` as a JSON array of
/// scope ids) and outlives any one session row.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PulseLineRow {
    pub id: i64,
    pub at_ms: i64,
    pub beat: i64,
    pub text: String,
    /// The retained high-level thought behind a low-level `text` beat
    /// ("intent • action" in the strip); absent when `text` is itself
    /// the monologue or a turn marker. Omitted from serialization when
    /// `None` so pre-intent rows round-trip unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent: Option<String>,
    pub scopes: Vec<String>,
}

/// The canonical turn-rule version stamped on every freshly-written
/// `external_scan_cache` row. Bump this whenever the scanner's turn rule
/// changes: existing rows (stamped a lower epoch, or the `DEFAULT 0` of a
/// pre-column ALTER) then fail the `rule_epoch == CURRENT_RULE_EPOCH` gate
/// at every cache read and are re-scanned faithfully. Epoch `2` is the
/// first in which the count is produced by the segmentation engine
/// (`turn_engine.rs`) — origin-tagged turns including assistant-originated
/// openers (wakes, `/compact` continuations, `--continue` leading orphans,
/// orphan assistant output) the prior user-record-only rule could not see.
/// The bump re-`set_turn_count`s every existing ledger row from
/// `engine(file)` on the next scan (`tuglaws/turn-metric.md` S03).
///
/// Epoch `3` is the first in which the count is taken over the **effective
/// record sequence** — abandoned branches and compaction re-appends
/// excluded, matching what the transcript renders. It also introduces
/// `frontier_leaf_uuid`, which epoch-2 rows lack; failing the gate is what
/// makes those rows re-stream once and record a real leaf.
///
/// Epoch `4` introduces `effective_uuids` — the effective chain uuid set at
/// the frontier — which is what lets a session that has compacted resume
/// incrementally instead of re-streaming in full on every change (a
/// straddled re-append tail is detectable against the set). Epoch-3 rows
/// carry no set, so they fail the gate and re-stream once to record one.
pub(crate) const CURRENT_RULE_EPOCH: i64 = 4;

/// One row of the `external_scan_cache` table — the persisted result
/// of scanning one on-disk session JSONL, keyed by session id and
/// validated by `(file_size, file_mtime)`. `excluded` remembers a
/// deliberate scanner rejection so the file isn't re-streamed on every
/// scan. See the schema comment in `bootstrap_schema` for why this
/// table carries no cascade trigger.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanCacheRow {
    pub session_id: String,
    pub project_dir: String,
    pub file_size: i64,
    pub file_mtime: i64,
    pub excluded: bool,
    pub turn_count: i64,
    pub last_user_prompt: Option<String>,
    pub name: Option<String>,
    pub created_at: i64,
    pub last_used_at: i64,
    /// Byte offset of the resumable parse frontier: the tallies above
    /// cover exactly the complete lines in `[0, parse_offset)`. `0`
    /// means "no resumable state" — the next change re-streams the
    /// whole file. Claude session JSONLs are append-only in steady
    /// state, so a grown file usually re-parses only its tail.
    pub parse_offset: i64,
    /// FNV-1a 64 (bit-cast to i64) over the last
    /// `TAIL_FINGERPRINT_BYTES` of the resumable prefix. A mismatch on
    /// resume means the prefix was rewritten (rewind/compaction) and
    /// the parse falls back to a full re-stream.
    pub tail_hash: i64,
    /// Whether the prefix contained a `cwd`-bearing record (the
    /// project-dir collision check already ran).
    pub cwd_checked: bool,
    /// Whether `created_at` came from a record timestamp (vs the
    /// file-mtime fallback) — a resumed parse keeps looking when false.
    pub created_at_found: bool,
    /// Segmentation-engine frontier (`turn_engine::Frontier`) at the
    /// resumable parse offset: whether a turn is open at the frontier.
    /// Carried so an incremental tail-resume continues the engine's
    /// open-turn state rather than re-deriving it (and undercounting).
    pub frontier_open: bool,
    /// Whether the open turn at the frontier has a deferred terminal close
    /// (`Frontier::pending_close`).
    pub frontier_pending_close: bool,
    /// The `message.id` that armed the deferred close
    /// (`Frontier::pending_close_msg_id`), or `None`.
    pub frontier_pending_close_msg_id: Option<String>,
    /// The chain leaf uuid at the frontier (`Frontier::leaf_uuid`).
    /// Carried so a tail-resume can tell an ordinary append from a rewind
    /// branch, which it must re-stream in full rather than segment
    /// incrementally.
    pub frontier_leaf_uuid: Option<String>,
    /// The effective chain uuid set at the frontier, encoded as
    /// concatenated 16-byte binary uuids. A tail-resume suppresses any
    /// appended record whose uuid is in this set — the shape a compaction
    /// re-append block leaves when it straddles a scan boundary. `None`
    /// means no resumable set (the next change re-streams in full).
    pub effective_uuids: Option<Vec<u8>>,
    /// Comma-joined foreign session ids this file's records carry — the
    /// pre-rotation lineage embedded in a resumed session's file. The scan
    /// uses these to suppress superseded ancestor files from the listing.
    pub lineage_ancestors: Option<String>,
    /// The line this scanned session belongs to ([P07]), or `None` before the
    /// scan has reached it once. An external session has no `sessions` row
    /// until it is adopted on first resume, so the line is where its callsign
    /// lives in the meantime. **Not** part of the parse —
    /// `upsert_scan_cache` carries it across rather than writing it, so a
    /// re-parse of a grown file cannot orphan the row from its line.
    pub line_id: Option<String>,
}

/// One row of the `lines` table — a **line of work** and everything that
/// identifies it ([P01]).
///
/// A line owns the callsign and the user's name. A `sessions` row is one
/// segment of a line and carries neither, so there is nothing on a segment to
/// inherit, strand, or displace when an id changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineRow {
    pub line_id: String,
    /// The mnemonic `adjective-noun` callsign, unique per ledger and made
    /// permanent by `minted_tags`.
    pub tag: String,
    /// The user's `/rename`, or the auto `aiTitle` scraped from a segment's
    /// JSONL. `name_user_set` tells them apart.
    pub name: Option<String>,
    pub name_user_set: bool,
    /// The card this line is seated on, or `None` for a line the external
    /// scan discovered and nothing has resumed ([P07]).
    pub card_id: Option<String>,
    pub project_dir: String,
    pub created_at: i64,
    pub last_used_at: i64,
}

/// A line a `/rename` took a user-set name away from ([P11]). The newest
/// naming gesture wins, so the previous holder falls back to its callsign and
/// the rename's ack reports who was displaced — the loss is announced, never
/// silent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplacedName {
    pub line_id: String,
    /// The displaced line's callsign, which is what its chip falls back to.
    pub tag: String,
}

/// One line's ownership shape ([P01]) — the answer to "who is this body of
/// work, across every id it has worn". `seat_id` is the segment that
/// answers for the line now (the same segment [`SessionLedger::
/// resume_segment_for_line`] would seat a card on); `segment_ids` is every
/// segment, resume-ordered; `any_live` is whether any of them has a live
/// relay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineOwnership {
    pub seat_id: String,
    pub segment_ids: Vec<String>,
    pub any_live: bool,
}

/// The scan-derived pair a `session_updated` push carries — the on-disk size
/// and the segmentation engine's turn count for one session. Read by
/// [`SessionLedger::scan_metrics_for`]; see its doc for why a push needs both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionScanMetrics {
    pub file_size: i64,
    pub turn_count: i64,
}

/// One row of the `file_events` table — an authoritative record that a
/// session changed a file, written at the moment of change from the
/// agent-bridge relay loop. A session's file knowledge is concentrated
/// here (a sqlite row per tool call that touched a file) rather than
/// reconstructed after the fact from conversation context — exact for
/// `Write`/`Edit`/`MultiEdit`/`NotebookEdit` (straight from the tool
/// input), bracketed for `Bash` (working-tree fingerprint delta).
///
/// Keyed by `(tug_session_id, tool_use_id, file_path)`: the tug session
/// id is the card-bound identity that survives resumes (claude ids
/// rotate underneath it), so attribution keyed here gets resume-lineage
/// for free. That primary key is also the idempotency contract — replay
/// re-emits the full persisted history and `subagent-tail` re-streams
/// background-agent children from offset 0, so any frame may be seen more
/// than once; the upsert (`ON CONFLICT DO NOTHING`) makes processing the
/// same frame twice a no-op.
///
/// `at` is the wall-clock millisecond time of the event: frame-arrival
/// time on the live path, the tool's own `timestamp` on the replay path
/// so backfilled rows keep historical time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileEventRow {
    /// The tug session id that owns the change (the `sessions.session_id`
    /// for a Tug-created session — tugcast passes it to claude as
    /// `--session-id`, so the two coincide).
    pub tug_session_id: String,
    /// The tool call's `tool_use_id`. A Bash call touching N files yields
    /// N rows that share this id.
    pub tool_use_id: String,
    /// The changed path, repo-relative within `project_dir`'s repo (projected
    /// in canonical space at record time). Legacy rows written before that
    /// change hold a canonical-or-raw absolute path; the changeset reconciler
    /// bridges both forms. A non-repo project dir stores the canonical absolute
    /// path (nothing to strip against).
    pub file_path: String,
    /// `Write` | `Edit` | `MultiEdit` | `NotebookEdit` | `Bash`.
    pub tool_name: String,
    /// `write` | `edit` | `notebook` | `created` | `modified` | `deleted`
    /// | `renamed` — the exact tools record their verb; Bash rows derive
    /// it from the working-tree status transition.
    pub op: String,
    /// `exact` (tool input) | `bash` (bracket delta) | `turn` (turn-scoped
    /// fallback delta) | `replay` (exact tool, backfilled on resume).
    pub origin: String,
    /// Legacy column, always written `false` and read by nothing. Capture
    /// records provenance only; the cross-session signal is per-file
    /// contention, computed at read time from ledger rows ([D112]).
    pub ambiguous: bool,
    /// Set for subagent-issued calls (the `parent_tool_use_id` from the
    /// stream); `None` for top-level calls.
    pub parent_tool_use_id: Option<String>,
    /// The checkout root at event time (worktree-aware): a worktree
    /// session records its worktree root, not the base checkout.
    pub project_dir: String,
    /// Epoch milliseconds — frame time on the live path,
    /// `ToolUse.timestamp` on replay.
    pub at: i64,
}

/// A `file_events` row joined with its owning `sessions` row's display
/// fields — the shape the workspace changeset composition reads (owner
/// display name = session `name` when `name_user_set`, else the callsign
/// `tag`, else the id hash). `owner_name` / `owner_name_user_set` /
/// `owner_tag` are `None`/`false` when no `sessions` row matches the
/// event's `tug_session_id` (a headless or evicted session). `owner_live`
/// reflects the session row's `state` — the changeset card's live dot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectFileEvent {
    pub event: FileEventRow,
    pub owner_name: Option<String>,
    pub owner_name_user_set: bool,
    /// The owning session's callsign, or `None` for a legacy tagless row.
    pub owner_tag: Option<String>,
    pub owner_live: bool,
    /// The line of work the owning session belongs to ([P01]): the row's
    /// own write-time stamp first, the sessions join as the legacy
    /// fallback. `None` for a row no line ever claimed — the compose keys
    /// such an owner by its raw session id.
    pub line_id: Option<String>,
}

/// One legacy-row rewrite for [`SessionLedger::backfill_file_events_repo_relative`]:
/// the row identified by `(tug_session_id, tool_use_id, old_file_path)` becomes
/// `new_file_path` (repo-relative) under the canonical project dir.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileEventRewrite {
    pub tug_session_id: String,
    pub tool_use_id: String,
    pub old_file_path: String,
    pub new_file_path: String,
}

/// One piece of sub-file evidence for a `file_events` row — what a tool call
/// wrote *inside* the file, so a path two sessions both touched can be read
/// as two disjoint regions instead of one contested file ([P10]).
///
/// A span is a child of its `file_events` row: it shares that row's
/// `(tug_session_id, tool_use_id, file_path)` key and adds `seq`, the
/// per-row ordinal. Every applier that moves or removes the parent carries
/// the children with it.
///
/// `anchor` is content, never a line number ([P11]) — line numbers die the
/// moment any other edit lands above them, while content still matches
/// against the current diff at read time. It holds JSON whose shape follows
/// `kind`: `{"new_hash","new_head","new_len","old_hash"?}` for `insert` and
/// `replace`, `{"hunk_id"}` for `hunk`, and `{}` for `whole` (a whole-file
/// assertion carries no region).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileEventSpan {
    /// Ordinal within the parent row, from 0.
    pub seq: i64,
    /// `whole` | `insert` | `replace` | `hunk`.
    pub kind: String,
    /// The content anchor as JSON — see the struct doc for the shapes.
    pub anchor: String,
}

/// One [`FileEventSpan`] with the parent key that owns it — the shape the
/// contention read side works in, where a span means nothing without knowing
/// whose it is and which file it is about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileEventSpanRow {
    pub tug_session_id: String,
    pub tool_use_id: String,
    pub file_path: String,
    /// The parent row's `at`, so the reader can apply the same row-liveness
    /// cut the file-level buckets use — a spent span must not feed a verdict.
    pub at: i64,
    pub span: FileEventSpan,
}

/// One `file_events` row named by its primary key, for a keyed delete.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileEventKey {
    pub tug_session_id: String,
    pub tool_use_id: String,
    pub file_path: String,
}

/// One maintained changeset draft (Spec S09) — the continuously-current,
/// convention-correct commit message the draft engine keeps for a changeset
/// entry. Keyed by `(owner_kind, owner_id, project_dir)`; the `fingerprint`
/// (a hash of the entry's scoped content) gates regeneration, and `message`
/// is the draft that rides the aggregate snapshot to the card. Advisory and
/// regenerable — never cascade-deleted, superseded in place.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangesetDraftRow {
    /// `session` | `dash` | `unattributed`.
    pub owner_kind: String,
    /// `tug_session_id` | `tugdash/<name>` | `""` (unattributed).
    pub owner_id: String,
    /// The checkout root the entry belongs to.
    pub project_dir: String,
    /// Hash of the entry's scoped content (Spec S11); an unchanged
    /// fingerprint means the draft is still current and no scribe runs.
    pub fingerprint: String,
    /// The maintained commit message (subject + terse bullets); its body
    /// doubles as the summary.
    pub message: String,
    /// Epoch milliseconds of the last regeneration.
    pub updated_at: i64,
    /// True once a human has touched the message — an edited draft is
    /// never machine-clobbered; only an explicit forced regenerate resets
    /// it.
    pub edited: bool,
    /// The persisted selection, stored and served verbatim: a free-form
    /// JSON object the client alone interprets (path-level
    /// `include`/`exclude` overrides against the default rule, per-file
    /// hunk elections, whatever it grows next), or `None` when the
    /// defaults stand.
    pub selection: Option<String>,
}

/// Result of a successful `trash` call.
///
/// `jsonl_moved_to` is `None` when the JSONL file is missing or the
/// trash directory cannot be created; in that case the ledger row is
/// still deleted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrashOutcome {
    pub session_id: String,
    pub jsonl_moved_to: Option<PathBuf>,
}

/// SQLite-backed per-session metadata store.
pub struct SessionLedger {
    db: Mutex<Connection>,
    /// Root directory where claude code stores per-project session JSONLs:
    /// `<root>/<encoded-project-dir>/<sessionId>.jsonl`. Production defaults
    /// to `~/.claude/projects/`; tests inject a tempdir so trash mechanics
    /// don't touch the real filesystem.
    claude_projects_root: PathBuf,
    /// "Sessions changed" signal — the ledger is the source of truth for
    /// sessions, so it publishes a change from its own lifecycle writes and any
    /// delegate (the account-global changeset aggregate) subscribes. Set once at
    /// startup via [`set_change_signal`], after the process-global signal
    /// exists; `None` in tests that don't observe the aggregate. Fired
    /// generically (the ledger names no consumer) at the end of every
    /// session-row mutation — see [`notify_sessions_changed`].
    sessions_changed: OnceLock<Arc<Notify>>,
    /// Verdict of the shared-schema `user_version` gate at open: false
    /// when the on-disk `changes.db` schema is newer than this build, in
    /// which case row INSERT/UPDATEs to the shared tables are refused
    /// (see [`guard_changes_write`]). Row DELETEs stay allowed.
    changes_write_ok: bool,
    /// Append-only durable record of every shared-table mutation — the
    /// disaster-recovery record ([`crate::changes_journal`]).
    /// Owner-only: `None` for in-memory ledgers, while forwarding
    /// (opening the journal rotates it, which is the owner's act alone),
    /// or when the file cannot open. Opened at construction for an
    /// owner, and lazily by [`ensure_changes_journal`] the moment a
    /// forwarder takes the claim over. Leaf lock: taken after `db`,
    /// never the other way.
    changes_journal: Mutex<Option<crate::changes_journal::ChangesJournal>>,
    /// How this instance writes the shared ledger: holding the
    /// machine-wide writer claim, forwarding to whoever holds it, or
    /// unclaimed (a private/in-memory changes database). See
    /// [`crate::changes_writer`].
    ///
    /// LOCK ORDER: `changes_access` is acquired strictly **before** `db`,
    /// never while `db` is held. [`write_change`] and
    /// [`take_over_changes_writer`] take `changes_access` → `db`; every
    /// path that already holds `db` (an eviction transaction, a
    /// checkpoint) must sample forwarding state *before* locking `db` and
    /// must release `db` before calling anything that routes through
    /// `changes_access` ([`settle_session_deletes`], [`write_change`]).
    changes_access: Mutex<crate::changes_writer::ChangesAccess>,
    /// Path of the attached changes database — `None` for in-memory.
    /// Needed to re-claim and re-attach read-write on takeover.
    changes_db_path: Option<PathBuf>,
    /// Identity published in the claim so non-owners can reach this
    /// instance's `/api/changes-write`.
    writer_identity: tugcore::ledger_db::WriterOwner,
}

impl SessionLedger {
    /// Open or create the ledger at `path`, attached to the
    /// **machine-global** changes ledger
    /// (`tugcore::instance::changes_db_path()`, `TUG_CHANGES_DB`
    /// overridable). Applies pragmas and runs the idempotent schema
    /// bootstrap. Safe to call against an existing file. Uses the default
    /// claude projects root (`~/.claude/projects/`). The production
    /// constructor.
    /// `http_port` is the loopback port this tugcast bound; it is
    /// published in the writer claim so a non-owning instance can forward
    /// its changes mutations here.
    pub fn open(path: impl AsRef<Path>, http_port: u16) -> Result<Self, LedgerError> {
        Self::open_full(
            path,
            Some(tugcore::instance::changes_db_path()),
            default_claude_projects_root(),
            http_port,
        )
    }

    /// Open the ledger with an explicit `claude_projects_root`, attached to
    /// a `<path>.changes` sibling file (never the machine-global one) —
    /// per-file isolation with reopen persistence.
    ///
    /// This is the on-disk test constructor, and it is also what `tugcast
    /// operator-ask` opens a ledger copy with: an instrument pointed at a copy
    /// must not reach past it and claim the writer role on the machine-global
    /// `changes.db` that a running instance holds. The server itself opens
    /// with [`SessionLedger::open`].
    pub fn open_with_claude_root(
        path: impl AsRef<Path>,
        claude_projects_root: PathBuf,
    ) -> Result<Self, LedgerError> {
        let mut sibling = path.as_ref().as_os_str().to_owned();
        sibling.push(".changes");
        Self::open_full(path, Some(PathBuf::from(sibling)), claude_projects_root, 0)
    }

    /// Core constructor: open `path`, attach the changes ledger at
    /// `changes_db` (`None` attaches an in-memory changes database — used
    /// by in-memory test ledgers), configure pragmas, bootstrap both
    /// schemas, and migrate any legacy per-instance `file_events` rows into
    /// the attached changes ledger.
    fn open_full(
        path: impl AsRef<Path>,
        changes_db: Option<PathBuf>,
        claude_projects_root: PathBuf,
        http_port: u16,
    ) -> Result<Self, LedgerError> {
        // Claim the machine-wide writer role before anything touches the
        // shared file. Only the owner may quarantine, bootstrap, salvage,
        // or write it; a non-owner attaches read-only and forwards.
        let writer_identity = crate::changes_writer::local_identity(http_port);
        let changes_access = match changes_db.as_deref() {
            None => crate::changes_writer::ChangesAccess::Unclaimed,
            Some(p) => match tugcore::ledger_db::claim_writer(p, &writer_identity) {
                Some(lock) => crate::changes_writer::ChangesAccess::Owner(lock),
                None => {
                    let owner = tugcore::ledger_db::read_writer_owner(p);
                    tracing::info!(
                        changes_db = %p.display(),
                        owner_pid = owner.as_ref().map(|o| o.pid).unwrap_or(0),
                        owner_instance = owner.as_ref().map(|o| o.instance_id.as_str()).unwrap_or("?"),
                        "another instance owns the changes ledger; attaching read-only \
                         and forwarding writes"
                    );
                    crate::changes_writer::ChangesAccess::Forward(
                        crate::changes_writer::ChangesForwarder::new(p.to_path_buf()),
                    )
                }
            },
        };
        let forwarding = changes_access.is_forwarding();
        // Integrity gate before the real open: a database that fails
        // quick_check is quarantined (renamed aside with its WAL/shm) so
        // no writer ever compounds damage in a corrupt tree; readable
        // rows are salvaged back in after the fresh schema bootstrap.
        // Only the owner gates the shared database — renaming a file the
        // owning process has open is its own kind of damage.
        let sessions_gate = ledger_integrity::integrity_gate(path.as_ref(), "sessions");
        // The downgrade guard: a corrupt database's `user_version` is
        // unreadable, so without the sidecar an *older* build would
        // quarantine a newer-schema changes.db and rebuild it at the OLD
        // schema — the machine-global reshaping [D112]/[LR5] forbid. Only
        // a build that knows the newer schema may rebuild it; this one
        // runs degraded instead.
        let changes_deferred = !forwarding
            && changes_db.as_deref().is_some_and(|p| {
                read_changes_schema_sidecar(p).is_some_and(|v| v > CHANGES_SCHEMA_VERSION)
            });
        if changes_deferred {
            tracing::warn!(
                supported = CHANGES_SCHEMA_VERSION,
                "on-disk changes.db schema is newer than this build; \
                 integrity gate and any rebuild are deferred to a newer build"
            );
        }
        let changes_gate = changes_db.as_deref().filter(|_| !forwarding).map(|p| {
            if changes_deferred {
                ledger_integrity::GateOutcome::Healthy
            } else {
                ledger_integrity::integrity_gate(p, "changes")
            }
        });
        let conn = tugcore::ledger_db::open(path)?;
        match Self::attach_changes(&conn, changes_db.as_deref(), forwarding) {
            Ok(()) => {}
            Err(err) if changes_deferred => {
                // The deferred database cannot even be attached (corrupt
                // header). An empty in-memory stand-in keeps this
                // instance alive and honest: reads answer empty behind a
                // latched degraded flag, and writes are refused below.
                tracing::error!(error = %err, "cannot attach the newer-schema changes.db; running degraded on an in-memory stand-in");
                ledger_integrity::health::note_error("changes", &err);
                Self::attach_changes(&conn, None, false)?;
            }
            Err(err) => return Err(err),
        }
        let changes_write_ok = Self::configure(&conn, !forwarding)? && !changes_deferred;
        // The owner that just bootstrapped (or verified) the shared schema
        // records its version in the sidecar the downgrade guard reads.
        if changes_write_ok && !forwarding {
            if let Some(p) = changes_db.as_deref() {
                stamp_changes_schema_sidecar(p);
            }
        }
        if let ledger_integrity::GateOutcome::Quarantined { corrupt_path } = &sessions_gate {
            ledger_integrity::salvage_into(
                &conn,
                "main",
                corrupt_path,
                &["sessions", "session_metadata", "session_capabilities"],
                "sessions",
            );
        }
        let changes_quarantined = matches!(
            &changes_gate,
            Some(ledger_integrity::GateOutcome::Quarantined { .. })
        );
        if let Some(ledger_integrity::GateOutcome::Quarantined { corrupt_path }) = &changes_gate {
            ledger_integrity::salvage_into(
                &conn,
                "changes",
                corrupt_path,
                &["file_events", "file_event_spans", "changeset_drafts"],
                "changes",
            );
        }
        let ledger = Self {
            db: Mutex::new(conn),
            claude_projects_root,
            sessions_changed: OnceLock::new(),
            changes_write_ok,
            changes_journal: Mutex::new(None),
            changes_access: Mutex::new(changes_access),
            changes_db_path: changes_db.clone(),
            writer_identity,
        };
        // Journal replay completes a post-quarantine rebuild: salvage
        // recovered what was readable; the journal re-applies everything
        // else (idempotently), including deletes salvage resurrected.
        if changes_quarantined {
            if let Some(changes_path) = changes_db.as_deref() {
                ledger.replay_changes_journal(&crate::changes_journal::journal_path_for(
                    changes_path,
                ));
            }
        }
        // The journal opens only now — after the replay, because opening
        // rotates an oversized journal and rotating first would empty the
        // very rebuild that needs it — and only as the owner: a forwarder
        // opening it would rotate the live owner's file out from under
        // its append fd. A takeover opens it via `ensure_changes_journal`.
        if !forwarding {
            ledger.ensure_changes_journal();
        }
        Ok(ledger)
    }

    /// Open an in-memory ledger (with an in-memory changes attach).
    /// Test-only convenience; never used by production callers. Uses a
    /// placeholder claude root that no test should write through (tests
    /// using trash should use `open_with_claude_root` against a tempdir).
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, LedgerError> {
        let conn = Connection::open_in_memory()?;
        Self::attach_changes(&conn, None, false)?;
        let changes_write_ok = Self::configure(&conn, true)?;
        Ok(Self {
            db: Mutex::new(conn),
            claude_projects_root: PathBuf::from("/tmp/tugcast-tests-no-trash"),
            sessions_changed: OnceLock::new(),
            changes_write_ok,
            changes_journal: Mutex::new(None),
            changes_access: Mutex::new(crate::changes_writer::ChangesAccess::Unclaimed),
            changes_db_path: None,
            writer_identity: crate::changes_writer::local_identity(0),
        })
    }

    /// An in-memory ledger whose Claude projects root is a directory the test
    /// owns — what a test asserting on transcript paths needs, since the
    /// default root deliberately points nowhere writable.
    #[cfg(test)]
    pub fn open_in_memory_with_root(root: &Path) -> Result<Self, LedgerError> {
        let mut ledger = Self::open_in_memory()?;
        ledger.claude_projects_root = root.to_path_buf();
        Ok(ledger)
    }

    /// Replay a changes journal into the (freshly rebuilt) database. All
    /// records are idempotent; a replay over rows salvage already restored
    /// is a no-op, and deletes salvage resurrected are re-applied.
    fn replay_changes_journal(&self, journal_path: &Path) {
        let records = crate::changes_journal::ChangesJournal::read_records(journal_path);
        if records.is_empty() {
            return;
        }
        let conn = self.db.lock().expect("ledger mutex");
        let mut applied = 0usize;
        let mut failed = 0usize;
        for record in &records {
            match Self::apply_journal_record(&conn, record) {
                Ok(_) => applied += 1,
                Err(err) => {
                    failed += 1;
                    tracing::warn!(error = %err, "journal record failed to re-apply");
                }
            }
        }
        tracing::error!(
            journal = %journal_path.display(),
            applied,
            failed,
            "changes journal replayed after quarantine rebuild"
        );
    }

    /// Apply one changes-ledger mutation to SQLite without journaling it.
    /// The single applier shared by the live write path, the forwarded
    /// write endpoint, and journal replay — one record shape, one set of
    /// statements, so the wire, durable, and recovery formats cannot drift
    /// apart. Returns the number of rows the record touched.
    fn apply_journal_record(
        conn: &Connection,
        record: &crate::changes_journal::Record,
    ) -> Result<usize, LedgerError> {
        use crate::changes_journal::Record;
        // One transaction for the whole record: a parent row and its spans —
        // and a delete of one with the other — land or vanish together. A
        // crash between the two autocommit halves would strand evidence the
        // widening rule then has to absorb; the transaction removes the
        // window instead.
        let tx = conn.unchecked_transaction()?;
        let conn: &Connection = &tx;
        let touched = match record {
            Record::FileEvent { row, spans } => {
                Self::insert_file_event(conn, row)?
                    + Self::insert_file_event_spans(conn, row, spans)?
            }
            Record::FileEventBatch { rows, spans } => {
                let mut inserted = 0usize;
                for (i, row) in rows.iter().enumerate() {
                    inserted += Self::insert_file_event(conn, row)?;
                    if let Some(row_spans) = spans.get(i) {
                        inserted += Self::insert_file_event_spans(conn, row, row_spans)?;
                    }
                }
                inserted
            }
            Record::DeleteSession { session } => {
                conn.execute(
                    "DELETE FROM changes.file_event_spans WHERE tug_session_id = ?1",
                    params![session],
                )?;
                conn.execute(
                    "DELETE FROM changes.file_events WHERE tug_session_id = ?1",
                    params![session],
                )?
            }
            Record::Sever {
                project_dir,
                paths,
                keep_session,
                keep_sessions,
            } => {
                let mut keep = Vec::with_capacity(1 + keep_sessions.len());
                keep.push(keep_session.clone());
                keep.extend(keep_sessions.iter().cloned());
                Self::sever_file_ownership_sql(conn, project_dir, paths, &keep)?
            }
            Record::Disclaim {
                project_dir,
                paths,
                session,
                sessions,
            } => {
                let mut renouncing = Vec::with_capacity(1 + sessions.len());
                renouncing.push(session.clone());
                renouncing.extend(sessions.iter().cloned());
                Self::disclaim_file_ownership_sql(conn, project_dir, paths, &renouncing)?
            }
            Record::PurgeOutOfRepo { keys, .. } => Self::purge_file_events_sql(conn, keys)?,
            Record::Rewrite {
                canonical_project_dir,
                rewrite,
            } => usize::from(Self::apply_file_event_rewrite(
                conn,
                canonical_project_dir,
                rewrite,
            )?),
            Record::Draft { row } => {
                Self::upsert_changeset_draft_sql(conn, row)?;
                1
            }
            Record::DraftDelete {
                owner_kind,
                owner_id,
                project_dir,
            } => conn.execute(
                "DELETE FROM changes.changeset_drafts
                     WHERE owner_kind = ?1 AND owner_id = ?2 AND project_dir = ?3",
                params![owner_kind, owner_id, project_dir],
            )?,
        };
        tx.commit()?;
        Ok(touched)
    }

    /// Attach the shared changes ledger as schema `changes` ([D112]: one
    /// machine-global `changes.db` regardless of app instance — the working
    /// tree is machine-global, so per-instance attribution splits the
    /// truth). `None` attaches an in-memory database. WAL + NORMAL sync on
    /// the attached db so concurrent instances (multiple tugcast processes)
    /// write safely; `busy_timeout` is per-connection and already applies.
    /// `read_only` attaches without write access — the non-owner half of
    /// the single-writer claim, so a mutation that escapes the forwarding
    /// route fails loudly instead of becoming a second writer.
    fn attach_changes(
        conn: &Connection,
        changes_db: Option<&Path>,
        read_only: bool,
    ) -> Result<(), LedgerError> {
        match changes_db {
            Some(path) if read_only => {
                // A follower can lose the claim race before the owner has
                // even created the database (two instances first-launched
                // together on a clean machine). A read-only attach cannot
                // create the file, so give the owner a moment to.
                for _ in 0..20 {
                    if path.exists() {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                tugcore::ledger_db::attach_read_only(conn, "changes", path)?;
            }
            Some(path) => {
                tugcore::ledger_db::attach(conn, "changes", path)?;
            }
            None => {
                conn.execute("ATTACH DATABASE ':memory:' AS changes", [])?;
            }
        }
        Ok(())
    }

    /// Default on-disk location for the ledger:
    ///
    /// - macOS: `~/Library/Application Support/Tug/sessions.db`
    /// - Linux: `$XDG_DATA_HOME/tugcast/sessions.db` (falling back to
    ///   `~/.local/share/tugcast/sessions.db`)
    ///
    /// Returns `None` only if no home directory can be resolved, which
    /// indicates a misconfigured environment; callers should treat that as
    /// a fatal startup error.
    pub fn default_path() -> Option<PathBuf> {
        tugcore::instance::resolve_sessions_db_path()
    }

    /// Configured claude projects root. Exposed so the supervisor's batch
    /// trash sweep can iterate `<root>/*/.tug-trash/` without re-resolving.
    pub fn claude_projects_root(&self) -> &Path {
        &self.claude_projects_root
    }

    /// The newest assistant `message.id` in `session_id`'s JSONL, or `None`.
    ///
    /// This is the **ink anchor**: the transcript turn a durable row written
    /// right now follows. Ink write gateways stamp it on the ledger row so a
    /// later restore seats that row by a written fact rather than re-deriving
    /// its position from clocks, which is what put landing receipts thousands
    /// of pixels above the transcript's end after a relaunch.
    ///
    /// The value is exactly what replay assigns as a turn's `msgId`, so the
    /// deck resolves an anchor by comparing against state the transcript
    /// already carries.
    ///
    /// Never errors. A missing session row, a missing or empty file, a line
    /// that does not parse, a tail holding no assistant line — every surprise
    /// is a `None`, which writes a NULL anchor and leaves the row restoring by
    /// timestamp exactly as it did before anchors existed. Placement may
    /// degrade; a receipt is never blocked or lost.
    ///
    /// Call it with a **lineage head**: the anchor must name a turn in the
    /// file the deck will replay, which is the head's file, not a superseded
    /// fork's.
    ///
    /// `project_dir` is the directory the session runs in, and it is what
    /// locates the transcript. Every ink gateway already holds it, so every
    /// ink gateway passes it. `None` falls back to the session's ledger row,
    /// which is a strictly weaker source: the row is written when tugcode
    /// announces the session, seconds after a card can already accept a `$`
    /// command, so a row written in that window would find nothing and record
    /// a NULL anchor for a session whose transcript was on disk all along.
    pub fn latest_assistant_msg_id(
        &self,
        session_id: &str,
        project_dir: Option<&str>,
    ) -> Option<String> {
        let project_dir = match project_dir {
            Some(dir) if !dir.is_empty() => dir.to_string(),
            _ => match self.get(session_id) {
                Ok(Some(row)) => row.project_dir,
                Ok(None) => {
                    tracing::debug!(session_id, "ink anchor: no session row and no project dir");
                    return None;
                }
                Err(err) => {
                    tracing::debug!(session_id, error = %err, "ink anchor: session lookup failed");
                    return None;
                }
            },
        };
        let (dir, _canonical) = claude_project_dir(&self.claude_projects_root, &project_dir);
        let anchor = latest_assistant_msg_id_in(&dir.join(format!("{session_id}.jsonl")));
        if anchor.is_none() {
            tracing::debug!(
                session_id,
                "ink anchor: no assistant line in the transcript tail"
            );
        }
        anchor
    }

    /// Wire the "sessions changed" signal the ledger publishes on. Called once
    /// at startup (after the process-global recompute signal is created), so a
    /// delegate — the account-global changeset aggregate — recomputes whenever
    /// a session row is written. Idempotent; a second call is ignored.
    pub fn set_change_signal(&self, signal: Arc<Notify>) {
        let _ = self.sessions_changed.set(signal);
    }

    /// Publish "the session set changed." Called at the end of every
    /// session-row mutation below, so the changeset aggregate reflects the
    /// ledger event-drively — the source-side twin of the registry's
    /// project-lifecycle bump. A no-op until `set_change_signal` is wired.
    fn notify_sessions_changed(&self) {
        if let Some(signal) = self.sessions_changed.get() {
            signal.notify_one();
        }
    }

    /// Apply pragmas and bootstrap both schemas. Returns whether this
    /// build may write the shared changes tables (the `user_version` gate
    /// verdict from [`bootstrap_changes_schema`]).
    /// `may_write_changes` is false for a forwarding instance: the shared
    /// schema is the owner's to create, stamp, and migrate.
    fn configure(conn: &Connection, may_write_changes: bool) -> Result<bool, LedgerError> {
        // Unified pragma set from the chokepoint ([tugcore::ledger_db]);
        // idempotent when the connection came from `ledger_db::open`, and
        // the only pragma application for injected in-memory connections.
        tugcore::ledger_db::apply_pragmas(conn)?;
        Self::bootstrap_schema(conn, may_write_changes)
    }

    /// One database's WAL-checkpoint verdict from
    /// [`checkpoint_health`]: the `PRAGMA wal_checkpoint(PASSIVE)`
    /// triple. `log_frames` is the WAL length in frames; a WAL that keeps
    /// growing while `checkpointed_frames` stays behind means checkpoints
    /// are failing — the silent precursor signature of the 2026-07-27
    /// corruption incident (a 4 MB WAL, a main file three days stale, and
    /// nothing logged).
    /// Checkpointing the shared database is an owner-only duty: a
    /// forwarding instance has it attached read-only and would report a
    /// pragma failure on every tick.
    pub fn checkpoint_health(&self) -> Vec<CheckpointHealth> {
        let databases: &[&'static str] = if self.forwarding() {
            &["main"]
        } else {
            &["main", "changes"]
        };
        let conn = self.db.lock().expect("ledger mutex poisoned");
        databases
            .iter()
            .map(|db| {
                let result =
                    conn.query_row(&format!("PRAGMA {db}.wal_checkpoint(PASSIVE)"), [], |r| {
                        Ok((
                            r.get::<_, i64>(0)?,
                            r.get::<_, i64>(1)?,
                            r.get::<_, i64>(2)?,
                        ))
                    });
                match result {
                    Ok((busy, log_frames, checkpointed_frames)) => CheckpointHealth {
                        db,
                        busy: busy != 0,
                        log_frames,
                        checkpointed_frames,
                        error: None,
                    },
                    Err(e) => CheckpointHealth {
                        db,
                        busy: false,
                        log_frames: -1,
                        checkpointed_frames: -1,
                        error: Some(e.to_string()),
                    },
                }
            })
            .collect()
    }

    /// The `(name, declared-type)` columns the current `turn_telemetry`
    /// `CREATE TABLE` defines, in order. The self-healing guard in
    /// {@link bootstrap_schema} compares an on-disk table against this;
    /// a mismatch means the schema drifted and the table is rebuilt.
    const TURN_TELEMETRY_SCHEMA: &'static [(&'static str, &'static str)] = &[
        ("session_id", "TEXT"),
        ("msg_id", "TEXT"),
        ("input_tokens", "INTEGER"),
        ("output_tokens", "INTEGER"),
        ("cache_creation_input_tokens", "INTEGER"),
        ("cache_read_input_tokens", "INTEGER"),
        ("total_cost_usd", "REAL"),
        ("wall_clock_ms", "INTEGER"),
        ("awaiting_approval_ms", "INTEGER"),
        ("transport_downtime_ms", "INTEGER"),
        ("active_ms", "INTEGER"),
        ("ttft_ms", "INTEGER"),
        ("ttftc_ms", "INTEGER"),
        ("reconnect_count", "INTEGER"),
        ("max_stream_gap_ms", "INTEGER"),
        ("ended_at", "INTEGER"),
        ("session_init_tokens", "INTEGER"),
    ];

    /// The `(name, declared-type)` columns the current `file_events`
    /// `CREATE TABLE` defines, in order. `file_events` is an advisory,
    /// fully-rebuildable record (nothing else keys on it; a resumed
    /// session backfills its exact events), so a drifted on-disk shape
    /// is resolved by the same DROP-and-recreate guard as
    /// `turn_telemetry` rather than a migration.
    const FILE_EVENTS_SCHEMA: &'static [(&'static str, &'static str)] = &[
        ("tug_session_id", "TEXT"),
        ("tool_use_id", "TEXT"),
        ("file_path", "TEXT"),
        ("tool_name", "TEXT"),
        ("op", "TEXT"),
        ("origin", "TEXT"),
        ("ambiguous", "INTEGER"),
        ("parent_tool_use_id", "TEXT"),
        ("project_dir", "TEXT"),
        ("at", "INTEGER"),
    ];

    /// The column shape of the legacy per-instance `changeset_drafts` table
    /// (pre-machine-global storage, before `edited`/`selection`). Guards the
    /// legacy table so the one-shot copy into `changes.changeset_drafts`
    /// below never trips over a drifted shape; a drifted legacy table is
    /// simply dropped (drafts are regenerable).
    const LEGACY_CHANGESET_DRAFTS_SCHEMA: &'static [(&'static str, &'static str)] = &[
        ("owner_kind", "TEXT"),
        ("owner_id", "TEXT"),
        ("project_dir", "TEXT"),
        ("fingerprint", "TEXT"),
        ("message", "TEXT"),
        ("updated_at", "INTEGER"),
    ];

    fn bootstrap_schema(conn: &Connection, may_write_changes: bool) -> Result<bool, LedgerError> {
        // Self-healing schema guard. `CREATE TABLE IF NOT EXISTS` does
        // not alter a table that already exists, so when a typed
        // table's column set changes, an on-disk DB created before the
        // change keeps its stale shape — and every `INSERT` that lists
        // the new column set then fails. For `turn_telemetry` that
        // failure is *silent*: the supervisor treats a telemetry-write
        // error as non-fatal, so the symptom is total loss of per-turn
        // metrics across reloads with nothing logged at the surface.
        //
        // `turn_telemetry` is a rebuildable cache of per-turn metrics —
        // per [DM08] there is nothing in it worth preserving — so a
        // drifted schema is resolved by DROPPING the stale table here;
        // the `CREATE TABLE IF NOT EXISTS` below then rebuilds it (and
        // its index) fresh. This is NOT a migration: it preserves no
        // data. It is the [DM08] delete-and-recreate, made automatic so
        // a schema change cannot silently strand telemetry again. The
        // mechanism ({@link rebuild_table_if_schema_drifted}) is
        // general; it is wired only for `turn_telemetry` — the table
        // whose drift was observed — and a future change to another
        // typed table can opt in with one more call.
        Self::rebuild_table_if_schema_drifted(conn, "turn_telemetry", Self::TURN_TELEMETRY_SCHEMA)?;
        // Legacy per-instance file_events (pre-shared-ledger): guard its
        // shape before the migration below copies it into `changes`.
        // MUST be `main.`-qualified: an unqualified name here resolves
        // into the attached shared db when the legacy table is absent
        // (every post-migration ledger), letting this guard DROP the
        // machine-global `changes.file_events` on any shape mismatch.
        Self::rebuild_table_if_schema_drifted(conn, "main.file_events", Self::FILE_EVENTS_SCHEMA)?;
        // Legacy per-instance changeset_drafts (pre-machine-global): guard
        // its shape before the migration below copies it into `changes`.
        Self::rebuild_table_if_schema_drifted(
            conn,
            "main.changeset_drafts",
            Self::LEGACY_CHANGESET_DRAFTS_SCHEMA,
        )?;
        // The derived FTS indexes gained a third column (`tokens`). They are
        // pure indexes over `facts` / `overview_posts`, so a shape change is
        // resolved by dropping and re-deriving rather than migrating — the
        // same carve-out `turn_telemetry` gets, and the reason the comments on
        // those two base tables say the shadow tables may be dropped freely.
        //
        // This must happen HERE, before the schema batch: the batch runs
        // exactly once per open and nothing re-runs it, so a drop placed after
        // it would never be followed by a create and the index would simply be
        // gone until the next process start.
        let facts_fts_dropped = Self::rebuild_fts_if_columns_drifted(
            conn,
            "main.facts_fts",
            &["subject", "text", "tokens"],
        )?;
        let posts_fts_dropped = Self::rebuild_fts_if_columns_drifted(
            conn,
            "main.overview_posts_fts",
            &["body", "refs", "tokens"],
        )?;
        // The SHARED changes.* tables are deliberately NOT drift-rebuilt:
        // drop-and-recreate on a machine-global database lets any stray
        // build destroy the shared truth. Their schema is governed by the
        // `user_version` gate in `bootstrap_changes_schema`.
        Self::migrate_sessions_first_to_last_user_prompt(conn)?;
        Self::migrate_sessions_add_fork_provenance(conn)?;
        Self::migrate_sessions_add_stage_provenance(conn)?;
        Self::migrate_sessions_add_synopsis(conn)?;
        Self::migrate_sessions_add_private(conn)?;
        Self::migrate_sessions_add_dash_binding(conn)?;
        Self::migrate_sessions_add_demoted(conn)?;
        Self::migrate_sessions_add_hand_back_owed(conn)?;
        Self::migrate_scan_cache_add_resume_columns(conn)?;
        Self::migrate_pulse_lines_add_intent(conn)?;
        // First of the post-table migrations: everything below it names
        // `overview_posts`, which does not exist until this has run.
        Self::migrate_gazette_posts_to_overview_posts(conn)?;
        Self::migrate_overview_posts_add_elapsed_ms(conn)?;
        Self::migrate_overview_posts_add_project_dir(conn)?;
        Self::migrate_overview_posts_add_attachments(conn)?;
        // Before the batch, so the column exists for the FTS declarations and
        // the triggers below to name.
        Self::migrate_facts_add_tokens(conn)?;
        Self::migrate_overview_posts_add_tokens(conn)?;
        Self::migrate_drop_pulse_overviews(conn)?;
        // Before the batch, because `migrate_sessions_to_lines` writes both
        // columns and the batch only declares them on a table it creates.
        Self::migrate_minted_tags_add_line_id(conn)?;
        Self::migrate_scan_cache_add_line_id(conn)?;
        conn.execute_batch(
            "
            -- A **line of work** and its identity ([P01]). The callsign and
            -- the user's name live here, once, for however many session ids
            -- the line lives through — so an id change has nothing to copy.
            CREATE TABLE IF NOT EXISTS lines (
                line_id       TEXT PRIMARY KEY,
                tag           TEXT NOT NULL UNIQUE,
                name          TEXT,
                name_user_set INTEGER NOT NULL DEFAULT 0,
                -- The card the line is seated on. NULL for a line the
                -- external scan discovered and nothing has resumed ([P07]).
                card_id       TEXT,
                project_dir   TEXT NOT NULL,
                created_at    INTEGER NOT NULL,
                last_used_at  INTEGER NOT NULL
            );

            -- A user-set name is unique across lines, enforced at the write
            -- ([P11]): a rename onto a taken name TAKES it, clearing the
            -- previous holder's name in the same transaction, so the newest
            -- gesture wins and the index still holds. Auto titles are exempt —
            -- two lines may perfectly well be auto-titled the same thing.
            CREATE UNIQUE INDEX IF NOT EXISTS lines_user_name
                ON lines(name) WHERE name_user_set = 1;

            CREATE INDEX IF NOT EXISTS lines_card ON lines(card_id);

            CREATE TABLE IF NOT EXISTS sessions (
                session_id        TEXT PRIMARY KEY,
                workspace_key     TEXT NOT NULL,
                project_dir       TEXT NOT NULL,
                created_at        INTEGER NOT NULL,
                last_used_at      INTEGER NOT NULL,
                turn_count        INTEGER NOT NULL DEFAULT 0,
                last_user_prompt  TEXT,
                state             TEXT NOT NULL,
                card_id           TEXT,
                -- The line this row is a segment of ([P01]). Identity is the
                -- line's; nothing here holds a callsign or a name.
                line_id           TEXT NOT NULL REFERENCES lines(line_id),
                -- Fork provenance ([P11]): which session this one was
                -- rewind-forked from, and the prompt uuid of the rewind
                -- point. Both NULL for a root session. Provenance lives in
                -- these columns, never in the callsign's spelling — the
                -- callsign is the line's and does not move.
                forked_from_session_id TEXT,
                fork_point        TEXT,
                -- Stage provenance ([P10]): what a rotation seated this
                -- session as. Both NULL on a session no rotation seated. They
                -- live here rather than being reconstructed from a dash arc's
                -- record, because a rotation need not have an arc behind it —
                -- and its transcript is an invariant either way.
                stage_label       TEXT,
                stage_model       TEXT,
                -- The rolling generated description ([P07]). NULL until the
                -- Summarize lane writes one; frozen (never written) once the
                -- user has renamed the session.
                synopsis          TEXT,
                -- The Overview privacy flag. `1` means this session is out of
                -- the fact base and out of the channel: no facts recorded, no
                -- Observer post, and every Operator verb that reads sessions
                -- skips it. From-now-on semantics — marking a session private
                -- hides it going forward and scrubs nothing already written.
                private           INTEGER NOT NULL DEFAULT 0,
                -- The dash this session is working on ([P01]/[P08]):
                -- `dash_id` is the owner key and the authority, `dash_name`
                -- is denormalized for display. NULL when unbound, and
                -- cleared when the session closes — bound-ness is defined
                -- over live sessions ([L27]).
                dash_id           TEXT,
                dash_name         TEXT,
                -- Which kind of `closed` this row is. `1` marks the startup
                -- demote — the *process* under the session ended, not the
                -- session — and is the one state `revive_on_activity` may
                -- correct on live-borne evidence. A deliberate close
                -- (`mark_closed`) and a spawn both clear it: closed-by-hand
                -- stays closed, and a spawned row is live on its own terms.
                demoted           INTEGER NOT NULL DEFAULT 0,
                -- The card owes a hand-back: a courseless rotation put it on
                -- a named model, and nothing but the restore will take it
                -- off. `1` while owed, cleared when the restore goes out.
                --
                -- On disk rather than in the wheel's memory alone, because
                -- the debt outlives the process that took it on: a tugcast
                -- restart between the rotation and the next turn's end used
                -- to drop the arming, and tugcode reuses its manager's
                -- selector for every later spawn — so the card stayed pinned
                -- on a stage model through the user's own `/new`, forever.
                hand_back_owed    INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS sessions_workspace_recent
                ON sessions(workspace_key, last_used_at DESC);

            -- The fork edge, read child-ward: given a session id, which
            -- session (if any) was forked from it. `lineage_chain` walks it
            -- once per hop to replay a card's transcript parent-ward.
            CREATE INDEX IF NOT EXISTS sessions_forked_from
                ON sessions(forked_from_session_id);

            -- The all-time tag arbiter (Spec S08). `sessions` rows are hard
            -- DELETEd — trash, the cascade paths, the age sweep — so the
            -- `sessions_tag` index above can enforce uniqueness among live
            -- sessions but not permanence. Commit trailers cite tags, and a
            -- recycled tag makes an old commit's citation resolve to a
            -- different session, so permanence rests here instead.
            --
            -- ROWS ARE NEVER DELETED FROM THIS TABLE. Not on trash, not on
            -- cascade delete, not on eviction. A tag outlives its session by
            -- design; deleting rows here silently restores recycling.
            --
            -- The guarantee is per-ledger: `sessions.db` is per-instance, so
            -- it holds against every tag *this* ledger minted. A trailer read
            -- against another machine's ledger simply misses (the citation
            -- renders unresolvable), which is safe; a wiped ledger re-opens
            -- recycling on that machine.
            CREATE TABLE IF NOT EXISTS minted_tags (
                tag        TEXT PRIMARY KEY,
                -- The line that owns this spelling — the whole of what a
                -- retired spelling resolves to ([P08]). NULL only transiently,
                -- inside `migrate_sessions_to_lines`, which asserts otherwise
                -- before it commits.
                line_id    TEXT,
                -- The segment that spent the spelling. Kept as history: which
                -- id was live at the moment the line took this name.
                session_id TEXT NOT NULL,
                minted_at  INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS turns (
                journal_id        TEXT PRIMARY KEY,
                session_id        TEXT NOT NULL,
                user_text         TEXT NOT NULL,
                user_attachments  BLOB NOT NULL,
                created_at        INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS turns_session_created
                ON turns(session_id, created_at);

            CREATE TRIGGER IF NOT EXISTS turns_cascade_delete_on_session
            AFTER DELETE ON sessions
            FOR EACH ROW
            BEGIN
                DELETE FROM turns WHERE session_id = OLD.session_id;
            END;

            -- Every prompt the WHEEL put on the wire.
            --
            -- The wheel speaks in the transcript under its own name, and on a
            -- reload nothing in claude's JSONL says so: that file is claude's,
            -- and it records a prompt the wheel sent exactly as it records one
            -- the user typed. So Tug keeps its own record of what it sent, and
            -- the replay translator states authorship from here instead of
            -- guessing it from a prompt's position in the file.
            --
            -- Keyed by LINE, not by session id: an arc rotates a card through
            -- several session ids and the wheel's prompts belong to the work,
            -- not to whichever segment was live when one was sent. Rows are
            -- durable for the life of the line — unlike `turns`, nothing
            -- deletes them on acknowledgement, because acknowledgement is not
            -- what they are for.
            CREATE TABLE IF NOT EXISTS wheel_prompts (
                prompt_id  TEXT PRIMARY KEY,
                line_id    TEXT NOT NULL,
                -- The segment that was live when the wheel spoke. Kept as
                -- history; the line is what the read is keyed on.
                session_id TEXT NOT NULL,
                text       TEXT NOT NULL,
                sent_at    INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS wheel_prompts_line
                ON wheel_prompts(line_id, sent_at);

            CREATE TRIGGER IF NOT EXISTS wheel_prompts_cascade_delete_on_line
            AFTER DELETE ON lines
            FOR EACH ROW
            BEGIN
                DELETE FROM wheel_prompts WHERE line_id = OLD.line_id;
            END;

            -- Per-turn telemetry — cost + multi-clock timing block,
            -- one row per committed turn. Written by the supervisor
            -- on receipt of a `record_turn_telemetry` inbound message
            -- from tugdeck (the reducer dispatches this from
            -- `handleTurnComplete` on the live path); read at
            -- `spawn_session(mode=resume)` and inlined onto replayed
            -- `turn_complete` events so the client reducer's merge
            -- function adopts the persisted values. Cascade-on-DELETE
            -- mirrors the `turns` journal pattern so eviction of a
            -- `sessions` row (cap / age policy) takes its telemetry
            -- with it.
            --
            -- `(session_id, msg_id)` PK: msg_id is Claude-assigned,
            -- carried through JSONL, survives replay unchanged. The
            -- client-only `turn_key` is intentionally absent — it is
            -- re-minted fresh on every reload and cannot cross
            -- persistence boundaries. See plan `#step-20-3-3` for
            -- the design rationale.
            CREATE TABLE IF NOT EXISTS turn_telemetry (
                session_id                  TEXT NOT NULL,
                msg_id                      TEXT NOT NULL,
                input_tokens                INTEGER NOT NULL DEFAULT 0,
                output_tokens               INTEGER NOT NULL DEFAULT 0,
                cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
                total_cost_usd              REAL    NOT NULL DEFAULT 0,
                wall_clock_ms               INTEGER NOT NULL DEFAULT 0,
                awaiting_approval_ms        INTEGER NOT NULL DEFAULT 0,
                transport_downtime_ms       INTEGER NOT NULL DEFAULT 0,
                active_ms                   INTEGER NOT NULL DEFAULT 0,
                ttft_ms                     INTEGER,
                ttftc_ms                    INTEGER,
                reconnect_count             INTEGER NOT NULL DEFAULT 0,
                max_stream_gap_ms           INTEGER NOT NULL DEFAULT 0,
                ended_at                    INTEGER NOT NULL,
                -- `window(0)` — the session's resident context before
                -- any turn. Session-level, not per-turn: every row of a
                -- session carries the same value. Persisted here (on the
                -- channel that already round-trips) so a resumed session
                -- restores it from the first replayed `turn_complete`.
                -- Nullable: a turn whose session never observed a first
                -- iteration has no value to record.
                session_init_tokens         INTEGER,
                PRIMARY KEY (session_id, msg_id)
            );

            CREATE INDEX IF NOT EXISTS turn_telemetry_session_order
                ON turn_telemetry(session_id, ended_at);

            CREATE TRIGGER IF NOT EXISTS turn_telemetry_cascade_delete_on_session
            AFTER DELETE ON sessions
            FOR EACH ROW
            BEGIN
                DELETE FROM turn_telemetry WHERE session_id = OLD.session_id;
            END;

            -- Per-session LIVE-ONLY metadata — the full `system_metadata`
            -- payload Claude Code emits on `session_init` (model with
            -- the `[1m]` suffix, cwd, permissionMode, tools,
            -- slash_commands, plugins, agents, skills, mcp_servers,
            -- version, output_style, fast_mode_state, apiKeySource).
            -- JSONL does not preserve any of these per-message — the
            -- replay path in `tugcode/src/replay.ts` synthesizes a
            -- bare-name `system_metadata` with every other field empty,
            -- which without persistence would clobber the live values
            -- the user already saw. The bridge captures the live
            -- payload, merges it with the persisted one on every
            -- forward, and rewrites the wire line so the client always
            -- receives the most-informationally-rich version.
            --
            -- Payload is stored as a JSON BLOB rather than per-column
            -- so future Anthropic fields land here without a schema
            -- migration. Trade-off: no indexed queries on individual
            -- fields, but the only access pattern is PK lookup.
            CREATE TABLE IF NOT EXISTS session_metadata (
                session_id  TEXT PRIMARY KEY,
                payload     BLOB NOT NULL,
                captured_at INTEGER NOT NULL
            );

            CREATE TRIGGER IF NOT EXISTS session_metadata_cascade_delete_on_session
            AFTER DELETE ON sessions
            FOR EACH ROW
            BEGIN
                DELETE FROM session_metadata WHERE session_id = OLD.session_id;
            END;

            -- Latest per-session `session_capabilities` handshake frame —
            -- the turn-free model list + command catalog (plugin commands
            -- merged) + version. Written by the supervisor's sideband
            -- capture on every live capabilities frame; read at session
            -- bind when the in-memory `latest_capabilities` slot is empty
            -- (app restart), so a resumed card's `/` catalog survives
            -- restarts instead of waiting on the resume handshake.
            --
            -- Keyed by the TUG session id (capabilities are spawn-scoped;
            -- `session_metadata` is keyed by claude's JSONL id). JSON BLOB
            -- for the same reasons as `session_metadata`: pure PK lookup,
            -- shape owned by the wire boundary, no schema migration when
            -- the handshake grows fields.
            CREATE TABLE IF NOT EXISTS session_capabilities (
                session_id  TEXT PRIMARY KEY,
                payload     BLOB NOT NULL,
                captured_at INTEGER NOT NULL
            );

            CREATE TRIGGER IF NOT EXISTS session_capabilities_cascade_delete_on_session
            AFTER DELETE ON sessions
            FOR EACH ROW
            BEGIN
                DELETE FROM session_capabilities WHERE session_id = OLD.session_id;
            END;

            -- Latest per-session `/context`-style breakdown — one row
            -- per session, UPSERT on receipt of a
            -- `record_context_breakdown` inbound action from tugdeck.
            -- The reducer dispatches the action after consuming each
            -- `context_breakdown` frame from tugcode, mirroring the
            -- `record_turn_telemetry` pattern (reducer is the
            -- persistence boundary; supervisor writes; ledger stores).
            --
            -- Read at session bind so the snapshot's
            -- `lastContextBreakdown` populates before the popover
            -- opens, then overwritten by the next live
            -- `context_breakdown` frame.
            --
            -- Payload is stored as a JSON BLOB rather than per-column
            -- so future categories (or the deprecation of existing
            -- ones, if Anthropic reshapes `/context`) land here
            -- without a schema migration. Trade-off: no indexed
            -- queries on individual category tokens, but the only
            -- access pattern is PK lookup by session_id. Mirrors the
            -- `session_metadata` decision in the same file. The wire-
            -- frame TypeScript types validate the payload shape on
            -- both write and read paths; the sqlite layer is pure
            -- persistence.
            --
            -- MCP is intentionally absent from the wire frame's
            -- categories union, so no MCP bytes ever reach this table.
            CREATE TABLE IF NOT EXISTS context_breakdown_latest (
                session_id  TEXT PRIMARY KEY,
                payload     BLOB NOT NULL,
                captured_at INTEGER NOT NULL
            );

            CREATE TRIGGER IF NOT EXISTS context_breakdown_latest_cascade_delete_on_session
            AFTER DELETE ON sessions
            FOR EACH ROW
            BEGIN
                DELETE FROM context_breakdown_latest WHERE session_id = OLD.session_id;
            END;

            -- Append-only log of indicator-tone triple transitions —
            -- one row per distinct `(phase, transport_state,
            -- interrupt_in_flight)` change for a given session.
            -- Written by `record_session_state_change` from the
            -- supervisor's inbound handler, after tugdeck's dispatch-
            -- wrapper observes the triple has changed. Read by the
            -- popover (Step 20.4.9) via `list_session_state_changes`.
            --
            -- Per-column storage (not BLOB) because the popover's
            -- access pattern reads structured fields and the row shape
            -- is small + fixed by the indicator's prop set. Promoting
            -- a new tone-bearing axis means co-evolving indicator
            -- props, matrix definitions, and this schema in the same
            -- step.
            --
            -- Dedupe: the writer skips the insert if the new triple
            -- equals the most recent persisted triple for the session.
            -- The SQL layer trusts the writer; no UNIQUE constraint
            -- (the natural-key set is the triple plus its position in
            -- the history, which the autoincrement PK already covers).
            CREATE TABLE IF NOT EXISTS session_state_changes (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id          TEXT NOT NULL,
                at_ms               INTEGER NOT NULL,
                phase               TEXT NOT NULL,
                transport_state     TEXT NOT NULL,
                interrupt_in_flight INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS session_state_changes_session_at
                ON session_state_changes(session_id, at_ms);

            CREATE TRIGGER IF NOT EXISTS session_state_changes_cascade_delete_on_session
            AFTER DELETE ON sessions
            FOR EACH ROW
            BEGIN
                DELETE FROM session_state_changes WHERE session_id = OLD.session_id;
            END;

            -- App-scoped PULSE commentary lines — a capped rolling log
            -- written by the pulse bridge as daemon lines arrive and
            -- read two ways: the deck fetches the tail through the
            -- `list_pulse_lines` CONTROL verb on mount, and the daemon
            -- is re-seeded from the same tail at spawn. `scopes` is a
            -- JSON array of the scope ids the line's source beat
            -- covered. Deliberately NO session cascade: a line may span
            -- scopes and the narrative log outlives any one session.
            CREATE TABLE IF NOT EXISTS pulse_lines (
                id     INTEGER PRIMARY KEY AUTOINCREMENT,
                at_ms  INTEGER NOT NULL,
                beat   INTEGER NOT NULL,
                text   TEXT NOT NULL,
                intent TEXT,
                scopes TEXT NOT NULL
            );

            -- App-scoped Overview channel — every post by any of its three
            -- authors ('observer' | 'operator' | 'user'). `session_id` is
            -- the provenance link a Observer digest carries back to the
            -- session it narrates (NULL on Operator answers and user
            -- questions, which belong to the channel rather than to any one
            -- session); `wake_reason` records which structural moment woke
            -- the Observer, and is NULL for the other two authors. `refs`
            -- is a JSON array of {kind, target}, serialized like
            -- `pulse_lines.scopes`.
            --
            -- Deliberately NO session cascade, for the same reason
            -- `pulse_lines` has none and one more besides: the channel
            -- outlives any single session, and a digest's whole value is
            -- that it still says what happened after the session row it
            -- points at has been evicted.
            --
            -- UNCAPPED, and unlike `pulse_lines` that is the point rather
            -- than an oversight. `pulse_lines` is a rolling log the strip
            -- reads the tail of; this is permanent history the Operator
            -- searches. Nothing prunes it.
            --
            -- NEVER register this table with `rebuild_table_if_schema_drifted`.
            -- That guard resolves a column-set change by DROPPING and
            -- recreating, which is harmless for a rolling log and total
            -- data loss here. A future column is added with an ALTER-based
            -- `migrate_overview_posts_add_*` alongside the other migrations,
            -- following `migrate_pulse_lines_add_intent`. The FTS5 shadow
            -- tables below are the opposite case: they are derived from
            -- this table and may be dropped and rebuilt freely.
            CREATE TABLE IF NOT EXISTS overview_posts (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                at_ms       INTEGER NOT NULL,
                author      TEXT NOT NULL,
                session_id  TEXT,
                wake_reason TEXT,
                body        TEXT NOT NULL,
                refs        TEXT NOT NULL,
                -- How long the agent turn that wrote the post took. NULL on a
                -- user question and on every row written before the column
                -- existed (`migrate_overview_posts_add_elapsed_ms`).
                elapsed_ms  INTEGER,
                -- The project directory the post's refs resolve against. NULL
                -- on a user question and on every row written before the
                -- column existed (`migrate_overview_posts_add_project_dir`).
                project_dir TEXT,
                -- Images the user attached to a question, as a JSON array of
                -- `{path, media_type}` — the bytes rest on disk beside the
                -- ledger, never in this row. NULL on every post nobody
                -- attached anything to and on every row written before the
                -- column existed (`migrate_overview_posts_add_attachments`).
                attachments TEXT,
                -- The sub-word bag derived from `body` and `refs` by
                -- `search_tokens::subword_tokens`, indexed as the third
                -- `overview_posts_fts` column so a search for `tooltip` reaches
                -- a post that only ever wrote `TugTooltip`. Derived state: it
                -- is recomputed from this row's own columns, never authored.
                -- NULL only between a pre-migration open and the backfill.
                tokens      TEXT
            );

            CREATE INDEX IF NOT EXISTS overview_posts_session
                ON overview_posts(session_id);

            -- Full-text index over the searchable columns. External-content
            -- (`content=`) so the bytes live once, in `overview_posts`, and
            -- this is a pure index: `bm25()` ranks a query's hits and
            -- `snippet()` cuts the excerpts the Operator's `overview.search`
            -- verb returns. A LIKE scan would answer the same questions
            -- without an index, tokenization, or ranking — over a table
            -- that only grows.
            --
            -- `tokens` is the derived sub-word column: unicode61 holds
            -- `TugTooltip` as one token, so without it a search for `tooltip`
            -- cannot reach a post that named the component. It is weighted
            -- below the authored columns in `bm25()` — added vocabulary, not
            -- re-weighted vocabulary.
            CREATE VIRTUAL TABLE IF NOT EXISTS overview_posts_fts USING fts5(
                body,
                refs,
                tokens,
                content='overview_posts',
                content_rowid='id'
            );

            -- Keep the index in step with the content table. External-content
            -- FTS5 does not observe its content table on its own; these are
            -- the documented sync triggers, with the delete/update pair using
            -- the 'delete' command rows FTS5 requires.
            CREATE TRIGGER IF NOT EXISTS overview_posts_fts_insert
            AFTER INSERT ON overview_posts
            BEGIN
                INSERT INTO overview_posts_fts (rowid, body, refs, tokens)
                VALUES (new.id, new.body, new.refs, new.tokens);
            END;

            CREATE TRIGGER IF NOT EXISTS overview_posts_fts_delete
            AFTER DELETE ON overview_posts
            BEGIN
                INSERT INTO overview_posts_fts (overview_posts_fts, rowid, body, refs, tokens)
                VALUES ('delete', old.id, old.body, old.refs, old.tokens);
            END;

            CREATE TRIGGER IF NOT EXISTS overview_posts_fts_update
            AFTER UPDATE ON overview_posts
            BEGIN
                INSERT INTO overview_posts_fts (overview_posts_fts, rowid, body, refs, tokens)
                VALUES ('delete', old.id, old.body, old.refs, old.tokens);
                INSERT INTO overview_posts_fts (rowid, body, refs, tokens)
                VALUES (new.id, new.body, new.refs, new.tokens);
            END;

            -- The facts-library: the durable, structured record of the work
            -- done through Tug. Where `overview_posts` holds the Observer's
            -- prose, this holds what the prose is about — prompts, session
            -- lifecycle, commits, shell commands, test runs — recorded at the
            -- sites that own each event and rendered once into `text`.
            --
            -- Same persistence posture as `overview_posts`, for the same
            -- reasons. Deliberately NO session cascade: a fact's whole value
            -- is that it still says what happened after the `sessions` row it
            -- names has been swept at 90 days or trashed by hand.
            -- UNCAPPED: fact volume is tens to low hundreds of rows per
            -- working day, and nothing prunes.
            --
            -- NEVER register this table with `rebuild_table_if_schema_drifted`.
            -- That guard resolves a column-set change by DROPPING and
            -- recreating, which is total data loss here. A future column is
            -- added with an ALTER-based `migrate_facts_add_*` alongside the
            -- other migrations. The FTS5 shadow tables below are the opposite
            -- case: derived from this table, droppable and rebuildable freely.
            --
            -- `text` is the one rendering of the fact, written by
            -- `facts_library::render_text`. Both the FTS index and the
            -- Observer's SETTLED FACTS wake section read this column, so
            -- search and narration cannot describe one fact two ways.
            --
            -- `dedupe_key` is what makes a recorder idempotent. The agent
            -- bridge re-streams replayed frames on resume, so a recorder on a
            -- replayable path supplies a key and the INSERT OR IGNORE lands
            -- the fact exactly once. Keys by kind:
            --   shell   (claude route)  `shell:<session>:<tool_use_id>`
            --   test_run               `test:<same suffix as its shell fact>`
            --   session.compacted      `compact:<session>:<frame at_ms>`
            --   commit                 `commit:<sha>`
            -- Live-only paths (the `$` shell route, session lifecycle) pass
            -- NULL, and NULLs are distinct in a SQLite unique index.
            CREATE TABLE IF NOT EXISTS facts (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                at_ms      INTEGER NOT NULL,
                kind       TEXT NOT NULL,
                session_id TEXT,
                subject    TEXT,
                text       TEXT NOT NULL,
                payload    TEXT NOT NULL,
                dedupe_key TEXT,
                -- The sub-word bag derived from `subject` and `text` by
                -- `search_tokens::subword_tokens`. See the `overview_posts`
                -- column of the same name; the same derived-state posture
                -- applies, and it is why dropping and rebuilding the FTS index
                -- is safe while dropping this table would not be.
                tokens     TEXT
            );

            CREATE INDEX IF NOT EXISTS facts_kind_at ON facts(kind, at_ms);
            CREATE INDEX IF NOT EXISTS facts_session_at ON facts(session_id, at_ms);
            CREATE UNIQUE INDEX IF NOT EXISTS facts_dedupe
                ON facts(dedupe_key) WHERE dedupe_key IS NOT NULL;

            -- External-content FTS5 over the searchable columns, the
            -- `overview_posts_fts` shape verbatim: the bytes live once in
            -- `facts`, `bm25()` ranks a query's hits and `snippet()` cuts the
            -- excerpts `facts.search` returns.
            CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
                subject,
                text,
                tokens,
                content='facts',
                content_rowid='id'
            );

            CREATE TRIGGER IF NOT EXISTS facts_fts_insert
            AFTER INSERT ON facts
            BEGIN
                INSERT INTO facts_fts (rowid, subject, text, tokens)
                VALUES (new.id, new.subject, new.text, new.tokens);
            END;

            CREATE TRIGGER IF NOT EXISTS facts_fts_delete
            AFTER DELETE ON facts
            BEGIN
                INSERT INTO facts_fts (facts_fts, rowid, subject, text, tokens)
                VALUES ('delete', old.id, old.subject, old.text, old.tokens);
            END;

            CREATE TRIGGER IF NOT EXISTS facts_fts_update
            AFTER UPDATE ON facts
            BEGIN
                INSERT INTO facts_fts (facts_fts, rowid, subject, text, tokens)
                VALUES ('delete', old.id, old.subject, old.text, old.tokens);
                INSERT INTO facts_fts (rowid, subject, text, tokens)
                VALUES (new.id, new.subject, new.text, new.tokens);
            END;

            -- Cache of external-session scan results — one row per
            -- on-disk JSONL the external scanner has parsed, keyed by
            -- session id and validated by (file_size, file_mtime).
            -- A matching pair means the cached metadata is current and
            -- the file is not re-read; appends/edits change the pair
            -- and force a re-parse. `excluded` marks files the scanner
            -- deliberately rejected (cwd mismatch from the lossy path
            -- encoding, sessionId/filename mismatch) so rejection is
            -- also remembered and the file isn't re-streamed per scan.
            --
            -- Deliberately NO cascade trigger on `sessions`: this
            -- table is independent of ledger rows by design — external
            -- sessions are never bulk-imported into `sessions`, and a
            -- cached scan row must survive the adoption/eviction
            -- lifecycle of any ledger row that shares its id. Rows are
            -- pruned by the scan itself when the backing file is gone.
            CREATE TABLE IF NOT EXISTS external_scan_cache (
                session_id        TEXT PRIMARY KEY,
                project_dir       TEXT NOT NULL,
                file_size         INTEGER NOT NULL,
                file_mtime        INTEGER NOT NULL,
                excluded          INTEGER NOT NULL DEFAULT 0,
                turn_count        INTEGER NOT NULL DEFAULT 0,
                last_user_prompt  TEXT,
                name              TEXT,
                created_at        INTEGER NOT NULL DEFAULT 0,
                last_used_at      INTEGER NOT NULL DEFAULT 0,
                parse_offset      INTEGER NOT NULL DEFAULT 0,
                tail_hash         INTEGER NOT NULL DEFAULT 0,
                cwd_checked       INTEGER NOT NULL DEFAULT 0,
                created_at_found  INTEGER NOT NULL DEFAULT 0,
                rule_epoch        INTEGER NOT NULL DEFAULT 0,
                frontier_open                  INTEGER NOT NULL DEFAULT 0,
                frontier_pending_close         INTEGER NOT NULL DEFAULT 0,
                frontier_pending_close_msg_id  TEXT,
                frontier_leaf_uuid             TEXT,
                effective_uuids                BLOB,
                lineage_ancestors              TEXT,
                -- The line this scanned session belongs to ([P07]). A scan
                -- births a card-less line at scan time, because the callsign
                -- it mints is spent in `minted_tags` immediately and a spent
                -- spelling needs an owner that exists. Adoption on first
                -- resume seats that same line on a card rather than minting a
                -- second identity.
                line_id                        TEXT
            );

            CREATE INDEX IF NOT EXISTS external_scan_cache_project
                ON external_scan_cache(project_dir);

            -- Legacy cascade trigger from the per-instance file_events era:
            -- a trigger cannot reach across databases, so eviction now
            -- deletes changes.file_events rows explicitly.
            DROP TRIGGER IF EXISTS file_events_cascade_delete_on_session;
            ",
        )?;
        // After the batch, because it reads and repoints `minted_tags` and
        // rewrites `sessions` — both of which the batch has just guaranteed
        // exist. On a ledger that already speaks lines this is a no-op.
        Self::migrate_sessions_to_lines(conn)?;
        // After the migration, because a pre-lines `sessions` has no
        // `line_id` for the index to name until it has run. Idempotent on
        // both paths, which is why it is not inside either.
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS sessions_line ON sessions(line_id, created_at DESC);",
        )?;
        // After the batch, because it needs the FTS tables to exist.
        Self::backfill_search_tokens(conn, facts_fts_dropped, posts_fts_dropped)?;
        let changes_write_ok = Self::bootstrap_changes_schema(conn, may_write_changes)?;
        if changes_write_ok && may_write_changes {
            Self::migrate_instance_file_events_to_changes(conn)?;
            Self::migrate_instance_changeset_drafts_to_changes(conn)?;
        }
        Ok(changes_write_ok)
    }

    /// Bootstrap the **shared** `changes` schema under the `user_version`
    /// gate. Returns whether this build may write the changes tables.
    ///
    /// The shared database's schema is versioned; an instance may only:
    /// - create the current schema on a fresh (version 0) database,
    /// - stamp a pre-versioning database that predates the gate, or
    /// - apply a *registered* migration ([`CHANGES_MIGRATIONS`]).
    ///
    /// An on-disk version **newer** than this build means another, newer
    /// instance owns the schema: this build must not touch it and gets no
    /// write access — never the old drop-and-recreate "self-healing",
    /// which let any stray build reshape the machine-global truth
    /// (2026-07-27 incident). Row DELETEs (session eviction, ownership
    /// severing) stay allowed: removing rows is shape-safe; creating or
    /// updating rows against an unknown shape is not.
    fn bootstrap_changes_schema(
        conn: &Connection,
        may_write_changes: bool,
    ) -> Result<bool, LedgerError> {
        let on_disk: i64 = match conn.query_row("PRAGMA changes.user_version", [], |r| r.get(0)) {
            Ok(v) => v,
            Err(err) => {
                // An unreadable version means an unusable shared attach —
                // typically a corrupt newer-schema database the downgrade
                // guard refused to rebuild. Run without write access
                // rather than failing the whole ledger open: sessions.db
                // still works, and the deck reports the degradation.
                tracing::error!(error = %err, "cannot read changes.db user_version; refusing shared-table writes");
                let err: LedgerError = err.into();
                ledger_integrity::health::note_error("changes", &err);
                return Ok(false);
            }
        };
        if on_disk > CHANGES_SCHEMA_VERSION {
            tracing::error!(
                on_disk,
                supported = CHANGES_SCHEMA_VERSION,
                "shared changes.db schema is newer than this build — refusing schema \
                 and row writes to the shared tables; upgrade this instance"
            );
            return Ok(false);
        }
        if !may_write_changes {
            // A forwarding instance only verifies it can live with the
            // shape on disk; creating and stamping it is the owner's job.
            return Ok(true);
        }
        if on_disk > 0 && on_disk < CHANGES_SCHEMA_VERSION {
            for (from, sql) in CHANGES_MIGRATIONS {
                if *from >= on_disk {
                    // A crash between a migration's DDL and the version
                    // stamp re-runs the migration on the next open; an
                    // `ALTER TABLE … ADD COLUMN` is not idempotent the way
                    // `CREATE TABLE IF NOT EXISTS` is, so the one error
                    // that means "already applied" is absorbed.
                    if let Err(err) = conn.execute_batch(sql) {
                        if !err.to_string().contains("duplicate column name") {
                            return Err(err.into());
                        }
                    }
                }
            }
        }
        // Fresh (0) or current: idempotent creation of the current shape.
        // A pre-versioning database with a *drifted* shape is left intact —
        // never dropped — and its insert failures surface through the
        // corruption/write tripwires for a human-reviewed migration.
        conn.execute_batch(
            "
            -- Authoritative per-session file attribution — one row per
            -- (tug_session_id, tool_use_id, file_path). Written from the
            -- agent-bridge relay loop at the moment a tool call that
            -- changed a file lands: exact for Write/Edit/MultiEdit/
            -- NotebookEdit (straight from the tool input), bracketed for
            -- Bash (working-tree fingerprint delta). This concentrates a
            -- session's file knowledge down to the point of change rather
            -- than reconstructing the session file list from conversation
            -- context (which is blind to Bash-mediated edits like sed,
            -- perl, or git mv).
            --
            -- Keyed by the tug session id — the card-bound identity that
            -- survives resumes (claude ids rotate underneath it), so
            -- attribution gets resume-lineage for free. The PK is the
            -- idempotency contract: resume replays the full history and
            -- subagent-tail re-streams background-agent children from
            -- offset 0, so a frame may be seen twice; `record_file_event`
            -- upserts with ON CONFLICT DO NOTHING, making the repeat a
            -- no-op. Cascade-on-DELETE mirrors the `turns` journal so
            -- evicting a `sessions` row takes its attribution with it.
            CREATE TABLE IF NOT EXISTS changes.file_events (
                tug_session_id      TEXT NOT NULL,
                tool_use_id         TEXT NOT NULL,
                file_path           TEXT NOT NULL,
                tool_name           TEXT NOT NULL,
                op                  TEXT NOT NULL,
                origin              TEXT NOT NULL,
                ambiguous           INTEGER NOT NULL DEFAULT 0,
                parent_tool_use_id  TEXT,
                project_dir         TEXT NOT NULL,
                at                  INTEGER NOT NULL,
                -- The line of work the writing session belonged to ([P01]),
                -- stamped at write time from the writer's `sessions` row.
                -- First-choice owner key at read time; the sessions join is
                -- the fallback for rows written before v3 (or by a session
                -- the writer's ledger had never seen, where it is NULL).
                line_id             TEXT,
                PRIMARY KEY (tug_session_id, tool_use_id, file_path)
            );

            CREATE INDEX IF NOT EXISTS changes.file_events_project
                ON file_events(project_dir, at);

            -- Maintained changeset drafts — machine-global like file_events
            -- ([D112]): the working tree is machine-global, so the truth
            -- about its proposed landing must be too. Two app instances on
            -- one checkout see one draft.
            CREATE TABLE IF NOT EXISTS changes.changeset_drafts (
                owner_kind   TEXT NOT NULL,
                owner_id     TEXT NOT NULL,
                project_dir  TEXT NOT NULL,
                fingerprint  TEXT NOT NULL,
                message      TEXT NOT NULL,
                updated_at   INTEGER NOT NULL,
                edited       INTEGER NOT NULL DEFAULT 0,
                selection    TEXT,
                PRIMARY KEY (owner_kind, owner_id, project_dir)
            );
            ",
        )?;
        conn.execute_batch(CREATE_FILE_EVENT_SPANS_SQL)?;
        // A pre-versioning database (version 0 with the table already on
        // disk) takes no registered migration above, and `CREATE TABLE IF
        // NOT EXISTS` leaves its shape alone — so the v3 column add runs
        // conditionally here, the one shape it could still be missing.
        let has_line_id = {
            let mut stmt = conn.prepare("PRAGMA changes.table_info(file_events)")?;
            let cols = stmt
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?;
            cols.iter().any(|name| name == "line_id")
        };
        if !has_line_id {
            conn.execute_batch(ADD_FILE_EVENTS_LINE_ID_SQL)?;
        }
        conn.pragma_update(
            Some(rusqlite::DatabaseName::Attached("changes")),
            "user_version",
            CHANGES_SCHEMA_VERSION,
        )?;
        Ok(true)
    }

    /// One-shot migration to the shared changes ledger ([D112]): copy any
    /// legacy per-instance `main.file_events` rows into
    /// `changes.file_events` (the `(session, tool_use_id, file_path)` PK
    /// makes the copy idempotent and cross-instance collision-free), then
    /// drop the legacy table so evicted rows can never resurrect from it.
    /// No-op when the legacy table is absent (fresh DBs never create it).
    fn migrate_instance_file_events_to_changes(conn: &Connection) -> Result<(), LedgerError> {
        let legacy_exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM main.sqlite_master
             WHERE type = 'table' AND name = 'file_events'",
            [],
            |r| r.get(0),
        )?;
        if legacy_exists == 0 {
            return Ok(());
        }
        conn.execute_batch(
            "
            INSERT OR IGNORE INTO changes.file_events (
                tug_session_id, tool_use_id, file_path,
                tool_name, op, origin, ambiguous,
                parent_tool_use_id, project_dir, at)
            SELECT tug_session_id, tool_use_id, file_path,
                   tool_name, op, origin, ambiguous,
                   parent_tool_use_id, project_dir, at
            FROM main.file_events;

            DROP TABLE main.file_events;
            ",
        )?;
        Ok(())
    }

    /// One-shot migration of maintained drafts to the shared changes ledger
    /// ([D112] scope axiom): copy any legacy per-instance
    /// `main.changeset_drafts` rows into `changes.changeset_drafts`
    /// (`INSERT OR IGNORE` on the `(owner_kind, owner_id, project_dir)` PK —
    /// a machine-global row, being newer truth, wins over a legacy one),
    /// then drop the legacy table. Legacy rows predate `edited`/`selection`
    /// and take the column defaults (unedited, no overrides). No-op when
    /// the legacy table is absent (fresh DBs never create it).
    fn migrate_instance_changeset_drafts_to_changes(conn: &Connection) -> Result<(), LedgerError> {
        let legacy_exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM main.sqlite_master
             WHERE type = 'table' AND name = 'changeset_drafts'",
            [],
            |r| r.get(0),
        )?;
        if legacy_exists == 0 {
            return Ok(());
        }
        conn.execute_batch(
            "
            INSERT OR IGNORE INTO changes.changeset_drafts (
                owner_kind, owner_id, project_dir,
                fingerprint, message, updated_at)
            SELECT owner_kind, owner_id, project_dir,
                   fingerprint, message, updated_at
            FROM main.changeset_drafts;

            DROP TABLE main.changeset_drafts;
            ",
        )?;
        Ok(())
    }

    /// The `(name, declared-type)` columns of `table`, in definition
    /// order, as `PRAGMA table_info` reports them. Empty when the
    /// table does not exist.
    fn table_columns(conn: &Connection, table: &str) -> Result<Vec<(String, String)>, LedgerError> {
        // `table` is a compile-time constant from `bootstrap_schema`,
        // never caller input — the `format!` carries no injection risk. A
        // schema-qualified name (`changes.file_events`) becomes the
        // schema-qualified pragma form (`PRAGMA changes.table_info(...)`).
        let pragma = match table.split_once('.') {
            Some((schema, name)) => format!("PRAGMA {schema}.table_info({name})"),
            None => format!("PRAGMA table_info({table})"),
        };
        let mut stmt = conn.prepare(&pragma)?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        })?;
        let mut columns = Vec::new();
        for row in rows {
            columns.push(row?);
        }
        Ok(columns)
    }

    /// One-shot rename: the `sessions.first_user_prompt` column became
    /// `last_user_prompt` when the picker switched from "first prompt
    /// ever" to "most recent prompt" semantics. Existing values stay —
    /// they become the most-recent prompt until the next user message
    /// overwrites them. No-op when the table is absent (fresh DB) or
    /// the rename has already run.
    fn migrate_sessions_first_to_last_user_prompt(conn: &Connection) -> Result<(), LedgerError> {
        let cols = Self::table_columns(conn, "sessions")?;
        let has_old = cols.iter().any(|(n, _)| n == "first_user_prompt");
        let has_new = cols.iter().any(|(n, _)| n == "last_user_prompt");
        if has_old && !has_new {
            conn.execute(
                "ALTER TABLE sessions RENAME COLUMN first_user_prompt TO last_user_prompt",
                [],
            )?;
        }
        Ok(())
    }

    /// Self-healing add of the `sessions.private` column — the Overview
    /// privacy flag. Pre-column rows default to `0` (public), which is the
    /// right reading: a session recorded before the flag existed was never
    /// marked private. No-op on a fresh DB (the CREATE TABLE defines it) or
    /// when already migrated.
    fn migrate_sessions_add_private(conn: &Connection) -> Result<(), LedgerError> {
        let cols = Self::table_columns(conn, "sessions")?;
        if cols.is_empty() {
            return Ok(());
        }
        if !cols.iter().any(|(n, _)| n == "private") {
            conn.execute(
                "ALTER TABLE sessions ADD COLUMN private INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        Ok(())
    }

    /// Self-healing add of the `demoted` marker — which kind of `closed` a
    /// row is. Pre-column rows default to `0` (deliberately closed), the
    /// conservative reading: a row that cannot say it was demoted is not
    /// revivable. No-op on a fresh DB or when already migrated.
    fn migrate_sessions_add_demoted(conn: &Connection) -> Result<(), LedgerError> {
        let cols = Self::table_columns(conn, "sessions")?;
        if cols.is_empty() {
            return Ok(());
        }
        if !cols.iter().any(|(n, _)| n == "demoted") {
            conn.execute(
                "ALTER TABLE sessions ADD COLUMN demoted INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        Ok(())
    }

    /// Self-healing add of the fork-provenance columns ([P11]).
    ///
    /// `forked_from_session_id` names the session a rewind-fork was taken
    /// from and `fork_point` the prompt uuid of the rewind point; both are
    /// NULL for a root session. Provenance lives here, never in the
    /// callsign's spelling — the callsign is the line's, and a fork is
    /// another segment of the same line.
    fn migrate_sessions_add_fork_provenance(conn: &Connection) -> Result<(), LedgerError> {
        let cols = Self::table_columns(conn, "sessions")?;
        if cols.is_empty() {
            return Ok(());
        }
        for name in ["forked_from_session_id", "fork_point"] {
            if !cols.iter().any(|(n, _)| n == name) {
                match conn.execute(&format!("ALTER TABLE sessions ADD COLUMN {name} TEXT"), []) {
                    Ok(_) => {}
                    Err(err) if is_duplicate_column(&err) => {}
                    Err(err) => return Err(err.into()),
                }
            }
        }
        Ok(())
    }

    /// Self-healing add of the stage-provenance columns ([P10]).
    ///
    /// `stage_label` and `stage_model` record what a rotation seated this
    /// session as. They live on the row rather than being reconstructed from a
    /// dash arc's record, because a rotation need not have an arc behind it:
    /// a card rotated by a bare `session rotate` has no arc to read, and
    /// without these columns its earlier sessions would vanish from the
    /// transcript on the next relaunch. Both are NULL on a session no rotation
    /// seated, and on every row written before this migration.
    fn migrate_sessions_add_stage_provenance(conn: &Connection) -> Result<(), LedgerError> {
        let cols = Self::table_columns(conn, "sessions")?;
        if cols.is_empty() {
            return Ok(());
        }
        for name in ["stage_label", "stage_model"] {
            if !cols.iter().any(|(n, _)| n == name) {
                match conn.execute(&format!("ALTER TABLE sessions ADD COLUMN {name} TEXT"), []) {
                    Ok(_) => {}
                    Err(err) if is_duplicate_column(&err) => {}
                    Err(err) => return Err(err.into()),
                }
            }
        }
        Ok(())
    }

    /// Self-healing add of `sessions.hand_back_owed` — the card is owed its
    /// deck model back.
    ///
    /// A no-op when the table is absent (the CREATE batch then declares it)
    /// and when the column is already there. Rows written before it read `0`,
    /// which is the right answer for every one of them: an arming that
    /// predates the column was already lost with the process that held it.
    fn migrate_sessions_add_hand_back_owed(conn: &Connection) -> Result<(), LedgerError> {
        let cols = Self::table_columns(conn, "sessions")?;
        if cols.is_empty() || cols.iter().any(|(n, _)| n == "hand_back_owed") {
            return Ok(());
        }
        match conn.execute(
            "ALTER TABLE sessions ADD COLUMN hand_back_owed INTEGER NOT NULL DEFAULT 0",
            [],
        ) {
            Ok(_) => Ok(()),
            Err(err) if is_duplicate_column(&err) => Ok(()),
            Err(err) => Err(err.into()),
        }
    }
    /// Self-healing add of `minted_tags.line_id` — the line that owns a
    /// spelling ([P08]). A no-op when the table is absent (the CREATE-batch
    /// then declares it) or when the column is already there.
    fn migrate_minted_tags_add_line_id(conn: &Connection) -> Result<(), LedgerError> {
        Self::add_line_id_column(conn, "minted_tags")
    }

    /// Self-healing add of `external_scan_cache.line_id` ([P07]) — the line a
    /// scanned session belongs to, which replaces the spelling the cache row
    /// used to carry.
    fn migrate_scan_cache_add_line_id(conn: &Connection) -> Result<(), LedgerError> {
        Self::add_line_id_column(conn, "external_scan_cache")
    }

    fn add_line_id_column(conn: &Connection, table: &str) -> Result<(), LedgerError> {
        let cols = Self::table_columns(conn, table)?;
        if cols.is_empty() || cols.iter().any(|(n, _)| n == "line_id") {
            return Ok(());
        }
        match conn.execute(&format!("ALTER TABLE {table} ADD COLUMN line_id TEXT"), []) {
            Ok(_) => Ok(()),
            Err(err) if is_duplicate_column(&err) => Ok(()),
            Err(err) => Err(err.into()),
        }
    }

    /// Copy `sessions.db` to `sessions.db.pre-lines` beside it, once, before
    /// the line migration writes anything ([R01]).
    ///
    /// `VACUUM main INTO` takes a transactional copy of the whole database
    /// with no WAL left to reconcile, which is the only safe way to snapshot a
    /// file this process holds open. Nothing deletes the sidecar; the user
    /// removes it.
    ///
    /// Best-effort by design. An in-memory ledger has no path, and a copy can
    /// fail for reasons that have nothing to do with the ledger (a full disk, a
    /// read-only directory). Refusing to migrate over that would leave the user
    /// with a database this build cannot serve, in exchange for a backup of it —
    /// so the migration's own pre-commit assertions are the guarantee, and this
    /// is the convenience beside them.
    fn write_pre_lines_sidecar(conn: &Connection) {
        let path: Option<String> = conn
            .query_row(
                "SELECT file FROM pragma_database_list WHERE name = 'main'",
                [],
                |row| row.get(0),
            )
            .optional()
            .unwrap_or(None);
        let Some(path) = path.filter(|p| !p.is_empty()) else {
            return;
        };
        let dest = PathBuf::from(format!("{path}.pre-lines"));
        if dest.exists() {
            return;
        }
        match conn.execute("VACUUM main INTO ?1", params![dest.to_string_lossy()]) {
            Ok(_) => tracing::info!(sidecar = %dest.display(), "pre-lines ledger copy written"),
            Err(err) => tracing::warn!(
                sidecar = %dest.display(),
                error = %err,
                "pre-lines ledger copy failed; migrating without it"
            ),
        }
    }

    /// Give every existing row a line, and take identity off the segment
    /// ([P10], Spec S04).
    ///
    /// Runs once, on the first open of a pre-lines ledger, inside one
    /// `BEGIN IMMEDIATE`: on any error the transaction rolls back and the open
    /// fails, because a ledger that cannot be brought to a shape this build
    /// understands is not one to serve. The guard is the absence of
    /// `sessions.line_id`, which is true of every pre-lines shape — including
    /// one old enough never to have grown a `tag` column — and false the
    /// moment this has run.
    ///
    /// **A line is a connected component of the `forked_from_session_id` edge,
    /// read undirected.** One relation carries both edge kinds — a rewind-fork
    /// (with a `fork_point`) and a rotation (without one) — and between them
    /// they are exactly the id changes that used to copy identity from one row
    /// to the next. A row no edge touches is a component of one.
    ///
    /// Each component takes the **earliest** spelling `minted_tags` records for
    /// any of its segments: the one already written into commit trailers, which
    /// is what has to keep resolving. A component no spelling was ever minted
    /// for rolls a fresh pair. It takes the user-set name of its most recently
    /// used segment, and where two components claim one spelling the more
    /// recently used one keeps it — the other keeps its callsign and loses the
    /// name, which is the resting-lie the old displacement loop papered over.
    ///
    /// `line_id` is added to `sessions` as a nullable column and made
    /// non-null by assertion rather than by constraint: `ALTER TABLE … ADD
    /// COLUMN` cannot declare `NOT NULL` without a default, and rebuilding a
    /// live `sessions` table to gain the constraint would be a far larger
    /// irreversible write than this migration already is. A fresh ledger gets
    /// the constraint from `CREATE TABLE`; a migrated one gets the assertions
    /// below, which run before the commit.
    fn migrate_sessions_to_lines(conn: &Connection) -> Result<(), LedgerError> {
        let cols = Self::table_columns(conn, "sessions")?;
        if cols.is_empty() || cols.iter().any(|(n, _)| n == "line_id") {
            return Ok(());
        }
        Self::write_pre_lines_sidecar(conn);
        conn.execute_batch("BEGIN IMMEDIATE")?;
        match Self::assign_lines_within_transaction(conn, &cols) {
            Ok(lines) => {
                conn.execute_batch("COMMIT")?;
                tracing::info!(lines, "sessions migrated to lines");
                Ok(())
            }
            Err(err) => {
                if let Err(rollback) = conn.execute_batch("ROLLBACK") {
                    tracing::error!(
                        error = %rollback,
                        "rollback after a failed line migration failed"
                    );
                }
                Err(err)
            }
        }
    }

    /// The body of [`Self::migrate_sessions_to_lines`], inside its
    /// transaction. Returns how many lines it created.
    fn assign_lines_within_transaction(
        conn: &Connection,
        cols: &[(String, String)],
    ) -> Result<usize, LedgerError> {
        let has = |name: &str| cols.iter().any(|(n, _)| n == name);
        let has_tag = has("tag");
        let has_name = has("name");
        let has_name_user_set = has("name_user_set");
        let scan_has_tag = Self::table_columns(conn, "external_scan_cache")?
            .iter()
            .any(|(n, _)| n == "tag");
        conn.execute("ALTER TABLE sessions ADD COLUMN line_id TEXT", [])?;

        // A ledger old enough to predate the arbiter carries its spellings only
        // on its rows. Seed them first, so the walk below reads one table and a
        // legacy callsign is not mistaken for a component that never had one.
        if has_tag {
            conn.execute(
                "INSERT OR IGNORE INTO minted_tags (tag, session_id, minted_at)
                 SELECT tag, session_id, created_at FROM sessions WHERE tag IS NOT NULL",
                [],
            )?;
        }

        struct Segment {
            session_id: String,
            forked_from: Option<String>,
            card_id: Option<String>,
            project_dir: String,
            created_at: i64,
            last_used_at: i64,
            name: Option<String>,
            name_user_set: bool,
        }
        let name_col = if has_name { "name" } else { "NULL" };
        let user_set_col = if has_name_user_set {
            "name_user_set"
        } else {
            "0"
        };
        let segments: Vec<Segment> = {
            let mut stmt = conn.prepare(&format!(
                "SELECT session_id, forked_from_session_id, card_id, project_dir,
                        created_at, last_used_at, {name_col}, {user_set_col}
                 FROM sessions"
            ))?;
            let rows = stmt.query_map([], |row| {
                Ok(Segment {
                    session_id: row.get(0)?,
                    forked_from: row.get(1)?,
                    card_id: row.get(2)?,
                    project_dir: row.get(3)?,
                    created_at: row.get(4)?,
                    last_used_at: row.get(5)?,
                    name: row.get(6)?,
                    name_user_set: row.get::<_, i64>(7)? != 0,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        // Union-find over the fork edge, read undirected.
        fn find(parent: &mut [usize], mut i: usize) -> usize {
            while parent[i] != i {
                parent[i] = parent[parent[i]];
                i = parent[i];
            }
            i
        }
        let index: HashMap<&str, usize> = segments
            .iter()
            .enumerate()
            .map(|(i, s)| (s.session_id.as_str(), i))
            .collect();
        let mut parent: Vec<usize> = (0..segments.len()).collect();
        for (i, segment) in segments.iter().enumerate() {
            let Some(from) = segment.forked_from.as_deref() else {
                continue;
            };
            let Some(&j) = index.get(from) else {
                continue;
            };
            let (a, b) = (find(&mut parent, i), find(&mut parent, j));
            if a != b {
                parent[a] = b;
            }
        }
        let mut components: HashMap<usize, Vec<usize>> = HashMap::new();
        for i in 0..segments.len() {
            let root = find(&mut parent, i);
            components.entry(root).or_default().push(i);
        }

        let now = now_millis();
        // The names are applied in a second pass: `lines_user_name` refuses a
        // duplicate at the write, and the rule for which line keeps a
        // contested spelling is "most recently used", not "inserted first".
        let mut claims: Vec<(i64, String, String)> = Vec::new();
        let mut created = 0usize;
        // Deterministic order, so a migration of one database is one answer.
        let mut ordered: Vec<Vec<usize>> = components.into_values().collect();
        for members in &mut ordered {
            members.sort_unstable();
        }
        ordered.sort_by(|a, b| segments[a[0]].session_id.cmp(&segments[b[0]].session_id));

        for members in ordered {
            let anchor = members
                .iter()
                .copied()
                .min_by_key(|&i| (segments[i].created_at, i))
                .expect("a component holds at least one segment");
            // The earliest spelling any segment of this line ever spent.
            let mut earliest: Option<(i64, String)> = None;
            for &i in &members {
                let minted: Option<(String, i64)> = conn
                    .query_row(
                        "SELECT tag, minted_at FROM minted_tags WHERE session_id = ?1
                         ORDER BY minted_at ASC, tag ASC LIMIT 1",
                        params![segments[i].session_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                let Some((tag, minted_at)) = minted else {
                    continue;
                };
                let better = match &earliest {
                    None => true,
                    Some((at, spelling)) => {
                        minted_at < *at || (minted_at == *at && tag < *spelling)
                    }
                };
                if better {
                    earliest = Some((minted_at, tag));
                }
            }
            let tag = match earliest {
                Some((_, tag)) => tag,
                None => {
                    let owner = &segments[anchor].session_id;
                    let mut attempt: u32 = 0;
                    let mut candidate = roll_fresh_tag(owner, now);
                    loop {
                        match claim_tag(conn, &candidate, owner, now)? {
                            TagClaim::Claimed => break candidate,
                            TagClaim::TakenByOther => {
                                candidate = reroll_or_fail(&candidate, owner, now, &mut attempt)?;
                            }
                        }
                    }
                }
            };
            let card_id = members
                .iter()
                .copied()
                .filter(|&i| {
                    segments[i]
                        .card_id
                        .as_deref()
                        .is_some_and(|c| !c.is_empty())
                })
                .max_by_key(|&i| (segments[i].last_used_at, i))
                .and_then(|i| segments[i].card_id.clone());
            let created_at = members
                .iter()
                .map(|&i| segments[i].created_at)
                .min()
                .unwrap_or(now);
            let last_used_at = members
                .iter()
                .map(|&i| segments[i].last_used_at)
                .max()
                .unwrap_or(now);
            let line_id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO lines (
                    line_id, tag, name, name_user_set, card_id,
                    project_dir, created_at, last_used_at
                 ) VALUES (?1, ?2, NULL, 0, ?3, ?4, ?5, ?6)",
                params![
                    line_id,
                    tag,
                    card_id,
                    segments[anchor].project_dir,
                    created_at,
                    last_used_at
                ],
            )?;
            created += 1;
            for &i in &members {
                conn.execute(
                    "UPDATE sessions SET line_id = ?2 WHERE session_id = ?1",
                    params![segments[i].session_id, line_id],
                )?;
                conn.execute(
                    "UPDATE minted_tags SET line_id = ?2 WHERE session_id = ?1",
                    params![segments[i].session_id, line_id],
                )?;
            }
            if let Some(i) = members
                .iter()
                .copied()
                .filter(|&i| segments[i].name_user_set && segments[i].name.is_some())
                .max_by_key(|&i| (segments[i].last_used_at, i))
            {
                let name = segments[i].name.clone().expect("filtered to Some");
                claims.push((segments[i].last_used_at, name, line_id));
            }
        }

        // Most recently used wins a contested spelling; every other claimant
        // simply keeps its callsign and no name.
        claims.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.2.cmp(&b.2)));
        let mut taken: HashSet<String> = HashSet::new();
        for (_, name, line_id) in claims {
            if !taken.insert(name.clone()) {
                continue;
            }
            conn.execute(
                "UPDATE lines SET name = ?2, name_user_set = 1 WHERE line_id = ?1",
                params![line_id, name],
            )?;
        }

        // Scanned sessions ([P07]): a spelling spent at scan time needs an
        // owner that exists, so every cache row wearing one gets a line —
        // its own, or the one its ledger row or an ancestor already has.
        if scan_has_tag {
            let scans: Vec<(String, String, Option<String>, String, i64, i64)> = {
                let mut stmt = conn.prepare(
                    "SELECT session_id, tag, lineage_ancestors, project_dir,
                            created_at, last_used_at
                     FROM external_scan_cache
                     WHERE tag IS NOT NULL
                     ORDER BY session_id",
                )?;
                let rows = stmt.query_map([], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                })?;
                rows.collect::<Result<Vec<_>, _>>()?
            };
            for (session_id, tag, ancestors, project_dir, created_at, last_used_at) in scans {
                let mut line_id: Option<String> = conn
                    .query_row(
                        "SELECT line_id FROM sessions WHERE session_id = ?1",
                        params![session_id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .flatten();
                if line_id.is_none() {
                    for ancestor in ancestors
                        .as_deref()
                        .unwrap_or_default()
                        .split(',')
                        .map(str::trim)
                        .filter(|id| !id.is_empty())
                    {
                        line_id = conn
                            .query_row(
                                "SELECT line_id FROM sessions WHERE session_id = ?1",
                                params![ancestor],
                                |row| row.get(0),
                            )
                            .optional()?
                            .flatten()
                            .or(conn
                                .query_row(
                                    "SELECT line_id FROM external_scan_cache WHERE session_id = ?1",
                                    params![ancestor],
                                    |row| row.get(0),
                                )
                                .optional()?
                                .flatten());
                        if line_id.is_some() {
                            break;
                        }
                    }
                }
                if line_id.is_none() {
                    line_id = conn
                        .query_row(
                            "SELECT line_id FROM lines WHERE tag = ?1",
                            params![tag],
                            |row| row.get(0),
                        )
                        .optional()?;
                }
                let line_id = match line_id {
                    Some(id) => id,
                    None => {
                        let id = uuid::Uuid::new_v4().to_string();
                        conn.execute(
                            "INSERT INTO minted_tags (tag, line_id, session_id, minted_at)
                             VALUES (?1, ?2, ?3, ?4)
                             ON CONFLICT(tag) DO NOTHING",
                            params![tag, id, session_id, created_at],
                        )?;
                        conn.execute(
                            "INSERT INTO lines (
                                line_id, tag, name, name_user_set, card_id,
                                project_dir, created_at, last_used_at
                             ) VALUES (?1, ?2, NULL, 0, NULL, ?3, ?4, ?5)",
                            params![id, tag, project_dir, created_at, last_used_at],
                        )?;
                        created += 1;
                        id
                    }
                };
                conn.execute(
                    "UPDATE external_scan_cache SET line_id = ?2 WHERE session_id = ?1",
                    params![session_id, line_id],
                )?;
                conn.execute(
                    "UPDATE minted_tags SET line_id = ?2 WHERE tag = ?1",
                    params![tag, line_id],
                )?;
            }
        }

        // A spelling whose session left both tables still has to resolve, so it
        // gets a card-less line wearing it and nothing else.
        let orphans: Vec<(String, i64)> = {
            let mut stmt = conn.prepare(
                "SELECT tag, minted_at FROM minted_tags WHERE line_id IS NULL ORDER BY tag",
            )?;
            let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for (tag, minted_at) in orphans {
            let owner: Option<String> = conn
                .query_row(
                    "SELECT line_id FROM lines WHERE tag = ?1",
                    params![tag],
                    |row| row.get(0),
                )
                .optional()?;
            let line_id = match owner {
                Some(id) => id,
                None => {
                    let id = uuid::Uuid::new_v4().to_string();
                    conn.execute(
                        "INSERT INTO lines (
                            line_id, tag, name, name_user_set, card_id,
                            project_dir, created_at, last_used_at
                         ) VALUES (?1, ?2, NULL, 0, NULL, '', ?3, ?3)",
                        params![id, tag, minted_at],
                    )?;
                    created += 1;
                    id
                }
            };
            conn.execute(
                "UPDATE minted_tags SET line_id = ?2 WHERE tag = ?1",
                params![tag, line_id],
            )?;
        }

        // The invariants this migration exists to establish, checked before it
        // is allowed to become permanent.
        let assert_empty = |sql: &str, what: &str| -> Result<(), LedgerError> {
            let count: i64 = conn.query_row(sql, [], |row| row.get(0))?;
            if count != 0 {
                return Err(LedgerError::MigrationFailed(format!(
                    "{count} {what} after assigning lines"
                )));
            }
            Ok(())
        };
        assert_empty(
            "SELECT COUNT(*) FROM sessions WHERE line_id IS NULL",
            "session rows still have no line",
        )?;
        assert_empty(
            "SELECT COUNT(*) FROM minted_tags WHERE line_id IS NULL",
            "minted spellings still have no line",
        )?;
        assert_empty(
            "SELECT COUNT(*) FROM (
                SELECT name FROM lines WHERE name_user_set = 1
                GROUP BY name HAVING COUNT(*) > 1
             )",
            "user-set names are worn by more than one line",
        )?;

        conn.execute_batch("DROP INDEX IF EXISTS sessions_tag")?;
        if has_tag {
            conn.execute("ALTER TABLE sessions DROP COLUMN tag", [])?;
        }
        if has_name {
            conn.execute("ALTER TABLE sessions DROP COLUMN name", [])?;
        }
        if has_name_user_set {
            conn.execute("ALTER TABLE sessions DROP COLUMN name_user_set", [])?;
        }
        if scan_has_tag {
            conn.execute("ALTER TABLE external_scan_cache DROP COLUMN tag", [])?;
        }
        // The retired lineage-suffix allocator. Nothing composes from it, and
        // the migration that used to drop it left with the grammar it served.
        conn.execute_batch("DROP TABLE IF EXISTS tag_lineage_points")?;
        Ok(created)
    }

    /// Self-healing add of the `sessions.synopsis` column ([P07], [Q02]).
    ///
    /// The description is per-session ledger state exactly like `name`, so it
    /// lives beside it rather than in tugbank (whose defaults are per-user
    /// knobs, not per-session data). Pre-column rows read `NULL` — no
    /// description — and acquire one the next time the Summarize lane runs for
    /// them. No-op on a fresh DB (the CREATE TABLE defines it) or when already
    /// migrated.
    fn migrate_sessions_add_synopsis(conn: &Connection) -> Result<(), LedgerError> {
        let cols = Self::table_columns(conn, "sessions")?;
        if cols.is_empty() {
            return Ok(());
        }
        if !cols.iter().any(|(n, _)| n == "synopsis") {
            match conn.execute("ALTER TABLE sessions ADD COLUMN synopsis TEXT", []) {
                Ok(_) => {}
                Err(err) if is_duplicate_column(&err) => {}
                Err(err) => return Err(err.into()),
            }
        }
        Ok(())
    }

    /// Self-healing add of the `sessions.dash_id` / `sessions.dash_name`
    /// columns — the session↔dash binding ([P01], Spec S03). Pre-column rows
    /// read `NULL` (unbound), which is exactly what they were. No-op on a
    /// fresh DB (the CREATE TABLE defines both) or when already migrated.
    fn migrate_sessions_add_dash_binding(conn: &Connection) -> Result<(), LedgerError> {
        let cols = Self::table_columns(conn, "sessions")?;
        if cols.is_empty() {
            return Ok(());
        }
        for column in ["dash_id", "dash_name"] {
            if cols.iter().any(|(n, _)| n == column) {
                continue;
            }
            match conn.execute(
                &format!("ALTER TABLE sessions ADD COLUMN {column} TEXT"),
                [],
            ) {
                Ok(_) => {}
                Err(err) if is_duplicate_column(&err) => {}
                Err(err) => return Err(err.into()),
            }
        }
        Ok(())
    }

    /// Self-healing add of the `pulse_lines.intent` column — the retained
    /// high-level thought behind a low-level beat ("intent • action" in
    /// the strip). Pre-column rows read `NULL` (no intent), which is
    /// exactly what they carried. No-op on a fresh DB (the CREATE TABLE
    /// defines it) or when already migrated.
    fn migrate_pulse_lines_add_intent(conn: &Connection) -> Result<(), LedgerError> {
        let cols = Self::table_columns(conn, "pulse_lines")?;
        if cols.is_empty() {
            return Ok(());
        }
        if !cols.iter().any(|(n, _)| n == "intent") {
            conn.execute("ALTER TABLE pulse_lines ADD COLUMN intent TEXT", [])?;
        }
        Ok(())
    }

    /// Drop the `pulse_overviews` cache and its cascade trigger.
    ///
    /// The table held one latest-per-scope row so a card could come back from
    /// a relaunch still wearing the sentence it had been given. Neither that
    /// sentence nor the deck map it restored into exists any more, so what is
    /// left on disk is a cache with no writer and no reader.
    ///
    /// A drop rather than a rename, and with no write-lock guard: both
    /// statements are idempotent, and the concurrent-open hazard
    /// {@link migrate_gazette_posts_to_overview_posts} takes `BEGIN IMMEDIATE`
    /// for belongs to a rename carrying permanent history. Nothing here was
    /// worth carrying — the cost of losing a row was always one blank line
    /// until the next write.
    ///
    /// Deletable once no installation predates this release.
    fn migrate_drop_pulse_overviews(conn: &Connection) -> Result<(), LedgerError> {
        conn.execute_batch(
            "
            DROP TRIGGER IF EXISTS pulse_overviews_cascade_delete_on_session;
            DROP TABLE IF EXISTS pulse_overviews;
            ",
        )?;
        Ok(())
    }

    /// Carry a database written before the channel was renamed forward:
    /// `gazette_posts` becomes `overview_posts`, and the author value
    /// `'reporter'` becomes `'observer'`.
    ///
    /// The base table moves by `ALTER TABLE … RENAME TO`, never a
    /// drop-and-recreate — it is permanent history. The FTS5 shadow tables
    /// are the opposite case (see the CREATE): `content='gazette_posts'` is
    /// baked into the stored virtual-table definition and the three triggers
    /// name both tables in their bodies, so none of them can be renamed in
    /// place. They are dropped, recreated under the new names, and rebuilt
    /// from the finished content in one pass.
    ///
    /// Order matters twice. The triggers come off before the author `UPDATE`,
    /// or every updated row fires the update trigger and writes two FTS
    /// command rows for an index that is about to be rebuilt anyway. And the
    /// whole function runs before the `CREATE TABLE IF NOT EXISTS` batch: an
    /// `overview_posts` created first would make the guard below find a table
    /// already present and no-op, stranding every existing post in an
    /// orphaned `gazette_posts` nothing reads.
    ///
    /// The guard reads inside the same write transaction that acts on it.
    /// Two processes opening the same ledger at once — which the integration
    /// suite does routinely — would otherwise both see `gazette_posts` and
    /// both try to rename it, and the loser would fail on a table the winner
    /// had already moved. `BEGIN IMMEDIATE` takes the write lock before the
    /// guard reads, so the second process reads the migrated world.
    ///
    /// Deletable once no installation predates the rename.
    fn migrate_gazette_posts_to_overview_posts(conn: &Connection) -> Result<(), LedgerError> {
        conn.execute_batch("BEGIN IMMEDIATE;")?;
        let result = Self::rename_gazette_posts_within_transaction(conn);
        if result.is_err() {
            let _ = conn.execute_batch("ROLLBACK;");
            return result;
        }
        conn.execute_batch("COMMIT;")?;
        Ok(())
    }

    /// The body of {@link migrate_gazette_posts_to_overview_posts}, run with
    /// the write lock already held.
    fn rename_gazette_posts_within_transaction(conn: &Connection) -> Result<(), LedgerError> {
        // Fresh database, or already migrated. The guard is the presence of
        // the OLD table, never the absence of the new one.
        if Self::table_columns(conn, "gazette_posts")?.is_empty() {
            return Ok(());
        }
        conn.execute_batch(
            "
            DROP TRIGGER IF EXISTS gazette_posts_fts_insert;
            DROP TRIGGER IF EXISTS gazette_posts_fts_delete;
            DROP TRIGGER IF EXISTS gazette_posts_fts_update;
            DROP TABLE IF EXISTS gazette_posts_fts;

            ALTER TABLE gazette_posts RENAME TO overview_posts;

            DROP INDEX IF EXISTS gazette_posts_session;
            CREATE INDEX IF NOT EXISTS overview_posts_session
                ON overview_posts(session_id);

            UPDATE overview_posts SET author = 'observer' WHERE author = 'reporter';

            CREATE VIRTUAL TABLE IF NOT EXISTS overview_posts_fts USING fts5(
                body,
                refs,
                tokens,
                content='overview_posts',
                content_rowid='id'
            );

            CREATE TRIGGER IF NOT EXISTS overview_posts_fts_insert
            AFTER INSERT ON overview_posts
            BEGIN
                INSERT INTO overview_posts_fts (rowid, body, refs, tokens)
                VALUES (new.id, new.body, new.refs, new.tokens);
            END;

            CREATE TRIGGER IF NOT EXISTS overview_posts_fts_delete
            AFTER DELETE ON overview_posts
            BEGIN
                INSERT INTO overview_posts_fts (overview_posts_fts, rowid, body, refs, tokens)
                VALUES ('delete', old.id, old.body, old.refs, old.tokens);
            END;

            CREATE TRIGGER IF NOT EXISTS overview_posts_fts_update
            AFTER UPDATE ON overview_posts
            BEGIN
                INSERT INTO overview_posts_fts (overview_posts_fts, rowid, body, refs, tokens)
                VALUES ('delete', old.id, old.body, old.refs, old.tokens);
                INSERT INTO overview_posts_fts (rowid, body, refs, tokens)
                VALUES (new.id, new.body, new.refs, new.tokens);
            END;

            INSERT INTO overview_posts_fts (overview_posts_fts) VALUES ('rebuild');
            ",
        )?;
        Ok(())
    }

    /// Self-healing add of `overview_posts.elapsed_ms` — how long the agent
    /// turn that wrote a post took. ALTER-based, never a rebuild: the table
    /// is permanent history and the drop-and-recreate guard would be total
    /// data loss on it (see the CREATE). Pre-column rows read `NULL`, which
    /// is honest — nobody clocked them. No-op on a fresh DB (the CREATE
    /// defines the column) or when already migrated.
    fn migrate_overview_posts_add_elapsed_ms(conn: &Connection) -> Result<(), LedgerError> {
        let cols = Self::table_columns(conn, "overview_posts")?;
        if cols.is_empty() {
            return Ok(());
        }
        if !cols.iter().any(|(n, _)| n == "elapsed_ms") {
            conn.execute(
                "ALTER TABLE overview_posts ADD COLUMN elapsed_ms INTEGER",
                [],
            )?;
        }
        Ok(())
    }

    /// Self-healing add of `overview_posts.project_dir` — the root the post's
    /// refs resolve against. Same ALTER-only posture as `elapsed_ms`, for the
    /// same reason: the table is permanent history. Pre-column rows read
    /// `NULL`, and their refs render inert rather than against a guessed root.
    fn migrate_overview_posts_add_project_dir(conn: &Connection) -> Result<(), LedgerError> {
        let cols = Self::table_columns(conn, "overview_posts")?;
        if cols.is_empty() {
            return Ok(());
        }
        if !cols.iter().any(|(n, _)| n == "project_dir") {
            conn.execute("ALTER TABLE overview_posts ADD COLUMN project_dir TEXT", [])?;
        }
        Ok(())
    }

    /// Self-healing add of `overview_posts.attachments` — the images a user
    /// attached to a question, as a JSON array of `{path, media_type}`. Same
    /// ALTER-only posture as the two above, for the same reason: the table is
    /// permanent history. Pre-column rows read `NULL`, which decodes to no
    /// attachments — honest, since nobody could attach one before the column
    /// existed.
    fn migrate_overview_posts_add_attachments(conn: &Connection) -> Result<(), LedgerError> {
        let cols = Self::table_columns(conn, "overview_posts")?;
        if cols.is_empty() {
            return Ok(());
        }
        if !cols.iter().any(|(n, _)| n == "attachments") {
            conn.execute("ALTER TABLE overview_posts ADD COLUMN attachments TEXT", [])?;
        }
        Ok(())
    }

    /// Self-healing add of the scan cache's incremental-parse columns
    /// (`parse_offset`, `tail_hash`, `cwd_checked`, `created_at_found`).
    /// Pre-existing rows get `parse_offset = 0` — no resumable state, so
    /// their next change re-streams the whole file once and records a
    /// fresh frontier. No-op on a fresh DB (the CREATE TABLE defines the
    /// columns directly) or when already migrated.
    fn migrate_scan_cache_add_resume_columns(conn: &Connection) -> Result<(), LedgerError> {
        let cols = Self::table_columns(conn, "external_scan_cache")?;
        if cols.is_empty() {
            return Ok(());
        }
        for (name, decl) in [
            ("parse_offset", "INTEGER NOT NULL DEFAULT 0"),
            ("tail_hash", "INTEGER NOT NULL DEFAULT 0"),
            ("cwd_checked", "INTEGER NOT NULL DEFAULT 0"),
            ("created_at_found", "INTEGER NOT NULL DEFAULT 0"),
            // The turn-rule epoch. DEFAULT 0 (not CURRENT) is load-bearing:
            // every row that predates the canonical rule is stamped 0 and so
            // fails the `rule_epoch == CURRENT_RULE_EPOCH` gate at every cache
            // read, forcing a faithful re-scan. A `DEFAULT CURRENT` here would
            // make stale rows match the gate and self-defeat.
            ("rule_epoch", "INTEGER NOT NULL DEFAULT 0"),
            // Engine frontier columns (epoch 2). A pre-existing row gets a
            // zero/empty frontier, but it also fails the epoch gate, so its
            // file re-streams in full once and records a real frontier.
            ("frontier_open", "INTEGER NOT NULL DEFAULT 0"),
            ("frontier_pending_close", "INTEGER NOT NULL DEFAULT 0"),
            ("frontier_pending_close_msg_id", "TEXT"),
            // Epoch 3: the chain leaf uuid at the frontier.
            ("frontier_leaf_uuid", "TEXT"),
            // Epoch 4: the effective chain uuid set at the frontier, and
            // the embedded pre-rotation lineage.
            ("effective_uuids", "BLOB"),
            ("lineage_ancestors", "TEXT"),
            // `tag` is deliberately absent: `migrate_sessions_to_lines` drops
            // it, and a self-healing add here would put it back on the next
            // open, dead, forever. The line the row belongs to arrives through
            // `migrate_scan_cache_add_line_id` instead ([P07]).
        ] {
            if !cols.iter().any(|(n, _)| n == name) {
                // The column set was read once, before the loop; two processes
                // opening the same database can both see it missing and both
                // ALTER. The loser gets `duplicate column name`, which means
                // the column is there — the outcome this call wanted.
                match conn.execute(
                    &format!("ALTER TABLE external_scan_cache ADD COLUMN {name} {decl}"),
                    [],
                ) {
                    Ok(_) => {}
                    Err(err) if is_duplicate_column(&err) => {}
                    Err(err) => return Err(err.into()),
                }
            }
        }
        Ok(())
    }

    /// Add the derived `tokens` column to a ledger created before it
    /// existed. The values are filled after the schema batch, by
    /// {@link backfill_search_tokens}.
    fn migrate_facts_add_tokens(conn: &Connection) -> Result<(), LedgerError> {
        Self::add_tokens_column(conn, "facts")
    }

    /// The `overview_posts` half of {@link migrate_facts_add_tokens}.
    fn migrate_overview_posts_add_tokens(conn: &Connection) -> Result<(), LedgerError> {
        Self::add_tokens_column(conn, "overview_posts")
    }

    fn add_tokens_column(conn: &Connection, table: &str) -> Result<(), LedgerError> {
        let cols = Self::table_columns(conn, table)?;
        // Absent means fresh: the batch creates the table with the column.
        if cols.is_empty() || cols.iter().any(|(name, _)| name == "tokens") {
            return Ok(());
        }
        match conn.execute(&format!("ALTER TABLE {table} ADD COLUMN tokens TEXT"), []) {
            Ok(_) => Ok(()),
            // The column set was read before the ALTER; two processes opening
            // the same database can both see it missing and both try. The
            // loser gets `duplicate column name`, which means the column is
            // there — the outcome this call wanted.
            Err(err) if is_duplicate_column(&err) => Ok(()),
            Err(err) => Err(err.into()),
        }
    }

    /// Drop a derived FTS5 index — and the three triggers that feed it —
    /// when its column set no longer matches `expected`.
    ///
    /// Separate from {@link rebuild_table_if_schema_drifted} for one
    /// reason: an external-content FTS5 index is kept in step by triggers,
    /// and `CREATE TRIGGER IF NOT EXISTS` does **not** replace an existing
    /// trigger. Dropping the index alone would leave the old ones in place
    /// and the schema batch would not overwrite them, so a two-column
    /// `facts_fts_insert` would go on writing two columns into the
    /// recreated three-column index — a half-populated `tokens` with no
    /// error anywhere.
    ///
    /// `fts_table` MUST be `main.`-qualified, for the reason the
    /// `main.file_events` guard is: on a connection with the shared
    /// `changes` database attached, an unqualified name resolves into the
    /// attachment when the local table is absent.
    ///
    /// Returns whether it dropped anything — half the rebuild condition in
    /// {@link backfill_search_tokens}.
    fn rebuild_fts_if_columns_drifted(
        conn: &Connection,
        fts_table: &str,
        expected: &[&str],
    ) -> Result<bool, LedgerError> {
        let actual = Self::table_columns(conn, fts_table)?;
        if actual.is_empty() {
            return Ok(false);
        }
        let current = actual.len() == expected.len()
            && actual
                .iter()
                .zip(expected)
                .all(|((name, _), want)| name.as_str() == *want);
        if current {
            return Ok(false);
        }
        let (schema, bare) = fts_table.split_once('.').unwrap_or(("main", fts_table));
        for suffix in ["insert", "delete", "update"] {
            conn.execute_batch(&format!("DROP TRIGGER IF EXISTS {schema}.{bare}_{suffix};"))?;
        }
        conn.execute_batch(&format!("DROP TABLE {fts_table};"))?;
        Ok(true)
    }

    /// Re-derive whichever FTS index was just dropped, then fill `tokens` on
    /// the rows that predate the column.
    ///
    /// **The rebuild comes first, and the order is not cosmetic.** A dropped
    /// index is recreated empty by the schema batch, while the sync triggers
    /// are live again the moment the batch runs. Backfilling into that state
    /// makes every `UPDATE` fire the update trigger's external-content
    /// `'delete'` command against an index entry that does not exist, and
    /// FTS5 answers a delete it cannot reconcile with `database disk image is
    /// malformed`. Rebuilding first puts the index back in step with the
    /// content table, after which the triggers keep it there through the
    /// backfill — `old.tokens` is genuinely what was indexed — and no second
    /// rebuild is needed.
    ///
    /// That ordering also closes the crash window on its own. A process that
    /// dies mid-backfill leaves an index that is *consistent* rather than
    /// half-garbage, and the rows still holding NULL are picked up by the next
    /// open, because the backfill is scoped by `tokens IS NULL` rather than by
    /// a one-shot flag.
    fn backfill_search_tokens(
        conn: &Connection,
        facts_fts_dropped: bool,
        posts_fts_dropped: bool,
    ) -> Result<(), LedgerError> {
        if facts_fts_dropped {
            conn.execute_batch("INSERT INTO facts_fts (facts_fts) VALUES ('rebuild');")?;
        }
        if posts_fts_dropped {
            conn.execute_batch(
                "INSERT INTO overview_posts_fts (overview_posts_fts) VALUES ('rebuild');",
            )?;
        }

        let tx = conn.unchecked_transaction()?;
        Self::backfill_tokens_for(&tx, "facts", "subject", "text")?;
        Self::backfill_tokens_for(&tx, "overview_posts", "body", "refs")?;
        tx.commit()?;
        Ok(())
    }

    /// Derive `tokens` for every row of `table` still holding NULL.
    fn backfill_tokens_for(
        conn: &Connection,
        table: &str,
        first: &str,
        second: &str,
    ) -> Result<(), LedgerError> {
        let cols = Self::table_columns(conn, table)?;
        if !cols.iter().any(|(name, _)| name == "tokens") {
            return Ok(());
        }
        let mut stmt = conn.prepare(&format!(
            "SELECT id, {first}, {second} FROM {table} WHERE tokens IS NULL"
        ))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if rows.is_empty() {
            return Ok(());
        }
        let mut update = conn.prepare(&format!("UPDATE {table} SET tokens = ?1 WHERE id = ?2"))?;
        for (id, first, second) in &rows {
            update.execute(params![
                subword_tokens(&[first.as_str(), second.as_str()]),
                id
            ])?;
        }
        Ok(())
    }

    /// Drop `table` when its on-disk column set no longer matches
    /// `expected` — the [DM08] delete-and-recreate, made automatic.
    /// No-op when the table is absent (the `CREATE TABLE IF NOT EXISTS`
    /// will build it fresh) or already matches. See the call site in
    /// {@link bootstrap_schema} for the rationale.
    fn rebuild_table_if_schema_drifted(
        conn: &Connection,
        table: &str,
        expected: &[(&str, &str)],
    ) -> Result<(), LedgerError> {
        let actual = Self::table_columns(conn, table)?;
        if actual.is_empty() {
            return Ok(());
        }
        let matches = actual.len() == expected.len()
            && actual
                .iter()
                .zip(expected)
                .all(|((an, at), (en, et))| an.as_str() == *en && at.as_str() == *et);
        if !matches {
            // Dropping the table also drops its indexes; the
            // cascade trigger lives on `sessions` and survives. The
            // batch below recreates table + index.
            conn.execute(&format!("DROP TABLE {table}"), [])?;
        }
        Ok(())
    }

    /// All rows in the workspace, ordered newest-first by `last_used_at`.
    pub fn list_for_workspace(&self, workspace_key: &str) -> Result<Vec<SessionRow>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(&format!(
            "SELECT {SESSION_COLUMNS} FROM {SESSIONS_JOINED}
             WHERE s.workspace_key = ?1
             ORDER BY s.last_used_at DESC"
        ))?;
        let rows = stmt
            .query_map(params![workspace_key], row_from_query)?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().collect()
    }

    /// All rows whose `project_dir` matches `project_dir` literally,
    /// ordered newest-first by `last_used_at`. The picker uses this for
    /// its "what sessions did I have under this typed path?" query — the
    /// raw user-typed path matches the value originally recorded at
    /// `record_spawn` time, so no client-side canonicalization is needed.
    /// `list_for_workspace` matches against the canonical key and stays
    /// for the supervisor's resume-resolution path.
    ///
    /// **Line-first, not session-first.** The listing enumerates the lines of
    /// work in this directory and attaches their segments, rather than walking
    /// `sessions` and hoping a line hangs off each row. The difference shows up
    /// in exactly one case and it is the case that matters: a line the user
    /// named whose every segment has gone. The name is on `lines` and intact,
    /// but a session-first listing cannot reach it, so the line reads as
    /// deleted although nothing deleted it. Here it is a row, under its own
    /// name.
    ///
    /// The stranded row's session id comes from `minted_tags`, which recorded
    /// the pairing when the callsign was claimed and is append-only (Spec S08),
    /// so this is a join to a durable record rather than a guess. A named line
    /// no tag was ever minted for yields no row: there is nothing to resume
    /// into and nothing to point at, and a row that names neither is worse
    /// than an honest absence.
    pub fn list_for_project_dir(&self, project_dir: &str) -> Result<Vec<SessionRow>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(&format!(
            "SELECT {SESSION_COLUMNS} FROM {SESSIONS_JOINED}
             WHERE s.project_dir = ?1
             UNION ALL
             SELECT m.session_id, l.project_dir, l.project_dir, l.created_at,
                    l.last_used_at, 0, NULL, 'closed', NULL,
                    l.name, l.name_user_set, l.tag, NULL, 0, NULL, NULL, l.line_id
             FROM lines l
             JOIN minted_tags m ON m.line_id = l.line_id
             WHERE l.project_dir = ?1
               AND l.name_user_set = 1
               AND NOT EXISTS (
                   SELECT 1 FROM sessions s2 WHERE s2.line_id = l.line_id
               )
               -- One row per stranded line: the newest mint the line has,
               -- picked by rowid so a tie in `minted_at` cannot double it.
               AND m.rowid = (
                   SELECT MAX(m2.rowid) FROM minted_tags m2
                   WHERE m2.line_id = l.line_id
               )
             ORDER BY last_used_at DESC"
        ))?;
        let rows = stmt
            .query_map(params![project_dir], row_from_query)?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().collect()
    }

    /// All non-failed rows that carry a `card_id`, ordered newest-first
    /// by `last_used_at`. The client-side restore consumes this through
    /// the `list_card_bindings` CONTROL verb: for each session card in the
    /// deck, the most recent matching row drives either
    /// `spawn_session(mode=resume)` (if `turn_count > 0`, i.e. claude
    /// has a JSONL on disk) or `spawn_session(mode=new)` with a fresh
    /// session id but the same `project_dir` (if `turn_count == 0`,
    /// the card was bound to a project but no real conversation
    /// happened). Either way the card opens to its bound project on
    /// relaunch — no picker, no misleading "Couldn't resume" banner.
    ///
    /// Filters:
    ///
    /// - `card_id IS NOT NULL` — the row was spawned through a dev
    ///   card path (not a headless test).
    /// - `state != 'failed'` — failed rows are known-unrecoverable.
    pub fn list_with_card_id(&self) -> Result<Vec<SessionRow>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(&format!(
            "SELECT {SESSION_COLUMNS} FROM {SESSIONS_JOINED}
             WHERE s.card_id IS NOT NULL
               AND s.state != 'failed'
             ORDER BY s.last_used_at DESC"
        ))?;
        let rows = stmt
            .query_map([], row_from_query)?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().collect()
    }

    /// Sessions ordered newest-first by `last_used_at`, optionally bounded by
    /// a `last_used_at` range and narrowed to the live ones. Backs the
    /// Operator's `sessions.list` verb — "what was I working on last Tuesday".
    ///
    /// Failed rows are included: a session that died is still part of the
    /// history a question can be about, and the `state` travels with the row
    /// so the answer can say so.
    pub fn list_sessions_recent(
        &self,
        since_ms: Option<i64>,
        until_ms: Option<i64>,
        active_only: bool,
        limit: usize,
    ) -> Result<Vec<SessionRow>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(&format!(
            "SELECT {SESSION_COLUMNS} FROM {SESSIONS_JOINED}
             WHERE (?1 IS NULL OR s.last_used_at >= ?1)
               AND (?2 IS NULL OR s.last_used_at <= ?2)
               AND (?3 = 0 OR s.state = 'live')
               -- The Overview's only reader of this list is the Operator, and a
               -- private session is out of the channel ([P05]). The chooser and
               -- the recents surface read their rows elsewhere and still see it.
               AND s.private = 0
             ORDER BY s.last_used_at DESC
             LIMIT ?4"
        ))?;
        let rows = stmt
            .query_map(
                params![since_ms, until_ms, active_only as i64, limit as i64],
                row_from_query,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().collect()
    }

    /// Look up a single row by session id.
    pub fn get(&self, session_id: &str) -> Result<Option<SessionRow>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(&format!(
            "SELECT {SESSION_COLUMNS} FROM {SESSIONS_JOINED}
             WHERE s.session_id = ?1
             LIMIT 1"
        ))?;
        let row = stmt
            .query_row(params![session_id], row_from_query)
            .optional()?;
        match row {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    /// Resolve citation ids to the rows they name ([D132]) — the server-side
    /// answer to "does this ledger hold the session that commit cited?".
    ///
    /// Each requested spelling is a full session uuid (an exact lookup), the
    /// 8-char short id a `Tug-Session:` citation records (a prefix lookup), or a
    /// **callsign** (an exact match on `tag`). The prefix arm demands a
    /// **unique** match: two rows sharing eight hex chars resolve to nothing
    /// rather than to the first one found, because a citation that resolves to
    /// the wrong session is the confidently-wrong answer [D132] calls strictly
    /// worse than an unresolvable one; the callsign arm demands the same, though
    /// the mint arbiter makes a duplicate tag a repair case rather than a race.
    /// Anything that is none of the three shapes is skipped — the caller's
    /// grammar already refused it, and this is not the place to invent a
    /// spelling.
    ///
    /// The callsign arm is what a **session atom** resolves through. An atom
    /// carries `<project>/<callsign>` and no id — the wire marker a submitted
    /// prompt records carries the same, so a replayed transcript has only the
    /// callsign to go on — and a chip that cannot reach an id cannot show a live
    /// dot or track a rename. Answering the callsign here rather than from the
    /// client's tag cache is the same decision [D132] already made for ids: the
    /// ledger can see every session, and a cache can only see what this run
    /// happened to mention.
    ///
    /// Answers from `sessions` first, then from `external_scan_cache`. A
    /// citation is written by a commit made from a Tug session, which is a
    /// `sessions` row at commit time — but `sessions` rows are hard-deleted by
    /// the age sweep and by trash, while the transcript stays on disk and
    /// the picker keeps listing it from the scan cache. A citation must not go
    /// dark on a session the picker can still resume, so an id the `sessions`
    /// table cannot answer falls back to the scan cache, synthesized the same
    /// way the picker union synthesizes an external row (`Closed`, no card, a
    /// scanned `aiTitle` never a rename, no synopsis). An ambiguous prefix in
    /// either table is still a refusal, never a guess.
    ///
    /// Ids absent from the result are absent from the ledger — a negative
    /// answer the client caches, so an unresolvable citation is a fact rather
    /// than a symptom of which listings happened to run.
    ///
    /// A citation names a **line of work**, so a callsign resolves to the
    /// line's seat segment rather than to whichever segment happened to spend
    /// the spelling, and a short id resolves by line uuid as well as by
    /// session uuid — the parenthesized token in a `Tug-Session:` trailer is
    /// the line's eight characters ([P13]). The identity on every row is the
    /// line's already, by the join, so nothing is resolved through afterwards.
    pub fn resolve_session_ids(
        &self,
        ids: &[String],
    ) -> Result<Vec<(String, SessionRow)>, LedgerError> {
        self.resolve_session_id_rows(ids)
    }

    /// [`Self::resolve_session_ids`] before the line-identity pass — the
    /// resolution proper, holding the connection for its whole run.
    fn resolve_session_id_rows(
        &self,
        ids: &[String],
    ) -> Result<Vec<(String, SessionRow)>, LedgerError> {
        // The scan cache's own columns, projected into the same row shape the
        // picker union synthesizes for an unadopted session.
        const SCAN_COLUMNS: &str = "c.session_id, c.project_dir, c.created_at, c.last_used_at,
                    c.turn_count, c.last_user_prompt, c.name, l.tag, c.line_id";
        const SCAN_JOINED: &str =
            "external_scan_cache c LEFT JOIN lines l ON l.line_id = c.line_id";
        fn scan_row_from_query(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionRow> {
            let project_dir: String = row.get(1)?;
            Ok(SessionRow {
                session_id: row.get(0)?,
                workspace_key: encode_claude_project_name(&project_dir),
                project_dir,
                created_at: row.get(2)?,
                last_used_at: row.get(3)?,
                turn_count: row.get(4)?,
                last_user_prompt: row.get(5)?,
                state: SessionState::Closed,
                card_id: None,
                name: row.get(6)?,
                name_user_set: false,
                tag: row.get(7)?,
                synopsis: None,
                // An unadopted scan row has no `sessions` row to carry a flag,
                // and an absent row reads as public everywhere else too.
                private: false,
                // Nor a binding: a dash is bound by a live session, and this
                // row has no session in the ledger at all.
                dash_id: None,
                dash_name: None,
                line_id: row.get::<_, Option<String>>(8)?.unwrap_or_default(),
            })
        }
        let conn = self.db.lock().expect("ledger mutex");
        let mut exact = conn.prepare(&format!(
            "SELECT {SESSION_COLUMNS} FROM {SESSIONS_JOINED} WHERE s.session_id = ?1 LIMIT 1"
        ))?;
        // `LIMIT 2` is the ambiguity probe: one row is an answer, two are a
        // refusal. The pattern is safe to interpolate into LIKE because the
        // short-id shape is validated first — eight hex chars carry no `%`/`_`.
        let mut prefixed = conn.prepare(&format!(
            "SELECT {SESSION_COLUMNS} FROM {SESSIONS_JOINED}
             WHERE s.session_id LIKE ?1 || '%' LIMIT 2"
        ))?;
        // The same eight characters, read as a line's. A `Tug-Session:`
        // trailer parenthesizes the **line's** short id, so this is the arm a
        // citation written by this build resolves through; the segment-prefix
        // arm above answers every trailer written before it.
        let mut line_prefixed = conn.prepare(&format!(
            "SELECT {SESSION_COLUMNS} FROM {SESSIONS_JOINED}
             WHERE s.line_id IN (SELECT line_id FROM lines WHERE line_id LIKE ?1 || '%')
               AND s.state != 'failed'
             {RESUME_SEGMENT_ORDER}
             LIMIT 1"
        ))?;
        let mut scan_exact = conn.prepare(&format!(
            "SELECT {SCAN_COLUMNS} FROM {SCAN_JOINED}
             WHERE c.session_id = ?1 AND c.excluded = 0 LIMIT 1"
        ))?;
        let mut scan_prefixed = conn.prepare(&format!(
            "SELECT {SCAN_COLUMNS} FROM {SCAN_JOINED}
             WHERE c.session_id LIKE ?1 || '%' AND c.excluded = 0 LIMIT 2"
        ))?;
        // The callsign arms. A callsign names a line, and `lines.tag` is
        // UNIQUE, so there is no ambiguity to probe for on the ledger side:
        // the answer is that line's seat segment. The scan cache still gets
        // the `LIMIT 2` probe, because several scanned files can belong to one
        // line and no index says which of them the citation meant.
        let mut tagged = conn.prepare(&format!(
            "SELECT {SESSION_COLUMNS} FROM {SESSIONS_JOINED}
             WHERE l.tag = ?1 AND s.state != 'failed'
             {RESUME_SEGMENT_ORDER}
             LIMIT 1"
        ))?;
        let mut scan_tagged = conn.prepare(&format!(
            "SELECT {SCAN_COLUMNS} FROM {SCAN_JOINED}
             WHERE l.tag = ?1 AND c.excluded = 0 LIMIT 2"
        ))?;
        // The alias arm: a spelling nothing wears anymore but the arbiter
        // remembers ([P08]). Every spelling a line ever spent — the retired
        // lineage-suffix chains, the pair a stage rotation used to roll for
        // itself — points at that line, so a legacy citation
        // (`stocky-pixie-A1-B2` in an old commit trailer) still resolves to
        // the same conversation.
        let mut minted_alias = conn.prepare(&format!(
            "SELECT {SESSION_COLUMNS} FROM {SESSIONS_JOINED}
             WHERE s.line_id = (SELECT line_id FROM minted_tags WHERE tag = ?1)
               AND s.state != 'failed'
             {RESUME_SEGMENT_ORDER}
             LIMIT 1"
        ))?;
        let mut seen = HashSet::new();
        let mut resolved = Vec::new();
        for id in ids {
            let queried = id.trim();
            if queried.is_empty() || !seen.insert(queried.to_owned()) {
                continue;
            }
            let needle = queried.to_ascii_lowercase();
            let full = is_full_session_uuid(&needle);
            let short = !full && is_short_session_id(&needle);
            // The callsign matches on the spelling as asked: an id is hex and
            // case-free, a callsign carries a capital in every fork segment.
            let callsign = !full && !short && is_session_callsign(queried);
            let rows = if full {
                exact
                    .query_map(params![needle], row_from_query)?
                    .collect::<Result<Vec<_>, _>>()?
            } else if short {
                let by_segment = prefixed
                    .query_map(params![needle], row_from_query)?
                    .collect::<Result<Vec<_>, _>>()?;
                if by_segment.is_empty() {
                    line_prefixed
                        .query_map(params![needle], row_from_query)?
                        .collect::<Result<Vec<_>, _>>()?
                } else {
                    by_segment
                }
            } else if callsign {
                tagged
                    .query_map(params![queried], row_from_query)?
                    .collect::<Result<Vec<_>, _>>()?
            } else {
                continue;
            };
            if rows.len() == 1 {
                let row = rows.into_iter().next().expect("length checked");
                resolved.push((queried.to_owned(), row?));
                continue;
            }
            if !rows.is_empty() {
                // Two `sessions` rows share the prefix — refuse, never guess.
                continue;
            }
            // The eviction fallback: the `sessions` table has no answer, but
            // the transcript may still be on disk and listed by the picker.
            let scan_rows = if full {
                scan_exact
                    .query_map(params![needle], scan_row_from_query)?
                    .collect::<Result<Vec<_>, _>>()?
            } else if short {
                scan_prefixed
                    .query_map(params![needle], scan_row_from_query)?
                    .collect::<Result<Vec<_>, _>>()?
            } else {
                scan_tagged
                    .query_map(params![queried], scan_row_from_query)?
                    .collect::<Result<Vec<_>, _>>()?
            };
            if scan_rows.len() == 1 {
                let row = scan_rows.into_iter().next().expect("length checked");
                resolved.push((queried.to_owned(), row));
                continue;
            }
            if !scan_rows.is_empty() || !callsign {
                continue;
            }
            // The alias fallback: a spent spelling resolving through the
            // arbiter to the session now heading its line of work.
            let alias_rows = minted_alias
                .query_map(params![queried], row_from_query)?
                .collect::<Result<Vec<_>, _>>()?;
            if let Some(row) = alias_rows.into_iter().next() {
                resolved.push((queried.to_owned(), row?));
            }
        }
        Ok(resolved)
    }

    /// Every line in the ledger that is seated on a card, with the segment a
    /// restore should resume and the turn count of the whole line ([P06]).
    ///
    /// One row per line, not per session: a card that has lived through eight
    /// id changes is one line here, and the turn count is the conversation's,
    /// not the last segment's.
    pub fn list_lines_with_card(&self) -> Result<Vec<(LineRow, SessionRow, i64)>, LedgerError> {
        let lines = {
            let conn = self.db.lock().expect("ledger mutex");
            let mut stmt = conn.prepare(
                "SELECT line_id, tag, name, name_user_set, card_id,
                        project_dir, created_at, last_used_at
                 FROM lines
                 WHERE card_id IS NOT NULL AND card_id != ''
                 ORDER BY last_used_at DESC",
            )?;
            let rows = stmt.query_map([], line_row_from_query)?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let mut out = Vec::with_capacity(lines.len());
        for line in lines {
            let Some(segment) = self.resume_segment_for_line(&line.line_id)? else {
                // Every segment failed, or the line's last segment was evicted.
                // A binding with nothing to resume is not a binding.
                continue;
            };
            let turns = self.line_turn_count(&line.line_id)?;
            out.push((line, segment, turns));
        }
        Ok(out)
    }

    /// The segment a restore should seat the card on ([P06]).
    ///
    /// In order: a `live` segment; then a segment nothing else was forked
    /// from, which is the line's tip; then the newest by `created_at`, and
    /// `rowid` to break a tie deterministically. Failed segments are never
    /// offered — they are known-unrecoverable, and a card replays parent-ward
    /// from wherever it is seated, so seating on the tip keeps the whole
    /// scroll.
    pub fn resume_segment_for_line(
        &self,
        line_id: &str,
    ) -> Result<Option<SessionRow>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(&format!(
            "SELECT {SESSION_COLUMNS} FROM {SESSIONS_JOINED}
             WHERE s.line_id = ?1 AND s.state != 'failed'
             {RESUME_SEGMENT_ORDER}
             LIMIT 1"
        ))?;
        let row = stmt
            .query_row(params![line_id], row_from_query)
            .optional()?;
        match row {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    /// A line's ownership shape ([P01]): every segment id it has worn, the
    /// segment that answers for it now, and whether any segment is live.
    ///
    /// This is what lets attribution treat a rotated id as the same body of
    /// work: the compose groups `file_events` owners by line through it, and
    /// the claim/disclaim verbs expand one incoming segment id to the whole
    /// set. `None` for a line no `sessions` row wears (every segment
    /// evicted) — the caller falls back to the raw id it was asked about.
    pub fn line_ownership(&self, line_id: &str) -> Result<Option<LineOwnership>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(&format!(
            "SELECT s.session_id, s.state FROM sessions s
             WHERE s.line_id = ?1
             {RESUME_SEGMENT_ORDER}"
        ))?;
        let segments: Vec<(String, String)> = stmt
            .query_map(params![line_id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        if segments.is_empty() {
            return Ok(None);
        }
        // The seat is the first non-failed segment in resume order — the
        // same answer `resume_segment_for_line` gives — with a failed-only
        // line degrading to its ordered head rather than to nothing: the
        // ownership expansion still needs an id to write and judge under.
        let seat_id = segments
            .iter()
            .find(|(_, state)| state != "failed")
            .unwrap_or(&segments[0])
            .0
            .clone();
        let any_live = segments.iter().any(|(_, state)| state == "live");
        Ok(Some(LineOwnership {
            seat_id,
            segment_ids: segments.into_iter().map(|(id, _)| id).collect(),
            any_live,
        }))
    }

    /// The turns the whole line has taken, summed across its segments.
    pub fn line_turn_count(&self, line_id: &str) -> Result<i64, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let total: i64 = conn.query_row(
            "SELECT COALESCE(SUM(turn_count), 0) FROM sessions WHERE line_id = ?1",
            params![line_id],
            |row| row.get(0),
        )?;
        Ok(total)
    }

    /// One line by id.
    pub fn get_line(&self, line_id: &str) -> Result<Option<LineRow>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let row = conn
            .query_row(
                "SELECT line_id, tag, name, name_user_set, card_id,
                        project_dir, created_at, last_used_at
                 FROM lines WHERE line_id = ?1",
                params![line_id],
                line_row_from_query,
            )
            .optional()?;
        Ok(row)
    }

    /// The line a session id belongs to, asked of every table that can answer.
    ///
    /// A segment answers first; then a scan row for a session nothing has
    /// adopted; then the arbiter, which remembers a spelling's owner after
    /// both other rows are gone. `None` means this ledger has never seen the
    /// id — the answer a durable-ink write falls back on by keying under the
    /// id itself.
    pub fn line_of(&self, session_id: &str) -> Option<String> {
        let conn = self.db.lock().expect("ledger mutex");
        line_of_in(&conn, session_id)
    }

    /// The **live** segment of the line `session_id` is a segment of ([P01])
    /// — the session a verb addressed to that id is really about.
    ///
    /// `$TUG_SESSION_ID` is frozen at spawn, and the Wheel rotates a card's
    /// session id *on purpose* whenever a stage crosses the compaction line.
    /// So the id a short-lived CLI process posts can name a segment that was
    /// closed and demoted two rotations ago, and every write keyed on it
    /// lands on a corpse and reports success. This expansion is what keeps a
    /// session-addressed verb answering for the conversation rather than for
    /// the segment that happened to be seated when the process was spawned —
    /// the same move `tugchanges_core::line_segments` makes for `tugtool
    /// changes` and `session_citation_for` makes for a commit trailer.
    ///
    /// The caller's own id wins when it is itself live, so the ordinary case
    /// resolves to itself. `None` when this ledger has never seen the id, and
    /// when no segment of its line is live — a line whose every segment has
    /// closed has no session to address, and that is an answer rather than a
    /// reason to fall back on the id that was posted.
    ///
    /// **Newest-first, not caller-first.** A rotation records the fresh
    /// segment before it demotes the old one, so for a window both are live
    /// — and a caller-first tiebreak resolves, during exactly that window, to
    /// the segment about to retire. A bind then passes the live-guard, writes
    /// onto the retiring row, and strands when it closes: `seat_line_binding`
    /// has already run for the fresh segment and will not run again until a
    /// relaunch. Preferring the newest live segment costs the ordinary case
    /// nothing (a line with one live segment resolves to it either way) and
    /// closes the window.
    pub fn live_segment_of(&self, session_id: &str) -> Result<Option<String>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        // `sessions.line_id` is NOT NULL and keyed into `lines`, so the join
        // finds the caller's own row whenever that row is itself live — there
        // is no lineless case left to fall back for.
        Ok(conn
            .query_row(
                "SELECT tip.session_id FROM sessions caller
                 JOIN sessions tip ON tip.line_id = caller.line_id
                 WHERE caller.session_id = ?1
                   AND COALESCE(caller.line_id, '') != ''
                   AND tip.state = 'live' AND tip.demoted = 0
                 ORDER BY tip.created_at DESC, tip.last_used_at DESC,
                          (tip.session_id = ?1) DESC, tip.rowid DESC
                 LIMIT 1",
                params![session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?)
    }

    /// Birth a line ([P03]) — the one place a line of work comes into
    /// existence, and the only place a callsign is claimed for one.
    ///
    /// `line_id` is the deck's uuid on a fresh spawn from the drop, and `None`
    /// where the server mints one (a plain `/new`, an external scan). `tag` is
    /// the client's optimistic callsign; a spelling the arbiter says is spent
    /// rerolls a complete fresh pair, which is the one moment a callsign a
    /// user has already seen may change.
    ///
    /// Idempotent on `line_id`: birthing a line that exists returns it
    /// unchanged, so a re-spawn re-claims its own line rather than corrupting
    /// it ([R02]).
    pub fn birth_line(
        &self,
        line_id: Option<&str>,
        session_id: &str,
        card_id: Option<&str>,
        project_dir: &str,
        tag: Option<&str>,
        now: i64,
    ) -> Result<LineRow, LedgerError> {
        let mut conn = self.db.lock().expect("ledger mutex");
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let line = birth_line_in(&tx, line_id, session_id, card_id, project_dir, tag, now)?;
        tx.commit()?;
        drop(conn);
        self.notify_sessions_changed();
        Ok(line)
    }

    /// The line a scanned external session belongs to, birthing one if this is
    /// the first time the scan has reached it ([P07]).
    ///
    /// A scan mints a permanent callsign, and a spelling spent in `minted_tags`
    /// needs an owner that exists — so the line is born here, card-less, rather
    /// than at some later adoption that may never happen. When the transcript
    /// names earlier lives of itself (`lineage_ancestors`), the session joins
    /// the line those ancestors already belong to instead of starting a second
    /// one for the same conversation.
    ///
    /// Returns the line's id, or `None` when there is no cache row to attach
    /// one to. Safe to call on every scan: an attached row is answered, not
    /// re-minted.
    pub fn ensure_scan_line(
        &self,
        session_id: &str,
        now: i64,
    ) -> Result<Option<String>, LedgerError> {
        let mut conn = self.db.lock().expect("ledger mutex");
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        /// The `external_scan_cache` columns this query selects, in order:
        /// line id, lineage ancestors, project dir, created-at, last-used-at.
        type CachedColumns = (Option<String>, Option<String>, String, i64, i64);

        let cached: Option<CachedColumns> = tx
            .query_row(
                "SELECT line_id, lineage_ancestors, project_dir, created_at, last_used_at
                 FROM external_scan_cache WHERE session_id = ?1",
                params![session_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?;
        let Some((existing, ancestors, project_dir, created_at, last_used_at)) = cached else {
            return Ok(None);
        };
        if let Some(line_id) = existing.filter(|id| !id.is_empty()) {
            return Ok(Some(line_id));
        }
        // Already adopted into the ledger since the last scan, or a transcript
        // that names an earlier life of itself: either way the line exists.
        let mut found = line_of_in(&tx, session_id);
        if found.is_none() {
            for ancestor in ancestors
                .as_deref()
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|id| !id.is_empty())
            {
                found = line_of_in(&tx, ancestor);
                if found.is_some() {
                    break;
                }
            }
        }
        let line_id = match found {
            Some(line_id) => line_id,
            None => {
                birth_line_in(
                    &tx,
                    None,
                    session_id,
                    None,
                    &project_dir,
                    None,
                    if created_at > 0 { created_at } else { now },
                )?
                .line_id
            }
        };
        tx.execute(
            "UPDATE external_scan_cache SET line_id = ?2 WHERE session_id = ?1",
            params![session_id, line_id],
        )?;
        tx.execute(
            "UPDATE lines SET last_used_at = MAX(last_used_at, ?2) WHERE line_id = ?1",
            params![line_id, last_used_at],
        )?;
        tx.commit()?;
        Ok(Some(line_id))
    }

    /// Insert a new live row, or transition an existing row back to live and
    /// rebind it to `card_id`. `created_at` is preserved across resumes.
    ///
    /// The row is a **segment** of `line_id` ([P01]) and holds no identity of
    /// its own. The line is born here when it does not exist yet — the one
    /// place that happens for a card ([P03]) — and `tag` is the candidate
    /// callsign for that birth alone; on an existing line it is ignored,
    /// because the line is already named.
    ///
    /// **An empty `line_id` means "you decide".** A caller that knows the
    /// card's line — the bridge, recording a segment against the entry it
    /// holds ([P04]) — names it, and it wins over anything the scanner
    /// guessed from a file on disk. A caller adopting a session it has never
    /// seen passes nothing, and the line the external scan already birthed
    /// for it ([P07]) is the one the card is seated on, so **adoption never
    /// mints a second identity**. A row that is already a segment of a line
    /// keeps that line either way.
    ///
    /// The row is hydrated from `external_scan_cache` when the scanner has
    /// already streamed this session's JSONL (the resume-an-external-session
    /// path: the picker row the user clicked came from that cache). A bare
    /// `turn_count = 0 / NULL prompt` insert would otherwise shadow the rich
    /// on-disk metadata in the picker union — and the picker hides zero-turn
    /// rows entirely, so the just-resumed session would vanish from the list.
    /// The conflict path backfills the same fields without ever overwriting
    /// richer ledger values (`MAX` on turn_count, `COALESCE` keeps an existing
    /// prompt).
    // The parameters are the row: a spawn writes seven columns, and grouping
    // them into a struct would put a shape between every caller and the table
    // it is describing.
    #[allow(clippy::too_many_arguments)]
    pub fn record_spawn(
        &self,
        session_id: &str,
        workspace_key: &str,
        project_dir: &str,
        card_id: &str,
        now: i64,
        line_id: &str,
        tag: Option<&str>,
    ) -> Result<(), LedgerError> {
        let mut conn = self.db.lock().expect("ledger mutex");
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let existing_created_at: Option<i64> = tx
            .query_row(
                "SELECT created_at FROM sessions WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()?;
        let seed: Option<(i64, Option<String>, Option<String>, i64)> = tx
            .query_row(
                // Epoch-gated like the scan hit-check: a stale-rule cache row
                // must not seed the `MAX(turn_count)` merge below, or a
                // pre-fix inflated count could survive the rule change and be
                // re-applied through the merge. A mismatched row yields no
                // seed; reconcile-on-replay then writes the authoritative
                // count ([P08]).
                "SELECT turn_count, last_user_prompt, name, created_at
                 FROM external_scan_cache
                 WHERE session_id = ?1 AND excluded = 0 AND rule_epoch = ?2",
                params![session_id, CURRENT_RULE_EPOCH],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let (seed_turns, seed_prompt, seed_name, seed_created_at) =
            seed.unwrap_or((0, None, None, 0));
        let created_at = existing_created_at.unwrap_or(if seed_created_at > 0 {
            seed_created_at
        } else {
            now
        });
        // Whose line this row is a segment of.
        //
        // The row's own line comes first: a respawn re-enters the line it is
        // already a segment of, and nothing may move it.
        //
        // Then the **caller's**, when it named one. The caller is the bridge
        // holding the card's `LedgerEntry` ([P04]) — it knows which
        // conversation this id belongs to, where the scanner only ever
        // guessed from a file on disk. A rotation whose JSONL the scanner
        // happened to see first would otherwise join the card's line to a
        // stranger's, which is the stranding this model exists to remove.
        //
        // The scan's line is the fallback, and it is the right one for the
        // case it was born for ([P07]): adopting a session the picker has
        // been showing under a callsign, where the caller has no line to
        // offer.
        let line_id = line_of_in_sessions(&tx, session_id)
            .or_else(|| Some(line_id).filter(|id| !id.is_empty()).map(str::to_owned))
            .or_else(|| line_of_in(&tx, session_id))
            .unwrap_or_else(|| session_id.to_owned());
        let line = birth_line_in(
            &tx,
            Some(&line_id),
            session_id,
            Some(card_id),
            project_dir,
            tag,
            now,
        )?;
        tx.execute(
            // `line_id` is left out of the conflict arm: a respawn re-enters
            // the line it is already a segment of, and an arm that could
            // rewrite it is the move this model exists to remove.
            "INSERT INTO sessions (
                session_id, workspace_key, project_dir,
                created_at, last_used_at, turn_count,
                last_user_prompt, state, card_id, line_id
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'live', ?8, ?9)
             ON CONFLICT(session_id) DO UPDATE SET
                workspace_key = excluded.workspace_key,
                project_dir   = excluded.project_dir,
                last_used_at  = excluded.last_used_at,
                turn_count    = MAX(sessions.turn_count, excluded.turn_count),
                last_user_prompt = COALESCE(sessions.last_user_prompt, excluded.last_user_prompt),
                state         = 'live',
                demoted       = 0,
                card_id       = excluded.card_id",
            params![
                session_id,
                workspace_key,
                project_dir,
                created_at,
                now,
                seed_turns,
                seed_prompt,
                card_id,
                line.line_id,
            ],
        )?;
        // Keep the scan cache pointing at the line the row settled on. Where
        // the two disagree the cache is holding a line the scanner birthed
        // from a file it saw before the caller named the conversation, and a
        // read that reached the cache first would answer with the guess.
        tx.execute(
            "UPDATE external_scan_cache SET line_id = ?2 WHERE session_id = ?1",
            params![session_id, line.line_id],
        )?;
        // A scanned `aiTitle` becomes the line's auto title on adoption — the
        // same fact it used to seed onto the row, written where the line has
        // no title of its own and the user has not named it.
        if let Some(title) = seed_name
            .as_deref()
            .map(str::trim)
            .filter(|title| !title.is_empty())
        {
            tx.execute(
                "UPDATE lines SET name = ?2
                 WHERE line_id = ?1 AND name_user_set = 0 AND COALESCE(name, '') = ''",
                params![line.line_id, title],
            )?;
        }
        // The lifecycle fact, written inside this same transaction so the fact
        // and the session row land together — and, decisively, **through the
        // `_tx` form**: the ledger mutex is held for this whole body and is not
        // reentrant, so the public `record_fact` here would deadlock tugcast on
        // every spawn ([P11]).
        //
        // `existing_created_at` already answered spawned-vs-resumed before the
        // UPSERT, so the disposition costs no extra query. A session the
        // external scan discovered and this instance is adopting has no
        // `sessions` row and therefore records `spawned` — first appearance in
        // *this* ledger, which is the first moment this instance can say
        // anything true about it. Its pre-Tug history is the transcript's to
        // tell.
        let start_fact = crate::feeds::facts_library::session_start_fact(
            now,
            session_id,
            existing_created_at.is_some(),
            &line.tag,
            workspace_key,
            project_dir,
            seed_name.as_deref(),
        );
        if let Err(e) = Self::record_fact_tx(&tx, &start_fact) {
            tracing::warn!(
                session = %session_id,
                error = %e,
                "record_spawn fact write failed; the session row is unaffected"
            );
        }
        tx.commit()?;
        self.notify_sessions_changed();
        Ok(())
    }

    /// Set `last_user_prompt` to the supplied snippet, overwriting any
    /// previous value. The picker shows this so the user recognizes
    /// the most-recent thread of conversation. The caller is responsible
    /// for truncation; the `truncate_user_prompt` helper is provided for
    /// consistency.
    pub fn record_user_prompt(&self, session_id: &str, prompt: &str) -> Result<(), LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let affected = conn.execute(
            "UPDATE sessions
             SET last_user_prompt = ?2
             WHERE session_id = ?1",
            params![session_id, prompt],
        )?;
        if affected == 0 {
            return Err(LedgerError::NotFound(session_id.to_owned()));
        }
        self.notify_sessions_changed();
        Ok(())
    }

    /// Set (or clear) the **line's** user-assigned name ([P11], `/rename`).
    /// `None` clears it. `NotFound` if the line id is unknown.
    ///
    /// **A user-set name is unique across lines, and the newest `/rename`
    /// wins.** A name another line already wears is taken from it: the holder's
    /// name and its user-set bit are cleared in this same transaction, so the
    /// partial `UNIQUE` index is satisfied at the write and the displaced line
    /// falls back to its callsign. The displaced lines are returned so the
    /// caller can push their rows and say whose name was taken — a rename is
    /// never refused for a spelling, and the loss is never silent.
    ///
    /// The comparison is exact-match on the spelling asked for. Clearing a
    /// name displaces nothing.
    pub fn rename(
        &self,
        line_id: &str,
        name: Option<&str>,
    ) -> Result<Vec<DisplacedName>, LedgerError> {
        let mut conn = self.db.lock().expect("ledger mutex");
        // Immediate, because the read of who wears the name and the write that
        // takes it must not interleave with another rename.
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        // The target is proved to exist BEFORE anything is displaced: a rename
        // addressed at an unknown line must not strip the name off the line
        // that legitimately wears it.
        let known: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM lines WHERE line_id = ?1",
                params![line_id],
                |row| row.get(0),
            )
            .optional()?;
        if known.is_none() {
            return Err(LedgerError::NotFound(line_id.to_owned()));
        }
        let mut displaced: Vec<DisplacedName> = Vec::new();
        if let Some(wanted) = name {
            {
                let mut stmt = tx.prepare(
                    "SELECT line_id, tag FROM lines
                     WHERE name = ?1 AND name_user_set = 1 AND line_id != ?2",
                )?;
                let rows = stmt.query_map(params![wanted, line_id], |row| {
                    Ok(DisplacedName {
                        line_id: row.get(0)?,
                        tag: row.get(1)?,
                    })
                })?;
                for row in rows {
                    displaced.push(row?);
                }
            }
            // Cleared, not rewritten: the holder loses the name outright and
            // its chip falls back to the callsign, the same resting state a
            // line that was never named wears.
            for holder in &displaced {
                tx.execute(
                    "UPDATE lines SET name = NULL, name_user_set = 0 WHERE line_id = ?1",
                    params![holder.line_id],
                )?;
            }
        }
        // Setting a name marks it user-set (the chip then shows it); clearing it
        // drops the bit so the chip falls back to the callsign.
        let user_set = i64::from(name.is_some());
        tx.execute(
            "UPDATE lines SET name = ?2, name_user_set = ?3 WHERE line_id = ?1",
            params![line_id, name, user_set],
        )?;
        tx.commit()?;
        // Dropped before the broadcast, as every neighbouring writer that grew
        // a transaction does — a transaction makes the held-lock window that
        // much wider.
        drop(conn);
        self.notify_sessions_changed();
        Ok(displaced)
    }

    /// Mark a session in or out of the Overview ([P05]).
    ///
    /// From-now-on semantics: turning it on stops new facts and new posts;
    /// turning it off resumes recording from that moment. Nothing already
    /// written is touched — a retroactive scrub is a separate act, and doing it
    /// silently here would be the wrong kind of surprise.
    pub fn set_session_private(&self, session_id: &str, private: bool) -> Result<(), LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let affected = conn.execute(
            "UPDATE sessions SET private = ?2 WHERE session_id = ?1",
            params![session_id, i64::from(private)],
        )?;
        if affected == 0 {
            return Err(LedgerError::NotFound(session_id.to_owned()));
        }
        drop(conn);
        self.notify_sessions_changed();
        Ok(())
    }

    /// Is this session currently private? A session with no row reads as
    /// public — the same reading the write-time check takes, and the reason
    /// the query-time exclusions are `NOT EXISTS` rather than joins.
    pub fn is_session_private(&self, session_id: &str) -> Result<bool, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let private: Option<i64> = conn
            .query_row(
                "SELECT private FROM sessions WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(private.unwrap_or(0) != 0)
    }

    /// Every session currently marked private, for a reader whose own SQL
    /// cannot reach this table ([P05]).
    ///
    /// `shell_exchanges` lives in its own database, so `not_private!` has no
    /// `sessions` to test against there. The ids travel instead, and the
    /// exclusion still happens inside that query — ahead of its LIMIT, which a
    /// filter over the returned page could not manage. Only sessions this
    /// ledger holds a row for are named: an id it has never seen reads as
    /// public, which is the same reading `NOT EXISTS` takes.
    pub fn private_session_ids(&self) -> Result<Vec<String>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare("SELECT session_id FROM sessions WHERE private = 1")?;
        let ids = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ids)
    }

    /// Write a fork's provenance onto its `sessions` row, after
    /// `record_spawn` has created it. Identity rode in as the line the segment
    /// joined; these columns record where the segment came from, which is a
    /// different question and the only one they answer.
    ///
    /// `fork_point` is `None` for an arc stage rotation, which descends from
    /// its parent without copying any history and so has no branch point. The
    /// column is written `NULL` rather than given a stand-in value: these two
    /// columns are what a reader uses to tell a rewind from a rotation.
    pub fn set_fork_provenance(
        &self,
        session_id: &str,
        forked_from_session_id: &str,
        fork_point: Option<&str>,
    ) -> Result<(), LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let affected = conn.execute(
            "UPDATE sessions SET forked_from_session_id = ?2, fork_point = ?3
             WHERE session_id = ?1",
            params![session_id, forked_from_session_id, fork_point],
        )?;
        if affected == 0 {
            return Err(LedgerError::NotFound(session_id.to_owned()));
        }
        drop(conn);
        self.notify_sessions_changed();
        Ok(())
    }

    /// Write what a rotation seated this session as ([P10]).
    ///
    /// Written beside `set_fork_provenance`, from the same announcement and at
    /// the same moment, because the two halves answer one question: the fork
    /// edge says *which session this descends from*, and these say *what it was
    /// seated as*. A restore reads both to redraw the transcript's divider, and
    /// reads them from the row rather than from an arc record, so a rotation
    /// with no arc behind it replays exactly as one on an arc does.
    ///
    /// `model` is `None` for the account default — the same absence the
    /// rotation itself carries, rather than a stand-in word.
    pub fn set_stage_provenance(
        &self,
        session_id: &str,
        label: &str,
        model: Option<&str>,
    ) -> Result<(), LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let affected = conn.execute(
            "UPDATE sessions SET stage_label = ?2, stage_model = ?3
             WHERE session_id = ?1",
            params![session_id, label, model],
        )?;
        if affected == 0 {
            return Err(LedgerError::NotFound(session_id.to_owned()));
        }
        drop(conn);
        self.notify_sessions_changed();
        Ok(())
    }

    /// What a rotation seated `session_id` as, or `None` if no rotation did.
    ///
    /// Total: an unknown session, a row written before the migration, and a
    /// query error all read as "no rotation seated this", which is what the
    /// lineage restore then falls back to the arc record for.
    pub fn stage_provenance(&self, session_id: &str) -> Option<(String, Option<String>)> {
        let conn = self.db.lock().expect("ledger mutex");
        conn.query_row(
            "SELECT stage_label, stage_model FROM sessions WHERE session_id = ?1",
            params![session_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .ok()
        .and_then(|(label, model)| label.map(|label| (label, model)))
    }

    /// Write down whether `session_id`'s card is owed its deck model back.
    ///
    /// The wheel keeps the armed set in memory because that is where it is
    /// read from, on a hot path, once per turn end. This is the copy that
    /// survives the process: a courseless rotation onto a named model pins the
    /// card until the restore goes out, tugcode reuses its manager's selector
    /// for every later spawn, and a tugcast restart in between used to drop
    /// the arming and leave the card on a stage model through the user's own
    /// `/new`.
    ///
    /// No `NotFound`: a session with no row is a session with no card, and a
    /// debt against it is nobody's to settle. Silent by design, and paired
    /// with [`Self::sessions_owed_hand_back`], which is what reads it back.
    pub fn set_hand_back_owed(&self, session_id: &str, owed: bool) -> Result<(), LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        conn.execute(
            "UPDATE sessions SET hand_back_owed = ?2 WHERE session_id = ?1",
            params![session_id, i64::from(owed)],
        )?;
        Ok(())
    }

    /// Every **live** session whose card is owed its deck model back.
    ///
    /// Live only, because a hand-back is a frame sent to a running card: a
    /// closed row has nothing to send to, and carrying its debt forward would
    /// only re-arm something no turn will ever end. Read once, at startup, to
    /// refill the wheel's in-memory set.
    pub fn sessions_owed_hand_back(&self) -> Result<Vec<String>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(
            "SELECT session_id FROM sessions
             WHERE hand_back_owed = 1 AND state = 'live'",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    /// Follow the fork edges parent-ward from `session_id` and return the
    /// whole chain in reading order — the oldest ancestor first, `session_id`
    /// last.
    ///
    /// A restore must replay every session the line passed through:
    /// an arc's devise, review, and implement stages each own their own JSONL,
    /// and a card that replays only the last of them shows a transcript that
    /// begins in the middle.
    ///
    /// Total by construction, and for the same reason: an id with no parent
    /// returns a one-element chain, and an unknown id, a query error, an edge
    /// cycle, or a chain past the depth cap all return what has been walked so
    /// far. A restore is best-effort — a partial chain shows less history, a
    /// failed one shows what it shows today, and neither may fail the replay.
    pub fn lineage_chain(&self, session_id: &str) -> Vec<String> {
        /// Chains are linear and short in practice; the cap is a guard
        /// against a corrupt edge set, not a real depth.
        const MAX_HOPS: usize = 16;

        let conn = self.db.lock().expect("ledger mutex");
        let mut chain = vec![session_id.to_owned()];
        let mut visited = HashSet::new();
        visited.insert(session_id.to_owned());
        let mut current = session_id.to_owned();
        for _ in 0..MAX_HOPS {
            let parent: Option<String> = match conn
                .query_row(
                    "SELECT forked_from_session_id FROM sessions WHERE session_id = ?1",
                    params![current],
                    |row| row.get(0),
                )
                .optional()
            {
                Ok(parent) => parent.flatten(),
                Err(err) => {
                    tracing::warn!(
                        session_id = %session_id,
                        error = %err,
                        "lineage chain walk failed; using what was walked"
                    );
                    break;
                }
            };
            let Some(parent) = parent else { break };
            if !visited.insert(parent.clone()) {
                tracing::warn!(
                    session_id = %session_id,
                    revisited = %parent,
                    "fork edges form a cycle; using what was walked"
                );
                break;
            }
            chain.push(parent.clone());
            current = parent;
        }
        chain.reverse();
        chain
    }

    /// Every session id a line of work has ever answered to, oldest first and
    /// `session_id` last — the fork edges *and* the resume rotations.
    ///
    /// [`Self::lineage_chain`] walks `forked_from_session_id`, which this
    /// ledger writes when **Tug** forks a session. That is the smaller half of
    /// the story. When Claude Code resumes a session it rotates the id on its
    /// own and copies the transcript forward, leaving no edge here at all; the
    /// only record is the ancestor ids embedded in the copied JSONL, which the
    /// external scanner parks in `external_scan_cache.lineage_ancestors`. A
    /// corpus keyed by session id and read through one source alone therefore
    /// goes blank after the first relaunch, which is exactly what it did.
    ///
    /// Total by construction, like both walks it composes: a missing cache
    /// row, an unparseable column, or a query error contributes nothing, and
    /// the answer always contains `session_id` itself.
    pub fn resume_lineage_chain(&self, session_id: &str) -> Vec<String> {
        // Taken first, and with the lock released, because it locks the same
        // mutex this function goes on to hold.
        let forks = self.lineage_chain(session_id);

        let conn = self.db.lock().expect("ledger mutex");
        let mut chain: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for id in forks {
            // A fork's own resume ancestors are older than the fork itself, so
            // they go in ahead of it and the whole chain stays in age order.
            for ancestor in resume_ancestors(&conn, &id) {
                if seen.insert(ancestor.clone()) {
                    chain.push(ancestor);
                }
            }
            if seen.insert(id.clone()) {
                chain.push(id);
            }
        }
        chain
    }

    /// Record an auto-generated `aiTitle` for a session, live.
    ///
    /// The title is the **line's** ([P02]), so a title scraped from any
    /// segment's JSONL titles the whole line of work — which is what a card
    /// that has rotated three times is. Writes `lines.name` **only** when
    /// `name_user_set = 0`: a `/rename` is the user's word and an auto title
    /// never overwrites it. Returns whether a row actually changed, so the
    /// caller can skip a pointless broadcast. An unknown session id, a
    /// line-less session, and a line the user has named are all no-ops rather
    /// than errors: the title arrives on a best-effort path and must never
    /// fail a turn.
    pub fn record_auto_title(&self, session_id: &str, title: &str) -> Result<bool, LedgerError> {
        let trimmed = title.trim();
        if trimmed.is_empty() {
            return Ok(false);
        }
        let conn = self.db.lock().expect("ledger mutex");
        let Some(line_id) = line_of_in(&conn, session_id) else {
            return Ok(false);
        };
        let affected = conn.execute(
            "UPDATE lines
             SET name = ?2
             WHERE line_id = ?1
               AND name_user_set = 0
               AND COALESCE(name, '') != ?2",
            params![line_id, trimmed],
        )?;
        if affected > 0 {
            drop(conn);
            self.notify_sessions_changed();
        }
        Ok(affected > 0)
    }

    /// Record the rolling generated description ([P07]).
    ///
    /// Writes `synopsis` regardless of `name_user_set`. A rename used to freeze
    /// the description because the two competed for one line of chrome, so a
    /// generated line could speak over the user's word. They no longer compete:
    /// the user's name is the title and the description is the line beneath it
    /// ([D132]), so a renamed session that stopped being described would simply
    /// show a dead line on its most-visible surface. Do not restore the freeze.
    ///
    /// The `COALESCE(synopsis, '') != ?2` guard stays — it is what suppresses a
    /// broadcast for a write that changes nothing. Returns whether a row
    /// actually changed. An unknown session id is a no-op rather than an error:
    /// the description arrives on a best-effort lane and must never fail
    /// anything upstream of it.
    pub fn record_synopsis(&self, session_id: &str, synopsis: &str) -> Result<bool, LedgerError> {
        let trimmed = synopsis.trim();
        if trimmed.is_empty() {
            return Ok(false);
        }
        let conn = self.db.lock().expect("ledger mutex");
        let affected = conn.execute(
            "UPDATE sessions
             SET synopsis = ?2
             WHERE session_id = ?1
               AND COALESCE(synopsis, '') != ?2",
            params![session_id, trimmed],
        )?;
        if affected > 0 {
            drop(conn);
            self.notify_sessions_changed();
        }
        Ok(affected > 0)
    }

    /// Touch `last_used_at` on a live turn. The turn **count** is no longer
    /// written here: `engine(file)` is the single count authority
    /// (`tuglaws/turn-metric.md` S03, [P08]), refreshed by the
    /// scan-on-`list_sessions` path — a live `turn_complete` only marks the
    /// row recently used. No-op if the row is absent or not `live`.
    pub fn record_turn(&self, session_id: &str, now: i64) -> Result<(), LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let affected = conn.execute(
            "UPDATE sessions
             SET last_used_at = ?2
             WHERE session_id = ?1 AND state = 'live'",
            params![session_id, now],
        )?;
        if affected == 0 {
            // Row may be absent (forgotten under us) or non-live (closed/failed
            // out from under a late turn). Both are acceptable no-ops.
        }
        self.notify_sessions_changed();
        Ok(())
    }

    /// Refresh a row's `turn_count` to `engine(file)` regardless of state —
    /// the migration / scan-refresh writer ([P08], S03). Unlike
    /// [`set_turn_count`], this is **not** gated on `live` (a closed or
    /// external row with a stale count must also be corrected on re-scan)
    /// and does **not** touch `last_used_at` (a count refresh is not usage).
    /// No-op if the row is absent (an external session with no ledger row).
    pub fn reconcile_turn_count_from_engine(
        &self,
        session_id: &str,
        count: i64,
    ) -> Result<(), LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        conn.execute(
            "UPDATE sessions
             SET turn_count = ?2
             WHERE session_id = ?1",
            params![session_id, count],
        )?;
        Ok(())
    }

    /// Overwrite `turn_count` with the authoritative value and bump
    /// `last_used_at`. Unlike `record_turn` (which increments per live turn),
    /// this SETs — the reconcile path ([P02]) calls it with a successful
    /// replay's `totalTurns` so the row converges to the segmenter's exact
    /// count, correcting any prior scan estimate or `record_spawn` `MAX` seed.
    /// Live `record_turn`s after replay build on this base. No-op if the row
    /// is absent or not `live`, exactly like `record_turn`.
    pub fn set_turn_count(
        &self,
        session_id: &str,
        count: i64,
        now: i64,
    ) -> Result<(), LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        conn.execute(
            "UPDATE sessions
             SET turn_count = ?2,
                 last_used_at = ?3
             WHERE session_id = ?1 AND state = 'live'",
            params![session_id, count, now],
        )?;
        self.notify_sessions_changed();
        Ok(())
    }

    /// Transition a row to `closed`. `card_id` is preserved across
    /// transitions so the client-side restore can ask "which session
    /// was last bound to this card?" after a tugcast restart.
    ///
    /// Returns whether a row actually moved. A session already closed is not
    /// closing again, and the caller's lifecycle fact hangs off this answer:
    /// several paths can call this for one ending (a close after a startup
    /// demote, a teardown after a crash), and each one recording would put two
    /// endings in the fact base for a session that ended once.
    /// Closing also **releases the dash binding** ([L27], [P08]): the
    /// acquisition a bind made is returned by the shorter-lived party. Without
    /// it a `dash_id` written once would report a mated session forever, and
    /// the *unbound* state — a dash with rounds and no live session — could
    /// never be reached.
    pub fn mark_closed(&self, session_id: &str) -> Result<bool, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let affected = conn.execute(
            // `demoted = 0`: a deliberate close outranks a prior demote —
            // this row is done and no late event may revive it. The guard
            // admits an already-demote-closed row for exactly that reason:
            // closing a card the startup demote beat to `closed` must still
            // strip its revivability.
            "UPDATE sessions
             SET state = 'closed', demoted = 0, dash_id = NULL, dash_name = NULL
             WHERE session_id = ?1
               AND (state != 'closed' OR demoted != 0)",
            params![session_id],
        )?;
        drop(conn);
        self.notify_sessions_changed();
        Ok(affected > 0)
    }

    /// Flip a non-live row back to `live` on proof of activity — a live
    /// turn, a submitted prompt, a `$` shell exec, a claim gesture. The
    /// startup demote closes every row because the *process* under it
    /// ended; a session that then keeps producing events is not closed,
    /// and every read keyed on `state` — the changeset owner join, the
    /// orphan lift, `record_turn`'s live gate — misreports it until the
    /// row is corrected. The caller vouches that its event is live-borne:
    /// replay backfill must never come through here, which is why
    /// [`Self::record_turn`] and friends stay non-resurrecting and this
    /// is a separate, explicit act.
    ///
    /// Returns whether a row moved. An absent row, a live row, and — by the
    /// `demoted` gate — a *deliberately* closed row are all no-ops: revival
    /// corrects the administrative demote and nothing else, so a card the
    /// user closed stays closed no matter what trails in behind it. The
    /// re-entry into the fact base is a `SessionResumed` under the line's
    /// handle ([P02]), the mirror of the demote's `session_end`.
    pub fn revive_on_activity(&self, session_id: &str, now: i64) -> Result<bool, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let row: Option<(String, String, String)> = conn
            .query_row(
                "SELECT s.workspace_key, s.project_dir,
                        COALESCE(l.tag, s.session_id)
                 FROM sessions s
                 LEFT JOIN lines l ON l.line_id = s.line_id
                 WHERE s.session_id = ?1 AND s.state != 'live' AND s.demoted = 1",
                params![session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((workspace_key, project_dir, handle)) = row else {
            return Ok(false);
        };
        conn.execute(
            "UPDATE sessions
             SET state = 'live', demoted = 0, last_used_at = ?2
             WHERE session_id = ?1",
            params![session_id, now],
        )?;
        let fact = crate::feeds::facts_library::session_start_fact(
            now,
            session_id,
            true,
            &handle,
            &workspace_key,
            &project_dir,
            None,
        );
        // The lock is held right here, so this is the `_tx` form ([P11]).
        if let Err(e) = Self::record_fact_tx(&conn, &fact) {
            tracing::warn!(
                session = %session_id,
                error = %e,
                "revive fact write failed; the session row is unaffected"
            );
        }
        drop(conn);
        self.notify_sessions_changed();
        Ok(true)
    }

    /// Bind a session to a dash, or clear its binding with `None` ([P08],
    /// Spec S03). `dash_id` is the owner key ([P01]); `dash_name` rides along
    /// so a display never needs a git read. Returns whether a row moved.
    ///
    /// **A binding may only be written onto a live segment.** A closed or
    /// demoted row is a corpse: the card it belonged to is gone, nothing
    /// reads its `dash_id`, and a write that landed there once reported a
    /// truthful success about the wrong session while the live card showed no
    /// dash at all. The `WHERE` refuses it, so a caller that failed to expand
    /// a frozen `$TUG_SESSION_ID` to its line's live segment
    /// ([`Self::live_segment_of`]) gets `Ok(false)` and has to say so, rather
    /// than a silent no-op wearing the face of a repair. Clearing (`None`) is
    /// exempt: dropping a stale binding off a dead row is housekeeping, and
    /// the only thing it can do is make the ledger tidier.
    pub fn set_dash_binding(
        &self,
        session_id: &str,
        dash: Option<(&str, &str)>,
    ) -> Result<bool, LedgerError> {
        let (dash_id, dash_name) = match dash {
            Some((id, name)) => (Some(id), Some(name)),
            None => (None, None),
        };
        let conn = self.db.lock().expect("ledger mutex");
        let affected = conn.execute(
            "UPDATE sessions SET dash_id = ?2, dash_name = ?3
             WHERE session_id = ?1
               AND (?2 IS NULL OR (state = 'live' AND demoted = 0))",
            params![session_id, dash_id, dash_name],
        )?;
        drop(conn);
        self.notify_sessions_changed();
        Ok(affected > 0)
    }

    /// Drop every binding to one dash, keyed by its **owner key** — the
    /// sweep a landing runs once the dash is gone ([P05]).
    ///
    /// Keyed by id and never by name: the column holds owner keys, so a name
    /// would match nothing, and a prefix match would also sweep a live
    /// successor dash that happens to reuse the name — the precise haunting
    /// this design retires. The caller resolves the key **before** the
    /// teardown that deletes the branch config it lives in ([L23], Risk R02).
    pub fn clear_dash_bindings_for_dash(&self, dash_id: &str) -> Result<usize, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let affected = conn.execute(
            "UPDATE sessions SET dash_id = NULL, dash_name = NULL WHERE dash_id = ?1",
            params![dash_id],
        )?;
        drop(conn);
        if affected > 0 {
            self.notify_sessions_changed();
        }
        Ok(affected)
    }

    /// Every **live** session bound to the dash *named* `dash`, with the
    /// checkout each one works.
    ///
    /// Keyed on `dash_name` rather than on `dash_id`, which is what
    /// [`Self::bound_sessions_by_dash`] groups by, because the caller is
    /// reading a record that only knows names: a dash-log line names its dash
    /// and nothing else. The owner key is the authority for *binding*; the
    /// name is what the record speaks, and a consumer of the record has to
    /// meet it there.
    ///
    /// The `project_dir` rides along because a name alone does not place a
    /// dash — two checkouts may each have a `refactor` — and the caller knows
    /// which tree it read the record from. A dash's stage session works the
    /// worktree, not the root, so the caller's test is containment rather than
    /// equality.
    pub fn live_sessions_on_dash_named(
        &self,
        dash: &str,
    ) -> Result<Vec<(String, String)>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(
            "SELECT session_id, project_dir
             FROM sessions
             WHERE state = 'live' AND dash_name = ?1
             ORDER BY last_used_at DESC",
        )?;
        let rows = stmt
            .query_map(params![dash], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    /// Every **live** session bound to a dash, grouped by the dash's owner
    /// key — the one query every consumer of bound-ness uses ([P08]).
    ///
    /// One query rather than a per-dash accessor: `dash status` looks its dash
    /// up in the map and the changeset feed fans the whole map out across
    /// entries, so neither pays a query per dash and neither can drift from
    /// the other on what "bound" means.
    ///
    /// The `state = 'live'` filter is where bound-ness is *defined*. The
    /// release on close ([L27]) is the primary mechanism; this is the guard
    /// that makes a row which escaped it harmless rather than wrong — and it
    /// is what makes *unbound* (rounds on file, no live session) reachable at
    /// all.
    pub fn bound_sessions_by_dash(
        &self,
    ) -> Result<std::collections::HashMap<String, Vec<String>>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(
            "SELECT dash_id, session_id
             FROM sessions
             WHERE dash_id IS NOT NULL AND state = 'live'
             ORDER BY last_used_at DESC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut by_dash: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        for (dash_id, session_id) in rows {
            by_dash.entry(dash_id).or_default().push(session_id);
        }
        Ok(by_dash)
    }

    /// Move each seated line's dash binding onto the segment a restore will
    /// resume ([P06], [P08]).
    ///
    /// A binding is written against the session id that was the card's at the
    /// time — the tug session id, which a rotation never changes while the
    /// process lives. A relaunch seats the card on the line's tip instead, and
    /// the tip a rotation minted carries no binding of its own, so the restore
    /// would report the card unbound while the arc record still names it
    /// mid-stage. Run once at startup, after the demote and before any client
    /// asks: the seat is the one row that reports bound, and the row it moved
    /// from reports nothing — moved, never copied. Returns how many moved.
    pub fn seat_line_bindings(&self) -> Result<usize, LedgerError> {
        let seats = self.list_lines_with_card()?;
        let mut moved = 0usize;
        {
            let mut conn = self.db.lock().expect("ledger mutex");
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            for (_, seat, _) in &seats {
                if seat.dash_id.is_some() {
                    continue;
                }
                let holder: Option<(String, String, Option<String>)> = tx
                    .query_row(
                        "SELECT session_id, dash_id, dash_name FROM sessions
                         WHERE line_id = ?1 AND dash_id IS NOT NULL AND session_id != ?2
                         ORDER BY created_at DESC, rowid DESC
                         LIMIT 1",
                        params![seat.line_id, seat.session_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .optional()?;
                let Some((from, dash_id, dash_name)) = holder else {
                    continue;
                };
                tx.execute(
                    "UPDATE sessions SET dash_id = ?2, dash_name = ?3 WHERE session_id = ?1",
                    params![seat.session_id, dash_id, dash_name],
                )?;
                tx.execute(
                    "UPDATE sessions SET dash_id = NULL, dash_name = NULL WHERE session_id = ?1",
                    params![from],
                )?;
                moved += 1;
            }
            tx.commit()?;
        }
        if moved > 0 {
            self.notify_sessions_changed();
        }
        Ok(moved)
    }

    /// Seat the line's dash binding on one fresh segment ([P06], [P08]) — the
    /// single-row form of [`Self::seat_line_bindings`], for the moment a
    /// rotation mints a segment rather than the moment a relaunch resumes one.
    ///
    /// The Wheel rotates a card's session on purpose, and the binding is
    /// written against the id that was the card's when it was written. The
    /// fresh segment carries none, and every reader of bound-ness is
    /// live-only ([`Self::bound_sessions_by_dash`]) — so the instant the old
    /// segment closes, a card mid-arc reads *unbound* while its arc record
    /// still names it mid-stage. Moving the binding forward is what keeps the
    /// rotation invisible to the work, which is the Wheel's whole promise.
    ///
    /// Moved, never copied, exactly as the plural does: the seated segment is
    /// the one row that reports bound. Returns the dash it seated — the
    /// caller's cue to announce the mating to the card — or `None` when there
    /// was nothing to move: the row already holds a binding, wears no line, or
    /// its line holds none.
    pub fn seat_line_binding(
        &self,
        session_id: &str,
    ) -> Result<Option<(String, String)>, LedgerError> {
        let seated;
        {
            let mut conn = self.db.lock().expect("ledger mutex");
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let row: Option<(Option<String>, Option<String>)> = tx
                .query_row(
                    "SELECT line_id, dash_id FROM sessions WHERE session_id = ?1",
                    params![session_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            // No row, no line, or already bound — the last of which is the
            // ordinary case for every spawn that is not a rotation.
            let Some((Some(line_id), None)) =
                row.filter(|(line, _)| line.as_deref().is_some_and(|l| !l.is_empty()))
            else {
                return Ok(None);
            };
            let holder: Option<(String, String, Option<String>)> = tx
                .query_row(
                    "SELECT session_id, dash_id, dash_name FROM sessions
                     WHERE line_id = ?1 AND dash_id IS NOT NULL AND session_id != ?2
                     ORDER BY last_used_at DESC, rowid DESC
                     LIMIT 1",
                    params![line_id, session_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            let Some((from, dash_id, dash_name)) = holder else {
                return Ok(None);
            };
            // The display name is denormalized and may be absent on an older
            // row; the owner key is the authority and reads well enough.
            let dash_name = dash_name.unwrap_or_else(|| dash_id.clone());
            // Live-only, exactly as `set_dash_binding` is. The seat is a
            // second binding writer, and a writer that skips the guard is a
            // writer that can put a binding on a corpse — which is the shape
            // this whole seat exists to repair, not to reproduce. Nothing
            // moves if the target is not live: the holder keeps its binding
            // rather than being cleared into nobody's hands.
            let seated_rows = tx.execute(
                "UPDATE sessions SET dash_id = ?2, dash_name = ?3
                 WHERE session_id = ?1 AND state = 'live' AND demoted = 0",
                params![session_id, dash_id, dash_name],
            )?;
            if seated_rows == 0 {
                return Ok(None);
            }
            tx.execute(
                "UPDATE sessions SET dash_id = NULL, dash_name = NULL WHERE session_id = ?1",
                params![from],
            )?;
            tx.commit()?;
            seated = Some((dash_id, dash_name));
        }
        self.notify_sessions_changed();
        Ok(seated)
    }

    /// Transition a row to `failed`. Replaces the previous "remove on
    /// resume_failed" semantics — the row is retained as a diagnostic crumb.
    /// `card_id` is preserved across transitions; see [`mark_closed`], whose
    /// return value means the same thing here.
    pub fn mark_failed(&self, session_id: &str) -> Result<bool, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let affected = conn.execute(
            "UPDATE sessions
             SET state = 'failed'
             WHERE session_id = ?1
               AND state != 'failed'",
            params![session_id],
        )?;
        drop(conn);
        self.notify_sessions_changed();
        Ok(affected > 0)
    }

    /// Delete the ledger row for `session_id` and move its claude-side
    /// JSONL to in-place trash so the user can recover for 7 days.
    ///
    /// Refuses if the row is currently live — callers must close the card
    /// first. JSONL move is best-effort: if the file is missing or the
    /// trash directory cannot be created, the row deletion still
    /// succeeds; `jsonl_moved_to` is `None` in that case and the caller
    /// can read tracing logs to understand why.
    ///
    /// **The `minted_tags` row stays.** Deleting every row naming this session
    /// is the obvious instinct and it is wrong: that table is the all-time tag
    /// arbiter (Spec S08), and freeing the callsign would let a later session
    /// mint it — making this session's commit trailers cite someone else.
    ///
    /// **A user-set name goes with the line's last segment.** Every *automatic*
    /// delete spares such a row (`sparing_named_lines!`), so this is the only
    /// path that can leave a named line with no segments at all — and the
    /// line-first listing would then keep offering that line forever, pointing
    /// at a transcript now sitting in `.tug-trash`. The user asked for the
    /// session to go, so the name goes with it, which also releases the
    /// `lines_user_name` index so the spelling can be typed again.
    pub fn trash(&self, session_id: &str) -> Result<TrashOutcome, LedgerError> {
        let forwarding = self.forwarding();
        let mut conn = self.db.lock().expect("ledger mutex");
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        // Read state + project_dir under the same lock so the JSONL move
        // afterwards has the canonical project_dir we recorded at spawn.
        let row: Option<(String, String, String)> = tx
            .query_row(
                "SELECT state, project_dir, line_id FROM sessions WHERE session_id = ?1",
                params![session_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;
        let (project_dir, line_id) = match row {
            None => return Err(LedgerError::NotFound(session_id.to_owned())),
            Some((state, _, _)) if state == "live" => {
                return Err(LedgerError::InvalidState(
                    "cannot trash a live session".to_owned(),
                ));
            }
            Some((_, pd, line)) => (pd, line),
        };
        tx.execute(
            "DELETE FROM sessions WHERE session_id = ?1",
            params![session_id],
        )?;
        // The user's own gesture is the one delete that may cost a name, and
        // it costs it exactly when there is no segment left to carry it.
        tx.execute(
            "UPDATE lines SET name = NULL, name_user_set = 0
             WHERE line_id = ?1
               AND name_user_set = 1
               AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.line_id = ?1)",
            params![line_id],
        )?;
        // Explicit attribution cascade (the legacy trigger cannot reach the
        // attached changes db): an evicted session takes its rows with it.
        self.delete_session_events(&tx, session_id, forwarding)?;
        tx.commit()?;
        drop(conn);
        self.settle_session_deletes([session_id]);

        let trash_path = move_jsonl_to_trash(
            &self.claude_projects_root,
            &project_dir,
            session_id,
            now_millis(),
        );
        self.notify_sessions_changed();
        Ok(TrashOutcome {
            session_id: session_id.to_owned(),
            jsonl_moved_to: trash_path,
        })
    }

    /// Drop every non-live row whose `project_dir` matches `project_dir`
    /// literally and move each row's JSONL to trash. Returns the session
    /// ids of the dropped rows so the caller can broadcast `session_updated
    /// { removed: true }` pushes. Used by recents-eviction → ledger-eviction
    /// coupling: when a dev recent-projects entry ages out, the matching
    /// ledger rows are dropped in lockstep so the picker doesn't surface
    /// sessions for a path the user no longer recognizes. The JSONLs go to
    /// trash so the user can `mv` them back if they recognize the loss.
    ///
    /// Their `minted_tags` rows stay — the arbiter is append-only (Spec S08).
    ///
    /// **A name the user typed is never taken here.** The selection runs
    /// through `sparing_named_lines!`, so a row that is the last surviving
    /// segment of a user-named line is left where it is — row and JSONL both.
    pub fn trash_for_project_dir(&self, project_dir: &str) -> Result<Vec<String>, LedgerError> {
        let forwarding = self.forwarding();
        let mut conn = self.db.lock().expect("ledger mutex");
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let doomed: Vec<String> = {
            let mut stmt = tx.prepare(sparing_named_lines!(
                "project_dir = ?1 AND state != 'live'"
            ))?;
            stmt.query_map(params![project_dir], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        for id in &doomed {
            tx.execute("DELETE FROM sessions WHERE session_id = ?1", params![id])?;
            self.delete_session_events(&tx, id, forwarding)?;
        }
        tx.commit()?;
        drop(conn);
        self.settle_session_deletes(doomed.iter().map(String::as_str));

        let now = now_millis();
        for id in &doomed {
            move_jsonl_to_trash(&self.claude_projects_root, project_dir, id, now);
        }
        if !doomed.is_empty() {
            self.notify_sessions_changed();
        }
        Ok(doomed)
    }

    /// Walk every project subdirectory under `claude_projects_root`,
    /// looking for `.tug-trash/<deletedAt>/` subdirs whose timestamp is
    /// older than `max_age_ms`. Called from `main.rs` at tugcast startup.
    ///
    /// Returns the count of subdirectories removed across all projects.
    /// IO errors are logged via tracing and swallowed — a partial sweep
    /// is preferable to bringing tugcast startup down.
    ///
    /// Filesystem-driven (not ledger-driven) so the sweep finds trash
    /// dirs even when their parent project's last ledger row was forgotten
    /// — that's the path that creates the orphan in the first place. The
    /// scan touches at most a few dozen subdirs (one per claude project),
    /// so the cost is negligible compared to the alternative of leaking
    /// trash dirs forever.
    pub fn sweep_trash(&self, max_age_ms: i64, now: i64) -> usize {
        let cutoff = now.saturating_sub(max_age_ms);
        let entries = match std::fs::read_dir(&self.claude_projects_root) {
            Ok(it) => it,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return 0,
            Err(err) => {
                tracing::warn!(
                    error = %err,
                    root = %self.claude_projects_root.display(),
                    "sweep_trash: read_dir failed",
                );
                return 0;
            }
        };
        let mut count = 0usize;
        for entry_result in entries {
            let Ok(entry) = entry_result else {
                continue;
            };
            // Only descend into directories (each project root is a dir).
            // file_type() avoids one syscall per stat() call when the
            // dirent already carries the type, which it does on macOS +
            // Linux APFS/ext.
            let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
            if !is_dir {
                continue;
            }
            let trash_root = entry.path().join(".tug-trash");
            count += sweep_trash_dir(&trash_root, cutoff);
        }
        count
    }

    /// Demote any rows still marked `live` (and bound to a card) into the
    /// `closed` state. Called once at tugcast startup: a previous tugcast
    /// process that crashed without cleanly closing its sessions will have
    /// left `state="live"` rows behind that no longer reflect any running
    /// subprocess. Returns the number of rows demoted.
    pub fn demote_live_to_closed(&self) -> Result<usize, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        // Read the doomed rows before the UPDATE erases which ones they were,
        // so each demotion records its own fact. `startup-demote` is the
        // detail because the distinction matters when reading history back:
        // this session did not end, the process under it did.
        // The handle a lifecycle fact wears is the **line's** callsign ([P02]).
        let mut stmt = conn.prepare(
            "SELECT s.session_id, l.tag FROM sessions s
             LEFT JOIN lines l ON l.line_id = s.line_id
             WHERE s.state = 'live'",
        )?;
        let demoted: Vec<(String, Option<String>)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        let count = conn.execute(
            // `demoted = 1` marks this as the administrative close — the
            // process ended, not the session — which is the one closed
            // state `revive_on_activity` may correct.
            "UPDATE sessions
             SET state = 'closed', demoted = 1
             WHERE state = 'live'",
            [],
        )?;
        let now = now_millis();
        for (session_id, tag) in &demoted {
            let handle = tag.clone().unwrap_or_else(|| session_id.clone());
            // The lock is held right here, so this is the `_tx` form ([P11]).
            let fact = crate::feeds::facts_library::session_end_fact(
                now,
                session_id,
                false,
                &handle,
                Some("startup-demote"),
            );
            if let Err(e) = Self::record_fact_tx(&conn, &fact) {
                tracing::warn!(
                    session = %session_id,
                    error = %e,
                    "startup-demote fact write failed"
                );
            }
        }
        drop(conn);
        if count > 0 {
            self.notify_sessions_changed();
        }
        Ok(count)
    }

    /// Remove every non-live row whose `last_used_at` is older than
    /// `now - max_age_ms`. Returns the session ids of the swept rows so
    /// the caller can broadcast `session_updated { removed: true }` pushes.
    ///
    /// Their `minted_tags` rows stay — the arbiter is append-only (Spec S08).
    ///
    /// **A name the user typed is never swept.** The selection runs through
    /// `sparing_named_lines!`, so the last surviving segment of a user-named
    /// line outlives any age, however long the line has sat untouched. That
    /// is the whole point: age is a fair reason to forget an anonymous row
    /// and never a reason to forget a name.
    pub fn sweep_expired(&self, max_age_ms: i64, now: i64) -> Result<Vec<String>, LedgerError> {
        let cutoff = now - max_age_ms;
        let forwarding = self.forwarding();
        let mut conn = self.db.lock().expect("ledger mutex");
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let doomed: Vec<String> = {
            let mut stmt = tx.prepare(sparing_named_lines!(
                "state != 'live' AND last_used_at < ?1"
            ))?;
            stmt.query_map(params![cutoff], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        for id in &doomed {
            tx.execute("DELETE FROM sessions WHERE session_id = ?1", params![id])?;
            self.delete_session_events(&tx, id, forwarding)?;
        }
        tx.commit()?;
        drop(conn);
        self.settle_session_deletes(doomed.iter().map(String::as_str));
        if !doomed.is_empty() {
            self.notify_sessions_changed();
        }
        Ok(doomed)
    }

    /// All distinct workspace keys currently represented in the ledger.
    /// Used by the trash sweep in step 8 to enumerate workspace dirs.
    pub fn distinct_workspaces(&self) -> Result<Vec<String>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt =
            conn.prepare("SELECT DISTINCT workspace_key FROM sessions ORDER BY workspace_key")?;
        let names = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(names)
    }

    /// Move an external session's JSONL to in-place trash. The
    /// no-ledger-row counterpart of [`trash`]: external sessions
    /// (discovered on disk, never adopted) have no row to delete, so
    /// the file move is the whole operation. Returns the trash
    /// destination, or `None` when the file is missing or the move
    /// failed (logged at warn level by the move helper).
    pub fn trash_external_jsonl(&self, project_dir: &str, session_id: &str) -> Option<PathBuf> {
        move_jsonl_to_trash(
            &self.claude_projects_root,
            project_dir,
            session_id,
            now_millis(),
        )
    }

    // ── external scan cache ──────────────────────────────────────────────────

    /// The two scan-derived facts a `session_updated` push has to carry, read
    /// in one statement ([D132]).
    ///
    /// Both live in `external_scan_cache` rather than on the `sessions` row:
    /// `file_size` is not a `sessions` column at all, and `turn_count` on the
    /// `sessions` row can be a sparse `0` for a session whose real count only
    /// ever came from a scan. A push built without these downgrades whatever it
    /// omits, because the client replaces its cached row wholesale.
    ///
    /// Epoch-gated like [`get_scan_cache`] — a row written under a prior turn
    /// rule reads as absent, and the caller then falls back to the `sessions`
    /// row's own count.
    pub fn scan_metrics_for(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionScanMetrics>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let metrics = conn
            .query_row(
                "SELECT file_size, turn_count
                 FROM external_scan_cache
                 WHERE session_id = ?1 AND rule_epoch = ?2 AND excluded = 0
                 LIMIT 1",
                params![session_id, CURRENT_RULE_EPOCH],
                |r| {
                    Ok(SessionScanMetrics {
                        file_size: r.get(0)?,
                        turn_count: r.get(1)?,
                    })
                },
            )
            .optional()?;
        Ok(metrics)
    }

    /// Look up the cached scan result for `session_id`. Validity
    /// against the current `(file_size, file_mtime)` is the caller's
    /// check — the cache stores what was true at parse time.
    pub fn get_scan_cache(&self, session_id: &str) -> Result<Option<ScanCacheRow>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(
            // Epoch-gated: a row written under a prior turn rule (or a
            // pre-column row defaulted to epoch 0) is treated as absent, so
            // the scanner's hit-check misses it and re-parses the file under
            // the current rule — and the stale `turn_count` never seeds a
            // tail-resume either (a miss carries no resume seed).
            "SELECT session_id, project_dir, file_size, file_mtime, excluded,
                    turn_count, last_user_prompt, name, created_at, last_used_at,
                    parse_offset, tail_hash, cwd_checked, created_at_found,
                    frontier_open, frontier_pending_close, frontier_pending_close_msg_id,
                    frontier_leaf_uuid, effective_uuids, lineage_ancestors, line_id
             FROM external_scan_cache
             WHERE session_id = ?1 AND rule_epoch = ?2
             LIMIT 1",
        )?;
        let row = stmt
            .query_row(
                params![session_id, CURRENT_RULE_EPOCH],
                scan_cache_row_from_query,
            )
            .optional()?;
        Ok(row)
    }

    /// Insert or overwrite the cached scan result for a session file.
    ///
    /// The `line_id` column is **carried across**, never taken from `row`: a
    /// line is born once and its callsign is permanent ([P07]), while this row
    /// is rewritten every time the file changes. Reading it back here is what
    /// keeps a re-parse from orphaning the scan row from its line — and with
    /// it, dropping the callsign the picker has been showing.
    ///
    /// `name` is not carried, and that is the distinction: it is a per-file
    /// derived fact this scan just regenerated, not identity.
    pub fn upsert_scan_cache(&self, row: &ScanCacheRow) -> Result<(), LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let existing_line: Option<String> = conn
            .query_row(
                "SELECT line_id FROM external_scan_cache WHERE session_id = ?1",
                params![row.session_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        conn.execute(
            "INSERT OR REPLACE INTO external_scan_cache (
                session_id, project_dir, file_size, file_mtime, excluded,
                turn_count, last_user_prompt, name, created_at, last_used_at,
                parse_offset, tail_hash, cwd_checked, created_at_found, rule_epoch,
                frontier_open, frontier_pending_close, frontier_pending_close_msg_id,
                frontier_leaf_uuid, effective_uuids, lineage_ancestors, line_id
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                       ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
            params![
                row.session_id,
                row.project_dir,
                row.file_size,
                row.file_mtime,
                row.excluded as i64,
                row.turn_count,
                row.last_user_prompt,
                row.name,
                row.created_at,
                row.last_used_at,
                row.parse_offset,
                row.tail_hash,
                row.cwd_checked as i64,
                row.created_at_found as i64,
                // Stamp the current rule epoch on every write — a fresh scan
                // always reflects the live rule, so its row is valid until the
                // rule (and this constant) next changes.
                CURRENT_RULE_EPOCH,
                row.frontier_open as i64,
                row.frontier_pending_close as i64,
                row.frontier_pending_close_msg_id,
                row.frontier_leaf_uuid,
                row.effective_uuids,
                row.lineage_ancestors,
                existing_line,
            ],
        )?;
        Ok(())
    }

    /// Delete cache rows under `project_dir` whose session id is not in
    /// `keep` — the backing files vanished (trash, manual delete) since
    /// the rows were written. Returns the number of rows pruned.
    pub fn prune_scan_cache_except(
        &self,
        project_dir: &str,
        keep: &[String],
    ) -> Result<usize, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        if keep.is_empty() {
            let n = conn.execute(
                "DELETE FROM external_scan_cache WHERE project_dir = ?1",
                params![project_dir],
            )?;
            return Ok(n);
        }
        let placeholders = (0..keep.len())
            .map(|i| format!("?{}", i + 2))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "DELETE FROM external_scan_cache
             WHERE project_dir = ?1 AND session_id NOT IN ({placeholders})"
        );
        let mut values: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(keep.len() + 1);
        values.push(&project_dir);
        for id in keep {
            values.push(id);
        }
        let n = conn.execute(&sql, values.as_slice())?;
        Ok(n)
    }

    // ── submission journal ───────────────────────────────────────────────────
    //
    // The `turns` table is a journal of pending user submissions: tugcast
    // inserts a row at user-message dispatch (the supervisor's
    // `dispatch_one` intercept), and the merger's `turn_complete`
    // intercept deletes the oldest pending row for the session via
    // `delete_oldest_pending_for_session` (FIFO match) once claude
    // acknowledges. tugcode reads pending rows for a session via the
    // cross-process bun:sqlite handle in `runReplay` and emits a synthetic
    // `user_message_replay` for any row whose `user_text` does not appear
    // as a `user_message` line in the JSONL — that's the never-drop
    // recovery for the gap between user-submit and JSONL-acknowledge.
    // See [DM08] in the mid-turn-replay plan.

    /// Insert a fresh row in the journal. `user_attachments` is encoded
    /// as a JSON array and stored as BLOB; the empty case (`&[]`)
    /// round-trips as `[]`. The caller mints `journal_id` (the supervisor
    /// uses `Uuid::new_v4().to_string()` so the id is unique across the
    /// whole database) and persists it before forwarding the
    /// `user_message` frame to tugcode — that ordering is the durability
    /// guarantee documented in [Never-drop chain audit row 4](#step-5-never-drop).
    pub fn insert_pending_turn(
        &self,
        session_id: &str,
        journal_id: &str,
        user_text: &str,
        user_attachments: &[serde_json::Value],
        now: i64,
    ) -> Result<(), LedgerError> {
        let attachments_blob = serde_json::to_vec(user_attachments)?;
        let conn = self.db.lock().expect("ledger mutex");
        conn.execute(
            "INSERT INTO turns (
                journal_id, session_id, user_text, user_attachments, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![journal_id, session_id, user_text, attachments_blob, now],
        )?;
        Ok(())
    }

    /// Delete the oldest pending row for `session_id` (FIFO match by
    /// `created_at` ASC). Called from the merger's `turn_complete`
    /// intercept (narrowed in [Step 5.3](#step-5-3) to delete-on-ack
    /// rather than mark-complete-by-id). Returns the deleted row's
    /// content so the caller can log it; returns `Ok(None)` if there
    /// were no pending rows for the session (a `turn_complete` arrived
    /// for a session whose journal is already empty — claude responding
    /// to a turn the journal didn't see, e.g. resume-after-bootstrap-of-
    /// older-tugcode-data).
    pub fn delete_oldest_pending_for_session(
        &self,
        session_id: &str,
    ) -> Result<Option<JournalRow>, LedgerError> {
        let mut conn = self.db.lock().expect("ledger mutex");
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let row = tx
            .query_row(
                "SELECT journal_id, session_id, user_text, user_attachments, created_at
                 FROM turns
                 WHERE session_id = ?1
                 ORDER BY created_at ASC, journal_id ASC
                 LIMIT 1",
                params![session_id],
                journal_row_from_query,
            )
            .optional()?;
        let Some(decoded) = row else {
            tx.commit()?;
            return Ok(None);
        };
        let row = decoded?;
        tx.execute(
            "DELETE FROM turns WHERE journal_id = ?1",
            params![row.journal_id],
        )?;
        tx.commit()?;
        Ok(Some(row))
    }

    /// All pending journal rows for `session_id`, ordered by `created_at`
    /// ASC (FIFO). This is the read surface tugcode's `runReplay`
    /// consumes through the cross-process `bun:sqlite` handle: for each
    /// row whose `user_text` does NOT appear as a `user_message` line in
    /// the JSONL, `runReplay` emits a synthetic `user_message_replay`
    /// frame to render the submission as awaiting-response. See
    /// [DM08]'s pending-row replay description in the mid-turn-replay plan.
    pub fn list_pending_turns_for_session(
        &self,
        session_id: &str,
    ) -> Result<Vec<JournalRow>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(
            "SELECT journal_id, session_id, user_text, user_attachments, created_at
             FROM turns
             WHERE session_id = ?1
             ORDER BY created_at ASC, journal_id ASC",
        )?;
        let rows = stmt
            .query_map(params![session_id], journal_row_from_query)?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().collect()
    }

    // ── the wheel's own record ───────────────────────────────────────────────
    //
    // What the wheel put on the wire, kept because claude's JSONL cannot say
    // it. On a reload the translator reads these rows and states which
    // submissions the wheel authored, so a prompt the wheel sent comes back
    // under the wheel's name rather than the user's.

    /// Record one prompt the wheel sent on `session_id`. The row is filed
    /// against that session's **line**, resolved here rather than by the
    /// caller: a rotation moves the arc onto a fresh session id mid-run, and
    /// the prompts before and after it are one line's.
    ///
    /// Answers `false` when no session row carries `session_id` — the caller
    /// says so rather than letting the record quietly not exist.
    pub fn record_wheel_prompt(
        &self,
        session_id: &str,
        prompt_id: &str,
        text: &str,
        now: i64,
    ) -> Result<bool, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let n = conn.execute(
            "INSERT INTO wheel_prompts (prompt_id, line_id, session_id, text, sent_at)
             SELECT ?1, line_id, session_id, ?2, ?3 FROM sessions WHERE session_id = ?4",
            params![prompt_id, text, now, session_id],
        )?;
        Ok(n > 0)
    }

    /// Every prompt the wheel sent on the line `session_id` is a segment of,
    /// oldest first. This is the read surface tugcode's `runReplay` consumes
    /// through the cross-process `bun:sqlite` handle — tugcast itself never
    /// reads these rows, it only writes them. The query is mirrored here, and
    /// kept in lockstep with `readWheelPromptsForLine` in tugcode's
    /// `session.ts`, so the writer is tested against what the reader asks.
    #[cfg(test)]
    pub fn list_wheel_prompts_for_line(
        &self,
        session_id: &str,
    ) -> Result<Vec<String>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(
            "SELECT text FROM wheel_prompts
             WHERE line_id = (SELECT line_id FROM sessions WHERE session_id = ?1)
             ORDER BY sent_at ASC, prompt_id ASC",
        )?;
        let rows = stmt
            .query_map(params![session_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Upsert one `turn_telemetry` row. Idempotent on
    /// `(session_id, msg_id)` via `INSERT OR REPLACE` — the supervisor
    /// may receive a repeat `record_turn_telemetry` from a reconnecting
    /// client that already committed the same turn locally, and the
    /// repeat should be a no-op write (same values overwriting same
    /// values), not a duplicate-key error.
    ///
    /// Single statement; sqlite's implicit per-statement transaction is
    /// enough. No explicit transaction needed for the write cadence we
    /// expect (one per `turn_complete`).
    pub fn record_turn_telemetry(&self, row: &TurnTelemetryRow) -> Result<(), LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        conn.execute(
            "INSERT OR REPLACE INTO turn_telemetry (
                session_id, msg_id,
                input_tokens, output_tokens,
                cache_creation_input_tokens, cache_read_input_tokens,
                total_cost_usd,
                wall_clock_ms, awaiting_approval_ms, transport_downtime_ms, active_ms,
                ttft_ms, ttftc_ms,
                reconnect_count, max_stream_gap_ms,
                ended_at,
                session_init_tokens
            ) VALUES (
                ?1, ?2,
                ?3, ?4,
                ?5, ?6,
                ?7,
                ?8, ?9, ?10, ?11,
                ?12, ?13,
                ?14, ?15,
                ?16,
                ?17
            )",
            params![
                row.session_id,
                row.msg_id,
                row.input_tokens,
                row.output_tokens,
                row.cache_creation_input_tokens,
                row.cache_read_input_tokens,
                row.total_cost_usd,
                row.wall_clock_ms,
                row.awaiting_approval_ms,
                row.transport_downtime_ms,
                row.active_ms,
                row.ttft_ms,
                row.ttftc_ms,
                row.reconnect_count,
                row.max_stream_gap_ms,
                row.ended_at,
                row.session_init_tokens,
            ],
        )?;
        Ok(())
    }

    /// All telemetry rows for a session, ordered oldest-to-newest by
    /// `ended_at`. The supervisor's replay path builds a
    /// `HashMap<msg_id, TurnTelemetryRow>` from this and inlines the
    /// matching row onto each replayed `turn_complete` event.
    pub fn list_turn_telemetry(
        &self,
        session_id: &str,
    ) -> Result<Vec<TurnTelemetryRow>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(
            "SELECT session_id, msg_id,
                    input_tokens, output_tokens,
                    cache_creation_input_tokens, cache_read_input_tokens,
                    total_cost_usd,
                    wall_clock_ms, awaiting_approval_ms, transport_downtime_ms, active_ms,
                    ttft_ms, ttftc_ms,
                    reconnect_count, max_stream_gap_ms,
                    ended_at,
                    session_init_tokens
             FROM turn_telemetry
             WHERE session_id = ?1
             ORDER BY ended_at ASC, msg_id ASC",
        )?;
        let rows = stmt
            .query_map(params![session_id], turn_telemetry_row_from_query)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Upsert one `file_events` row. Idempotent on the
    /// `(tug_session_id, tool_use_id, file_path)` primary key via
    /// `ON CONFLICT DO NOTHING` — the first write wins and every replay
    /// / re-stream of the same frame is a no-op, which is the
    /// invariant the attribution pipeline relies on ([P06],
    /// #replay-idempotency). A repeat of the *same* tool call never
    /// mutates the row (so a re-streamed live frame can't flip an
    /// already-recorded `origin='replay'` back to `exact`, or vice
    /// versa) — the point of change is recorded once.
    pub fn record_file_event(&self, row: &FileEventRow) -> Result<(), LedgerError> {
        self.record_file_event_with_spans(row, &[])
    }

    /// Record a `file_events` row together with its sub-file evidence, as one
    /// journal record: the spans are children of the row and must land with
    /// it, not after it, or a crash between the two leaves evidence for a row
    /// that does not exist.
    pub fn record_file_event_with_spans(
        &self,
        row: &FileEventRow,
        spans: &[FileEventSpan],
    ) -> Result<(), LedgerError> {
        self.write_change(crate::changes_journal::Record::FileEvent {
            row: row.clone(),
            spans: spans.to_vec(),
        })?;
        Ok(())
    }

    /// Record a whole batch of `file_events` rows as one journal record,
    /// applied in a single transaction: every row lands or none does. One
    /// user gesture (a `Claim all` over N files) is one durable record, one
    /// forwarder unit, and one replay unit, so a partial write is not a
    /// state the receipt has to describe. A no-op for an empty batch.
    /// Production writes carry Bash spans and go through
    /// [`SessionLedger::record_file_events_with_spans`]; this span-less form
    /// remains for tests.
    #[cfg(test)]
    pub fn record_file_events(&self, rows: &[FileEventRow]) -> Result<(), LedgerError> {
        self.record_file_events_with_spans(rows, &[])
    }

    /// The batch write with per-row spans, `spans[i]` belonging to `rows[i]`.
    /// A shorter (or empty) `spans` leaves the remaining rows span-less.
    pub fn record_file_events_with_spans(
        &self,
        rows: &[FileEventRow],
        spans: &[Vec<FileEventSpan>],
    ) -> Result<(), LedgerError> {
        if rows.is_empty() {
            return Ok(());
        }
        self.write_change(crate::changes_journal::Record::FileEventBatch {
            rows: rows.to_vec(),
            spans: spans.to_vec(),
        })?;
        Ok(())
    }

    /// The bare insert — shared by the live path and journal replay.
    ///
    /// `line_id` is stamped from the applying instance's own tables at
    /// write time ([P01]) — the row's `FileEventRow` shape is untouched, so
    /// every journal line ever written replays unchanged. NULL when the
    /// writing session belongs to no line this ledger knows, which the read
    /// side's sessions-join fallback absorbs.
    fn insert_file_event(conn: &Connection, row: &FileEventRow) -> Result<usize, LedgerError> {
        let line_id = line_of_in(conn, &row.tug_session_id);
        Ok(conn.execute(
            "INSERT INTO changes.file_events (
                tug_session_id, tool_use_id, file_path,
                tool_name, op, origin, ambiguous,
                parent_tool_use_id, project_dir, at, line_id
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT (tug_session_id, tool_use_id, file_path) DO NOTHING",
            params![
                row.tug_session_id,
                row.tool_use_id,
                row.file_path,
                row.tool_name,
                row.op,
                row.origin,
                i64::from(row.ambiguous),
                row.parent_tool_use_id,
                row.project_dir,
                row.at,
                line_id,
            ],
        )?)
    }

    /// Every span held for the given repo-relative paths under `project_dir`,
    /// carrying the parent key that owns it.
    ///
    /// The read side of [P12]: a path with two live proof owners is contested
    /// only where their claimed regions intersect, and this is where those
    /// regions come from. Matched through [`file_path_spellings`] for the same
    /// reason the ownership deletes are — legacy rows hold an absolute
    /// spelling until the backfill reaches them, and a query that saw only the
    /// repo-relative form would read those owners as span-less and widen them.
    ///
    /// Filtered to proof-origin parents: a `bash`/`turn` row never makes a
    /// session an owner, so its spans must not shape an owner's claim either.
    /// A database whose owner has not migrated to v2 has no spans table and
    /// reads as span-less — an older owner is not a damaged ledger.
    pub fn file_event_spans_for_paths(
        &self,
        project_dir: &str,
        paths: &[String],
    ) -> Result<Vec<FileEventSpanRow>, LedgerError> {
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        let spellings = Self::file_path_spellings(project_dir, paths);
        let placeholders = (2..2 + spellings.len())
            .map(|n| format!("?{n}"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT s.tug_session_id, s.tool_use_id, s.file_path, s.seq, s.kind, s.anchor, e.at
             FROM changes.file_event_spans s
             JOIN changes.file_events e
               ON e.tug_session_id = s.tug_session_id
              AND e.tool_use_id = s.tool_use_id
              AND e.file_path = s.file_path
             WHERE e.project_dir = ?1
               AND e.origin IN ('exact', 'replay', 'claim', 'cmd')
               AND s.file_path IN ({placeholders})
             ORDER BY s.tug_session_id, s.file_path, s.tool_use_id, s.seq"
        );
        let conn = self.db.lock().expect("ledger mutex");
        let table_exists: bool = conn
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM changes.sqlite_master
                 WHERE type = 'table' AND name = 'file_event_spans')",
                [],
                |r| r.get(0),
            )
            .unwrap_or(false);
        if !table_exists {
            return Ok(Vec::new());
        }
        let mut stmt = conn.prepare(&sql)?;
        let mut params: Vec<&dyn rusqlite::ToSql> = vec![&project_dir];
        for p in &spellings {
            params.push(p);
        }
        let rows = stmt.query_map(params.as_slice(), |r| {
            Ok(FileEventSpanRow {
                tug_session_id: r.get(0)?,
                tool_use_id: r.get(1)?,
                file_path: r.get(2)?,
                at: r.get(6)?,
                span: FileEventSpan {
                    seq: r.get(3)?,
                    kind: r.get(4)?,
                    anchor: r.get(5)?,
                },
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Insert one row's spans, keyed to that row — shared by the live path and
    /// journal replay. Idempotent on the child key exactly as the parent
    /// insert is, so a re-streamed frame re-inserting nothing is a no-op.
    /// Returns the number of span rows that landed; the caller folds it into
    /// the record's touched count so a record adding only spans to a row that
    /// already exists is still journaled.
    fn insert_file_event_spans(
        conn: &Connection,
        row: &FileEventRow,
        spans: &[FileEventSpan],
    ) -> Result<usize, LedgerError> {
        let mut inserted = 0usize;
        for span in spans {
            inserted += conn.execute(
                "INSERT INTO changes.file_event_spans (
                    tug_session_id, tool_use_id, file_path, seq, kind, anchor
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT (tug_session_id, tool_use_id, file_path, seq) DO NOTHING",
                params![
                    row.tug_session_id,
                    row.tool_use_id,
                    row.file_path,
                    span.seq,
                    span.kind,
                    span.anchor,
                ],
            )?;
        }
        Ok(inserted)
    }

    /// Delete the spans of every `file_events` row the given predicate
    /// selects, by joining on the parent's key.
    ///
    /// Spans carry no `project_dir` of their own — they are addressed only
    /// through their parent — so an ownership delete must resolve the parents
    /// first and remove their children *before* the parents go, or the
    /// children are stranded with nothing left to name them (Risk R10).
    /// `parent_where` is spliced with the same numbered parameters the
    /// parent delete uses.
    fn delete_spans_of_matching_events(
        conn: &Connection,
        parent_where: &str,
        params: &[&dyn rusqlite::ToSql],
    ) -> Result<usize, LedgerError> {
        let sql = format!(
            "DELETE FROM changes.file_event_spans
             WHERE (tug_session_id, tool_use_id, file_path) IN (
                 SELECT tug_session_id, tool_use_id, file_path
                 FROM changes.file_events
                 WHERE {parent_where}
             )"
        );
        Ok(conn.execute(&sql, params)?)
    }

    /// Sever every other owner's hold on the given repo-relative paths
    /// under `project_dir`: delete `file_events` rows for those paths whose
    /// `tug_session_id` is not in `keep_session_ids`. The counterpart to a
    /// claim ([D120]) — when a live session claims an orphan, the dead
    /// originator's rows are removed so re-opening it can't silently re-own
    /// the file. `keep_session_ids` is the claimant's whole **line** of
    /// segment ids ([P01]), seat first, so a claim never severs the
    /// claimant's own rows written under an id it has since rotated away
    /// from. Returns the number of rows deleted. A no-op for an empty
    /// `paths` or an empty keep set.
    pub fn sever_file_ownership_except(
        &self,
        project_dir: &str,
        paths: &[String],
        keep_session_ids: &[String],
    ) -> Result<usize, LedgerError> {
        if paths.is_empty() || keep_session_ids.is_empty() {
            return Ok(0);
        }
        self.write_change(crate::changes_journal::Record::Sever {
            project_dir: project_dir.to_string(),
            paths: paths.to_vec(),
            keep_session: keep_session_ids[0].clone(),
            keep_sessions: keep_session_ids[1..].to_vec(),
        })
    }

    /// Every stored spelling of the given repo-relative paths under
    /// `project_dir`, for an ownership delete's `file_path IN (…)`.
    ///
    /// `file_events.file_path` has held two forms: the repo-relative key that
    /// capture writes today, and the absolute path older rows carry. The read
    /// side reconciles them (`repo_relative_key`: a relative path is itself, an
    /// absolute one is stripped of the repo root), so a delete that matched
    /// only the relative form would under-delete against exactly the rows the
    /// compose-side backfill has not reached yet — silently leaving a session
    /// owning a file it renounced. This is the inverse of that rule, and it is
    /// pure string work: an ownership delete is replayed from the journal, so
    /// it must not depend on the filesystem being in any particular state.
    ///
    /// Deliberately not a `LIKE '%/' || path` suffix match, which would also
    /// delete `vendor/a.rs` when the caller named `a.rs`.
    fn file_path_spellings(project_dir: &str, paths: &[String]) -> Vec<String> {
        let root = project_dir.trim_end_matches('/');
        let mut out = Vec::with_capacity(paths.len() * 2);
        for path in paths {
            out.push(path.clone());
            out.push(format!("{root}/{path}"));
        }
        out
    }

    /// The bare severing delete — shared with journal replay.
    fn sever_file_ownership_sql(
        conn: &Connection,
        project_dir: &str,
        paths: &[String],
        keep_session_ids: &[String],
    ) -> Result<usize, LedgerError> {
        let spellings = Self::file_path_spellings(project_dir, paths);
        // Numbered explicitly: ?1 is the project, the keep set takes
        // ?2.., the path spellings follow. Mixing anonymous `?` in after
        // numbered parameters is correct — SQLite numbers an anonymous
        // parameter one past the highest assigned — but correct by a rule
        // nobody reading it recalls.
        let keep_placeholders = (2..2 + keep_session_ids.len())
            .map(|n| format!("?{n}"))
            .collect::<Vec<_>>()
            .join(", ");
        let first_path = 2 + keep_session_ids.len();
        let path_placeholders = (first_path..first_path + spellings.len())
            .map(|n| format!("?{n}"))
            .collect::<Vec<_>>()
            .join(", ");
        let predicate = format!(
            "project_dir = ?1
               AND tug_session_id NOT IN ({keep_placeholders})
               AND file_path IN ({path_placeholders})"
        );
        let mut params: Vec<&dyn rusqlite::ToSql> = vec![&project_dir];
        for id in keep_session_ids {
            params.push(id);
        }
        for p in &spellings {
            params.push(p);
        }
        Self::delete_spans_of_matching_events(conn, &predicate, params.as_slice())?;
        Ok(conn.execute(
            &format!("DELETE FROM changes.file_events WHERE {predicate}"),
            params.as_slice(),
        )?)
    }

    /// Renounce an owner's hold on the given repo-relative paths under
    /// `project_dir`: delete every `file_events` row of `session_ids` for
    /// those paths — proof and bracket alike, so the owner's own hint rows
    /// can't go on saying `likely` about a file it just gave up.
    /// `session_ids` is the renouncing **line's** whole segment set ([P01]),
    /// so the file leaves the line of work entirely rather than just its
    /// current id. The inverse of a claim: another live owner becomes sole
    /// owner, and with no other owner the file degrades to unattributed.
    /// Returns the number of rows deleted. A no-op for empty `paths` or an
    /// empty owner set.
    pub fn disclaim_file_ownership(
        &self,
        project_dir: &str,
        paths: &[String],
        session_ids: &[String],
    ) -> Result<usize, LedgerError> {
        if paths.is_empty() || session_ids.is_empty() {
            return Ok(0);
        }
        self.write_change(crate::changes_journal::Record::Disclaim {
            project_dir: project_dir.to_string(),
            paths: paths.to_vec(),
            session: session_ids[0].clone(),
            sessions: session_ids[1..].to_vec(),
        })
    }

    /// The bare renunciation delete — shared with journal replay.
    fn disclaim_file_ownership_sql(
        conn: &Connection,
        project_dir: &str,
        paths: &[String],
        session_ids: &[String],
    ) -> Result<usize, LedgerError> {
        let spellings = Self::file_path_spellings(project_dir, paths);
        let id_placeholders = (2..2 + session_ids.len())
            .map(|n| format!("?{n}"))
            .collect::<Vec<_>>()
            .join(", ");
        let first_path = 2 + session_ids.len();
        let path_placeholders = (first_path..first_path + spellings.len())
            .map(|n| format!("?{n}"))
            .collect::<Vec<_>>()
            .join(", ");
        let predicate = format!(
            "project_dir = ?1
               AND tug_session_id IN ({id_placeholders})
               AND file_path IN ({path_placeholders})"
        );
        let mut params: Vec<&dyn rusqlite::ToSql> = vec![&project_dir];
        for id in session_ids {
            params.push(id);
        }
        for p in &spellings {
            params.push(p);
        }
        Self::delete_spans_of_matching_events(conn, &predicate, params.as_slice())?;
        Ok(conn.execute(
            &format!("DELETE FROM changes.file_events WHERE {predicate}"),
            params.as_slice(),
        )?)
    }

    /// Delete `file_events` rows naming files outside the project's repo, by
    /// explicit key. Capture no longer writes such rows (they can never match
    /// the compose fold, which is keyed on git's repo-relative dirty paths);
    /// this removes the population written before it learned to skip them.
    /// The whole batch is one record — the forwarder queue is bounded, so a
    /// record per row would overrun it. Returns the number of rows deleted.
    pub fn purge_file_events_out_of_repo(
        &self,
        project_dir: &str,
        keys: &[FileEventKey],
    ) -> Result<usize, LedgerError> {
        if keys.is_empty() {
            return Ok(0);
        }
        self.write_change(crate::changes_journal::Record::PurgeOutOfRepo {
            project_dir: project_dir.to_string(),
            keys: keys.to_vec(),
        })
    }

    /// The bare keyed delete — shared with journal replay. Matching on the
    /// primary key alone makes replay exact and idempotent: a row already
    /// gone deletes nothing, and no other row can collide with the key.
    fn purge_file_events_sql(
        conn: &Connection,
        keys: &[FileEventKey],
    ) -> Result<usize, LedgerError> {
        let mut deleted = 0usize;
        for key in keys {
            conn.execute(
                "DELETE FROM changes.file_event_spans
                 WHERE tug_session_id = ?1 AND tool_use_id = ?2 AND file_path = ?3",
                params![key.tug_session_id, key.tool_use_id, key.file_path],
            )?;
            deleted += conn.execute(
                "DELETE FROM changes.file_events
                 WHERE tug_session_id = ?1 AND tool_use_id = ?2 AND file_path = ?3",
                params![key.tug_session_id, key.tool_use_id, key.file_path],
            )?;
        }
        Ok(deleted)
    }

    /// Shutdown flush: checkpoint both WALs down to the main files
    /// (`TRUNCATE`) so the next open — possibly by a different build —
    /// starts from a clean, WAL-less state instead of running recovery.
    /// Best-effort; failures are logged and shutdown proceeds.
    pub fn final_flush(&self) {
        let databases: &[&str] = if self.forwarding() {
            &["main"]
        } else {
            &["main", "changes"]
        };
        let conn = self.db.lock().expect("ledger mutex");
        for db in databases {
            let result =
                conn.query_row(&format!("PRAGMA {db}.wal_checkpoint(TRUNCATE)"), [], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                });
            match result {
                // busy != 0 means the checkpoint could not complete (a
                // reader pinned the WAL) — say so, or the "clean,
                // WAL-less state" this flush promises is silently untrue.
                Ok((busy, log_frames, checkpointed_frames)) if busy != 0 => {
                    tracing::warn!(
                        db,
                        log_frames,
                        checkpointed_frames,
                        "final WAL checkpoint incomplete at shutdown; a WAL remains for the next open to recover"
                    );
                }
                Ok(_) => {}
                Err(err) => {
                    tracing::warn!(db, error = %err, "final WAL checkpoint failed at shutdown");
                }
            }
        }
    }

    /// Online snapshot backup: `VACUUM <db> INTO dest` — a transactional,
    /// compacted copy taken without blocking concurrent writers. `db` is
    /// `"main"` (sessions) or `"changes"` (the attached shared ledger).
    /// Fails if `dest` already exists (SQLite semantics); callers use
    /// timestamped names.
    pub fn snapshot_into(&self, db: &str, dest: &Path) -> Result<(), LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        conn.execute(
            &format!("VACUUM {db} INTO ?1"),
            params![dest.to_string_lossy()],
        )?;
        Ok(())
    }

    /// Settle the attribution half of a session eviction after the
    /// enclosing transaction commits, so a rollback never leaves phantom
    /// deletes behind: the owner journals the deletes it already applied
    /// in-transaction; a forwarding instance (whose read-only attach could
    /// not apply them) sends them to the owner now.
    fn settle_session_deletes<'a>(&self, ids: impl IntoIterator<Item = &'a str>) {
        let forwarding = self.forwarding();
        for id in ids {
            let record = crate::changes_journal::Record::DeleteSession {
                session: id.to_string(),
            };
            if forwarding {
                if let Err(err) = self.write_change(record) {
                    tracing::warn!(session = id, error = %err, "session eviction: attribution delete could not be forwarded");
                }
            } else if let Some(journal) = &*self.changes_journal.lock().expect("journal mutex") {
                journal.append(&record);
            }
        }
    }

    /// The attribution cascade inside an eviction transaction. A
    /// forwarding instance skips it — its attach is read-only, and
    /// [`settle_session_deletes`] sends the delete after the commit.
    /// `forwarding` is the caller's pre-transaction sample: reading it
    /// live here would take `changes_access` while the caller holds `db`,
    /// inverting the lock order (see [`changes_access`]).
    fn delete_session_events(
        &self,
        tx: &Connection,
        session_id: &str,
        forwarding: bool,
    ) -> Result<(), LedgerError> {
        if forwarding {
            return Ok(());
        }
        tx.execute(
            "DELETE FROM changes.file_event_spans WHERE tug_session_id = ?1",
            params![session_id],
        )?;
        tx.execute(
            "DELETE FROM changes.file_events WHERE tug_session_id = ?1",
            params![session_id],
        )?;
        Ok(())
    }

    /// Whether shared-ledger mutations must be forwarded to the instance
    /// that holds the writer claim.
    fn forwarding(&self) -> bool {
        self.changes_access
            .lock()
            .expect("changes access mutex")
            .is_forwarding()
    }

    /// Route one shared-ledger mutation: apply it locally when this
    /// instance owns the writer claim, otherwise forward it to the owner.
    /// Returns the number of rows the mutation touched (as reported by
    /// the owner when forwarded).
    ///
    /// A forward that fails is the failover trigger: the owner is gone or
    /// unreachable, so this instance tries to take the claim. Whoever wins
    /// drains what the forwarder was holding and continues locally;
    /// whoever loses queues the record for the next attempt.
    fn write_change(&self, record: crate::changes_journal::Record) -> Result<usize, LedgerError> {
        if record.shapes_rows() {
            self.guard_changes_write()?;
        }
        let mut access = self.changes_access.lock().expect("changes access mutex");
        let crate::changes_writer::ChangesAccess::Forward(forwarder) = &mut *access else {
            return self.apply_change_locally(&record);
        };
        match forwarder.send(&record) {
            Ok(applied) => Ok(applied),
            // The owner answered and refused. It is alive, so this is not a
            // failover trigger — taking its claim would be a healthy owner
            // losing the database to a disagreement. A permanent refusal is
            // also not a durability outage: nothing is damaged and nothing
            // is pending, so it must not latch the degraded flag the deck
            // renders as "attribution ledger damaged". It is one gesture's
            // failure, returned to the caller, which surfaces it as that
            // verb's own error.
            Err(crate::changes_writer::ForwardError::Rejected {
                detail,
                permanent: true,
            }) => {
                tracing::error!(
                    detail,
                    "the changes-ledger owner refused this write and always will"
                );
                Err(LedgerError::ForwardRejected(detail))
            }
            // A refusal that might not repeat (the owner's own ledger erred).
            // Still an answer, so still no takeover — hold it for the next
            // attempt, which is the pending-queue path a live owner deserves.
            Err(crate::changes_writer::ForwardError::Rejected {
                detail,
                permanent: false,
            }) => {
                tracing::warn!(
                    detail,
                    "the changes-ledger owner refused this write; holding it for retry"
                );
                forwarder.queue(record);
                ledger_integrity::health::note_degraded("changes-forward");
                Ok(0)
            }
            Err(err) => {
                if !forwarder.retry_due() {
                    forwarder.queue(record);
                    return Ok(0);
                }
                forwarder.note_attempt();
                match self.take_over_changes_writer() {
                    Some(lock) => {
                        tracing::warn!(
                            error = %err,
                            "changes-ledger owner unreachable; this instance took the writer claim"
                        );
                        let drained = forwarder.take_pending();
                        *access = crate::changes_writer::ChangesAccess::Owner(lock);
                        drop(access);
                        self.ensure_changes_journal();
                        for held in &drained {
                            if let Err(e) = self.apply_change_locally(held) {
                                tracing::warn!(error = %e, "queued changes record failed to apply after takeover");
                            }
                        }
                        self.apply_change_locally(&record)
                    }
                    None => {
                        forwarder.queue(record);
                        tracing::warn!(
                            error = %err,
                            pending = forwarder.pending_len(),
                            "changes mutation could not be forwarded; holding it for retry"
                        );
                        ledger_integrity::health::note_degraded("changes-forward");
                        Ok(0)
                    }
                }
            }
        }
    }

    /// Apply a record to this instance's own attach and journal it.
    /// Only ever reached while this instance owns (or does not contend
    /// for) the shared database.
    fn apply_change_locally(
        &self,
        record: &crate::changes_journal::Record,
    ) -> Result<usize, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let result = Self::apply_journal_record(&conn, record).inspect_err(|err| {
            ledger_integrity::health::note_error("changes", err);
        });
        // Journal while the ledger mutex is held, so the journal's order
        // is the apply order. A record that landed is journaled; so is
        // one whose apply FAILED — a database degrading mid-run must not
        // swallow the durable record (the post-quarantine rebuild replays
        // it). Only a no-op apply (a replayed duplicate hitting its
        // DO-NOTHING key) is skipped, so replays never bloat the journal.
        let journal_worthy = match &result {
            Ok(touched) => *touched > 0,
            Err(_) => true,
        };
        if journal_worthy {
            if let Some(journal) = &*self.changes_journal.lock().expect("journal mutex") {
                journal.append(record);
            }
        }
        drop(conn);
        result
    }

    /// Owner-only lazy journal open. A forwarding instance keeps the
    /// journal closed — opening it rotates, and rotation is the owner's
    /// act alone — so the instant a takeover lands, this brings the new
    /// owner's journal up before any drained record is applied.
    fn ensure_changes_journal(&self) {
        if !self.changes_write_ok {
            return;
        }
        let Some(path) = self.changes_db_path.as_deref() else {
            return;
        };
        let mut journal = self.changes_journal.lock().expect("journal mutex");
        if journal.is_none() {
            *journal = crate::changes_journal::ChangesJournal::open(path);
        }
    }

    /// Apply a mutation that another instance forwarded to us. Owner-only
    /// by construction: a record that arrives while *this* instance is
    /// itself forwarding (stale routing — the sender read an out-of-date
    /// lockfile identity) is refused, never forwarded onward. Refusal is
    /// what makes a routing loop structurally impossible; the sender
    /// treats it like any failed forward — re-resolve, retry, or take the
    /// claim itself.
    pub fn apply_forwarded_change(
        &self,
        record: crate::changes_journal::Record,
    ) -> Result<usize, LedgerError> {
        if record.shapes_rows() {
            self.guard_changes_write()?;
        }
        if self.forwarding() {
            return Err(LedgerError::InvalidState(
                "this instance does not hold the changes writer claim".to_string(),
            ));
        }
        self.apply_change_locally(&record)
    }

    /// Try to take the writer claim and promote the attach to read-write.
    /// `None` when the claim is still held elsewhere or the re-attach
    /// fails (in which case the claim is released again rather than held
    /// by an instance that cannot write).
    fn take_over_changes_writer(&self) -> Option<tugcore::ledger_db::WriterLock> {
        let path = self.changes_db_path.as_deref()?;
        let lock = tugcore::ledger_db::claim_writer(path, &self.writer_identity)?;
        let conn = self.db.lock().expect("ledger mutex");
        if let Err(err) = conn.execute("DETACH DATABASE changes", []) {
            // Benign when a previous failed takeover left no attach
            // behind — treating it as fatal would poison every future
            // retry. A schema that genuinely is still attached fails the
            // ATTACH below, which handles it.
            tracing::warn!(error = %err, "detaching the changes attach for takeover failed; proceeding");
        }
        if let Err(err) = tugcore::ledger_db::attach(&conn, "changes", path) {
            tracing::error!(error = %err, "cannot re-attach the changes ledger read-write after taking the writer claim");
            // Fall back to read-only so reads keep working; without the
            // attach every changeset query would fail outright.
            if let Err(err) = tugcore::ledger_db::attach_read_only(&conn, "changes", path) {
                tracing::error!(error = %err, "cannot re-attach the changes ledger at all");
            }
            ledger_integrity::health::note_degraded("changes-takeover");
            return None;
        }
        Some(lock)
    }

    /// Retry a stalled takeover from outside the write path — the
    /// maintenance tick's nudge, so a forwarding instance whose owner died
    /// while nothing was being written still recovers (and drains what it
    /// is holding) instead of waiting for the next attribution event.
    pub fn retry_changes_takeover(&self) {
        let mut access = self.changes_access.lock().expect("changes access mutex");
        let crate::changes_writer::ChangesAccess::Forward(forwarder) = &mut *access else {
            return;
        };
        if !forwarder.retry_due() {
            return;
        }
        forwarder.note_attempt();
        let Some(lock) = self.take_over_changes_writer() else {
            return;
        };
        let drained = forwarder.take_pending();
        *access = crate::changes_writer::ChangesAccess::Owner(lock);
        drop(access);
        self.ensure_changes_journal();
        tracing::warn!(
            drained = drained.len(),
            "changes-ledger writer claim taken over on the maintenance tick"
        );
        for held in &drained {
            if let Err(err) = self.apply_change_locally(held) {
                tracing::warn!(error = %err, "queued changes record failed to apply after takeover");
            }
        }
    }

    /// Re-publish the owner identity into the claim lockfile when its
    /// content has drifted (a publish that failed at claim time leaves
    /// forwarders routing to the *previous* owner). No-op for non-owners
    /// and when the content already matches; called on the maintenance
    /// tick.
    pub fn republish_writer_identity(&self) {
        let mut access = self.changes_access.lock().expect("changes access mutex");
        if let crate::changes_writer::ChangesAccess::Owner(lock) = &mut *access {
            lock.republish(&self.writer_identity);
        }
    }

    /// Whether this instance currently owns the shared changes ledger.
    /// Owner-only duties (checkpointing, snapshot backups) consult it.
    pub fn owns_changes_writer(&self) -> bool {
        matches!(
            &*self.changes_access.lock().expect("changes access mutex"),
            crate::changes_writer::ChangesAccess::Owner(_)
                | crate::changes_writer::ChangesAccess::Unclaimed
        )
    }

    /// Refuse row INSERT/UPDATEs to the shared changes tables when the
    /// on-disk schema is newer than this build ([`CHANGES_SCHEMA_VERSION`]
    /// gate) — creating or reshaping rows against an unknown shape is how
    /// an old instance silently violates a newer schema's invariants.
    fn guard_changes_write(&self) -> Result<(), LedgerError> {
        if self.changes_write_ok {
            Ok(())
        } else {
            Err(LedgerError::InvalidState(
                "shared changes.db schema is newer than this build; write refused".to_string(),
            ))
        }
    }

    /// Rewrite a batch of legacy `file_events` rows to their canonical
    /// `project_dir` + repo-relative `file_path`, collision-safe against
    /// transitional duplicate rows, in one transaction. Returns the number of
    /// rows changed.
    ///
    /// Each rewrite is identified by its current PK
    /// `(tug_session_id, tool_use_id, old_file_path)`. Because a resumed session
    /// replays its history post-upgrade, a row already carrying the target
    /// repo-relative PK can coexist with the legacy absolute row — a plain
    /// multi-row `UPDATE` would abort on that PK conflict. So per row: when the
    /// target PK already exists, the legacy row is **deleted** and its
    /// `ambiguous` is OR-folded / the later `at` kept on the survivor;
    /// otherwise the legacy row is updated in place. A rewrite whose legacy row
    /// is already gone is skipped.
    pub fn backfill_file_events_repo_relative(
        &self,
        canonical_project_dir: &str,
        rewrites: &[FileEventRewrite],
    ) -> Result<usize, LedgerError> {
        if rewrites.is_empty() {
            return Ok(0);
        }
        self.guard_changes_write()?;
        // Forwarding mode has no local transaction to run: each rewrite
        // goes to the owner on its own. Rewrites are individually
        // idempotent, so the loss of batch atomicity costs nothing.
        if self.forwarding() {
            let mut applied = 0usize;
            for rw in rewrites {
                applied += self.write_change(crate::changes_journal::Record::Rewrite {
                    canonical_project_dir: canonical_project_dir.to_string(),
                    rewrite: rw.clone(),
                })?;
            }
            return Ok(applied);
        }
        let mut applied: Vec<FileEventRewrite> = Vec::new();
        {
            let mut conn = self.db.lock().expect("ledger mutex");
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            for rw in rewrites {
                if Self::apply_file_event_rewrite(&tx, canonical_project_dir, rw)? {
                    applied.push(rw.clone());
                }
            }
            tx.commit()?;
        }
        // Journal after commit so a rolled-back transaction never leaves
        // phantom rewrites in the durable record.
        if let Some(journal) = &*self.changes_journal.lock().expect("journal mutex") {
            for rw in &applied {
                journal.append(&crate::changes_journal::Record::Rewrite {
                    canonical_project_dir: canonical_project_dir.to_string(),
                    rewrite: rw.clone(),
                });
            }
        }
        Ok(applied.len())
    }

    /// Apply one canonicalization rewrite (see
    /// [`backfill_file_events_repo_relative`] for the collision rules).
    /// Returns whether a row changed. Also the journal-replay applier.
    fn apply_file_event_rewrite(
        conn: &Connection,
        canonical_project_dir: &str,
        rw: &FileEventRewrite,
    ) -> Result<bool, LedgerError> {
        let legacy: Option<(i64, i64)> = conn
            .query_row(
                "SELECT ambiguous, at FROM changes.file_events
                 WHERE tug_session_id = ?1 AND tool_use_id = ?2 AND file_path = ?3",
                params![rw.tug_session_id, rw.tool_use_id, rw.old_file_path],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((legacy_ambiguous, legacy_at)) = legacy else {
            return Ok(false);
        };

        let survivor: Option<(i64, i64)> = conn
            .query_row(
                "SELECT ambiguous, at FROM changes.file_events
                 WHERE tug_session_id = ?1 AND tool_use_id = ?2 AND file_path = ?3",
                params![rw.tug_session_id, rw.tool_use_id, rw.new_file_path],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;

        match survivor {
            Some((surv_ambiguous, surv_at)) => {
                // Target PK exists (replay duplicate): merge into it and drop
                // the legacy row.
                let merged_ambiguous = i64::from(surv_ambiguous != 0 || legacy_ambiguous != 0);
                conn.execute(
                    "UPDATE changes.file_events SET ambiguous = ?4, at = ?5, project_dir = ?6
                     WHERE tug_session_id = ?1 AND tool_use_id = ?2 AND file_path = ?3",
                    params![
                        rw.tug_session_id,
                        rw.tool_use_id,
                        rw.new_file_path,
                        merged_ambiguous,
                        surv_at.max(legacy_at),
                        canonical_project_dir,
                    ],
                )?;
                // The survivor keeps its own spans; the legacy row's go with
                // the legacy row rather than being stranded under a key
                // nothing names any more (Risk R10).
                conn.execute(
                    "DELETE FROM changes.file_event_spans
                     WHERE tug_session_id = ?1 AND tool_use_id = ?2 AND file_path = ?3",
                    params![rw.tug_session_id, rw.tool_use_id, rw.old_file_path],
                )?;
                conn.execute(
                    "DELETE FROM changes.file_events
                     WHERE tug_session_id = ?1 AND tool_use_id = ?2 AND file_path = ?3",
                    params![rw.tug_session_id, rw.tool_use_id, rw.old_file_path],
                )?;
            }
            None => {
                // The spans move with their parent. `OR REPLACE` because a
                // span orphaned at the target key by an earlier partial
                // rewrite must yield to the row that actually owns it — the
                // parent-level branch is already collision-free.
                conn.execute(
                    "UPDATE OR REPLACE changes.file_event_spans SET file_path = ?4
                     WHERE tug_session_id = ?1 AND tool_use_id = ?2 AND file_path = ?3",
                    params![
                        rw.tug_session_id,
                        rw.tool_use_id,
                        rw.old_file_path,
                        rw.new_file_path,
                    ],
                )?;
                conn.execute(
                    "UPDATE changes.file_events SET file_path = ?4, project_dir = ?5
                     WHERE tug_session_id = ?1 AND tool_use_id = ?2 AND file_path = ?3",
                    params![
                        rw.tug_session_id,
                        rw.tool_use_id,
                        rw.old_file_path,
                        rw.new_file_path,
                        canonical_project_dir,
                    ],
                )?;
            }
        }
        Ok(true)
    }

    /// Every `file_events` row owned by `tug_session_id`, oldest-first by
    /// `at`. The authoritative "files this session changed" list that
    /// `tugtool changes` filters against current `git status`.
    pub fn file_events_for_session(
        &self,
        tug_session_id: &str,
    ) -> Result<Vec<FileEventRow>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(
            "SELECT tug_session_id, tool_use_id, file_path,
                    tool_name, op, origin, ambiguous,
                    parent_tool_use_id, project_dir, at
             FROM changes.file_events
             WHERE tug_session_id = ?1
             ORDER BY at ASC, tool_use_id ASC, file_path ASC",
        )?;
        let rows = stmt
            .query_map(params![tug_session_id], file_event_row_from_query)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Every `file_events` row recorded against `project_dir`, joined with
    /// its owning `sessions` row for the owner display fields, oldest-first
    /// by `at`. The workspace changeset composition groups these by owner
    /// (the LEFT JOIN keeps events whose session row was evicted — they
    /// fall into the unattributed/unknown-owner bucket rather than
    /// vanishing).
    pub fn file_events_for_project(
        &self,
        project_dir: &str,
    ) -> Result<Vec<ProjectFileEvent>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        // The row's own stamp is the first-choice line ([P01]); the
        // sessions join answers for rows written before v3. A shared
        // database still owned by a pre-v3 build has no `fe.line_id`
        // column at all, so that spelling falls back to the join-only
        // query rather than failing the compose.
        let sql_v3 = "SELECT fe.tug_session_id, fe.tool_use_id, fe.file_path,
                    fe.tool_name, fe.op, fe.origin, fe.ambiguous,
                    fe.parent_tool_use_id, fe.project_dir, fe.at,
                    l.name, l.name_user_set, s.state, l.tag,
                    COALESCE(NULLIF(fe.line_id, ''), s.line_id)
             FROM changes.file_events fe
             LEFT JOIN sessions s ON s.session_id = fe.tug_session_id
             -- The owner's display fields are the **line's** ([P02]); the
             -- segment answers only for liveness, which is its own fact.
             LEFT JOIN lines l ON l.line_id = s.line_id
             WHERE fe.project_dir = ?1
             ORDER BY fe.at ASC, fe.tool_use_id ASC, fe.file_path ASC";
        let sql_v2 = "SELECT fe.tug_session_id, fe.tool_use_id, fe.file_path,
                    fe.tool_name, fe.op, fe.origin, fe.ambiguous,
                    fe.parent_tool_use_id, fe.project_dir, fe.at,
                    l.name, l.name_user_set, s.state, l.tag,
                    s.line_id
             FROM changes.file_events fe
             LEFT JOIN sessions s ON s.session_id = fe.tug_session_id
             LEFT JOIN lines l ON l.line_id = s.line_id
             WHERE fe.project_dir = ?1
             ORDER BY fe.at ASC, fe.tool_use_id ASC, fe.file_path ASC";
        let mut stmt = match conn.prepare(sql_v3) {
            Ok(stmt) => stmt,
            Err(rusqlite::Error::SqliteFailure(_, Some(ref msg)))
                if msg.contains("no such column") =>
            {
                conn.prepare(sql_v2)?
            }
            Err(err) => return Err(err.into()),
        };
        let rows = stmt
            .query_map(params![project_dir], |row| {
                Ok(ProjectFileEvent {
                    event: FileEventRow {
                        tug_session_id: row.get(0)?,
                        tool_use_id: row.get(1)?,
                        file_path: row.get(2)?,
                        tool_name: row.get(3)?,
                        op: row.get(4)?,
                        origin: row.get(5)?,
                        ambiguous: row.get::<_, i64>(6)? != 0,
                        parent_tool_use_id: row.get(7)?,
                        project_dir: row.get(8)?,
                        at: row.get(9)?,
                    },
                    owner_name: row.get(10)?,
                    // NULL when no session row matched (LEFT JOIN miss).
                    owner_name_user_set: row.get::<_, Option<i64>>(11)?.unwrap_or(0) != 0,
                    owner_live: row.get::<_, Option<String>>(12)?.as_deref() == Some("live"),
                    owner_tag: row.get(13)?,
                    line_id: row
                        .get::<_, Option<String>>(14)?
                        .filter(|line| !line.is_empty()),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Upsert one maintained changeset draft (Spec S09). `INSERT OR REPLACE`
    /// on the `(owner_kind, owner_id, project_dir)` key — the draft engine
    /// writes the latest message for an entry, superseding any prior draft.
    pub fn upsert_changeset_draft(&self, row: &ChangesetDraftRow) -> Result<(), LedgerError> {
        self.write_change(crate::changes_journal::Record::Draft { row: row.clone() })?;
        Ok(())
    }

    /// The bare draft upsert — shared with journal replay.
    fn upsert_changeset_draft_sql(
        conn: &Connection,
        row: &ChangesetDraftRow,
    ) -> Result<(), LedgerError> {
        conn.execute(
            "INSERT OR REPLACE INTO changes.changeset_drafts (
                owner_kind, owner_id, project_dir, fingerprint, message, updated_at,
                edited, selection
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                row.owner_kind,
                row.owner_id,
                row.project_dir,
                row.fingerprint,
                row.message,
                row.updated_at,
                row.edited as i64,
                row.selection,
            ],
        )?;
        Ok(())
    }

    /// The maintained draft for one entry, or `None` when none is stored.
    pub fn changeset_draft(
        &self,
        owner_kind: &str,
        owner_id: &str,
        project_dir: &str,
    ) -> Result<Option<ChangesetDraftRow>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(
            "SELECT owner_kind, owner_id, project_dir, fingerprint, message, updated_at,
                    edited, selection
             FROM changes.changeset_drafts
             WHERE owner_kind = ?1 AND owner_id = ?2 AND project_dir = ?3",
        )?;
        let mut rows = stmt.query_map(
            params![owner_kind, owner_id, project_dir],
            changeset_draft_row_from_query,
        )?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    /// The drafts version: `MAX(updated_at)` across every maintained draft,
    /// `None` when the table is empty. The aggregate feed's 2 s probe reads
    /// this to observe out-of-process writes (`tugtool draft set`) — [P12].
    pub fn changeset_drafts_version(&self) -> Result<Option<i64>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let version = conn.query_row(
            "SELECT MAX(updated_at) FROM changes.changeset_drafts",
            [],
            |r| r.get(0),
        )?;
        Ok(version)
    }

    /// Delete one maintained draft (post-landing cleanup: a committed entry,
    /// a joined or released dash). A no-op when no row matches.
    pub fn delete_changeset_draft(
        &self,
        owner_kind: &str,
        owner_id: &str,
        project_dir: &str,
    ) -> Result<(), LedgerError> {
        self.write_change(crate::changes_journal::Record::DraftDelete {
            owner_kind: owner_kind.to_string(),
            owner_id: owner_id.to_string(),
            project_dir: project_dir.to_string(),
        })?;
        Ok(())
    }

    /// Every maintained draft recorded against `project_dir` — the
    /// compose-time bulk read that attaches drafts to their entries.
    pub fn changeset_drafts_for_project(
        &self,
        project_dir: &str,
    ) -> Result<Vec<ChangesetDraftRow>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(
            "SELECT owner_kind, owner_id, project_dir, fingerprint, message, updated_at,
                    edited, selection
             FROM changes.changeset_drafts
             WHERE project_dir = ?1",
        )?;
        let rows = stmt
            .query_map(params![project_dir], changeset_draft_row_from_query)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Upsert one `session_metadata` row. Idempotent on `session_id`
    /// via `INSERT OR REPLACE` — the bridge intercept runs the merge
    /// on every outbound `system_metadata` line, so a steady-state
    /// session writes the same merged payload on every subsequent
    /// hit, which should be a no-op overwrite, not a duplicate-key
    /// error.
    ///
    /// `payload` is the merged JSON serialized as bytes. The merge
    /// itself happens in `merge_session_metadata` (this method is the
    /// pure persistence write).
    pub fn record_session_metadata(
        &self,
        session_id: &str,
        payload: &[u8],
        captured_at: i64,
    ) -> Result<(), LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        conn.execute(
            "INSERT OR REPLACE INTO session_metadata (session_id, payload, captured_at)
             VALUES (?1, ?2, ?3)",
            params![session_id, payload, captured_at],
        )?;
        Ok(())
    }

    /// Fetch the persisted `session_metadata` row for `session_id`, or
    /// `None` if no row exists (first-observation case; the merge
    /// degenerates to "take incoming verbatim").
    pub fn get_session_metadata(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionMetadataRow>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let row = conn
            .query_row(
                "SELECT session_id, payload, captured_at
                 FROM session_metadata
                 WHERE session_id = ?1",
                params![session_id],
                |row| {
                    Ok(SessionMetadataRow {
                        session_id: row.get(0)?,
                        payload: row.get(1)?,
                        captured_at: row.get(2)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    /// Upsert one `session_capabilities` row. Idempotent on `session_id`
    /// via `INSERT OR REPLACE` — the supervisor persists on every live
    /// capabilities frame, and only the most recent handshake matters
    /// (the next one replaces it wholesale, mirroring the in-memory
    /// `latest_capabilities` slot it backs).
    pub fn record_session_capabilities(
        &self,
        session_id: &str,
        payload: &[u8],
        captured_at: i64,
    ) -> Result<(), LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        conn.execute(
            "INSERT OR REPLACE INTO session_capabilities (session_id, payload, captured_at)
             VALUES (?1, ?2, ?3)",
            params![session_id, payload, captured_at],
        )?;
        Ok(())
    }

    /// Fetch the persisted `session_capabilities` row for `session_id`,
    /// or `None` if no handshake has ever been captured for it (a
    /// brand-new session, or one whose every spawn predates this table).
    pub fn get_session_capabilities(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionCapabilitiesRow>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let row = conn
            .query_row(
                "SELECT session_id, payload, captured_at
                 FROM session_capabilities
                 WHERE session_id = ?1",
                params![session_id],
                |row| {
                    Ok(SessionCapabilitiesRow {
                        session_id: row.get(0)?,
                        payload: row.get(1)?,
                        captured_at: row.get(2)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    /// Upsert the per-session `/context`-style breakdown. Idempotent on
    /// `session_id` via `INSERT OR REPLACE` — every fresh frame from
    /// tugcode produces one persist action, and the only persisted row
    /// for a session is always the most recent.
    ///
    /// `payload` is the wire-frame JSON serialized as bytes (the
    /// supervisor receives the frame, hands the raw payload here, and
    /// re-emits the same bytes at bind time). This module does not
    /// parse or validate the payload — the wire-frame TypeScript
    /// types do that on both ends.
    pub fn record_context_breakdown(
        &self,
        session_id: &str,
        payload: &[u8],
        captured_at: i64,
    ) -> Result<(), LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        conn.execute(
            "INSERT OR REPLACE INTO context_breakdown_latest (session_id, payload, captured_at)
             VALUES (?1, ?2, ?3)",
            params![session_id, payload, captured_at],
        )?;
        Ok(())
    }

    /// Fetch the persisted breakdown row for `session_id`, or `None`
    /// if no row exists. The popover's fallback path renders the
    /// pre-existing `cost_update`-derived view when `None` — see the
    /// "Fallback contract" section of the parent plan step.
    pub fn get_context_breakdown(
        &self,
        session_id: &str,
    ) -> Result<Option<ContextBreakdownRow>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let row = conn
            .query_row(
                "SELECT session_id, payload, captured_at
                 FROM context_breakdown_latest
                 WHERE session_id = ?1",
                params![session_id],
                |row| {
                    Ok(ContextBreakdownRow {
                        session_id: row.get(0)?,
                        payload: row.get(1)?,
                        captured_at: row.get(2)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    /// Append a `session_state_changes` row for `session_id`. Dedupes
    /// against the most recent persisted row for the same session: if
    /// the new `(phase, transport_state, interrupt_in_flight)` triple
    /// equals the most recent row's triple, this is a no-op (the
    /// caller has already deduped locally; this is the SQL-layer
    /// safety net for races where two dispatches see the same
    /// previous-state but one writes its row before the other
    /// finishes its comparison).
    ///
    /// Returns `Ok(true)` if a row was written, `Ok(false)` if the
    /// dedupe skipped it.
    pub fn record_session_state_change(
        &self,
        session_id: &str,
        at_ms: i64,
        phase: &str,
        transport_state: &str,
        interrupt_in_flight: bool,
    ) -> Result<bool, LedgerError> {
        let mut conn = self.db.lock().expect("ledger mutex");
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let most_recent: Option<(String, String, i64)> = tx
            .query_row(
                "SELECT phase, transport_state, interrupt_in_flight
                 FROM session_state_changes
                 WHERE session_id = ?1
                 ORDER BY id DESC
                 LIMIT 1",
                params![session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if let Some((prev_phase, prev_transport, prev_interrupt)) = most_recent {
            let prev_interrupt_bool = prev_interrupt != 0;
            if prev_phase == phase
                && prev_transport == transport_state
                && prev_interrupt_bool == interrupt_in_flight
            {
                return Ok(false);
            }
        }
        tx.execute(
            "INSERT INTO session_state_changes
                (session_id, at_ms, phase, transport_state, interrupt_in_flight)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                session_id,
                at_ms,
                phase,
                transport_state,
                interrupt_in_flight as i64,
            ],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// Return every `session_state_changes` row for `session_id`,
    /// oldest-first by `id` (which is monotonic). Empty vec if no rows
    /// exist for the session.
    pub fn list_session_state_changes(
        &self,
        session_id: &str,
    ) -> Result<Vec<SessionStateChangeRow>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(
            "SELECT id, session_id, at_ms, phase, transport_state, interrupt_in_flight
             FROM session_state_changes
             WHERE session_id = ?1
             ORDER BY id ASC",
        )?;
        let rows = stmt
            .query_map(params![session_id], |row| {
                let interrupt_int: i64 = row.get(5)?;
                Ok(SessionStateChangeRow {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    at_ms: row.get(2)?,
                    phase: row.get(3)?,
                    transport_state: row.get(4)?,
                    interrupt_in_flight: interrupt_int != 0,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Append a `pulse_lines` row and prune the log to `cap` rows
    /// (oldest first). `scopes` is persisted as a JSON array string.
    pub fn record_pulse_line(
        &self,
        at_ms: i64,
        beat: i64,
        text: &str,
        intent: Option<&str>,
        scopes: &[String],
        cap: usize,
    ) -> Result<(), LedgerError> {
        let scopes_json = serde_json::to_string(scopes).unwrap_or_else(|_| "[]".to_string());
        let mut conn = self.db.lock().expect("ledger mutex");
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT INTO pulse_lines (at_ms, beat, text, intent, scopes)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![at_ms, beat, text, intent, scopes_json],
        )?;
        tx.execute(
            "DELETE FROM pulse_lines
             WHERE id NOT IN (
                 SELECT id FROM pulse_lines ORDER BY id DESC LIMIT ?1
             )",
            params![cap as i64],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// The newest `limit` pulse lines, returned OLDEST-first (display /
    /// seed order). Empty vec when the log is empty.
    pub fn list_pulse_lines_tail(&self, limit: usize) -> Result<Vec<PulseLineRow>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(
            "SELECT id, at_ms, beat, text, intent, scopes FROM (
                 SELECT id, at_ms, beat, text, intent, scopes
                 FROM pulse_lines ORDER BY id DESC LIMIT ?1
             ) ORDER BY id ASC",
        )?;
        let rows = stmt
            .query_map(params![limit as i64], |row| {
                let scopes_json: String = row.get(5)?;
                Ok(PulseLineRow {
                    id: row.get(0)?,
                    at_ms: row.get(1)?,
                    beat: row.get(2)?,
                    text: row.get(3)?,
                    intent: row.get(4)?,
                    scopes: serde_json::from_str(&scopes_json).unwrap_or_default(),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// The newest `per_scope` lines for EACH scope the log's last `scan`
    /// rows mention, returned OLDEST-first (display order).
    ///
    /// The deck's restore read, and deliberately not `list_pulse_lines_tail`:
    /// a flat app-wide tail is whatever the last-chatty session said, so a
    /// quiet card rehydrates empty even though its lines are sitting in the
    /// table. Selecting per scope gives every session its own window. A line
    /// covering several scopes counts against all of them but is returned
    /// once; an unscoped (app-wide ambience) line gets a window of its own.
    pub fn list_pulse_lines_per_scope(
        &self,
        per_scope: usize,
        scan: usize,
    ) -> Result<Vec<PulseLineRow>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(
            "SELECT id, at_ms, beat, text, intent, scopes
             FROM pulse_lines ORDER BY id DESC LIMIT ?1",
        )?;
        let newest_first = stmt
            .query_map(params![scan as i64], |row| {
                let scopes_json: String = row.get(5)?;
                Ok(PulseLineRow {
                    id: row.get(0)?,
                    at_ms: row.get(1)?,
                    beat: row.get(2)?,
                    text: row.get(3)?,
                    intent: row.get(4)?,
                    scopes: serde_json::from_str(&scopes_json).unwrap_or_default(),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        // Where an unscoped line's window is kept — not a scope id, and the
        // empty string can never collide with one.
        const UNSCOPED: &str = "";
        let mut taken: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        let mut kept: Vec<PulseLineRow> = Vec::new();
        for row in newest_first {
            let keys: Vec<&str> = if row.scopes.is_empty() {
                vec![UNSCOPED]
            } else {
                row.scopes.iter().map(String::as_str).collect()
            };
            if !keys
                .iter()
                .any(|k| taken.get(*k).copied().unwrap_or(0) < per_scope)
            {
                continue;
            }
            for key in keys {
                *taken.entry(key.to_string()).or_insert(0) += 1;
            }
            kept.push(row);
        }
        kept.reverse();
        Ok(kept)
    }

    // MARK: - Overview posts

    /// Append one Overview post and return its rowid.
    ///
    /// Nothing prunes: the channel is permanent history, and the Operator's
    /// searches reach all of it. A transient post never arrives here — it is
    /// broadcast and forgotten by the caller.
    pub fn record_overview_post(&self, post: &OverviewPost) -> Result<i64, LedgerError> {
        let refs_json = serde_json::to_string(&post.refs).unwrap_or_else(|_| "[]".to_string());
        // NULL rather than `[]` where there is nothing attached: the column is
        // the exception on this table, and a row with no images should read
        // exactly like the rows written before the column existed.
        let attachments_json = if post.attachments.is_empty() {
            None
        } else {
            serde_json::to_string(&post.attachments).ok()
        };
        let conn = self.db.lock().expect("ledger mutex");
        conn.execute(
            "INSERT INTO overview_posts
                 (at_ms, author, session_id, wake_reason, body, refs, elapsed_ms, project_dir,
                  attachments, tokens)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                post.at_ms,
                post.author.as_str(),
                post.session_id,
                post.wake_reason,
                post.body,
                refs_json,
                post.elapsed_ms,
                post.project_dir,
                attachments_json,
                subword_tokens(&[&post.body, &refs_json]),
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// The newest `limit` posts, returned OLDEST-first (display order), which
    /// is what the card's CONTROL tail read wants on mount.
    pub fn list_overview_posts_tail(&self, limit: usize) -> Result<Vec<OverviewPost>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(
            "SELECT id, at_ms, author, session_id, wake_reason, body, refs, elapsed_ms, project_dir, attachments FROM (
                 SELECT id, at_ms, author, session_id, wake_reason, body, refs, elapsed_ms, project_dir, attachments
                 FROM overview_posts ORDER BY id DESC LIMIT ?1
             ) ORDER BY id ASC",
        )?;
        let rows = stmt.query_map(params![limit as i64], overview_post_from_row)?;
        Ok(rows
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .collect())
    }

    /// One page of history, newest-first by keyset, returned OLDEST-first —
    /// the read behind the card's scrollback.
    ///
    /// `before_id` is exclusive: absent it is the tail (identical to
    /// [`Self::list_overview_posts_tail`]), present it is the `limit` posts
    /// immediately older than that row. Keyset rather than offset because
    /// posts keep arriving while a reader pages backwards, and an offset would
    /// slide under them — the same page would return rows it already returned.
    ///
    /// The second half of the answer is whether there is more: the query asks
    /// for `limit + 1` rows and reports `has_more` from whether it got them,
    /// which costs one row and saves a `COUNT(*)` over the whole table.
    pub fn list_overview_posts_page(
        &self,
        before_id: Option<i64>,
        limit: usize,
    ) -> Result<(Vec<OverviewPost>, bool), LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(
            "SELECT id, at_ms, author, session_id, wake_reason, body, refs, elapsed_ms, project_dir, attachments FROM (
                 SELECT id, at_ms, author, session_id, wake_reason, body, refs, elapsed_ms, project_dir, attachments
                 FROM overview_posts
                 WHERE (?1 IS NULL OR id < ?1)
                 ORDER BY id DESC LIMIT ?2
             ) ORDER BY id ASC",
        )?;
        let rows = stmt.query_map(params![before_id, limit as i64 + 1], overview_post_from_row)?;
        let fetched = rows.collect::<Result<Vec<_>, _>>()?;
        // `has_more` is read off how many ROWS came back, before any
        // unreadable one is dropped: the probe row's job is to say whether
        // older history exists, and it says so by existing.
        let has_more = fetched.len() > limit;
        let mut posts: Vec<OverviewPost> = fetched.into_iter().flatten().collect();
        // The probe is the OLDEST of the page, since the page came back
        // oldest-first — so it comes off the front.
        if has_more && !posts.is_empty() {
            posts.remove(0);
        }
        Ok((posts, has_more))
    }

    /// The newest `limit` posts for one session, oldest-first — what a wake
    /// hands the Observer as "what you already said about this session", and
    /// therefore the whole dedup mechanism.
    pub fn list_overview_posts_for_session(
        &self,
        session_id: &str,
        limit: usize,
    ) -> Result<Vec<OverviewPost>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(
            "SELECT id, at_ms, author, session_id, wake_reason, body, refs, elapsed_ms, project_dir, attachments FROM (
                 SELECT id, at_ms, author, session_id, wake_reason, body, refs, elapsed_ms, project_dir, attachments
                 FROM overview_posts
                 WHERE session_id = ?1 AND author = 'observer'
                 ORDER BY id DESC LIMIT ?2
             ) ORDER BY id ASC",
        )?;
        let rows = stmt.query_map(params![session_id, limit as i64], overview_post_from_row)?;
        Ok(rows
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .collect())
    }

    /// The `n` posts on either side of `id`, inclusive of `id` itself —
    /// reading the narrative around a search hit.
    pub fn overview_posts_window(
        &self,
        id: i64,
        n: usize,
    ) -> Result<Vec<OverviewPost>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(
            "SELECT id, at_ms, author, session_id, wake_reason, body, refs, elapsed_ms, project_dir, attachments
             FROM overview_posts
             WHERE id BETWEEN ?1 - ?2 AND ?1 + ?2
             ORDER BY id ASC",
        )?;
        let rows = stmt.query_map(params![id, n as i64], overview_post_from_row)?;
        Ok(rows
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .collect())
    }

    /// Full-text search over post bodies and refs, best-match first.
    ///
    /// `query` is an FTS5 MATCH expression. A malformed one (an unbalanced
    /// quote, a bare operator) is a caller error rather than a panic: it comes
    /// back as `Err` and the Operator sees its own mistake in the verb result.
    /// The optional filters narrow the content table alongside the MATCH, so
    /// "what did the Observer say about this session last Tuesday" is one query.
    pub fn search_overview_posts(
        &self,
        query: &str,
        filter: &OverviewSearchFilter,
        limit: usize,
    ) -> Result<Vec<OverviewSearchHit>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(
            "SELECT p.id, p.at_ms, p.author, p.session_id, p.wake_reason, p.body, p.refs,
                    p.elapsed_ms, p.project_dir, p.attachments,
                    snippet(overview_posts_fts, 0, '', '', '…', 32)
             FROM overview_posts_fts f
             JOIN overview_posts p ON p.id = f.rowid
             WHERE overview_posts_fts MATCH ?1
               AND (?2 IS NULL OR p.author = ?2)
               AND (?3 IS NULL OR p.session_id = ?3)
               AND (?4 IS NULL OR p.at_ms >= ?4)
               AND (?5 IS NULL OR p.at_ms <= ?5)
             -- Column weights (body, refs, tokens). The body is what a post
             -- says; `refs` is a machine-written JSON list of paths and shas,
             -- and `tokens` is derived vocabulary — both are ways IN to a
             -- post, not reasons one is the best answer.
             ORDER BY bm25(overview_posts_fts, 2.0, 1.0, 1.0) ASC
             LIMIT ?6",
        )?;
        let rows = stmt.query_map(
            params![
                query,
                filter.author.map(|a| a.as_str()),
                filter.session_id.as_deref(),
                filter.since_ms,
                filter.until_ms,
                limit as i64,
            ],
            |row| {
                // Index 10: the hit columns are `overview_post_from_row`'s own
                // ten, and the excerpt trails them.
                let excerpt: String = row.get(10)?;
                Ok(overview_post_from_row(row)?.map(|post| OverviewSearchHit { post, excerpt }))
            },
        )?;
        Ok(rows
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .collect())
    }

    // MARK: - Facts library

    /// Append one fact, inside a transaction (or connection) the caller
    /// already holds.
    ///
    /// **This is the form to call from anywhere that already holds the ledger
    /// lock.** `SessionLedger.db` is a `std::sync::Mutex<Connection>`, which is
    /// not reentrant: `record_spawn` holds it across an IMMEDIATE transaction
    /// for its whole body, so calling the public `record_fact` from in there
    /// would deadlock tugcast on every session spawn — a hang, not an error,
    /// and one no unit test of either function alone would catch.
    ///
    /// Returns the new rowid, or `None` when nothing was written: either the
    /// `dedupe_key` was already present (a replayed frame recorded twice) or
    /// the fact names a private session. Both are ordinary outcomes, never
    /// errors — a recorder is best-effort and rides someone else's hot path.
    pub fn record_fact_tx(conn: &Connection, fact: &NewFact) -> Result<Option<i64>, LedgerError> {
        // Write-time privacy ([P05]), inside the same connection acquisition so
        // both the public and the `_tx` path enforce it. App-scoped facts (no
        // session) always record; a session with no row reads as public.
        if let Some(session_id) = fact.session_id.as_deref() {
            let private: Option<i64> = conn
                .query_row(
                    "SELECT private FROM sessions WHERE session_id = ?1",
                    params![session_id],
                    |row| row.get(0),
                )
                .optional()?;
            if private.unwrap_or(0) != 0 {
                return Ok(None);
            }
        }
        let affected = conn.execute(
            "INSERT OR IGNORE INTO facts
                 (at_ms, kind, session_id, subject, text, payload, dedupe_key, tokens)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                fact.at_ms,
                fact.kind,
                fact.session_id,
                fact.subject,
                fact.text,
                fact.payload,
                fact.dedupe_key,
                subword_tokens(&[fact.subject.as_deref().unwrap_or(""), &fact.text]),
            ],
        )?;
        if affected == 0 {
            return Ok(None);
        }
        Ok(Some(conn.last_insert_rowid()))
    }

    /// Append one fact, acquiring the ledger lock. Callers that already hold
    /// it must use [`SessionLedger::record_fact_tx`] instead.
    pub fn record_fact(&self, fact: &NewFact) -> Result<Option<i64>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        Self::record_fact_tx(&conn, fact)
    }

    /// One session's facts newer than a rowid, oldest first, capped.
    ///
    /// The read behind the tripwire engine's high-water mark ([P05]): a
    /// landing asks each of its lineage sessions for what that session has
    /// done since this wire last looked at it. Per session rather than over
    /// the whole tail, because the mark is per session — sessions run
    /// concurrently, and one that started before the last landing can land
    /// afterwards carrying facts whose rowids sit below a global mark.
    pub fn facts_for_session_after(
        &self,
        session_id: &str,
        after_rowid: i64,
        cap: usize,
    ) -> Result<Vec<FactRow>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(
            "SELECT id, at_ms, kind, session_id, subject, text, payload
             FROM facts WHERE session_id = ?1 AND id > ?2 ORDER BY id ASC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![session_id, after_rowid, cap as i64], fact_from_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Facts about one session, optionally narrowed to a single kind and to
    /// what is newer than a timestamp.
    ///
    /// Two callers share one shape: `session.prompts` asks for a session's
    /// `prompt` facts, and a Observer wake asks for every kind newer than its
    /// own most recent post.
    ///
    /// Returns the **newest `limit`** rows, ordered OLDEST-first — the
    /// `list_overview_posts_tail` shape, and the ordering both callers want.
    /// Truncating the other way would hand a long window's wake the start of
    /// the stretch and drop the end, which is the half a post is about.
    pub fn list_facts_for_session_since(
        &self,
        session_id: &str,
        kind: Option<&str>,
        since_ms: Option<i64>,
        limit: usize,
    ) -> Result<Vec<FactRow>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(concat!(
            "SELECT id, at_ms, kind, session_id, subject, text, payload FROM (
                 SELECT id, at_ms, kind, session_id, subject, text, payload
                 FROM facts
                 WHERE session_id = ?1
                   AND (?2 IS NULL OR kind = ?2)
                   AND (?3 IS NULL OR at_ms > ?3)",
            not_private!("facts.session_id"),
            "     ORDER BY at_ms DESC, id DESC
                 LIMIT ?4
             ) ORDER BY at_ms ASC, id ASC"
        ))?;
        let rows = stmt.query_map(
            params![session_id, kind, since_ms, limit as i64],
            fact_from_row,
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Facts by any combination of kind, session, and time — or none at all.
    ///
    /// The browse read beside the search one: `search_facts` answers "find
    /// facts about X" ranked by relevance, this answers "what happened"
    /// ordered by time, newest-first. Every filter is optional, including the
    /// session — which is the whole difference from
    /// [`SessionLedger::list_facts_for_session_since`], along with an
    /// `until_ms` bound and an ordering that is not re-sorted ascending for a
    /// wake composer. That function keeps its shape because the Observer wake
    /// depends on it; generalizing it in place would risk every wake for a
    /// verb's convenience.
    pub fn list_facts(
        &self,
        kind: Option<&str>,
        session_id: Option<&str>,
        since_ms: Option<i64>,
        until_ms: Option<i64>,
        limit: usize,
    ) -> Result<Vec<FactRow>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(concat!(
            "SELECT id, at_ms, kind, session_id, subject, text, payload
             FROM facts
             WHERE (?1 IS NULL OR kind = ?1)
               AND (?2 IS NULL OR session_id = ?2)
               AND (?3 IS NULL OR at_ms >= ?3)
               AND (?4 IS NULL OR at_ms <= ?4)",
            not_private!("facts.session_id"),
            " ORDER BY at_ms DESC, id DESC
             LIMIT ?5"
        ))?;
        let rows = stmt.query_map(
            params![kind, session_id, since_ms, until_ms, limit as i64],
            fact_from_row,
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// The `n` facts on either side of `id`, inclusive of `id` itself — what
    /// else was going on around a search hit.
    pub fn facts_window(&self, id: i64, n: usize) -> Result<Vec<FactRow>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(concat!(
            "SELECT id, at_ms, kind, session_id, subject, text, payload
             FROM facts
             WHERE id BETWEEN ?1 - ?2 AND ?1 + ?2",
            not_private!("facts.session_id"),
            " ORDER BY id ASC"
        ))?;
        let rows = stmt.query_map(params![id, n as i64], fact_from_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Full-text search over fact subjects and renderings, best-match first.
    ///
    /// The `search_overview_posts` shape: an FTS5 MATCH ranked by `bm25`, with
    /// the content-table filters narrowing alongside it, and a malformed query
    /// coming back as `Err` for the Operator to read rather than as a panic.
    pub fn search_facts(
        &self,
        query: &str,
        filter: &FactSearchFilter,
        limit: usize,
    ) -> Result<Vec<FactSearchHit>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(concat!(
            "SELECT f.id, f.at_ms, f.kind, f.session_id, f.subject, f.text, f.payload,
                    -- Column 1 (`text`), pinned. `-1` means auto-select the
                    -- best-matching column, which was harmless while both
                    -- indexed columns held authored prose. `tokens` is column
                    -- 2 and holds normalizer output (`tug tooltip action`), so
                    -- auto-select would start handing the Operator token soup
                    -- to quote into answers.
                    snippet(facts_fts, 1, '', '', '…', 32)
             FROM facts_fts x
             JOIN facts f ON f.id = x.rowid
             WHERE facts_fts MATCH ?1
               AND (?2 IS NULL OR f.kind = ?2)
               AND (?3 IS NULL OR f.session_id = ?3)
               AND (?4 IS NULL OR f.at_ms >= ?4)
               AND (?5 IS NULL OR f.at_ms <= ?5)",
            not_private!("f.session_id"),
            // Column weights (subject, text, tokens). `subject` is the fact's
            // headline handle — a sha, a command incipit, a session name — and
            // a hit there is almost always what the question meant, so it
            // outranks a passing mention in the rendered text. `tokens` is
            // derived vocabulary and ranks below both: it exists to make a row
            // reachable, not to make it win.
            " ORDER BY bm25(facts_fts, 4.0, 2.0, 1.0) ASC
             LIMIT ?6"
        ))?;
        let rows = stmt.query_map(
            params![
                query,
                filter.kind.as_deref(),
                filter.session_id.as_deref(),
                filter.since_ms,
                filter.until_ms,
                limit as i64,
            ],
            |row| {
                let excerpt: String = row.get(7)?;
                Ok(FactSearchHit {
                    fact: fact_from_row(row)?,
                    excerpt,
                })
            },
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// A segment's rewind point, for tests in other modules that drive the
    /// relay and need to see which edge kind it recorded. `None` on a rotation
    /// edge, which is exactly the distinction they are checking.
    #[cfg(test)]
    pub fn fork_point_for_test(&self, session_id: &str) -> Option<String> {
        let conn = self.db.lock().expect("ledger mutex");
        conn.query_row(
            "SELECT fork_point FROM sessions WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()
        .flatten()
    }

    /// Every recorded fact as `(kind, subject, text)`, oldest-first, for tests
    /// in other modules that drive a recorder and need to see what it wrote.
    /// The typed read verbs land with the Operator that consumes them.
    #[cfg(test)]
    pub fn facts_for_test(&self) -> Vec<(String, String, String)> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn
            .prepare("SELECT kind, subject, text FROM facts ORDER BY id ASC")
            .expect("prepare");
        stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                row.get::<_, String>(2)?,
            ))
        })
        .expect("query")
        .collect::<Result<Vec<_>, _>>()
        .expect("rows")
    }

    // MARK: - File events, read side

    /// Every file event one session recorded, oldest-first. Backs the
    /// Operator's `changes.for_session` verb.
    pub fn list_file_events_for_session(
        &self,
        session_id: &str,
        limit: usize,
    ) -> Result<Vec<FileEventRow>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(concat!(
            "SELECT tug_session_id, tool_use_id, file_path, tool_name, op, origin,
                    ambiguous, parent_tool_use_id, project_dir, at
             FROM changes.file_events
             WHERE tug_session_id = ?1",
            not_private!("changes.file_events.tug_session_id"),
            " ORDER BY at ASC, rowid ASC
             LIMIT ?2"
        ))?;
        let rows = stmt.query_map(params![session_id, limit as i64], file_event_read_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// File events whose path matches a SQL LIKE pattern, newest-first,
    /// optionally bounded by time. Backs `changes.for_path` — "which sessions
    /// touched this file, and when".
    ///
    /// LIKE rather than FTS here on purpose: a path pattern is a structural
    /// match against a short indexed-ish column, not a relevance question over
    /// prose, so the mechanism that is wrong for post bodies is right here.
    pub fn list_file_events_for_path_pattern(
        &self,
        pattern: &str,
        since_ms: Option<i64>,
        until_ms: Option<i64>,
        limit: usize,
    ) -> Result<Vec<FileEventRow>, LedgerError> {
        let conn = self.db.lock().expect("ledger mutex");
        let mut stmt = conn.prepare(concat!(
            "SELECT tug_session_id, tool_use_id, file_path, tool_name, op, origin,
                    ambiguous, parent_tool_use_id, project_dir, at
             FROM changes.file_events
             WHERE file_path LIKE ?1
               AND (?2 IS NULL OR at >= ?2)
               AND (?3 IS NULL OR at <= ?3)",
            not_private!("changes.file_events.tug_session_id"),
            " ORDER BY at DESC, rowid DESC
             LIMIT ?4"
        ))?;
        let rows = stmt.query_map(
            params![pattern, since_ms, until_ms, limit as i64],
            file_event_read_row,
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
}

/// Optional narrowing applied alongside a Overview full-text MATCH.
#[derive(Debug, Clone, Default)]
pub struct OverviewSearchFilter {
    pub author: Option<OverviewAuthor>,
    pub session_id: Option<String>,
    pub since_ms: Option<i64>,
    pub until_ms: Option<i64>,
}

/// One search result: the post, plus the FTS5-cut excerpt around the match.
#[derive(Debug, Clone)]
pub struct OverviewSearchHit {
    pub post: OverviewPost,
    pub excerpt: String,
}

/// One fact on its way into the library. Every field is composed by
/// `feeds::facts_library` — the ledger computes nothing, so the rendering the
/// FTS index holds is the same rendering the Observer reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewFact {
    pub at_ms: i64,
    /// The fact kind, as `facts_library::FactKind` spells it — `prompt`,
    /// `session.spawned`, `shell`, `test_run`, `commit`, …
    pub kind: String,
    /// The session this fact is about, or `None` for an app-scoped fact.
    pub session_id: Option<String>,
    /// The headline handle: a sha, a command incipit, a name.
    pub subject: Option<String>,
    /// The one-line rendering ([P02]).
    pub text: String,
    /// Small structured JSON. Never outputs, never file bodies.
    pub payload: String,
    /// The idempotency key for replayable paths; `None` on live-only ones.
    pub dedupe_key: Option<String>,
}

/// One fact read back out of the library.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FactRow {
    pub id: i64,
    pub at_ms: i64,
    pub kind: String,
    pub session_id: Option<String>,
    pub subject: Option<String>,
    pub text: String,
    pub payload: String,
}

/// Optional narrowing applied alongside a facts full-text MATCH.
#[derive(Debug, Clone, Default)]
pub struct FactSearchFilter {
    pub kind: Option<String>,
    pub session_id: Option<String>,
    pub since_ms: Option<i64>,
    pub until_ms: Option<i64>,
}

/// One search result: the fact, plus the FTS5-cut excerpt around the match.
#[derive(Debug, Clone)]
pub struct FactSearchHit {
    pub fact: FactRow,
    pub excerpt: String,
}

/// Decode one `facts` row. The column order matches every read above.
fn fact_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<FactRow> {
    Ok(FactRow {
        id: row.get(0)?,
        at_ms: row.get(1)?,
        kind: row.get(2)?,
        session_id: row.get(3)?,
        subject: row.get(4)?,
        text: row.get(5)?,
        payload: row.get(6)?,
    })
}

/// Decode one `overview_posts` row.
///
/// An unparseable author yields `None` rather than an error: one row written
/// by a drifted writer should be skipped, not fail the whole read and take
/// the card's scrollback with it.
fn overview_post_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Option<OverviewPost>> {
    let author_raw: String = row.get(2)?;
    let Some(author) = OverviewAuthor::parse(&author_raw) else {
        tracing::warn!(author = %author_raw, "overview_posts: unknown author; row skipped");
        return Ok(None);
    };
    let refs_json: String = row.get(6)?;
    // NULL on every post with nothing attached, and on every row older than
    // the column. Unreadable JSON decodes to nothing attached rather than
    // failing the row: the post's body is the news.
    let attachments_json: Option<String> = row.get(9)?;
    Ok(Some(OverviewPost {
        id: Some(row.get(0)?),
        at_ms: row.get(1)?,
        author,
        session_id: row.get(3)?,
        wake_reason: row.get(4)?,
        body: row.get(5)?,
        refs: serde_json::from_str(&refs_json).unwrap_or_default(),
        elapsed_ms: row.get(7)?,
        project_dir: row.get(8)?,
        attachments: attachments_json
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default(),
        request_id: None,
        transient: false,
    }))
}

/// Decode one `changes.file_events` row for the read-side verbs. The column
/// order matches both read queries above.
fn file_event_read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<FileEventRow> {
    Ok(FileEventRow {
        tug_session_id: row.get(0)?,
        tool_use_id: row.get(1)?,
        file_path: row.get(2)?,
        tool_name: row.get(3)?,
        op: row.get(4)?,
        origin: row.get(5)?,
        ambiguous: row.get::<_, i64>(6)? != 0,
        parent_tool_use_id: row.get(7)?,
        project_dir: row.get(8)?,
        at: row.get(9)?,
    })
}

/// Decode one row from a `SELECT … FROM sessions` cursor matching the column
/// order documented inline at every callsite. The closure type makes
/// `query_map` happy: it returns `rusqlite::Result<Result<SessionRow, LedgerError>>`
/// so the outer collector can flatten with `?`.
fn scan_cache_row_from_query(row: &rusqlite::Row<'_>) -> rusqlite::Result<ScanCacheRow> {
    Ok(ScanCacheRow {
        session_id: row.get(0)?,
        project_dir: row.get(1)?,
        file_size: row.get(2)?,
        file_mtime: row.get(3)?,
        excluded: row.get::<_, i64>(4)? != 0,
        turn_count: row.get(5)?,
        last_user_prompt: row.get(6)?,
        name: row.get(7)?,
        created_at: row.get(8)?,
        last_used_at: row.get(9)?,
        parse_offset: row.get(10)?,
        tail_hash: row.get(11)?,
        cwd_checked: row.get::<_, i64>(12)? != 0,
        created_at_found: row.get::<_, i64>(13)? != 0,
        frontier_open: row.get::<_, i64>(14)? != 0,
        frontier_pending_close: row.get::<_, i64>(15)? != 0,
        frontier_pending_close_msg_id: row.get(16)?,
        frontier_leaf_uuid: row.get(17)?,
        effective_uuids: row.get(18)?,
        lineage_ancestors: row.get(19)?,
        line_id: row.get(20)?,
    })
}

/// The ids a resumed session's transcript names as its own earlier lives,
/// oldest first, as the external scanner stored them.
///
/// The column is a comma-joined list written by `external_sessions`, and the
/// session's own id is never in it. Read on a best-effort footing: a session
/// the scanner has not reached yet simply has no ancestors to report.
fn resume_ancestors(conn: &Connection, session_id: &str) -> Vec<String> {
    let stored: Option<String> = match conn
        .query_row(
            "SELECT lineage_ancestors FROM external_scan_cache WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )
        .optional()
    {
        Ok(stored) => stored.flatten(),
        Err(err) => {
            tracing::warn!(
                session_id = %session_id,
                error = %err,
                "resume ancestors unreadable; treating the session as having none"
            );
            None
        }
    };
    stored
        .into_iter()
        .flat_map(|column| {
            column
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Every read of a `sessions` row projects through this list ([P02]). The
/// segment's own columns come from `sessions`; `tag`, `name` and
/// `name_user_set` are the **line's** and arrive through the join in
/// [`SESSIONS_JOINED`], which is why some forty readers across tugcast and the
/// deck went line-correct without one of them changing.
const SESSION_COLUMNS: &str = "s.session_id, s.workspace_key, s.project_dir, s.created_at,
     s.last_used_at, s.turn_count, s.last_user_prompt, s.state, s.card_id,
     l.name, l.name_user_set, l.tag, s.synopsis, s.private, s.dash_id, s.dash_name, s.line_id";

/// The `FROM` clause [`SESSION_COLUMNS`] is written against. `LEFT`, not
/// inner: a row whose line is somehow missing reads back as a row with no
/// identity rather than vanishing from a listing, which is the failure a
/// reader can see and act on.
const SESSIONS_JOINED: &str = "sessions s LEFT JOIN lines l ON l.line_id = s.line_id";

/// Which segment answers for a line ([P06]) — one rule, written once, because
/// a citation, a restore and a picker row must all seat on the same one.
const RESUME_SEGMENT_ORDER: &str = "ORDER BY (s.state = 'live') DESC,
              (NOT EXISTS (
                  SELECT 1 FROM sessions child
                  WHERE child.forked_from_session_id = s.session_id
              )) DESC,
              s.created_at DESC,
              s.rowid DESC";

fn line_row_from_query(row: &rusqlite::Row<'_>) -> rusqlite::Result<LineRow> {
    Ok(LineRow {
        line_id: row.get(0)?,
        tag: row.get(1)?,
        name: row.get(2)?,
        name_user_set: row.get::<_, i64>(3)? != 0,
        card_id: row.get(4)?,
        project_dir: row.get(5)?,
        created_at: row.get(6)?,
        last_used_at: row.get(7)?,
    })
}

/// The line a `sessions` row already carries, and nothing else — the one
/// answer no other source may override, because a row that is already a
/// segment of a line stays one.
fn line_of_in_sessions(conn: &Connection, session_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT line_id FROM sessions WHERE session_id = ?1",
        params![session_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .ok()
    .flatten()
    .flatten()
    .filter(|line_id| !line_id.is_empty())
}

/// [`SessionLedger::line_of`] against a connection the caller already holds,
/// so a writer inside a transaction asks the same question the same way.
fn line_of_in(conn: &Connection, session_id: &str) -> Option<String> {
    for sql in [
        "SELECT line_id FROM sessions WHERE session_id = ?1",
        "SELECT line_id FROM external_scan_cache WHERE session_id = ?1",
        "SELECT line_id FROM minted_tags WHERE session_id = ?1
         ORDER BY minted_at ASC, tag ASC LIMIT 1",
    ] {
        match conn
            .query_row(sql, params![session_id], |row| {
                row.get::<_, Option<String>>(0)
            })
            .optional()
        {
            Ok(Some(Some(line_id))) if !line_id.is_empty() => return Some(line_id),
            Ok(_) => {}
            Err(err) => {
                tracing::warn!(
                    session_id = %session_id,
                    error = %err,
                    "line lookup failed; treating the session as line-less"
                );
                return None;
            }
        }
    }
    None
}

/// Birth a line inside the caller's transaction, or return the one that is
/// already there ([P03]).
///
/// Claim-then-write, exactly as the segment tag claim used to be: `minted_tags`
/// is the all-time arbiter, so a spelling another line ever spent rerolls a
/// complete fresh `adjective-noun` rather than suffixing the taken one. The
/// `lines.tag` UNIQUE index is the live-row invariant and rerolls on the same
/// terms — it can fire where the arbiter says the spelling is this session's
/// own from an earlier life whose line still wears it.
///
/// Idempotent on `line_id`: an existing line has its `last_used_at` bumped and
/// its `card_id` seated, and nothing about its identity is touched.
fn birth_line_in(
    tx: &Connection,
    line_id: Option<&str>,
    session_id: &str,
    card_id: Option<&str>,
    project_dir: &str,
    tag: Option<&str>,
    now: i64,
) -> Result<LineRow, LedgerError> {
    let line_id = line_id
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let seat = card_id.filter(|c| !c.is_empty());
    let existing: Option<LineRow> = tx
        .query_row(
            "SELECT line_id, tag, name, name_user_set, card_id,
                    project_dir, created_at, last_used_at
             FROM lines WHERE line_id = ?1",
            params![line_id],
            line_row_from_query,
        )
        .optional()?;
    if let Some(mut line) = existing {
        tx.execute(
            "UPDATE lines
             SET last_used_at = MAX(last_used_at, ?2),
                 card_id = COALESCE(?3, card_id)
             WHERE line_id = ?1",
            params![line_id, now, seat],
        )?;
        line.last_used_at = line.last_used_at.max(now);
        if let Some(seat) = seat {
            line.card_id = Some(seat.to_owned());
        }
        return Ok(line);
    }
    let mut attempt: u32 = 0;
    let mut candidate = tag
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| roll_fresh_tag(session_id, now));
    let tag = loop {
        match claim_tag(tx, &candidate, session_id, now)? {
            TagClaim::Claimed => {}
            TagClaim::TakenByOther => {
                candidate = reroll_or_fail(&candidate, session_id, now, &mut attempt)?;
                continue;
            }
        }
        let worn: Option<String> = tx
            .query_row(
                "SELECT line_id FROM lines WHERE tag = ?1",
                params![candidate],
                |row| row.get(0),
            )
            .optional()?;
        match worn {
            None => break candidate,
            Some(_) => {
                candidate = reroll_or_fail(&candidate, session_id, now, &mut attempt)?;
            }
        }
    };
    tx.execute(
        "INSERT INTO lines (
            line_id, tag, name, name_user_set, card_id,
            project_dir, created_at, last_used_at
         ) VALUES (?1, ?2, NULL, 0, ?3, ?4, ?5, ?5)",
        params![line_id, tag, seat, project_dir, now],
    )?;
    tx.execute(
        "UPDATE minted_tags SET line_id = ?2 WHERE tag = ?1",
        params![tag, line_id],
    )?;
    Ok(LineRow {
        line_id,
        tag,
        name: None,
        name_user_set: false,
        card_id: seat.map(str::to_owned),
        project_dir: project_dir.to_owned(),
        created_at: now,
        last_used_at: now,
    })
}

fn row_from_query(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<SessionRow, LedgerError>> {
    let session_id: String = row.get(0)?;
    let workspace_key: String = row.get(1)?;
    let project_dir: String = row.get(2)?;
    let created_at: i64 = row.get(3)?;
    let last_used_at: i64 = row.get(4)?;
    let turn_count: i64 = row.get(5)?;
    let last_user_prompt: Option<String> = row.get(6)?;
    let state_str: String = row.get(7)?;
    let card_id: Option<String> = row.get(8)?;
    let name: Option<String> = row.get(9)?;
    let name_user_set: bool = row.get::<_, i64>(10)? != 0;
    let tag: Option<String> = row.get(11)?;
    let synopsis: Option<String> = row.get(12)?;
    let private: bool = row.get::<_, i64>(13)? != 0;
    let dash_id: Option<String> = row.get(14)?;
    let dash_name: Option<String> = row.get(15)?;
    let line_id: String = row.get::<_, Option<String>>(16)?.unwrap_or_default();
    let state = match state_str.parse::<SessionState>() {
        Ok(s) => s,
        Err(e) => return Ok(Err(e)),
    };
    Ok(Ok(SessionRow {
        session_id,
        workspace_key,
        project_dir,
        created_at,
        last_used_at,
        turn_count,
        last_user_prompt,
        state,
        card_id,
        name,
        name_user_set,
        tag,
        synopsis,
        private,
        dash_id,
        dash_name,
        line_id,
    }))
}

/// Whether `s` is a full session uuid — the `Tug-Session-Id` trailer's shape,
/// and the legacy one-line trailer's parenthesized token.
fn is_full_session_uuid(s: &str) -> bool {
    let groups = [8usize, 4, 4, 4, 12];
    let mut parts = s.split('-');
    for len in groups {
        match parts.next() {
            Some(part) if part.len() == len && part.bytes().all(|b| b.is_ascii_hexdigit()) => {}
            _ => return false,
        }
    }
    parts.next().is_none()
}

/// Whether `s` is a short session id — exactly the leading run a citation
/// records. The length comes from the trailer writer's own constant rather than
/// a second copy of the number.
fn is_short_session_id(s: &str) -> bool {
    s.len() == tugchanges_core::SHORT_SESSION_ID_LEN && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Whether `s` is a callsign — `adjective-noun`, extended by `-<Letter><digits>`
/// fork segments (`stocky-pixie`, `stocky-pixie-A1-B2`).
///
/// The shape is checked before the value reaches a query so a spelling that is
/// neither an id nor a callsign is refused here rather than scanning the table
/// for free prose. The match itself is exact and case-sensitive: the fork
/// segments carry a capital, and a callsign is a name rather than a query.
fn is_session_callsign(s: &str) -> bool {
    const MAX_LEN: usize = 64;
    if s.is_empty() || s.len() > MAX_LEN {
        return false;
    }
    let mut segments = s.split('-');
    let head = [segments.next(), segments.next()];
    for word in head {
        match word {
            Some(w) if !w.is_empty() && w.bytes().all(|b| b.is_ascii_lowercase()) => {}
            _ => return false,
        }
    }
    segments.all(|seg| {
        let mut bytes = seg.bytes();
        matches!(bytes.next(), Some(b) if b.is_ascii_uppercase())
            && bytes.len() > 0
            && bytes.all(|b| b.is_ascii_digit())
    })
}

/// The verdict of a `minted_tags` claim (Spec S08).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TagClaim {
    /// The tag is ours — either freshly claimed, or already recorded against
    /// this same session (re-spawn, resume, external adoption).
    Claimed,
    /// Another session minted this tag at some point. It is spent forever,
    /// even if that session has since been trashed.
    TakenByOther,
}

/// Claim `tag` for `session_id` in the all-time arbiter (Spec S08).
///
/// **Mine is not taken.** A claim whose row already names this same session
/// is idempotent and returns [`TagClaim::Claimed`] — that is the path a
/// re-spawn, a resume, and an external session's adoption all take, and
/// treating it as a collision would reroll a perfectly good callsign. Only a
/// row naming a *different* session is a real collision.
///
/// Runs inside the caller's transaction so the claim and the row it names
/// land together or not at all.
pub fn claim_tag(
    tx: &Connection,
    tag: &str,
    session_id: &str,
    now: i64,
) -> Result<TagClaim, LedgerError> {
    tx.execute(
        "INSERT INTO minted_tags (tag, session_id, minted_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(tag) DO NOTHING",
        params![tag, session_id, now],
    )?;
    let owner: String = tx.query_row(
        "SELECT session_id FROM minted_tags WHERE tag = ?1",
        params![tag],
        |row| row.get(0),
    )?;
    Ok(if owner == session_id {
        TagClaim::Claimed
    } else {
        TagClaim::TakenByOther
    })
}

/// Roll a fresh `adjective-noun` from the Rust lexicon.
///
/// The roller needs no exclusion set: `minted_tags` is the arbiter, so a
/// collision is caught by the claim and simply rerolls. `seed` is mixed per
/// attempt so successive rerolls inside one claim loop differ.
fn roll_tag(seed: u64) -> String {
    // xorshift64* — a whole PRNG crate for two array indices would be
    // ceremony; this only has to spread across 524k combinations.
    let mut x = seed | 1;
    let mut next = || {
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    };
    let adjectives = crate::session_tag_lexicon::TAG_ADJECTIVES;
    let nouns = crate::session_tag_lexicon::TAG_NOUNS;
    let adjective = adjectives[(next() as usize) % adjectives.len()];
    let noun = nouns[(next() as usize) % nouns.len()];
    format!("{adjective}-{noun}")
}

/// A seed for [`roll_tag`] that varies per session and per attempt without
/// pulling in a clock the tests cannot control.
fn roll_seed(session_id: &str, now: i64, attempt: u32) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in session_id.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash ^ (now as u64).rotate_left(17) ^ (u64::from(attempt) << 40)
}

/// A fresh `adjective-noun` candidate for a **line** being born with no
/// callsign offered — a spawn that named none, or a component the migration
/// found no spelling for. [`birth_line_in`] claims it and rerolls on a
/// collision. Nothing outside this module rolls one, because nothing outside
/// it births a line ([P03]).
fn roll_fresh_tag(session_id: &str, now: i64) -> String {
    roll_tag(roll_seed(session_id, now, 0))
}

/// How many fresh word pairs a single claim will try before giving up. With
/// 524,288 combinations, reaching this bound means something other than luck
/// is wrong.
const TAG_REROLL_CAP: u32 = 64;

/// The collision response: a fresh `adjective-noun`, or an error.
///
/// This also covers a spelling that has **moved on**: a candidate carried by
/// a superseded pre-fork copy loses its claim to the lineage head that
/// inherited it, and the fresh pair names what that copy now is — a new line
/// of work.
fn reroll_or_fail(
    taken: &str,
    session_id: &str,
    now: i64,
    attempt: &mut u32,
) -> Result<String, LedgerError> {
    *attempt += 1;
    if *attempt > TAG_REROLL_CAP {
        return Err(LedgerError::TagClaimFailed(format!(
            "no free tag after {TAG_REROLL_CAP} rerolls for session {session_id}"
        )));
    }
    let fresh = roll_tag(roll_seed(session_id, now, *attempt));
    tracing::info!(session_id, taken, fresh, "tag collision; rerolled");
    Ok(fresh)
}

/// True when `err` is sqlite's `duplicate column name` — the answer a losing
/// racer gets from a self-healing `ALTER TABLE ADD COLUMN`.
fn is_duplicate_column(err: &rusqlite::Error) -> bool {
    matches!(
        err,
        rusqlite::Error::SqliteFailure(_, Some(msg)) if msg.starts_with("duplicate column name")
    )
}

/// Decode one row from a `SELECT journal_id, session_id, user_text,
/// user_attachments, created_at FROM turns` cursor. Same closure type as
/// `row_from_query`: returns `rusqlite::Result<Result<JournalRow,
/// LedgerError>>` so callers can distinguish BLOB-JSON-decode errors
/// from sqlite-level errors and surface them through `LedgerError`.
fn journal_row_from_query(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<Result<JournalRow, LedgerError>> {
    let journal_id: String = row.get(0)?;
    let session_id: String = row.get(1)?;
    let user_text: String = row.get(2)?;
    let attachments_blob: Vec<u8> = row.get(3)?;
    let created_at: i64 = row.get(4)?;
    let user_attachments: Vec<serde_json::Value> = match serde_json::from_slice(&attachments_blob) {
        Ok(v) => v,
        Err(e) => return Ok(Err(LedgerError::Serde(e))),
    };
    Ok(Ok(JournalRow {
        journal_id,
        session_id,
        user_text,
        user_attachments,
        created_at,
    }))
}

/// Decode one row from a `SELECT … FROM turn_telemetry` cursor matching
/// the column order in `list_turn_telemetry`. No fallible decode beyond
/// rusqlite's own type coercion — every column is a fixed scalar — so
/// the outer `Result` wrapper just keeps the function-signature shape
/// consistent with the other row decoders in this module.
fn turn_telemetry_row_from_query(row: &rusqlite::Row<'_>) -> rusqlite::Result<TurnTelemetryRow> {
    Ok(TurnTelemetryRow {
        session_id: row.get(0)?,
        msg_id: row.get(1)?,
        input_tokens: row.get(2)?,
        output_tokens: row.get(3)?,
        cache_creation_input_tokens: row.get(4)?,
        cache_read_input_tokens: row.get(5)?,
        total_cost_usd: row.get(6)?,
        wall_clock_ms: row.get(7)?,
        awaiting_approval_ms: row.get(8)?,
        transport_downtime_ms: row.get(9)?,
        active_ms: row.get(10)?,
        ttft_ms: row.get(11)?,
        ttftc_ms: row.get(12)?,
        reconnect_count: row.get(13)?,
        max_stream_gap_ms: row.get(14)?,
        ended_at: row.get(15)?,
        session_init_tokens: row.get(16)?,
    })
}

/// Decode one row from a `SELECT … FROM file_events` cursor matching the
/// column order in `file_events_for_session`. Every column is a fixed
/// scalar (the `ambiguous` INTEGER is coerced to `bool`), so there is no
/// fallible decode beyond rusqlite's own type coercion.
fn file_event_row_from_query(row: &rusqlite::Row<'_>) -> rusqlite::Result<FileEventRow> {
    Ok(FileEventRow {
        tug_session_id: row.get(0)?,
        tool_use_id: row.get(1)?,
        file_path: row.get(2)?,
        tool_name: row.get(3)?,
        op: row.get(4)?,
        origin: row.get(5)?,
        ambiguous: row.get::<_, i64>(6)? != 0,
        parent_tool_use_id: row.get(7)?,
        project_dir: row.get(8)?,
        at: row.get(9)?,
    })
}

fn changeset_draft_row_from_query(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChangesetDraftRow> {
    Ok(ChangesetDraftRow {
        owner_kind: row.get(0)?,
        owner_id: row.get(1)?,
        project_dir: row.get(2)?,
        fingerprint: row.get(3)?,
        message: row.get(4)?,
        updated_at: row.get(5)?,
        edited: row.get::<_, i64>(6)? != 0,
        selection: row.get(7)?,
    })
}

/// Truncate a user-prompt to at most `USER_PROMPT_MAX_CHARS` chars
/// (Unicode-scalar count, not bytes). Cheap helper for callers that
/// want to forward the user's latest message into `record_user_prompt`.
pub fn truncate_user_prompt(prompt: &str) -> String {
    if prompt.chars().count() <= USER_PROMPT_MAX_CHARS {
        return prompt.to_owned();
    }
    prompt.chars().take(USER_PROMPT_MAX_CHARS).collect()
}

/// Current wall-clock time in unix milliseconds. Returns 0 if the system
/// clock is set before 1970, which doesn't happen on machines we run on.
pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Default location of claude code's per-project session JSONLs:
/// `~/.claude/projects/`. Production callers pass this to
/// `SessionLedger::open_with_claude_root` (or rely on `open` which
/// resolves it implicitly).
pub fn default_claude_projects_root() -> PathBuf {
    let home = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_default()));
    home.join(".claude").join("projects")
}

/// Encode a project_dir into the directory name claude code uses under
/// `~/.claude/projects/`. claude's convention replaces every character
/// outside `[A-Za-z0-9-]` in the absolute path with `-` — slashes and
/// dots, but also underscores and anything else exotic — producing a
/// flat name that's filesystem-safe and hashable. Verified against
/// `~/.claude/projects/` on claude 2.1.198 (a worktree path like
/// `.tugtree/tugdash__foo` lands on disk as `--tugtree-tugdash--foo`;
/// the earlier `/`-and-`.`-only mapping missed the underscores and hid
/// every such project's sessions from the picker).
///
/// **Do not call this directly with a user-supplied path** — claude
/// derives the directory name from the *canonical* cwd, so a path typed
/// through a symlink alias (`/u/src/tugtool`) encodes to a directory
/// that doesn't exist. [`claude_project_dir`] is the chokepoint that
/// canonicalizes first; this raw encoder exists for callers that
/// already hold a canonical path (and for tests seeding fixtures).
pub fn encode_claude_project_name(project_dir: &str) -> String {
    project_dir
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// THE mapping from a user-supplied project path to claude's on-disk
/// per-project directory — the single chokepoint every production
/// consumer (scan, trash, row synthesis) must route through.
///
/// Resolves the path to the **Claude form** via
/// [`resolve_to_claude_form`] (symlinks + synthetic.conf firmlinks
/// resolved, APFS data-volume firmlink collapsed back to `/Users/…`).
/// Claude names its `~/.claude/projects/<encoded-cwd>` directory after
/// the form `getcwd` reports — which is firmlink-*collapsed*, NOT the
/// firmlink-expanded `/System/Volumes/Data/…` that `std::fs::canonicalize`
/// would yield. Using `canonicalize` here was the bug that hid every
/// terminal-created session from the picker (the scan opened a
/// `-System-Volumes-Data-…` directory that does not exist) and silently
/// no-op'd trash; the resolver is firmlink-aware so all three forms
/// (on-disk dir name, ledger `workspace_key`, this canonical string)
/// agree. Returns both the resolved directory under `claude_projects_root`
/// and the canonical project-dir string, so callers never re-derive either.
pub fn claude_project_dir(claude_projects_root: &Path, project_dir: &str) -> (PathBuf, String) {
    let canonical = resolve_to_claude_form(Path::new(project_dir))
        .to_str()
        .map(|s| s.to_owned())
        .unwrap_or_else(|| project_dir.to_owned());
    let dir = claude_projects_root.join(encode_claude_project_name(&canonical));
    (dir, canonical)
}

/// How much of a transcript's tail the anchor read looks at.
///
/// Comfortably covers the distance from a turn's last assistant line to EOF —
/// the lines that follow one are short (progress, summaries). A turn whose
/// final assistant message alone exceeds this yields `None` and the timestamp
/// fallback, which is the same posture as every other failure here.
const ANCHOR_TAIL_BYTES: u64 = 64 * 1024;

/// Scan `path`'s tail backward for the newest assistant `message.id`.
///
/// The parse is deliberately permissive — the file belongs to Claude Code, not
/// to us, so a shape we don't recognize degrades placement rather than failing
/// a write. See [`SessionLedger::latest_assistant_msg_id`], whose contract this
/// implements.
///
/// `isSidechain` and `isMeta` entries are skipped, and that exclusion is
/// load-bearing rather than defensive tidiness: replay drops both, so their
/// `message.id` never becomes any turn's `msgId` and an anchor naming one could
/// never resolve — a silent, permanent fallback that would look like a working
/// anchor from the write side.
fn latest_assistant_msg_id_in(path: &Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(ANCHOR_TAIL_BYTES);
    if start > 0 {
        file.seek(SeekFrom::Start(start)).ok()?;
    }
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);

    let mut lines: Vec<&str> = text.split('\n').collect();
    // A non-zero seek can land mid-line. That first fragment is not a whole
    // JSON object and is never evidence of anything.
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }

    for line in lines.iter().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if entry.get("type").and_then(|v| v.as_str()) != Some("assistant") {
            continue;
        }
        if entry.get("isSidechain").and_then(|v| v.as_bool()) == Some(true)
            || entry.get("isMeta").and_then(|v| v.as_bool()) == Some(true)
        {
            continue;
        }
        let id = entry
            .get("message")
            .and_then(|m| m.get("id"))
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if !id.is_empty() {
            return Some(id.to_string());
        }
    }
    None
}

/// Move `<root>/<encoded>/<sessionId>.jsonl` to
/// `<root>/<encoded>/.tug-trash/<deletedAt>/<sessionId>.jsonl`. Best-
/// effort: returns the destination path on success or `None` if the
/// source file is missing or the move fails. Logs at warn-level on
/// error but never propagates — the row deletion that motivates this
/// move has already committed and shouldn't roll back over a filesystem
/// hiccup.
fn move_jsonl_to_trash(
    claude_projects_root: &Path,
    project_dir: &str,
    session_id: &str,
    deleted_at_ms: i64,
) -> Option<PathBuf> {
    // Chokepoint resolution: ledger rows record the user-typed path,
    // which may be a symlink alias of the canonical dir claude's
    // directory name encodes.
    let (project_root, _canonical) = claude_project_dir(claude_projects_root, project_dir);
    let source = project_root.join(format!("{session_id}.jsonl"));
    if !source.exists() {
        // Nothing to move — the JSONL was never created or already
        // disappeared. Not an error; the row was the last reference.
        return None;
    }
    let trash_dir = project_root
        .join(".tug-trash")
        .join(deleted_at_ms.to_string());
    if let Err(err) = std::fs::create_dir_all(&trash_dir) {
        tracing::warn!(
            error = %err,
            session_id,
            project_dir,
            trash_dir = %trash_dir.display(),
            "failed to create trash dir; leaving JSONL in place",
        );
        return None;
    }
    let dest = trash_dir.join(format!("{session_id}.jsonl"));
    if let Err(err) = std::fs::rename(&source, &dest) {
        tracing::warn!(
            error = %err,
            session_id,
            project_dir,
            dest = %dest.display(),
            "failed to move JSONL to trash; leaving in place",
        );
        return None;
    }
    tracing::info!(
        target: "dev::session-lifecycle",
        event = "ledger.trash_jsonl",
        session_id,
        project_dir,
        dest = %dest.display(),
    );
    Some(dest)
}

/// Walk `<trash_root>/*/` and remove any subdirectory whose name (a
/// `<deletedAt>` unix-millis stamp) is older than `cutoff`. Returns the
/// count of removed subdirs. Best-effort: missing root, missing entries,
/// or rmdir failures are logged but never propagated.
fn sweep_trash_dir(trash_root: &Path, cutoff: i64) -> usize {
    let entries = match std::fs::read_dir(trash_root) {
        Ok(it) => it,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return 0,
        Err(err) => {
            tracing::warn!(
                error = %err,
                trash_root = %trash_root.display(),
                "sweep_trash_dir read_dir failed",
            );
            return 0;
        }
    };
    let mut count = 0usize;
    for entry_result in entries {
        let entry = match entry_result {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = match entry.file_name().to_str().map(|s| s.to_owned()) {
            Some(n) => n,
            None => continue,
        };
        let stamp: i64 = match name.parse() {
            Ok(s) => s,
            Err(_) => continue,
        };
        if stamp >= cutoff {
            continue;
        }
        let path = entry.path();
        if let Err(err) = std::fs::remove_dir_all(&path) {
            tracing::warn!(
                error = %err,
                path = %path.display(),
                "sweep_trash remove_dir_all failed",
            );
            continue;
        }
        count += 1;
        tracing::info!(
            target: "dev::session-lifecycle",
            event = "ledger.trash_swept",
            path = %path.display(),
            stamp_ms = stamp,
        );
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;
    use tugcast_core::{OverviewAttachment, OverviewRef, OverviewRefKind};

    const WS_A: &str = "ws-alpha";
    const WS_B: &str = "ws-beta";

    fn millis(days_ago: i64) -> i64 {
        let now = 1_700_000_000_000_i64;
        now - days_ago * 86_400_000
    }

    fn fresh() -> SessionLedger {
        SessionLedger::open_in_memory().expect("open in-memory ledger")
    }

    fn seed_live(ledger: &SessionLedger, id: &str, ws: &str, card: &str, now: i64) {
        ledger
            .record_spawn(id, ws, "/proj", card, now, id, None)
            .expect("record_spawn");
    }

    // ── sessions.tag: claim-or-reroll, COALESCE-preserve, lazy backfill ───────

    /// A tag rerolled by the ledger is a fresh `adjective-noun` from the
    /// lexicon — never a suffix of the taken one, never NULL.
    fn assert_is_lexicon_pair(tag: &str) {
        let (adjective, noun) = tag.split_once('-').expect("adjective-noun");
        assert!(
            crate::session_tag_lexicon::TAG_ADJECTIVES.contains(&adjective),
            "{adjective} is not in the adjective pool ({tag})"
        );
        assert!(
            crate::session_tag_lexicon::TAG_NOUNS.contains(&noun),
            "{noun} is not in the noun pool ({tag})"
        );
    }

    #[test]
    fn record_spawn_stores_the_given_tag() {
        let l = fresh();
        l.record_spawn(
            "s1",
            WS_A,
            "/proj",
            "card-1",
            millis(0),
            "s1",
            Some("azure-heron"),
        )
        .expect("record_spawn");
        assert_eq!(
            l.get("s1").unwrap().unwrap().tag.as_deref(),
            Some("azure-heron")
        );
    }

    #[test]
    fn record_spawn_rerolls_a_taken_tag() {
        let l = fresh();
        l.record_spawn(
            "s1",
            WS_A,
            "/proj",
            "card-1",
            millis(0),
            "s1",
            Some("azure-heron"),
        )
        .unwrap();
        // A different session claiming the same tag gets a complete fresh
        // word pair — not `azure-heron-2` ([P12], Spec S08).
        l.record_spawn(
            "s2",
            WS_A,
            "/proj",
            "card-2",
            millis(0),
            "s2",
            Some("azure-heron"),
        )
        .unwrap();
        assert_eq!(
            l.get("s1").unwrap().unwrap().tag.as_deref(),
            Some("azure-heron"),
            "the original keeps its callsign"
        );
        let rerolled = l.get("s2").unwrap().unwrap().tag.expect("never NULL");
        assert_ne!(rerolled, "azure-heron");
        assert!(
            !rerolled.starts_with("azure-heron"),
            "no bare -N suffix survives: {rerolled}"
        );
        assert_is_lexicon_pair(&rerolled);
    }

    #[test]
    fn a_trashed_sessions_tag_is_never_re_minted() {
        // The property commit trailers rest on: a citation written today must
        // not resolve to a different session two years from now.
        let l = fresh();
        l.record_spawn(
            "s1",
            WS_A,
            "/proj",
            "card-1",
            millis(0),
            "s1",
            Some("azure-heron"),
        )
        .unwrap();
        l.mark_closed("s1").unwrap();
        l.trash("s1").unwrap();
        assert!(l.get("s1").unwrap().is_none(), "the row is gone");

        l.record_spawn(
            "s2",
            WS_A,
            "/proj",
            "card-2",
            millis(0),
            "s2",
            Some("azure-heron"),
        )
        .unwrap();
        let tag = l.get("s2").unwrap().unwrap().tag.expect("never NULL");
        assert_ne!(tag, "azure-heron", "a spent callsign never returns");
        assert_is_lexicon_pair(&tag);
    }

    #[test]
    fn a_cascade_deleted_sessions_tag_is_never_re_minted() {
        let l = fresh();
        l.record_spawn(
            "s1",
            WS_A,
            "/proj",
            "card-1",
            millis(3),
            "s1",
            Some("azure-heron"),
        )
        .unwrap();
        l.mark_closed("s1").unwrap();
        // The age sweep is one of the paths that hard-DELETEs the row.
        let swept = l.sweep_expired(86_400_000, millis(0)).unwrap();
        assert_eq!(swept, vec!["s1".to_string()]);

        l.record_spawn(
            "s2",
            WS_A,
            "/proj",
            "card-2",
            millis(0),
            "s2",
            Some("azure-heron"),
        )
        .unwrap();
        let tag = l.get("s2").unwrap().unwrap().tag.expect("never NULL");
        assert_ne!(tag, "azure-heron");
        assert_is_lexicon_pair(&tag);
    }

    #[test]
    fn re_claiming_a_tag_for_the_same_session_is_idempotent() {
        // Re-spawn, resume, and external adoption all re-present a tag the
        // session already owns. "Mine" is not "taken" (Spec S08) — no reroll.
        let l = fresh();
        for _ in 0..3 {
            l.record_spawn(
                "s1",
                WS_A,
                "/proj",
                "card-1",
                millis(0),
                "s1",
                Some("azure-heron"),
            )
            .unwrap();
        }
        assert_eq!(
            l.get("s1").unwrap().unwrap().tag.as_deref(),
            Some("azure-heron")
        );
    }

    #[test]
    fn a_spelling_that_moved_on_rerolls_a_fresh_pair() {
        // A legacy suffixed spelling claimed by one session is spent like any
        // other; a second session presenting it gets a complete fresh pair —
        // the retired lineage grammar earns no special refusal.
        let l = fresh();
        l.record_spawn(
            "s1",
            WS_A,
            "/proj",
            "card-1",
            millis(0),
            "s1",
            Some("azure-heron-A1"),
        )
        .unwrap();
        l.record_spawn(
            "s2",
            WS_A,
            "/proj",
            "card-2",
            millis(0),
            "s2",
            Some("azure-heron-A1"),
        )
        .unwrap();
        let tag = l.get("s2").unwrap().unwrap().tag.expect("rerolled tag");
        assert_ne!(tag, "azure-heron-A1");
        assert_is_lexicon_pair(&tag);
    }

    #[test]
    fn the_rust_lexicon_matches_its_typescript_source() {
        // Drift test (Spec S05): the ledger rerolls from the Rust copy while
        // the client mints from the TS source. Two lists that part would put
        // a word in one machine's callsigns and not the other's.
        let ts_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tugdeck/src/lib/session-tag-lexicon.ts");
        let ts = std::fs::read_to_string(&ts_path)
            .unwrap_or_else(|e| panic!("read {}: {e}", ts_path.display()));

        let pool = |name: &str| -> Vec<String> {
            // The marker ends at the opening bracket, so the body starts right
            // after it — searching for `[` would land on `string[]` instead.
            let marker = format!("export const {name}: readonly string[] = [");
            let start = ts
                .find(&marker)
                .unwrap_or_else(|| panic!("{name} not found in the TS lexicon"));
            let body_start = start + marker.len();
            let body_end = body_start + ts[body_start..].find(']').expect("close bracket");
            ts[body_start..body_end]
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.trim_matches('"').to_owned())
                .collect()
        };

        assert_eq!(
            pool("TAG_ADJECTIVES"),
            crate::session_tag_lexicon::TAG_ADJECTIVES,
            "adjective pools drifted — run `just gen-session-tag-lexicon`"
        );
        assert_eq!(
            pool("TAG_NOUNS"),
            crate::session_tag_lexicon::TAG_NOUNS,
            "noun pools drifted — run `just gen-session-tag-lexicon`"
        );
    }

    // ── migrate_sessions_to_lines: every pre-lines row gets a line ───────────

    /// Write a **pre-lines** ledger at `path` and hand back a connection to it.
    ///
    /// Hand-written rather than derived, deliberately: this is the shape the
    /// migration will meet on a real machine, and it stopped changing the day
    /// the migration was written. Only the three tables identity lived in are
    /// declared; the ledger's own bootstrap creates the rest on the open that
    /// migrates.
    fn pre_lines_ledger(path: &Path) -> Connection {
        let conn = Connection::open(path).expect("open the file directly");
        conn.execute_batch(
            "CREATE TABLE sessions (
                session_id        TEXT PRIMARY KEY,
                workspace_key     TEXT NOT NULL,
                project_dir       TEXT NOT NULL,
                created_at        INTEGER NOT NULL,
                last_used_at      INTEGER NOT NULL,
                turn_count        INTEGER NOT NULL DEFAULT 0,
                last_user_prompt  TEXT,
                state             TEXT NOT NULL,
                card_id           TEXT,
                name              TEXT,
                name_user_set     INTEGER NOT NULL DEFAULT 0,
                tag               TEXT,
                forked_from_session_id TEXT,
                fork_point        TEXT,
                stage_label       TEXT,
                stage_model       TEXT,
                synopsis          TEXT,
                private           INTEGER NOT NULL DEFAULT 0,
                dash_id           TEXT,
                dash_name         TEXT
             );
             CREATE UNIQUE INDEX sessions_tag ON sessions(tag);
             CREATE TABLE minted_tags (
                tag        TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                minted_at  INTEGER NOT NULL
             );
             CREATE TABLE external_scan_cache (
                session_id        TEXT PRIMARY KEY,
                project_dir       TEXT NOT NULL,
                file_size         INTEGER NOT NULL,
                file_mtime        INTEGER NOT NULL,
                excluded          INTEGER NOT NULL DEFAULT 0,
                turn_count        INTEGER NOT NULL DEFAULT 0,
                last_user_prompt  TEXT,
                name              TEXT,
                created_at        INTEGER NOT NULL DEFAULT 0,
                last_used_at      INTEGER NOT NULL DEFAULT 0,
                lineage_ancestors TEXT,
                tag               TEXT
             );",
        )
        .expect("the pre-lines schema");
        conn
    }

    /// One pre-lines `sessions` row.
    #[allow(clippy::too_many_arguments)]
    fn pre_lines_session(
        conn: &Connection,
        session_id: &str,
        card_id: Option<&str>,
        last_used_at: i64,
        tag: Option<&str>,
        name: Option<&str>,
        name_user_set: bool,
        forked_from: Option<&str>,
        fork_point: Option<&str>,
        stage_label: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO sessions (
                session_id, workspace_key, project_dir, created_at, last_used_at,
                turn_count, state, card_id, name, name_user_set, tag,
                forked_from_session_id, fork_point, stage_label
             ) VALUES (?1, 'ws', '/proj', ?2, ?2, 1, 'closed', ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                session_id,
                last_used_at,
                card_id,
                name,
                i64::from(name_user_set),
                tag,
                forked_from,
                fork_point,
                stage_label
            ],
        )
        .expect("seed a session");
    }

    fn mint(conn: &Connection, tag: &str, session_id: &str, minted_at: i64) {
        conn.execute(
            "INSERT INTO minted_tags (tag, session_id, minted_at) VALUES (?1, ?2, ?3)",
            params![tag, session_id, minted_at],
        )
        .expect("seed a minted spelling");
    }

    /// The live `release-main` shapes the brief's audit found, migrated in one
    /// pass: an arc whose stages each minted their own spelling, a rewind-fork
    /// that took its parent's, two rows wearing one user-set name, edge-less
    /// rows, and scan rows with and without a ledger ancestor.
    ///
    /// Run against a copy of `release-main` (41 segments, 1109 spent
    /// spellings), this produced 1091 lines with no `sessions` row and no
    /// `minted_tags` row left line-less and no user-set name worn twice. The
    /// largest line was `heroic-mule` / `dash+join-xp` with eight segments —
    /// `5b4b5867, 8698cbea, 696b12a6, 56617479, 4cde21f9, 7c9d2b49, e78009cd,
    /// 8fbf9d74` — owning `heroic-mule, open-stoat, sinewy-flash, pearly-horn,
    /// chummy-carp, plenty-mint, spicy-grain, chichi-jute`. Its shape is the
    /// one this fixture reproduces: two arc triples with a label-less segment
    /// between them.
    #[test]
    fn the_migration_gives_every_pre_lines_row_a_line() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sessions.db");
        {
            let conn = pre_lines_ledger(&path);

            // [F04]: root → devise → implement → rewind → devise → implement.
            // The user's name is on the root; each stage minted its own
            // spelling, and the label-less rewind sits mid-chain the way a
            // second arc's does on the live ledger.
            pre_lines_session(
                &conn,
                "root",
                Some("card-A"),
                100,
                Some("heroic-mule"),
                Some("dash+join-xp"),
                true,
                None,
                None,
                None,
            );
            pre_lines_session(
                &conn,
                "devise",
                Some("card-A"),
                200,
                Some("open-stoat"),
                None,
                false,
                Some("root"),
                None,
                Some("devise"),
            );
            pre_lines_session(
                &conn,
                "implement",
                Some("card-A"),
                300,
                None,
                Some("Keep the spike"),
                false,
                Some("devise"),
                None,
                Some("implement"),
            );
            pre_lines_session(
                &conn,
                "rewind",
                Some("card-A"),
                400,
                Some("pearly-horn"),
                None,
                false,
                Some("implement"),
                Some("prompt-uuid"),
                None,
            );
            pre_lines_session(
                &conn,
                "devise-2",
                Some("card-A"),
                450,
                Some("spicy-grain"),
                None,
                false,
                Some("rewind"),
                None,
                Some("devise"),
            );
            pre_lines_session(
                &conn,
                "implement-2",
                Some("card-A"),
                480,
                None,
                None,
                false,
                Some("devise-2"),
                None,
                Some("implement"),
            );
            mint(&conn, "heroic-mule", "root", 10);
            mint(&conn, "open-stoat", "devise", 20);
            mint(&conn, "pearly-horn", "rewind", 30);
            mint(&conn, "spicy-grain", "devise-2", 35);
            // A spelling the arc spent on a segment both tables have since
            // forgotten — an evicted stage. It still has to resolve.
            mint(&conn, "sinewy-flash", "evicted-stage", 25);

            // [F07]: two rows on one card wearing one user-set name.
            pre_lines_session(
                &conn,
                "dup-old",
                Some("card-B"),
                500,
                Some("glossy-straw"),
                Some("the parser work"),
                true,
                None,
                None,
                None,
            );
            pre_lines_session(
                &conn,
                "dup-new",
                Some("card-B"),
                600,
                Some("chummy-carp"),
                Some("the parser work"),
                true,
                None,
                None,
                None,
            );
            mint(&conn, "glossy-straw", "dup-old", 40);
            mint(&conn, "chummy-carp", "dup-new", 50);

            // Edge-less rows: one named, one legacy and tagless.
            pre_lines_session(
                &conn,
                "solo",
                Some("card-C"),
                700,
                Some("plenty-mint"),
                None,
                false,
                None,
                None,
                None,
            );
            mint(&conn, "plenty-mint", "solo", 60);
            pre_lines_session(
                &conn, "legacy", None, 800, None, None, false, None, None, None,
            );

            // Scan rows: one whose transcript names a ledger row as an earlier
            // life of itself, one that names nobody.
            for (id, ancestors, tag) in [
                ("scan-joined", Some("implement"), "tidy-perch"),
                ("scan-alone", None, "brisk-otter"),
            ] {
                conn.execute(
                    "INSERT INTO external_scan_cache (
                        session_id, project_dir, file_size, file_mtime,
                        created_at, last_used_at, lineage_ancestors, tag
                     ) VALUES (?1, '/proj', 100, 1, 1, 900, ?2, ?3)",
                    params![id, ancestors, tag],
                )
                .expect("seed a scan row");
                mint(&conn, tag, id, 70);
            }
        }

        let l = SessionLedger::open(&path, 0).expect("the migrating open");
        let conn = l.db.lock().expect("ledger mutex");

        let line_of = |id: &str| -> String {
            conn.query_row(
                "SELECT line_id FROM sessions WHERE session_id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap_or_else(|e| panic!("{id} has a line: {e}"))
        };
        let line = |line_id: &str| -> (String, Option<String>, bool, Option<String>) {
            conn.query_row(
                "SELECT tag, name, name_user_set, card_id FROM lines WHERE line_id = ?1",
                params![line_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get::<_, i64>(2)? != 0,
                        row.get(3)?,
                    ))
                },
            )
            .expect("the line")
        };

        // The whole arc is one line, wearing the earliest spelling any of its
        // segments ever spent and the user's name.
        let arc = line_of("root");
        for segment in ["devise", "implement", "rewind", "devise-2", "implement-2"] {
            assert_eq!(line_of(segment), arc, "{segment} joins the arc's line");
        }
        assert_eq!(
            line(&arc),
            (
                "heroic-mule".to_string(),
                Some("dash+join-xp".to_string()),
                true,
                Some("card-A".to_string())
            )
        );
        // Every spelling the arc spent points at that one line — including the
        // one whose segment is gone.
        let owner_of = |tag: &str| -> String {
            conn.query_row(
                "SELECT line_id FROM minted_tags WHERE tag = ?1",
                params![tag],
                |row| row.get(0),
            )
            .unwrap_or_else(|e| panic!("{tag} has an owning line: {e}"))
        };
        for spelling in ["heroic-mule", "open-stoat", "pearly-horn", "spicy-grain"] {
            assert_eq!(owner_of(spelling), arc, "{spelling} belongs to the arc");
        }
        // `sinewy-flash` names a segment neither table holds, so it gets a
        // card-less line of its own rather than going unresolvable.
        let stranded = owner_of("sinewy-flash");
        assert_ne!(stranded, arc);
        assert_eq!(line(&stranded).0, "sinewy-flash");

        // The contested name goes to the more recently used line; the other
        // keeps its callsign and loses only the name.
        assert_eq!(
            line(&line_of("dup-new")).1.as_deref(),
            Some("the parser work")
        );
        let older = line(&line_of("dup-old"));
        assert_eq!(older.0, "glossy-straw");
        assert_eq!(older.1, None);
        assert!(!older.2);

        // Edge-less rows are lines of one; the legacy tagless row rolls a pair.
        assert_ne!(line_of("solo"), line_of("legacy"));
        assert_eq!(line(&line_of("solo")).0, "plenty-mint");
        assert_is_lexicon_pair(&line(&line_of("legacy")).0);
        assert_eq!(line(&line_of("legacy")).3, None, "no card, no seat");

        // A scan row whose transcript names a ledger row joins that line; one
        // that names nobody becomes a card-less line of its own.
        let scan_line = |id: &str| -> String {
            conn.query_row(
                "SELECT line_id FROM external_scan_cache WHERE session_id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap_or_else(|e| panic!("{id} has a line: {e}"))
        };
        assert_eq!(scan_line("scan-joined"), arc);
        let alone = scan_line("scan-alone");
        assert_ne!(alone, arc);
        assert_eq!(line(&alone), ("brisk-otter".to_string(), None, false, None));

        // The invariants the migration asserted before it committed.
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |row| row.get(0)).unwrap() };
        assert_eq!(
            count("SELECT COUNT(*) FROM sessions WHERE line_id IS NULL"),
            0
        );
        assert_eq!(
            count("SELECT COUNT(*) FROM minted_tags WHERE line_id IS NULL"),
            0
        );
        assert_eq!(
            count(
                "SELECT COUNT(*) FROM (
                    SELECT name FROM lines WHERE name_user_set = 1
                    GROUP BY name HAVING COUNT(*) > 1
                 )"
            ),
            0
        );
    }

    /// The migration runs once. A second open finds `sessions.line_id` already
    /// there and does nothing — which is what makes the guard a shape rather
    /// than a version stamp.
    #[test]
    fn the_migration_is_a_no_op_on_a_ledger_that_already_speaks_lines() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sessions.db");
        {
            let conn = pre_lines_ledger(&path);
            pre_lines_session(
                &conn,
                "root",
                Some("card-A"),
                100,
                Some("heroic-mule"),
                Some("held"),
                true,
                None,
                None,
                None,
            );
            mint(&conn, "heroic-mule", "root", 10);
        }
        let before = {
            let l = SessionLedger::open(&path, 0).expect("the migrating open");
            l.line_of("root").expect("a line")
        };
        let l = SessionLedger::open(&path, 0).expect("reopen");
        assert_eq!(l.line_of("root").as_deref(), Some(before.as_str()));
        let row = l.get_line(&before).unwrap().expect("the line");
        assert_eq!(row.tag, "heroic-mule");
        assert_eq!(row.name.as_deref(), Some("held"));
    }

    /// The migration leaves a copy of the pre-lines file beside the ledger
    /// ([R01]) — the one irreversible write in this plan, with a way back.
    #[test]
    fn the_migration_writes_a_pre_lines_sidecar() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sessions.db");
        {
            let conn = pre_lines_ledger(&path);
            pre_lines_session(
                &conn,
                "root",
                Some("card-A"),
                100,
                Some("heroic-mule"),
                None,
                false,
                None,
                None,
                None,
            );
            mint(&conn, "heroic-mule", "root", 10);
        }
        let sidecar = dir.path().join("sessions.db.pre-lines");
        assert!(!sidecar.exists());
        let _l = SessionLedger::open(&path, 0).expect("the migrating open");
        assert!(sidecar.exists(), "the pre-lines copy is beside the ledger");

        // It is the *old* shape, which is the whole point of keeping it.
        let old = Connection::open(&sidecar).expect("open the sidecar");
        let columns: Vec<String> = old
            .prepare("SELECT name FROM pragma_table_info('sessions')")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<String>, _>>()
            .unwrap();
        assert!(columns.contains(&"tag".to_string()));
        assert!(!columns.contains(&"line_id".to_string()));
    }

    #[test]
    /// A `sessions` row carries no identity ([P01]). This is the invariant the
    /// whole model rests on: with nothing on a segment to name it, there is
    /// nothing to inherit, strand, displace, or climb for.
    fn no_identity_on_segments() {
        let l = fresh();
        let conn = l.db.lock().expect("ledger mutex");
        let columns: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('sessions')")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<String>, _>>()
            .unwrap();
        for gone in ["tag", "name", "name_user_set"] {
            assert!(
                !columns.contains(&gone.to_string()),
                "`sessions` still carries `{gone}`: {columns:?}"
            );
        }
        assert!(columns.contains(&"line_id".to_string()));
    }

    /// [P06]'s tie-break, in order: a live segment, then the line's tip (one
    /// nothing was forked from), then the newest. A failed segment is never
    /// offered — it is known-unrecoverable.
    #[test]
    fn resume_segment_prefers_live_then_unforked_then_newest() {
        let l = fresh();
        let line = "line-1";
        let seg = |id: &str, days_ago: i64| {
            l.record_spawn(id, WS_A, "/proj", "card-1", millis(days_ago), line, None)
                .expect("record_spawn");
        };

        // Newest alone: three closed segments, no edges.
        for (id, days_ago) in [("old", 5), ("mid", 3), ("new", 1)] {
            seg(id, days_ago);
            l.mark_closed(id).unwrap();
        }
        assert_eq!(
            l.resume_segment_for_line(line).unwrap().unwrap().session_id,
            "new"
        );

        // The line's tip beats recency: chain them so `tip` is the only
        // segment nothing was forked from, and seat there even though it is
        // the oldest row on the line.
        seg("tip", 9);
        l.mark_closed("tip").unwrap();
        l.set_fork_provenance("mid", "old", Some("point-1"))
            .unwrap();
        l.set_fork_provenance("new", "mid", Some("point-2"))
            .unwrap();
        l.set_fork_provenance("tip", "new", Some("point-3"))
            .unwrap();
        assert_eq!(
            l.resume_segment_for_line(line).unwrap().unwrap().session_id,
            "tip",
            "the tip keeps the whole scroll"
        );

        // A live segment beats both.
        seg("live", 7);
        assert_eq!(
            l.resume_segment_for_line(line).unwrap().unwrap().session_id,
            "live"
        );

        // A failed segment is never offered, however live-looking.
        l.mark_failed("live").unwrap();
        assert_eq!(
            l.resume_segment_for_line(line).unwrap().unwrap().session_id,
            "tip"
        );
    }

    /// A scanned transcript that names an earlier life of itself joins that
    /// line rather than starting a second one for the same conversation
    /// ([P07]).
    #[test]
    fn ensure_scan_line_joins_an_ancestors_line() {
        let l = fresh();
        l.record_spawn("root", WS_A, "/proj", "card-1", millis(0), "root", None)
            .unwrap();
        let root_line = l.line_of("root").expect("the root has a line");

        l.upsert_scan_cache(&scan_cache_row("resumed", Some("root")))
            .unwrap();
        let joined = l.ensure_scan_line("resumed", millis(0)).unwrap();
        assert_eq!(joined.as_deref(), Some(root_line.as_str()));

        // A transcript that names nobody gets a card-less line of its own.
        l.upsert_scan_cache(&scan_cache_row("stranger", None))
            .unwrap();
        let own = l
            .ensure_scan_line("stranger", millis(0))
            .unwrap()
            .expect("a line");
        assert_ne!(own, root_line);
        let row = l.get_line(&own).unwrap().expect("the line");
        assert_eq!(row.card_id, None, "a scan line is seated on no card");
        assert_is_lexicon_pair(&row.tag);

        // And a session with no cache row has nothing to attach a line to.
        assert_eq!(l.ensure_scan_line("absent", millis(0)).unwrap(), None);
    }

    /// `upsert_scan_cache` carries `line_id` across, so a re-parse of a grown
    /// file cannot orphan the row from its line — which would drop the
    /// callsign the picker has been showing ([P07]).
    #[test]
    fn a_rescan_does_not_orphan_the_scan_line() {
        let l = fresh();
        l.upsert_scan_cache(&scan_cache_row("ext", None)).unwrap();
        let line = l
            .ensure_scan_line("ext", millis(0))
            .unwrap()
            .expect("a line");

        // The file grew; the scanner writes a whole fresh row for it, and the
        // row it writes says nothing about lines.
        let mut grown = scan_cache_row("ext", None);
        grown.file_size = 99_999;
        grown.turn_count = 12;
        l.upsert_scan_cache(&grown).unwrap();

        assert_eq!(
            l.get_scan_cache("ext").unwrap().expect("the row").line_id,
            Some(line.clone())
        );
        assert_eq!(l.ensure_scan_line("ext", millis(0)).unwrap(), Some(line));
    }

    /// A spelling nothing wears anymore still resolves — to the line that
    /// spent it, seated on the segment a resume would open ([P08]).
    #[test]
    fn a_citation_resolves_a_retired_spelling_to_its_line() {
        let l = fresh();
        l.record_spawn("root", WS_A, "/proj", "card-1", millis(5), "line-1", None)
            .unwrap();
        let worn = l.get("root").unwrap().unwrap().tag.expect("a callsign");
        // A spelling the line spent under an older grammar: recorded against a
        // segment, owned by the line, worn by nothing.
        {
            let conn = l.db.lock().expect("ledger mutex");
            conn.execute(
                "INSERT INTO minted_tags (tag, line_id, session_id, minted_at)
                 VALUES ('stocky-pixie', 'line-1', 'root', 1)",
                [],
            )
            .unwrap();
        }
        // The line moved on to a newer segment.
        l.record_spawn("stage", WS_A, "/proj", "card-1", millis(1), "line-1", None)
            .unwrap();
        l.mark_closed("root").unwrap();

        for spelling in [worn.as_str(), "stocky-pixie"] {
            let resolved = l.resolve_session_ids(&[spelling.to_owned()]).unwrap();
            assert_eq!(resolved.len(), 1, "{spelling} resolves");
            assert_eq!(
                resolved[0].1.session_id, "stage",
                "{spelling} seats on the line's resume segment"
            );
            assert_eq!(resolved[0].1.tag.as_deref(), Some(worn.as_str()));
        }
    }

    /// A `Tug-Session:` trailer parenthesizes the **line's** eight characters
    /// ([P13]), so the prefix arm has to answer for a line id as well as for a
    /// session id.
    #[test]
    fn a_line_citation_resolves_by_line_short_id() {
        let l = fresh();
        let line = "7f3d2c18-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
        l.record_spawn(
            "aa11bb22-cc33-4d44-8e55-ff6677889900",
            WS_A,
            "/proj",
            "card-1",
            millis(0),
            line,
            None,
        )
        .unwrap();

        let resolved = l.resolve_session_ids(&["7f3d2c18".to_owned()]).unwrap();
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].0, "7f3d2c18");
        assert_eq!(
            resolved[0].1.session_id,
            "aa11bb22-cc33-4d44-8e55-ff6677889900"
        );

        // The segment's own eight characters keep resolving too — that is what
        // every trailer written before this model says.
        let by_segment = l.resolve_session_ids(&["aa11bb22".to_owned()]).unwrap();
        assert_eq!(by_segment.len(), 1);
        assert_eq!(
            by_segment[0].1.session_id,
            "aa11bb22-cc33-4d44-8e55-ff6677889900"
        );
    }

    /// A scan-cache row for `session_id`, optionally naming `ancestor` as an
    /// earlier life of the same transcript.
    fn scan_cache_row(session_id: &str, ancestor: Option<&str>) -> ScanCacheRow {
        ScanCacheRow {
            session_id: session_id.into(),
            project_dir: "/proj".into(),
            file_size: 1_000,
            file_mtime: millis(0),
            excluded: false,
            turn_count: 3,
            last_user_prompt: None,
            name: None,
            created_at: millis(1),
            last_used_at: millis(0),
            parse_offset: 0,
            tail_hash: 0,
            cwd_checked: false,
            created_at_found: false,
            frontier_open: false,
            frontier_pending_close: false,
            frontier_pending_close_msg_id: None,
            frontier_leaf_uuid: None,
            effective_uuids: None,
            lineage_ancestors: ancestor.map(str::to_owned),
            line_id: None,
        }
    }

    #[test]
    fn a_lines_callsign_survives_a_respawn_carrying_a_different_candidate() {
        let l = fresh();
        // A callsign is the line's and is minted once. A respawn carrying a
        // different provisional tag is offering one to a line that already has
        // one, and is ignored.
        l.record_spawn(
            "s1",
            WS_A,
            "/proj",
            "card-1",
            millis(0),
            "s1",
            Some("azure-heron"),
        )
        .unwrap();
        l.record_spawn(
            "s1",
            WS_A,
            "/proj",
            "card-1",
            millis(0),
            "s1",
            Some("other-swan"),
        )
        .unwrap();
        assert_eq!(
            l.get("s1").unwrap().unwrap().tag.as_deref(),
            Some("azure-heron")
        );

        // A spawn that offers none rolls one rather than landing a nameless
        // line: `lines.tag` is NOT NULL, so there is no tagless state to be in.
        l.record_spawn("s2", WS_A, "/proj", "card-2", millis(0), "s2", None)
            .unwrap();
        let rolled = l
            .get("s2")
            .unwrap()
            .unwrap()
            .tag
            .expect("a rolled callsign");
        assert_is_lexicon_pair(&rolled);
    }

    #[test]
    fn record_spawn_rerolls_a_backfill_that_collides() {
        let l = fresh();
        // One row already owns the tag.
        l.record_spawn(
            "s1",
            WS_A,
            "/proj",
            "card-1",
            millis(0),
            "s1",
            Some("azure-heron"),
        )
        .unwrap();
        // A second, initially tagless row is resumed with the SAME provisional
        // tag: the claim sees another session already minted it and rerolls
        // before the backfill `DO UPDATE` ever runs (Spec S08).
        l.record_spawn("s2", WS_A, "/proj", "card-2", millis(0), "s2", None)
            .unwrap();
        l.record_spawn(
            "s2",
            WS_A,
            "/proj",
            "card-2",
            millis(0),
            "s2",
            Some("azure-heron"),
        )
        .unwrap();
        let tag = l.get("s2").unwrap().unwrap().tag.expect("never NULL");
        assert_ne!(tag, "azure-heron");
        assert_is_lexicon_pair(&tag);
    }

    #[test]
    fn no_spawn_lands_a_null_tag_when_a_candidate_was_offered() {
        // The retired backstop landed NULL on suffix exhaustion. Every claim
        // path now either lands a real callsign or errors.
        let l = fresh();
        for i in 0..24 {
            let id = format!("s{i}");
            let card = format!("card-{i}");
            l.record_spawn(
                &id,
                WS_A,
                "/proj",
                &card,
                millis(0),
                &id,
                Some("azure-heron"),
            )
            .unwrap();
            let tag = l
                .get(&id)
                .unwrap()
                .unwrap()
                .tag
                .unwrap_or_else(|| panic!("{id} landed a NULL tag"));
            assert_is_lexicon_pair(&tag);
        }
    }

    #[test]
    fn a_resume_with_a_differing_candidate_spends_no_tag() {
        // A resumed row already wears its callsign, and the COALESCE keeps it.
        // A client racing the listing can still offer a fresh optimistic
        // candidate — claiming that candidate would spend a `minted_tags` row
        // on a tag no session will ever display.
        let l = fresh();
        l.record_spawn(
            "s1",
            WS_A,
            "/proj",
            "card-1",
            millis(0),
            "s1",
            Some("azure-heron"),
        )
        .unwrap();
        l.record_spawn(
            "s1",
            WS_A,
            "/proj",
            "card-1",
            millis(1),
            "s1",
            Some("coral-otter"),
        )
        .unwrap();
        assert_eq!(
            l.get("s1").unwrap().unwrap().tag.as_deref(),
            Some("azure-heron")
        );
        let conn = l.db.lock().expect("ledger mutex");
        let minted: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM minted_tags WHERE session_id = 's1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(minted, 1);
        // The offered-but-unused candidate stays mintable for another session.
        let taken: Option<String> = conn
            .query_row(
                "SELECT session_id FROM minted_tags WHERE tag = 'coral-otter'",
                [],
                |row| row.get(0),
            )
            .optional()
            .unwrap();
        assert_eq!(taken, None);
    }

    #[test]
    fn a_spawn_that_offers_no_callsign_rolls_a_fresh_one_per_line() {
        let l = fresh();
        // There is no tagless line, so two of them get two distinct spellings
        // rather than sharing a NULL the unique index would let past.
        l.record_spawn("s1", WS_A, "/proj", "card-1", millis(0), "s1", None)
            .unwrap();
        l.record_spawn("s2", WS_A, "/proj", "card-2", millis(0), "s2", None)
            .unwrap();
        let a = l.get("s1").unwrap().unwrap().tag.expect("a callsign");
        let b = l.get("s2").unwrap().unwrap().tag.expect("a callsign");
        assert_is_lexicon_pair(&a);
        assert_is_lexicon_pair(&b);
        assert_ne!(a, b);
    }

    // ── line identity: every segment wears the line's callsign ([P01]) ───────

    /// A rewind-fork: another **segment** of the parent's line ([P04]).
    /// Nothing is transferred, because there is nothing on a segment to
    /// transfer — the fork records where it came from and joins the line.
    fn spawn_fork(l: &SessionLedger, parent: &str, fork_point: &str, fork_id: &str) {
        let line_id = l.line_of(parent).expect("the parent belongs to a line");
        l.record_spawn(fork_id, WS_A, "/proj", "card-1", millis(0), &line_id, None)
            .expect("record_spawn");
        l.set_fork_provenance(fork_id, parent, Some(fork_point))
            .expect("set_fork_provenance");
    }

    #[test]
    fn every_segment_of_a_line_wears_the_lines_callsign() {
        let l = fresh();
        l.record_spawn(
            "root",
            WS_A,
            "/proj",
            "card-1",
            millis(0),
            "root",
            Some("stocky-pixie"),
        )
        .unwrap();

        // Five successive rewinds. Nothing accretes and nothing is stranded:
        // the callsign is the line's, so every segment reads it and the
        // superseded parent goes on wearing it too.
        let mut parent = "root".to_owned();
        for n in 0..5 {
            let fork_id = format!("f-{n}");
            spawn_fork(&l, &parent, &format!("point-{n}"), &fork_id);
            assert_eq!(
                l.get(&fork_id).unwrap().unwrap().tag.as_deref(),
                Some("stocky-pixie")
            );
            assert_eq!(
                l.get(&parent).unwrap().unwrap().tag.as_deref(),
                Some("stocky-pixie"),
                "the parent is still a segment of the same line"
            );
            parent = fork_id;
        }

        // Provenance lives in the columns, not the spelling.
        let conn = l.db.lock().unwrap();
        let (from, point): (String, String) = conn
            .query_row(
                "SELECT forked_from_session_id, fork_point FROM sessions
                 WHERE session_id = 'f-4'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(from, "f-3");
        assert_eq!(point, "point-4");
    }

    #[test]
    fn what_a_rotation_seated_a_session_as_survives_on_the_row() {
        // The transcript is an invariant of a rotation ([B05]), and a rotation
        // with no arc behind it has no arc record to reconstruct it from —
        // so the two facts the divider needs live on the row.
        let l = fresh();
        for id in ["root", "seated", "untouched"] {
            l.record_spawn(id, WS_A, "/proj", "card-1", millis(0), id, None)
                .expect("record_spawn");
        }
        l.set_stage_provenance("seated", "review", Some("opus"))
            .expect("stage provenance");

        assert_eq!(
            l.stage_provenance("seated"),
            Some(("review".to_string(), Some("opus".to_string())))
        );
        assert_eq!(
            l.stage_provenance("untouched"),
            None,
            "no rotation seated this session"
        );
        assert_eq!(
            l.stage_provenance("no-such-session"),
            None,
            "and an unknown session is not an error"
        );

        // The account default is the same absence the rotation carries, not a
        // stand-in word.
        l.set_stage_provenance("root", "rotate", None)
            .expect("stage provenance");
        assert_eq!(
            l.stage_provenance("root"),
            Some(("rotate".to_string(), None))
        );

        assert!(matches!(
            l.set_stage_provenance("no-such-session", "review", None),
            Err(LedgerError::NotFound(_))
        ));
    }

    #[test]
    fn a_ledger_opened_over_a_pre_migration_file_accepts_stage_provenance() {
        // The migration is additive and self-healing: a database written before
        // the columns existed grows them on the next open, and the rows it
        // already held read as "no rotation seated this".
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sessions.db");
        {
            let l = SessionLedger::open(&path, 0).expect("open");
            l.record_spawn("older", WS_A, "/proj", "card-1", millis(0), "older", None)
                .expect("record_spawn");
            let conn = l.db.lock().unwrap();
            for name in ["stage_label", "stage_model"] {
                conn.execute(&format!("ALTER TABLE sessions DROP COLUMN {name}"), [])
                    .expect("drop the column so the reopen has to add it");
            }
        }

        let l = SessionLedger::open(&path, 0).expect("reopen");
        assert_eq!(l.stage_provenance("older"), None);
        l.set_stage_provenance("older", "review", Some("opus"))
            .expect("the reopened ledger accepts the write");
        assert_eq!(
            l.stage_provenance("older"),
            Some(("review".to_string(), Some("opus".to_string())))
        );
    }

    #[test]
    fn a_stages_fork_point_is_null_where_a_rewinds_is_the_prompt_uuid() {
        // The provenance columns are what tells a rotation from a rewind: a
        // stage descends from its parent without copying history, so it has no
        // branch point and the column must be NULL rather than a stand-in.
        let l = fresh();
        for id in ["root", "stage", "rewind"] {
            l.record_spawn(id, WS_A, "/proj", "card-1", millis(0), id, None)
                .expect("record_spawn");
        }
        l.set_fork_provenance("stage", "root", None)
            .expect("stage provenance");
        l.set_fork_provenance("rewind", "root", Some("prompt-uuid"))
            .expect("rewind provenance");

        let conn = l.db.lock().unwrap();
        let read = |id: &str| -> (String, Option<String>) {
            conn.query_row(
                "SELECT forked_from_session_id, fork_point FROM sessions
                 WHERE session_id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
        };
        assert_eq!(read("stage"), ("root".to_string(), None));
        assert_eq!(
            read("rewind"),
            ("root".to_string(), Some("prompt-uuid".to_string()))
        );
    }

    #[test]
    fn an_inherited_callsign_resolves_to_the_line_head() {
        let l = fresh();
        l.record_spawn(
            "root",
            WS_A,
            "/proj",
            "card-1",
            millis(0),
            "root",
            Some("stocky-pixie"),
        )
        .unwrap();
        spawn_fork(&l, "root", "point-1", "f-1");
        let resolved = l.resolve_session_ids(&["stocky-pixie".to_owned()]).unwrap();
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].1.session_id, "f-1");
    }

    #[test]
    fn an_inherited_tag_stays_spent_across_trash() {
        let l = fresh();
        l.record_spawn(
            "root",
            WS_A,
            "/proj",
            "card-1",
            millis(0),
            "root",
            Some("stocky-pixie"),
        )
        .unwrap();
        spawn_fork(&l, "root", "point-1", "f-1");
        // Trash the head; the spelling is spent forever and never recycles
        // onto an unrelated session.
        l.mark_closed("f-1").unwrap();
        l.trash("f-1").unwrap();
        l.record_spawn(
            "s-new",
            WS_A,
            "/proj",
            "card-2",
            millis(0),
            "s-new",
            Some("stocky-pixie"),
        )
        .unwrap();
        let tag = l.get("s-new").unwrap().unwrap().tag.expect("rerolled");
        assert_ne!(tag, "stocky-pixie");
        assert_is_lexicon_pair(&tag);
    }

    #[test]
    fn a_cycle_in_the_edges_answers_rather_than_hanging() {
        let l = fresh();
        for id in ["a", "b"] {
            l.record_spawn(id, WS_A, "/proj", "card-1", millis(0), id, None)
                .unwrap();
        }
        l.set_fork_provenance("a", "b", Some("point-1")).unwrap();
        l.set_fork_provenance("b", "a", Some("point-2")).unwrap();
        // The parent-ward walk is bounded by its own visited set, so a cycle
        // ends the chain rather than hanging the restore that reads it.
        assert_eq!(l.lineage_chain("a"), vec!["b".to_string(), "a".to_string()]);
        assert_eq!(l.lineage_chain("b"), vec!["a".to_string(), "b".to_string()]);
    }

    // ── sessions.name: the live auto-title write ─────────────────────────────

    #[test]
    fn an_auto_title_never_overwrites_a_rename() {
        let l = fresh();
        l.record_spawn("s1", WS_A, "/proj", "card-1", millis(0), "s1", None)
            .unwrap();

        // An untitled row takes the auto title, and stays auto.
        assert!(
            l.record_auto_title("s1", "Parser bug investigation")
                .unwrap()
        );
        let row = l.get("s1").unwrap().unwrap();
        assert_eq!(row.name.as_deref(), Some("Parser bug investigation"));
        assert!(!row.name_user_set);

        // A second, identical title is not a change — no needless broadcast.
        assert!(
            !l.record_auto_title("s1", "Parser bug investigation")
                .unwrap()
        );
        // A newer auto title supersedes the older one.
        assert!(l.record_auto_title("s1", "Parser rewrite").unwrap());

        // Once the user has spoken, the auto title is silent forever.
        l.rename("s1", Some("the parser work")).unwrap();
        assert!(
            !l.record_auto_title("s1", "Something else entirely")
                .unwrap()
        );
        let row = l.get("s1").unwrap().unwrap();
        assert_eq!(row.name.as_deref(), Some("the parser work"));
        assert!(row.name_user_set);
    }

    #[test]
    fn an_auto_title_for_an_unknown_or_blank_case_is_a_no_op() {
        let l = fresh();
        l.record_spawn("s1", WS_A, "/proj", "card-1", millis(0), "s1", None)
            .unwrap();
        // The title rides a best-effort path; neither case may fail a turn.
        assert!(!l.record_auto_title("no-such-session", "A title").unwrap());
        assert!(!l.record_auto_title("s1", "   ").unwrap());
        assert_eq!(l.get("s1").unwrap().unwrap().name, None);
    }

    // ── sessions.synopsis: the rolling description ───────────────────────────

    #[test]
    fn a_synopsis_persists_and_survives_a_rename() {
        let l = fresh();
        l.record_spawn("s1", WS_A, "/proj", "card-1", millis(0), "s1", None)
            .unwrap();

        // An unnamed row takes the description and reads it back.
        assert!(l.record_synopsis("s1", "Repair tag minting").unwrap());
        assert_eq!(
            l.get("s1").unwrap().unwrap().synopsis.as_deref(),
            Some("Repair tag minting")
        );

        // An identical re-write is not a change — no needless broadcast.
        assert!(!l.record_synopsis("s1", "Repair tag minting").unwrap());
        // A newer description supersedes the older one.
        assert!(l.record_synopsis("s1", "Trace mint collisions").unwrap());

        // Naming the session does not stop it being described: the name is the
        // title and the description is the line beneath it, so both are wanted.
        l.rename("s1", Some("the mint work")).unwrap();
        assert!(l.record_synopsis("s1", "Something else entirely").unwrap());
        let row = l.get("s1").unwrap().unwrap();
        assert_eq!(row.synopsis.as_deref(), Some("Something else entirely"));
        // And the two fields are independent — a description write leaves the
        // user's name and its provenance flag exactly as they were.
        assert_eq!(row.name.as_deref(), Some("the mint work"));
        assert!(row.name_user_set);

        // Clearing the name leaves the description standing.
        l.rename("s1", None).unwrap();
        assert!(l.record_synopsis("s1", "Audit the reroll loop").unwrap());
        assert_eq!(
            l.get("s1").unwrap().unwrap().synopsis.as_deref(),
            Some("Audit the reroll loop")
        );
    }

    #[test]
    fn a_synopsis_for_an_unknown_or_blank_case_is_a_no_op() {
        let l = fresh();
        l.record_spawn("s1", WS_A, "/proj", "card-1", millis(0), "s1", None)
            .unwrap();
        // The description rides a best-effort lane; neither case may fail.
        assert!(!l.record_synopsis("no-such-session", "A line").unwrap());
        assert!(!l.record_synopsis("s1", "   ").unwrap());
        assert_eq!(l.get("s1").unwrap().unwrap().synopsis, None);
    }

    // ── scan_metrics_for: the pair every push carries ────────────────────────

    #[test]
    fn scan_metrics_answer_for_a_session_whose_ledger_count_is_sparse() {
        let l = fresh();
        // The shape the regression lives in: a `sessions` row whose own
        // `turn_count` is a sparse 0 because the session's real count only ever
        // came from a scan. A push built from the row alone would report both a
        // null size and 0 turns; the client replaces its cached row wholesale,
        // so that push is a downgrade rather than a partial update.
        l.record_spawn("s1", WS_A, "/proj", "card-1", millis(0), "s1", None)
            .unwrap();
        assert_eq!(l.get("s1").unwrap().unwrap().turn_count, 0);
        assert!(l.scan_metrics_for("s1").unwrap().is_none());

        l.upsert_scan_cache(&ScanCacheRow {
            session_id: "s1".into(),
            project_dir: "/proj".into(),
            file_size: 48_192,
            file_mtime: millis(5),
            excluded: false,
            turn_count: 7,
            last_user_prompt: None,
            name: None,
            created_at: millis(1),
            last_used_at: millis(5),
            parse_offset: 0,
            tail_hash: 0,
            cwd_checked: false,
            created_at_found: false,
            frontier_open: false,
            frontier_pending_close: false,
            frontier_pending_close_msg_id: None,
            frontier_leaf_uuid: None,
            effective_uuids: None,
            lineage_ancestors: None,
            line_id: None,
        })
        .unwrap();
        let metrics = l.scan_metrics_for("s1").unwrap().expect("scan row");
        assert_eq!(metrics.file_size, 48_192);
        assert_eq!(metrics.turn_count, 7);

        // A rename does not disturb the pair — which is the whole point: the
        // rename push carries the same two facts any other push does.
        l.rename("s1", Some("the mint work")).unwrap();
        assert_eq!(l.scan_metrics_for("s1").unwrap(), Some(metrics));

        // An unknown session has no pair, and neither does an excluded file:
        // a cwd/sessionId mismatch is not this session's transcript, so its
        // size and count are not this session's facts.
        assert!(l.scan_metrics_for("no-such-session").unwrap().is_none());
        l.upsert_scan_cache(&ScanCacheRow {
            session_id: "s2".into(),
            project_dir: "/proj".into(),
            file_size: 900,
            file_mtime: millis(5),
            excluded: true,
            turn_count: 3,
            last_user_prompt: None,
            name: None,
            created_at: millis(1),
            last_used_at: millis(5),
            parse_offset: 0,
            tail_hash: 0,
            cwd_checked: false,
            created_at_found: false,
            frontier_open: false,
            frontier_pending_close: false,
            frontier_pending_close_msg_id: None,
            frontier_leaf_uuid: None,
            effective_uuids: None,
            lineage_ancestors: None,
            line_id: None,
        })
        .unwrap();
        assert!(l.scan_metrics_for("s2").unwrap().is_none());
    }

    // ── resolve_session_ids: what a commit's citation names ──────────────────

    #[test]
    fn a_citation_resolves_by_full_uuid_and_by_short_id() {
        let l = fresh();
        let full = "f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
        l.record_spawn(
            full,
            WS_A,
            "/proj",
            "card-1",
            millis(0),
            full,
            Some("stocky-pixie"),
        )
        .unwrap();

        // The machine field's exact join.
        let by_uuid = l.resolve_session_ids(&[full.to_owned()]).unwrap();
        assert_eq!(by_uuid.len(), 1);
        assert_eq!(by_uuid[0].0, full);
        assert_eq!(by_uuid[0].1.session_id, full);

        // The citation's 8-char token, expanded here rather than against
        // whatever the client happened to have cached. Case is the trailer's,
        // not the ledger's.
        let by_short = l.resolve_session_ids(&["F6E43925".to_owned()]).unwrap();
        assert_eq!(by_short.len(), 1);
        // The answer is keyed by what was ASKED, so a caller can match it back
        // to the citation it read.
        assert_eq!(by_short[0].0, "F6E43925");
        assert_eq!(by_short[0].1.session_id, full);

        // The row travels whole — the callsign is what the chip renders, and
        // resolving is what puts the ledger's own word on it.
        assert_eq!(by_uuid[0].1.tag.as_deref(), Some("stocky-pixie"));
    }

    #[test]
    fn a_citation_resolves_by_callsign() {
        let l = fresh();
        let full = "f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
        l.record_spawn(
            full,
            WS_A,
            "/proj",
            "card-1",
            millis(0),
            full,
            Some("stocky-pixie"),
        )
        .unwrap();
        let forked = "aabbccdd-1111-2222-3333-444455556666";
        l.record_spawn(
            forked,
            WS_A,
            "/proj",
            "card-2",
            millis(1),
            forked,
            Some("stocky-pixie-A1"),
        )
        .unwrap();

        // A session atom carries a callsign and no id — this arm is what lets
        // its chip reach one, and so show a live dot.
        let by_tag = l.resolve_session_ids(&["stocky-pixie".to_owned()]).unwrap();
        assert_eq!(by_tag.len(), 1);
        assert_eq!(by_tag[0].0, "stocky-pixie");
        assert_eq!(by_tag[0].1.session_id, full);

        // A fork's callsign is a tag like any other and matches as itself, never
        // as its root.
        let by_fork = l
            .resolve_session_ids(&["stocky-pixie-A1".to_owned()])
            .unwrap();
        assert_eq!(by_fork.len(), 1);
        assert_eq!(by_fork[0].1.session_id, forked);

        // Exact, deliberately: a callsign is a name, not a prefix query.
        assert!(
            l.resolve_session_ids(&["stocky-pix".to_owned()])
                .unwrap()
                .is_empty()
        );
        assert!(
            l.resolve_session_ids(&["stocky-pixie-a1".to_owned()])
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn an_ambiguous_callsign_in_the_scan_cache_resolves_to_nothing() {
        // `lines.tag` is UNIQUE, so the ledger arm cannot be ambiguous — it
        // answers with the line's seat segment. Two *scan* rows can belong to
        // one line, and no index says which of them a citation meant, so the
        // ambiguity probe is load-bearing on the fallback.
        let l = fresh();
        let a = "f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
        let b = "aabbccdd-1111-2222-3333-444455556666";
        let scan_row = |id: &str| ScanCacheRow {
            session_id: id.into(),
            project_dir: "/proj/alpha".into(),
            file_size: 1_000,
            file_mtime: millis(5),
            excluded: false,
            turn_count: 42,
            last_user_prompt: None,
            name: None,
            created_at: millis(1),
            last_used_at: millis(5),
            parse_offset: 0,
            tail_hash: 0,
            cwd_checked: false,
            created_at_found: false,
            frontier_open: false,
            frontier_pending_close: false,
            frontier_pending_close_msg_id: None,
            frontier_leaf_uuid: None,
            effective_uuids: None,
            lineage_ancestors: None,
            line_id: None,
        };
        for id in [a, b] {
            l.upsert_scan_cache(&scan_row(id)).unwrap();
        }
        // Both scan rows join one line, which is the ambiguity: the callsign
        // names a conversation two files both claim to be.
        let line_id = l.ensure_scan_line(a, millis(0)).unwrap().expect("a line");
        l.db.lock()
            .expect("ledger mutex")
            .execute(
                "UPDATE external_scan_cache SET line_id = ?2 WHERE session_id = ?1",
                params![b, line_id],
            )
            .unwrap();
        let callsign = l.get_line(&line_id).unwrap().expect("the line").tag;
        assert!(l.resolve_session_ids(&[callsign]).unwrap().is_empty());
    }

    #[test]
    fn an_id_this_ledger_does_not_hold_resolves_to_nothing() {
        let l = fresh();
        l.record_spawn(
            "f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
            WS_A,
            "/proj",
            "card-1",
            millis(0),
            "f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
            None,
        )
        .unwrap();
        // A commit written against another machine's ledger. The absence IS the
        // answer — the client caches it and renders the slashed atom.
        assert!(
            l.resolve_session_ids(&["0badf00d-dead-4bee-8fee-000000000000".to_owned()])
                .unwrap()
                .is_empty()
        );
        assert!(
            l.resolve_session_ids(&["0badf00d".to_owned()])
                .unwrap()
                .is_empty()
        );
        // Neither shape: the grammar refused it upstream and nothing here
        // invents a spelling for it.
        assert!(
            l.resolve_session_ids(&["some free prose".to_owned()])
                .unwrap()
                .is_empty()
        );
        assert!(l.resolve_session_ids(&["".to_owned()]).unwrap().is_empty());
        // A `%` cannot become a wildcard: the short-id shape is validated
        // before the LIKE pattern is built.
        assert!(
            l.resolve_session_ids(&["f6e439%%".to_owned()])
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn an_ambiguous_short_id_resolves_to_nothing_rather_than_to_the_first_row() {
        let l = fresh();
        // Two sessions sharing eight hex chars — vanishingly unlikely and
        // therefore exactly the case nobody would notice going wrong.
        let a = "f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
        let b = "f6e43925-9999-4c3d-8e9f-0a1b2c3d4e5f";
        l.record_spawn(a, WS_A, "/proj", "card-1", millis(0), a, None)
            .unwrap();
        l.record_spawn(b, WS_A, "/proj", "card-2", millis(1), b, None)
            .unwrap();
        // A wrong-but-resolvable citation is strictly worse than an
        // unresolvable one ([D132]), so an ambiguous prefix answers nothing.
        assert!(
            l.resolve_session_ids(&["f6e43925".to_owned()])
                .unwrap()
                .is_empty()
        );
        // Each full uuid still resolves exactly — ambiguity is the prefix's
        // problem alone.
        assert_eq!(l.resolve_session_ids(&[a.to_owned()]).unwrap().len(), 1);
        assert_eq!(l.resolve_session_ids(&[b.to_owned()]).unwrap().len(), 1);
    }

    #[test]
    fn a_batch_answers_once_per_distinct_id() {
        let l = fresh();
        let a = "f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
        let b = "aabbccdd-1111-2222-3333-444455556666";
        l.record_spawn(a, WS_A, "/proj", "card-1", millis(0), a, None)
            .unwrap();
        l.record_spawn(b, WS_A, "/proj", "card-2", millis(1), b, None)
            .unwrap();
        // A History card asks for every commit on screen at once, and the same
        // session cites many commits — the duplicate is answered once.
        let answered = l
            .resolve_session_ids(&[
                a.to_owned(),
                b.to_owned(),
                a.to_owned(),
                "0badf00d".to_owned(),
            ])
            .unwrap();
        assert_eq!(answered.len(), 2);
        assert_eq!(answered[0].0, a);
        assert_eq!(answered[1].0, b);
    }

    #[test]
    fn a_ledger_predating_the_synopsis_column_migrates_in_place() {
        // A table built without the column — every ledger on disk before this
        // work. The self-healing ALTER adds it, existing rows read NULL, and a
        // second pass is a no-op rather than an error.
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(
            "CREATE TABLE sessions (
                 session_id        TEXT PRIMARY KEY,
                 workspace_key     TEXT NOT NULL,
                 project_dir       TEXT NOT NULL,
                 created_at        INTEGER NOT NULL,
                 last_used_at      INTEGER NOT NULL,
                 turn_count        INTEGER NOT NULL DEFAULT 0,
                 last_user_prompt  TEXT,
                 state             TEXT NOT NULL,
                 card_id           TEXT,
                 name              TEXT,
                 name_user_set     INTEGER NOT NULL DEFAULT 0,
                 tag               TEXT,
                 root_tag          TEXT,
                 tag_lineage       TEXT
             );
             INSERT INTO sessions
                 (session_id, workspace_key, project_dir, created_at,
                  last_used_at, state)
             VALUES ('legacy', 'ws', '/proj', 0, 0, 'closed');",
        )
        .expect("legacy schema");

        let has_synopsis = |conn: &Connection| {
            SessionLedger::table_columns(conn, "sessions")
                .expect("columns")
                .iter()
                .any(|(n, _)| n == "synopsis")
        };
        assert!(!has_synopsis(&conn));
        SessionLedger::migrate_sessions_add_synopsis(&conn).expect("migrate");
        assert!(has_synopsis(&conn));
        // Idempotent: a second open of the same database must not fail.
        SessionLedger::migrate_sessions_add_synopsis(&conn).expect("re-migrate");

        let existing: Option<String> = conn
            .query_row(
                "SELECT synopsis FROM sessions WHERE session_id = 'legacy'",
                [],
                |row| row.get(0),
            )
            .expect("read");
        assert_eq!(existing, None);

        // And on a database with no `sessions` table at all — a fresh install,
        // where the CREATE batch defines the column directly.
        let empty = Connection::open_in_memory().expect("in-memory db");
        SessionLedger::migrate_sessions_add_synopsis(&empty).expect("no-op");
    }

    #[test]
    fn a_ledger_carrying_the_pulse_overviews_cache_drops_it() {
        fn has_trigger(conn: &Connection) -> bool {
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'trigger'
                   AND name = 'pulse_overviews_cascade_delete_on_session'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("read sqlite_master")
                > 0
        }
        fn has_table(conn: &Connection) -> bool {
            !SessionLedger::table_columns(conn, "pulse_overviews")
                .expect("columns")
                .is_empty()
        }

        // The cache as it shipped — table, cascade trigger, and a row in it.
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(
            "CREATE TABLE sessions (session_id TEXT PRIMARY KEY);
             CREATE TABLE pulse_overviews (
                 scope  TEXT PRIMARY KEY,
                 at_ms  INTEGER NOT NULL,
                 beat   INTEGER NOT NULL,
                 text   TEXT NOT NULL,
                 phase  TEXT
             );
             CREATE TRIGGER pulse_overviews_cascade_delete_on_session
             AFTER DELETE ON sessions
             FOR EACH ROW
             BEGIN
                 DELETE FROM pulse_overviews WHERE scope = OLD.session_id;
             END;
             INSERT INTO pulse_overviews (scope, at_ms, beat, text, phase)
             VALUES ('s1', 1000, 1, 'a standing take', NULL);",
        )
        .expect("legacy schema");
        assert!(has_table(&conn) && has_trigger(&conn));

        SessionLedger::migrate_drop_pulse_overviews(&conn).expect("migrate");
        assert!(!has_table(&conn), "the cache survived the drop");
        assert!(!has_trigger(&conn), "the cascade trigger survived the drop");
        // Idempotent: a second open of the same database must not fail.
        SessionLedger::migrate_drop_pulse_overviews(&conn).expect("re-migrate");
        assert!(!has_table(&conn));

        // A database that never had it is untouched, and a ledger opened the
        // ordinary way never grows one — the DDL is gone and the migration is
        // wired into the bootstrap.
        let empty = Connection::open_in_memory().expect("in-memory db");
        SessionLedger::migrate_drop_pulse_overviews(&empty).expect("no-op");
        let ledger = fresh();
        let conn = ledger.db.lock().expect("ledger mutex");
        assert!(!has_table(&conn) && !has_trigger(&conn));
    }

    // ── pulse_lines: capped rolling log + tail read ──────────────────────────

    #[test]
    fn pulse_lines_cap_and_tail() {
        let ledger = fresh();
        // Empty log → empty tail.
        assert!(ledger.list_pulse_lines_tail(20).unwrap().is_empty());

        // Write past the cap; only the newest `cap` rows survive.
        // Even beats carry an intent, odd beats none — the tail must
        // round-trip both.
        let scopes = vec!["scope-a".to_string(), "scope-b".to_string()];
        for i in 1..=250_i64 {
            let intent = (i % 2 == 0).then(|| format!("intent {i}"));
            ledger
                .record_pulse_line(
                    1_000 + i,
                    i,
                    &format!("line {i}"),
                    intent.as_deref(),
                    &scopes,
                    200,
                )
                .expect("record_pulse_line");
        }
        let all = ledger.list_pulse_lines_tail(1_000).unwrap();
        assert_eq!(all.len(), 200);
        assert_eq!(all.first().unwrap().text, "line 51");
        assert_eq!(all.last().unwrap().text, "line 250");

        // Tail read returns the newest N, OLDEST-first, scopes intact.
        let tail = ledger.list_pulse_lines_tail(20).unwrap();
        assert_eq!(tail.len(), 20);
        assert_eq!(tail.first().unwrap().text, "line 231");
        assert_eq!(tail.last().unwrap().text, "line 250");
        assert_eq!(tail.last().unwrap().beat, 250);
        assert_eq!(tail.last().unwrap().scopes, scopes);
        assert_eq!(tail.last().unwrap().intent.as_deref(), Some("intent 250"));
        assert_eq!(tail.first().unwrap().intent, None); // beat 231, odd
    }

    #[test]
    fn pulse_lines_per_scope_gives_every_session_its_own_window() {
        let ledger = fresh();
        assert!(
            ledger
                .list_pulse_lines_per_scope(3, 200)
                .unwrap()
                .is_empty()
        );

        // A quiet session speaks once, then a chatty one floods the log —
        // the flat tail would bury the quiet line past any window.
        let quiet = vec!["quiet".to_string()];
        let chatty = vec!["chatty".to_string()];
        ledger
            .record_pulse_line(1_000, 1, "quiet beat", None, &quiet, 200)
            .unwrap();
        for i in 2..=50_i64 {
            ledger
                .record_pulse_line(1_000 + i, i, &format!("chatty {i}"), None, &chatty, 200)
                .unwrap();
        }
        assert!(
            !ledger
                .list_pulse_lines_tail(3)
                .unwrap()
                .iter()
                .any(|r| r.scopes == quiet),
            "the flat tail is exactly what loses the quiet session"
        );

        let per_scope = ledger.list_pulse_lines_per_scope(3, 200).unwrap();
        let texts: Vec<&str> = per_scope.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(
            texts,
            vec!["quiet beat", "chatty 48", "chatty 49", "chatty 50"],
            "each scope keeps its own newest 3; order stays oldest-first"
        );

        // A line covering both scopes is returned once and counts for each.
        let woven = vec!["quiet".to_string(), "chatty".to_string()];
        ledger
            .record_pulse_line(2_000, 51, "woven", None, &woven, 200)
            .unwrap();
        let per_scope = ledger.list_pulse_lines_per_scope(1, 200).unwrap();
        assert_eq!(
            per_scope
                .iter()
                .map(|r| r.text.as_str())
                .collect::<Vec<_>>(),
            vec!["woven"],
        );
    }

    // MARK: - Overview posts

    fn overview_post(at_ms: i64, author: OverviewAuthor, body: &str) -> OverviewPost {
        OverviewPost {
            id: None,
            at_ms,
            author,
            session_id: None,
            wake_reason: None,
            body: body.to_string(),
            refs: vec![],
            elapsed_ms: None,
            project_dir: None,
            attachments: Vec::new(),
            request_id: None,
            transient: false,
        }
    }

    /// The one assumption the search design rests on: the bundled SQLite has
    /// FTS5 compiled in. Kept as a permanent test rather than a one-off spike
    /// — a rusqlite bump that dropped the feature would otherwise surface as
    /// every ledger open failing, far from the cause.
    #[test]
    fn fts5_is_available_in_the_bundled_sqlite() {
        let ledger = fresh();
        let conn = ledger.db.lock().unwrap();
        conn.execute_batch("CREATE VIRTUAL TABLE fts5_probe USING fts5(x); DROP TABLE fts5_probe;")
            .expect("bundled SQLite must have FTS5 (SQLITE_ENABLE_FTS5)");
    }

    #[test]
    fn overview_posts_round_trip_with_refs_and_tail_ordering() {
        let ledger = fresh();
        assert!(ledger.list_overview_posts_tail(50).unwrap().is_empty());

        let mut first = overview_post(1_000, OverviewAuthor::Observer, "Landed the wake core");
        first.session_id = Some("s1".to_string());
        first.wake_reason = Some("sitrep-timer".to_string());
        first.refs = vec![
            OverviewRef {
                kind: OverviewRefKind::Commit,
                target: "4fe4d3fcd".to_string(),
            },
            OverviewRef {
                kind: OverviewRefKind::File,
                target: "tugrust/crates/tugcast/src/lib.rs".to_string(),
            },
        ];
        let id = ledger.record_overview_post(&first).expect("record");
        assert!(id > 0);

        for i in 2..=60_i64 {
            ledger
                .record_overview_post(&overview_post(
                    1_000 + i,
                    OverviewAuthor::Observer,
                    &format!("post {i}"),
                ))
                .expect("record");
        }

        // Nothing prunes — the channel is permanent history.
        assert_eq!(ledger.list_overview_posts_tail(1_000).unwrap().len(), 60);

        // The tail is the newest N, oldest-first.
        let tail = ledger.list_overview_posts_tail(10).unwrap();
        assert_eq!(tail.len(), 10);
        assert_eq!(tail.first().unwrap().body, "post 51");
        assert_eq!(tail.last().unwrap().body, "post 60");

        // Refs and the provenance columns survive the round trip.
        let all = ledger.list_overview_posts_tail(1_000).unwrap();
        let restored = all.first().unwrap();
        assert_eq!(restored.id, Some(id));
        assert_eq!(restored.author, OverviewAuthor::Observer);
        assert_eq!(restored.session_id.as_deref(), Some("s1"));
        assert_eq!(restored.wake_reason.as_deref(), Some("sitrep-timer"));
        assert_eq!(restored.refs.len(), 2);
        assert_eq!(restored.refs[0].kind, OverviewRefKind::Commit);
        assert_eq!(restored.refs[0].target, "4fe4d3fcd");
        // A stored row is never transient and carries no request id.
        assert!(!restored.transient);
        assert_eq!(restored.request_id, None);
        // And a post nobody attached anything to comes back with nothing
        // attached, rather than with a row the card has to defend against.
        assert!(restored.attachments.is_empty());
    }

    /// The pictures a question was asked with survive the round trip — which
    /// is the whole reason they are a column: a post read back days later has
    /// to still be able to show them.
    #[test]
    fn overview_post_attachments_round_trip() {
        let ledger = fresh();
        let mut asked = overview_post(2_000, OverviewAuthor::User, "what is this");
        asked.attachments = vec![
            OverviewAttachment {
                path: "/tmp/overview-attachments/a.png".to_string(),
                media_type: "image/png".to_string(),
            },
            OverviewAttachment {
                path: "/tmp/overview-attachments/b.jpg".to_string(),
                media_type: "image/jpeg".to_string(),
            },
        ];
        ledger.record_overview_post(&asked).expect("record");

        let restored = ledger.list_overview_posts_tail(10).unwrap();
        let post = restored.first().expect("the question");
        assert_eq!(post.attachments.len(), 2);
        assert_eq!(post.attachments[0].path, "/tmp/overview-attachments/a.png");
        assert_eq!(post.attachments[0].media_type, "image/png");
        // In the order they were composed, which is the order they are shown
        // to the model and drawn in the strip.
        assert_eq!(post.attachments[1].media_type, "image/jpeg");
    }

    /// Paging backwards through history: each page is the rows immediately
    /// older than the one the reader has, and `has_more` says whether to
    /// offer another.
    #[test]
    fn overview_paging_walks_backwards_by_keyset_and_reports_more() {
        let ledger = fresh();
        let mut ids = Vec::new();
        for i in 1..=25_i64 {
            ids.push(
                ledger
                    .record_overview_post(&overview_post(
                        1_000 + i,
                        OverviewAuthor::Observer,
                        &format!("post {i}"),
                    ))
                    .expect("record"),
            );
        }

        // No `before_id` is the tail, and it is the tail read verbatim.
        let (tail, more) = ledger.list_overview_posts_page(None, 10).unwrap();
        assert_eq!(
            tail.iter().map(|p| p.body.clone()).collect::<Vec<_>>(),
            ledger
                .list_overview_posts_tail(10)
                .unwrap()
                .iter()
                .map(|p| p.body.clone())
                .collect::<Vec<_>>(),
        );
        assert_eq!(tail.first().unwrap().body, "post 16");
        assert_eq!(tail.last().unwrap().body, "post 25");
        assert!(more, "fifteen older posts remain");

        // The next page is the ten immediately older, still oldest-first,
        // and it neither repeats nor skips a row at the seam.
        let oldest_held = tail.first().unwrap().id.unwrap();
        let (page, more) = ledger
            .list_overview_posts_page(Some(oldest_held), 10)
            .unwrap();
        assert_eq!(page.first().unwrap().body, "post 6");
        assert_eq!(page.last().unwrap().body, "post 15");
        assert!(more, "five older posts remain");

        // The last page comes up short and says so — nothing older exists.
        let (last, more) = ledger
            .list_overview_posts_page(Some(page.first().unwrap().id.unwrap()), 10)
            .unwrap();
        assert_eq!(last.len(), 5);
        assert_eq!(last.first().unwrap().body, "post 1");
        assert!(!more, "the walk has reached the beginning");

        // Past the beginning is empty rather than an error.
        let (none, more) = ledger.list_overview_posts_page(Some(ids[0]), 10).unwrap();
        assert!(none.is_empty());
        assert!(!more);
    }

    /// `has_more` at exactly the limit is the boundary that decides whether a
    /// reader is offered a page that turns out to be empty.
    #[test]
    fn overview_paging_reports_no_more_when_the_page_exactly_empties_history() {
        let ledger = fresh();
        for i in 1..=10_i64 {
            ledger
                .record_overview_post(&overview_post(
                    1_000 + i,
                    OverviewAuthor::Observer,
                    &format!("post {i}"),
                ))
                .expect("record");
        }
        let (page, more) = ledger.list_overview_posts_page(None, 10).unwrap();
        assert_eq!(page.len(), 10);
        assert!(!more, "ten of ten is the whole history, not a full page");

        let (page, more) = ledger.list_overview_posts_page(None, 9).unwrap();
        assert_eq!(page.len(), 9);
        assert!(more);
    }

    /// The keyset's whole reason for being: posts keep arriving while the
    /// reader pages backwards, and the page must not slide under them the way
    /// an OFFSET would.
    #[test]
    fn overview_paging_is_stable_while_newer_posts_arrive() {
        let ledger = fresh();
        for i in 1..=20_i64 {
            ledger
                .record_overview_post(&overview_post(
                    1_000 + i,
                    OverviewAuthor::Observer,
                    &format!("post {i}"),
                ))
                .expect("record");
        }
        let (tail, _) = ledger.list_overview_posts_page(None, 5).unwrap();
        let anchor = tail.first().unwrap().id.unwrap();

        // Five more posts land while the reader is reading.
        for i in 21..=25_i64 {
            ledger
                .record_overview_post(&overview_post(
                    1_000 + i,
                    OverviewAuthor::Observer,
                    &format!("post {i}"),
                ))
                .expect("record");
        }

        // The page is still the five immediately older than the anchor. An
        // offset-based read would have returned "post 16".."post 20" again,
        // shifted by exactly the five arrivals.
        let (page, _) = ledger.list_overview_posts_page(Some(anchor), 5).unwrap();
        assert_eq!(
            page.iter().map(|p| p.body.as_str()).collect::<Vec<_>>(),
            ["post 11", "post 12", "post 13", "post 14", "post 15"],
        );
    }

    /// The channel outlives the sessions it narrates: evicting a session row
    /// must not take its digests with it. Deliberately no cascade trigger.
    #[test]
    fn overview_posts_survive_deletion_of_the_session_they_reference() {
        let ledger = fresh();
        seed_live(&ledger, "s1", WS_A, "card-1", millis(0));
        let mut post = overview_post(1_000, OverviewAuthor::Observer, "narrating s1");
        post.session_id = Some("s1".to_string());
        ledger.record_overview_post(&post).expect("record");

        // Straight at the row, which is what eviction ultimately does — and
        // what fires every cascade trigger the schema declares.
        {
            let conn = ledger.db.lock().unwrap();
            conn.execute("DELETE FROM sessions WHERE session_id = 's1'", [])
                .expect("delete session row");
        }

        let posts = ledger.list_overview_posts_tail(50).unwrap();
        assert_eq!(posts.len(), 1, "the digest outlives its session row");
        assert_eq!(posts[0].session_id.as_deref(), Some("s1"));
    }

    #[test]
    fn overview_window_reads_around_a_hit_and_clamps_at_the_ends() {
        let ledger = fresh();
        let mut ids = Vec::new();
        for i in 1..=10_i64 {
            ids.push(
                ledger
                    .record_overview_post(&overview_post(
                        1_000 + i,
                        OverviewAuthor::Observer,
                        &format!("post {i}"),
                    ))
                    .expect("record"),
            );
        }
        // Interior: n on each side plus the hit itself.
        let window = ledger.overview_posts_window(ids[4], 2).unwrap();
        assert_eq!(window.len(), 5);
        assert_eq!(window.first().unwrap().body, "post 3");
        assert_eq!(window.last().unwrap().body, "post 7");

        // At an edge the window clamps rather than erroring.
        let head = ledger.overview_posts_window(ids[0], 3).unwrap();
        assert_eq!(head.first().unwrap().body, "post 1");
        assert_eq!(head.len(), 4);
    }

    /// The last-K-posts read is what a wake shows the Observer as "what you
    /// already said", so it must be per-session and Observer-only — an
    /// Operator answer mentioning the session is not something the Observer
    /// said.
    #[test]
    fn overview_per_session_read_is_observer_only_and_scoped() {
        let ledger = fresh();
        for (session, author, body) in [
            (Some("s1"), OverviewAuthor::Observer, "s1 digest one"),
            (Some("s2"), OverviewAuthor::Observer, "s2 digest"),
            (Some("s1"), OverviewAuthor::Operator, "an answer about s1"),
            (Some("s1"), OverviewAuthor::Observer, "s1 digest two"),
            (None, OverviewAuthor::User, "a question"),
        ] {
            let mut post = overview_post(1_000, author, body);
            post.session_id = session.map(str::to_string);
            ledger.record_overview_post(&post).expect("record");
        }
        let mine = ledger.list_overview_posts_for_session("s1", 10).unwrap();
        assert_eq!(mine.len(), 2);
        assert_eq!(mine[0].body, "s1 digest one");
        assert_eq!(mine[1].body, "s1 digest two");
    }

    #[test]
    fn overview_search_ranks_by_relevance_and_composes_with_filters() {
        let ledger = fresh();
        let rows: [(&str, OverviewAuthor, Option<&str>, i64); 4] = [
            (
                "border color tuning in the theme",
                OverviewAuthor::Observer,
                Some("s1"),
                1_000,
            ),
            (
                "a passing mention of color",
                OverviewAuthor::Observer,
                Some("s1"),
                2_000,
            ),
            (
                "border border border everywhere",
                OverviewAuthor::Observer,
                Some("s2"),
                3_000,
            ),
            ("border color question", OverviewAuthor::User, None, 4_000),
        ];
        for (body, author, session, at_ms) in rows {
            let mut post = overview_post(at_ms, author, body);
            post.session_id = session.map(str::to_string);
            ledger.record_overview_post(&post).expect("record");
        }

        // The triggers kept the index in step with the inserts, and bm25
        // ranks — the row matching both terms outranks the ones matching one,
        // which insertion order alone would not produce.
        let hits = ledger
            .search_overview_posts("border AND color", &OverviewSearchFilter::default(), 10)
            .expect("search");
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().all(|h| h.post.body.contains("border")));
        assert!(!hits[0].excerpt.is_empty(), "snippet() cut an excerpt");

        // Filters narrow the content table alongside the MATCH.
        let scoped = ledger
            .search_overview_posts(
                "border",
                &OverviewSearchFilter {
                    session_id: Some("s2".to_string()),
                    ..Default::default()
                },
                10,
            )
            .expect("search");
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].post.session_id.as_deref(), Some("s2"));

        let by_author = ledger
            .search_overview_posts(
                "border",
                &OverviewSearchFilter {
                    author: Some(OverviewAuthor::User),
                    ..Default::default()
                },
                10,
            )
            .expect("search");
        assert_eq!(by_author.len(), 1);
        assert_eq!(by_author[0].post.author, OverviewAuthor::User);

        let windowed = ledger
            .search_overview_posts(
                "border",
                &OverviewSearchFilter {
                    since_ms: Some(2_500),
                    ..Default::default()
                },
                10,
            )
            .expect("search");
        assert_eq!(windowed.len(), 2);

        // A malformed MATCH expression is an error the caller can report, not
        // a panic.
        assert!(
            ledger
                .search_overview_posts("\"unbalanced", &OverviewSearchFilter::default(), 10)
                .is_err()
        );
    }

    /// A post deleted from the content table must leave no ghost in the
    /// index — the `'delete'` command rows the triggers write are what keep
    /// an external-content FTS5 table honest.
    #[test]
    fn overview_search_index_follows_content_deletes() {
        let ledger = fresh();
        let id = ledger
            .record_overview_post(&overview_post(
                1_000,
                OverviewAuthor::Observer,
                "a distinctive phrase",
            ))
            .expect("record");
        assert_eq!(
            ledger
                .search_overview_posts("distinctive", &OverviewSearchFilter::default(), 10)
                .unwrap()
                .len(),
            1
        );
        {
            let conn = ledger.db.lock().unwrap();
            conn.execute("DELETE FROM overview_posts WHERE id = ?1", params![id])
                .expect("delete");
        }
        assert!(
            ledger
                .search_overview_posts("distinctive", &OverviewSearchFilter::default(), 10)
                .unwrap()
                .is_empty(),
            "the index dropped the row with its content"
        );
    }

    // ── the facts library ────────────────────────────────────────────────────

    /// A fact with everything filled in but the fields a caller varies.
    fn fact(at_ms: i64, kind: &str, subject: &str, text: &str) -> NewFact {
        NewFact {
            at_ms,
            kind: kind.to_string(),
            session_id: None,
            subject: Some(subject.to_string()),
            text: text.to_string(),
            payload: "{}".to_string(),
            dedupe_key: None,
        }
    }

    /// Every stored fact as `(kind, subject, text, payload)`, oldest-first.
    /// Read straight off the table: the typed read verbs land with the
    /// Operator that consumes them, and the write path is what is under test
    /// here.
    fn stored_facts(ledger: &SessionLedger) -> Vec<(String, Option<String>, String, String)> {
        let conn = ledger.db.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT kind, subject, text, payload FROM facts ORDER BY id ASC")
            .expect("prepare");
        stmt.query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .expect("query")
        .collect::<Result<Vec<_>, _>>()
        .expect("rows")
    }

    /// What the FTS index answers for a query — the shadow tables are part of
    /// the schema under test even before a verb reads them.
    fn fts_hits(ledger: &SessionLedger, query: &str) -> usize {
        let conn = ledger.db.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM facts_fts WHERE facts_fts MATCH ?1",
            params![query],
            |row| row.get::<_, i64>(0),
        )
        .expect("match") as usize
    }

    #[test]
    fn facts_round_trip_every_kind_with_payload_and_subject_intact() {
        let ledger = fresh();
        seed_live(&ledger, "s1", WS_A, "card-1", millis(0));
        let kinds = [
            ("prompt", "make the chip legible"),
            ("session.spawned", "brisk-otter"),
            ("session.compacted", "auto"),
            ("commit", "a1b2c3d4e5f6"),
            ("shell", "cargo nextest run"),
            ("test_run", "cargo nextest"),
        ];
        for (i, (kind, subject)) in kinds.iter().enumerate() {
            let mut f = fact(1_000 + i as i64, kind, subject, &format!("rendered {kind}"));
            f.session_id = Some("s1".to_string());
            f.payload = format!(r#"{{"n":{i}}}"#);
            assert!(
                ledger.record_fact(&f).expect("record").is_some(),
                "{kind} recorded"
            );
        }

        // The seeded spawn wrote its own lifecycle fact first; everything
        // recorded above follows it in id order.
        let rows = stored_facts(&ledger);
        assert_eq!(rows.len(), kinds.len() + 1);
        assert_eq!(rows[0].0, "session.spawned");
        assert_eq!(rows[1].0, "prompt");
        assert_eq!(rows[1].1.as_deref(), Some("make the chip legible"));
        assert_eq!(rows[1].2, "rendered prompt");
        assert_eq!(rows[1].3, r#"{"n":0}"#);
        assert_eq!(rows[6].0, "test_run");
        assert_eq!(rows[6].2, "rendered test_run");

        // Both indexed columns are searchable — the subject carries the
        // handle a question asks by, the text carries the wording.
        assert_eq!(fts_hits(&ledger, "legible"), 1);
        assert_eq!(fts_hits(&ledger, "rendered"), kinds.len());
    }

    /// Fact 6291's text, verbatim from the release ledger — the row the
    /// 2026-08-15 question needed and the index could not reach.
    const TOOLTIP_COMMIT_TEXT: &str = "commit ac462ba3a1ae \"tugways(entity-tips): unify commit hover into a real TugTooltip\" — 27 file(s)";

    #[test]
    fn a_camel_case_identifier_is_findable_by_its_parts() {
        let ledger = fresh();
        ledger
            .record_fact(&fact(1_000, "commit", "ac462ba3a1ae", TOOLTIP_COMMIT_TEXT))
            .expect("record");

        // unicode61 holds `TugTooltip` as one token, so before the `tokens`
        // column neither of these matched — not even the prefix form, since a
        // prefix query extends a token rightward and cannot start mid-token.
        let hits = ledger
            .search_facts("tooltip", &FactSearchFilter::default(), 10)
            .expect("search");
        assert_eq!(hits.len(), 1, "the commit fact is reachable by sub-word");
        assert_eq!(hits[0].fact.subject.as_deref(), Some("ac462ba3a1ae"));

        // The authored spelling still matches, and so does the other hump.
        assert_eq!(fts_hits(&ledger, "tugtooltip"), 1);
        assert_eq!(fts_hits(&ledger, "tug"), 1);
    }

    #[test]
    fn an_excerpt_quotes_the_fact_text_never_the_derived_tokens() {
        let ledger = fresh();
        ledger
            .record_fact(&fact(1_000, "commit", "ac462ba3a1ae", TOOLTIP_COMMIT_TEXT))
            .expect("record");

        // `snippet(facts_fts, -1, …)` would auto-select the best-matching
        // column, and for this query that is `tokens` — so the Operator would
        // quote `tug tooltip` into an answer instead of the sentence it came
        // from. Presence assertions cannot see this: token soup is a non-empty
        // string. Content can.
        let hits = ledger
            .search_facts("tooltip", &FactSearchFilter::default(), 10)
            .expect("search");
        let excerpt = &hits[0].excerpt;
        assert!(!excerpt.is_empty(), "snippet() cut an excerpt");
        assert!(
            excerpt.contains("unify") || excerpt.contains("hover") || excerpt.contains("entity"),
            "excerpt should quote the fact's prose, got {excerpt:?}"
        );
        assert!(
            !excerpt.contains("tug tooltip"),
            "excerpt is normalizer output, not prose: {excerpt:?}"
        );
    }

    #[test]
    fn a_overview_post_is_findable_by_sub_word_too() {
        let ledger = fresh();
        ledger
            .record_overview_post(&overview_post(
                1_000,
                OverviewAuthor::Observer,
                "The commit hover became a real `TugTooltip` this afternoon.",
            ))
            .expect("record");

        let hits = ledger
            .search_overview_posts("tooltip", &OverviewSearchFilter::default(), 10)
            .expect("search");
        assert_eq!(hits.len(), 1);
        assert!(
            hits[0].excerpt.contains("hover") || hits[0].excerpt.contains("commit"),
            "excerpt quotes the body, got {:?}",
            hits[0].excerpt
        );
    }

    /// Build a ledger at the shape that shipped before `tokens` existed —
    /// two-column FTS indexes, two-column sync triggers, no `tokens` column —
    /// with one row already in it, then hand back its path for a real
    /// `SessionLedger::open` to migrate.
    fn seed_pre_tokens_ledger(path: &Path) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "
            CREATE TABLE facts (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                at_ms      INTEGER NOT NULL,
                kind       TEXT NOT NULL,
                session_id TEXT,
                subject    TEXT,
                text       TEXT NOT NULL,
                payload    TEXT NOT NULL,
                dedupe_key TEXT
            );
            CREATE VIRTUAL TABLE facts_fts USING fts5(
                subject, text, content='facts', content_rowid='id'
            );
            CREATE TRIGGER facts_fts_insert AFTER INSERT ON facts BEGIN
                INSERT INTO facts_fts (rowid, subject, text)
                VALUES (new.id, new.subject, new.text);
            END;
            CREATE TRIGGER facts_fts_delete AFTER DELETE ON facts BEGIN
                INSERT INTO facts_fts (facts_fts, rowid, subject, text)
                VALUES ('delete', old.id, old.subject, old.text);
            END;
            CREATE TRIGGER facts_fts_update AFTER UPDATE ON facts BEGIN
                INSERT INTO facts_fts (facts_fts, rowid, subject, text)
                VALUES ('delete', old.id, old.subject, old.text);
                INSERT INTO facts_fts (rowid, subject, text)
                VALUES (new.id, new.subject, new.text);
            END;
            ",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO facts (at_ms, kind, subject, text, payload)
             VALUES (1000, 'commit', 'ac462ba3a1ae', ?1, '{}')",
            params![TOOLTIP_COMMIT_TEXT],
        )
        .unwrap();
    }

    #[test]
    fn a_pre_tokens_ledger_migrates_backfills_and_becomes_searchable() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sessions.db");
        seed_pre_tokens_ledger(&path);

        let ledger = SessionLedger::open_with_claude_root(
            &path,
            PathBuf::from("/tmp/tugcast-tests-no-trash"),
        )
        .expect("open migrates");

        // The row that predates the column carries derived tokens now …
        let hits = ledger
            .search_facts("tooltip", &FactSearchFilter::default(), 10)
            .expect("search");
        assert_eq!(hits.len(), 1, "the backfilled row is reachable by sub-word");

        // … and the rebuild left a coherent index behind it.
        {
            let conn = ledger.db.lock().unwrap();
            let nulls: i64 = conn
                .query_row("SELECT COUNT(*) FROM facts WHERE tokens IS NULL", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(nulls, 0, "backfill left no NULL tokens");
            conn.execute_batch("INSERT INTO facts_fts (facts_fts) VALUES ('integrity-check');")
                .expect("FTS integrity");
        }
    }

    #[test]
    fn the_migration_leaves_no_two_column_sync_trigger_behind() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sessions.db");
        seed_pre_tokens_ledger(&path);

        let ledger = SessionLedger::open_with_claude_root(
            &path,
            PathBuf::from("/tmp/tugcast-tests-no-trash"),
        )
        .expect("open migrates");

        // `CREATE TRIGGER IF NOT EXISTS` cannot replace a trigger, so a stale
        // two-column `facts_fts_insert` would survive the schema batch and go
        // on writing two columns into the three-column index — leaving
        // `tokens` silently half-populated with no error anywhere. A fact
        // inserted AFTER the migration is what proves which trigger fired.
        ledger
            .record_fact(&fact(
                2_000,
                "commit",
                "beefcafe1234",
                "commit beefcafe1234 \"tugdeck(rows): teach TugListView to scroll\" — 3 file(s)",
            ))
            .expect("record");

        // `view` reaches this row ONLY through the derived column: it is not a
        // whole unicode61 token anywhere in the subject or the text.
        let hits = ledger
            .search_facts("view", &FactSearchFilter::default(), 10)
            .expect("search");
        assert_eq!(hits.len(), 1, "the recreated three-column trigger fired");
        assert_eq!(fts_hits(&ledger, "scroll"), 1);
    }

    #[test]
    fn reopening_an_already_migrated_ledger_changes_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sessions.db");
        seed_pre_tokens_ledger(&path);

        let ledger = SessionLedger::open_with_claude_root(
            &path,
            PathBuf::from("/tmp/tugcast-tests-no-trash"),
        )
        .expect("first open");
        let tokens_after_first: String = {
            let conn = ledger.db.lock().unwrap();
            conn.query_row("SELECT tokens FROM facts WHERE id = 1", [], |r| r.get(0))
                .unwrap()
        };
        drop(ledger);

        let ledger = SessionLedger::open_with_claude_root(
            &path,
            PathBuf::from("/tmp/tugcast-tests-no-trash"),
        )
        .expect("second open");
        let conn = ledger.db.lock().unwrap();
        let tokens_after_second: String = conn
            .query_row("SELECT tokens FROM facts WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        // The derivation is deterministic and the backfill is NULL-scoped, so
        // the second open neither recomputes nor disturbs the row.
        assert_eq!(tokens_after_first, tokens_after_second);
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM facts_fts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "the index still holds exactly its one row");
    }

    #[test]
    fn a_dedupe_key_lands_the_fact_once_however_often_it_is_replayed() {
        let ledger = fresh();
        let mut f = fact(1_000, "shell", "cargo build", "$ cargo build → ok");
        f.dedupe_key = Some("shell:s1:toolu_1".to_string());

        assert!(ledger.record_fact(&f).expect("first").is_some());
        // The relay re-streams replayed frames on every resume; the second and
        // third pass must be silent no-ops, not errors and not new rows.
        assert_eq!(ledger.record_fact(&f).expect("second"), None);
        assert_eq!(ledger.record_fact(&f).expect("third"), None);

        assert_eq!(stored_facts(&ledger).len(), 1);
        assert_eq!(fts_hits(&ledger, "cargo"), 1);
    }

    #[test]
    fn a_sessions_fact_tail_pages_by_rowid_oldest_first() {
        let ledger = fresh();
        assert!(
            ledger
                .facts_for_session_after("s1", 0, 10)
                .expect("empty")
                .is_empty()
        );

        // Two facts share a millisecond on purpose: a tail keyed by timestamp
        // would have to re-read one or skip one here, with no way to tell
        // which. The rowid is what makes the resume exact.
        for i in 0..5 {
            let mut f = fact(1_000, "shell", &format!("cmd-{i}"), &format!("$ cmd-{i}"));
            f.session_id = Some("s1".to_string());
            ledger.record_fact(&f).expect("record");
        }
        // Another session's facts are never in this session's tail — the mark
        // is per session, and so is the read it advances ([P05]).
        let mut theirs = fact(1_000, "shell", "cmd-x", "$ cmd-x");
        theirs.session_id = Some("s2".to_string());
        ledger.record_fact(&theirs).expect("record");

        let first_two = ledger.facts_for_session_after("s1", 0, 2).expect("tail");
        assert_eq!(first_two.len(), 2);
        assert_eq!(first_two[0].text, "$ cmd-0");
        assert_eq!(first_two[1].text, "$ cmd-1");
        assert!(first_two[0].id < first_two[1].id, "oldest first");

        let rest = ledger
            .facts_for_session_after("s1", first_two[1].id, 10)
            .expect("tail");
        assert_eq!(rest.len(), 3);
        assert_eq!(rest[0].text, "$ cmd-2");

        let tip = rest[2].id;
        assert!(
            ledger
                .facts_for_session_after("s1", tip, 10)
                .expect("tail")
                .is_empty(),
            "a wire whose mark is at the tip re-reads nothing"
        );
        assert_eq!(
            ledger
                .facts_for_session_after("s2", 0, 10)
                .expect("tail")
                .len(),
            1,
            "and the other session's own tail is untouched by either"
        );
    }

    #[test]
    fn a_null_dedupe_key_never_collides_with_another_null() {
        // NULLs are distinct in a SQLite unique index, which is what lets the
        // live-only paths (the `$` shell route, session lifecycle) pass none.
        let ledger = fresh();
        for i in 0..3 {
            assert!(
                ledger
                    .record_fact(&fact(1_000 + i, "session.closed", "s1", "session closed"))
                    .expect("record")
                    .is_some()
            );
        }
        assert_eq!(stored_facts(&ledger).len(), 3);
    }

    /// One fact through the production builders, so the browse read is tested
    /// against the rows the live recorders actually write.
    fn seed_shell(ledger: &SessionLedger, at_ms: i64, session_id: &str, command: &str) {
        ledger
            .record_fact(&crate::feeds::facts_library::shell_fact(
                at_ms,
                Some(session_id),
                &crate::feeds::facts_library::ShellFact {
                    command,
                    route: crate::feeds::facts_library::ShellRoute::Claude,
                    ok: true,
                    exit_code: None,
                    cwd: None,
                },
                None,
            ))
            .expect("record");
    }

    #[test]
    fn list_facts_with_no_filters_returns_the_newest_limit_newest_first() {
        let ledger = fresh();
        seed_live(&ledger, "s1", WS_A, "card-1", millis(0));
        // After the spawn's own lifecycle fact, so the cap's far end is a
        // known row rather than whatever the seeding happened to write.
        let base = millis(0) + 1_000;
        for i in 0..40 {
            seed_shell(&ledger, base + i, "s1", &format!("cargo build case{i}"));
        }
        let rows = ledger.list_facts(None, None, None, None, 30).expect("list");
        assert_eq!(rows.len(), 30, "capped at the limit asked for");
        assert_eq!(rows[0].at_ms, base + 39, "the newest fact leads");
        assert!(
            rows.windows(2).all(|w| w[0].at_ms >= w[1].at_ms),
            "newest-first, with no ascending re-sort for a wake composer"
        );
        // The oldest rows are what fell off — the browse verb answers "what
        // happened", so the truncation must take the far end. The spawn fact,
        // oldest of all, is the first thing over the side.
        assert_eq!(rows[29].at_ms, base + 10);
        assert!(rows.iter().all(|r| r.kind == "shell"));
    }

    #[test]
    fn each_list_facts_filter_narrows_independently() {
        let ledger = fresh();
        seed_live(&ledger, "s1", WS_A, "card-1", millis(0));
        seed_live(&ledger, "s2", WS_A, "card-2", millis(0));
        let base = millis(0) + 1_000;
        seed_shell(&ledger, base, "s1", "cargo build one");
        seed_shell(&ledger, base + 1_000, "s2", "cargo build two");
        ledger
            .record_fact(&crate::feeds::facts_library::prompt_fact(
                base + 2_000,
                "s1",
                "why is the wash so pale",
            ))
            .expect("record");

        let by_kind = ledger
            .list_facts(Some("prompt"), None, None, None, 30)
            .expect("list");
        assert_eq!(by_kind.len(), 1);
        assert_eq!(by_kind[0].kind, "prompt");

        let by_session = ledger
            .list_facts(None, Some("s2"), None, None, 30)
            .expect("list");
        assert!(
            by_session
                .iter()
                .all(|r| r.session_id.as_deref() == Some("s2")),
            "the session filter admits nothing from anywhere else"
        );
        assert!(
            by_session
                .iter()
                .any(|r| r.text.contains("cargo build two"))
        );
        assert!(
            !by_session
                .iter()
                .any(|r| r.text.contains("cargo build one"))
        );

        // The bounds are inclusive on both ends, which is what makes a
        // since/until pair a window rather than a fencepost puzzle.
        let since = ledger
            .list_facts(None, None, Some(base + 1_000), None, 30)
            .expect("list");
        assert_eq!(since.len(), 2, "the since bound admits the row it names");
        let until = ledger
            .list_facts(None, None, Some(base), Some(base + 1_000), 30)
            .expect("list");
        assert_eq!(until.len(), 2, "and so does the until bound");
        let bracket = ledger
            .list_facts(None, None, Some(base + 1_000), Some(base + 1_000), 30)
            .expect("list");
        assert_eq!(bracket.len(), 1);
        assert_eq!(bracket[0].at_ms, base + 1_000);

        // A kind nothing was recorded under is an empty answer, not an error:
        // it is a filter value, not a schema key.
        assert!(
            ledger
                .list_facts(Some("no.such.kind"), None, None, None, 30)
                .expect("list")
                .is_empty()
        );
    }

    #[test]
    fn list_facts_excludes_a_private_sessions_facts() {
        let ledger = fresh();
        seed_live(&ledger, "s1", WS_A, "card-1", millis(0));
        seed_live(&ledger, "s2", WS_A, "card-2", millis(0));
        let base = millis(0) + 1_000;
        seed_shell(&ledger, base, "s1", "cargo build public");
        seed_shell(&ledger, base + 1_000, "s2", "cargo build secret");
        ledger
            .set_session_private("s2", true)
            .expect("marked private");

        let rows = ledger.list_facts(None, None, None, None, 30).expect("list");
        assert!(
            rows.iter().all(|r| r.session_id.as_deref() != Some("s2")),
            "the new read carries the same in-SQL exclusion as every other"
        );
        assert!(rows.iter().any(|r| r.text.contains("public")));
    }

    #[test]
    fn facts_survive_deletion_of_the_session_they_name() {
        // Permanence is the whole point: the 90-day sweep and an explicit
        // trash both hard-DELETE `sessions` rows, and a fact must still say
        // what happened afterwards.
        let ledger = fresh();
        seed_live(&ledger, "s1", WS_A, "card-1", millis(0));
        let mut f = fact(
            1_000,
            "commit",
            "a1b2c3d4",
            "commit a1b2c3d4 \"land it\" — 3 file(s)",
        );
        f.session_id = Some("s1".to_string());
        ledger.record_fact(&f).expect("record");

        {
            let conn = ledger.db.lock().unwrap();
            conn.execute("DELETE FROM sessions WHERE session_id = 's1'", [])
                .expect("delete session row");
        }

        let rows = stored_facts(&ledger);
        assert_eq!(rows.len(), 2, "the facts outlive their session row");
        assert_eq!(rows[1].1.as_deref(), Some("a1b2c3d4"));
    }

    #[test]
    fn record_spawn_records_spawned_then_resumed() {
        // Written with `record_fact_tx` inside `record_spawn`'s own
        // transaction: the mutex is not reentrant, so the public form there
        // would deadlock every spawn rather than fail one.
        let ledger = fresh();
        seed_live(&ledger, "s1", WS_A, "card-1", millis(2));
        seed_live(&ledger, "s1", WS_A, "card-1", millis(1));
        let kinds: Vec<String> = stored_facts(&ledger).into_iter().map(|f| f.0).collect();
        assert_eq!(kinds, vec!["session.spawned", "session.resumed"]);
    }

    #[test]
    fn an_adopted_scan_session_records_spawned_not_resumed() {
        // A session the scan discovered has no `sessions` row but real prior
        // history. It records `spawned` — first appearance in *this* ledger,
        // which is the first moment this instance can say anything true about
        // it. Its pre-Tug history is the transcript's to tell, and a `resumed`
        // fact with no prior `spawned` beside it would read as a gap.
        let ledger = fresh();
        let id = "adopted-session";
        ledger
            .upsert_scan_cache(&ScanCacheRow {
                session_id: id.into(),
                project_dir: "/proj/alpha".into(),
                file_size: 1_000,
                file_mtime: millis(5),
                excluded: false,
                turn_count: 42,
                last_user_prompt: Some("the last prompt".into()),
                name: Some("Scanned title".into()),
                created_at: millis(1),
                last_used_at: millis(5),
                parse_offset: 0,
                tail_hash: 0,
                cwd_checked: false,
                created_at_found: false,
                frontier_open: false,
                frontier_pending_close: false,
                frontier_pending_close_msg_id: None,
                frontier_leaf_uuid: None,
                effective_uuids: None,
                lineage_ancestors: None,
                line_id: None,
            })
            .expect("seed the scan cache");
        seed_live(&ledger, id, WS_A, "card-1", millis(0));
        let rows = stored_facts(&ledger);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "session.spawned");
    }

    /// Set the flag the way the CONTROL verb will once it lands, so the
    /// write-time refusal can be pinned before its toggle exists.
    fn mark_private(ledger: &SessionLedger, session_id: &str, private: bool) {
        let conn = ledger.db.lock().unwrap();
        conn.execute(
            "UPDATE sessions SET private = ?2 WHERE session_id = ?1",
            params![session_id, i64::from(private)],
        )
        .expect("set private");
    }

    #[test]
    fn a_private_session_records_no_facts_while_the_flag_is_set() {
        let ledger = fresh();
        seed_live(&ledger, "s1", WS_A, "card-1", millis(0));

        let mut before = fact(1_000, "prompt", "public work", "prompt: \"public work\"");
        before.session_id = Some("s1".to_string());
        ledger.record_fact(&before).expect("record");

        mark_private(&ledger, "s1", true);
        let mut during = fact(2_000, "prompt", "private work", "prompt: \"private work\"");
        during.session_id = Some("s1".to_string());
        assert_eq!(
            ledger.record_fact(&during).expect("refused"),
            None,
            "the write-time check refuses silently rather than erroring"
        );
        // The spawn fact and the public prompt, and nothing from while the
        // flag was set.
        assert_eq!(stored_facts(&ledger).len(), 2);

        // From-now-on: marking it public again resumes recording from that
        // moment, and scrubs nothing either way.
        mark_private(&ledger, "s1", false);
        assert!(ledger.record_fact(&during).expect("record").is_some());
        assert_eq!(stored_facts(&ledger).len(), 3);
    }

    #[test]
    fn an_app_scoped_fact_records_even_while_some_session_is_private() {
        let ledger = fresh();
        seed_live(&ledger, "s1", WS_A, "card-1", millis(0));
        mark_private(&ledger, "s1", true);
        // No session named, so no session's flag can hide it.
        assert!(
            ledger
                .record_fact(&fact(
                    1_000,
                    "shell",
                    "just build-app",
                    "$ just build-app → ok"
                ))
                .expect("record")
                .is_some()
        );
        // The seeded spawn plus the app-scoped fact.
        assert_eq!(stored_facts(&ledger).len(), 2);
    }

    #[test]
    fn a_fact_naming_an_unknown_session_still_records() {
        // An absent `sessions` row reads as public — the machine-global
        // `changes.db` case, where another instance's session has no local row.
        let ledger = fresh();
        let mut f = fact(1_000, "shell", "git log", "$ git log → ok");
        f.session_id = Some("some-other-instances-session".to_string());
        assert!(ledger.record_fact(&f).expect("record").is_some());
        assert_eq!(stored_facts(&ledger).len(), 1);
    }

    #[test]
    fn a_ledger_predating_the_private_column_migrates_in_place() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(
            "CREATE TABLE sessions (
                 session_id        TEXT PRIMARY KEY,
                 workspace_key     TEXT NOT NULL,
                 project_dir       TEXT NOT NULL,
                 created_at        INTEGER NOT NULL,
                 last_used_at      INTEGER NOT NULL,
                 turn_count        INTEGER NOT NULL DEFAULT 0,
                 last_user_prompt  TEXT,
                 state             TEXT NOT NULL,
                 card_id           TEXT,
                 name              TEXT,
                 name_user_set     INTEGER NOT NULL DEFAULT 0,
                 tag               TEXT,
                 root_tag          TEXT,
                 tag_lineage       TEXT,
                 synopsis          TEXT
             );
             INSERT INTO sessions
                 (session_id, workspace_key, project_dir, created_at,
                  last_used_at, state)
             VALUES ('legacy', 'ws', '/proj', 0, 0, 'closed');",
        )
        .expect("legacy schema");

        let has_private = |conn: &Connection| {
            SessionLedger::table_columns(conn, "sessions")
                .expect("columns")
                .iter()
                .any(|(n, _)| n == "private")
        };
        assert!(!has_private(&conn));
        SessionLedger::migrate_sessions_add_private(&conn).expect("migrate");
        assert!(has_private(&conn));
        SessionLedger::migrate_sessions_add_private(&conn).expect("re-migrate");

        // A row written before the flag existed was never marked private.
        let existing: i64 = conn
            .query_row(
                "SELECT private FROM sessions WHERE session_id = 'legacy'",
                [],
                |row| row.get(0),
            )
            .expect("read");
        assert_eq!(existing, 0);
    }

    #[test]
    fn file_event_reads_answer_by_session_and_by_path_pattern() {
        let ledger = fresh();
        let event = |session: &str, path: &str, at: i64| FileEventRow {
            tug_session_id: session.to_string(),
            tool_use_id: format!("t-{session}-{at}"),
            file_path: path.to_string(),
            tool_name: "Edit".to_string(),
            op: "edit".to_string(),
            origin: "exact".to_string(),
            ambiguous: false,
            parent_tool_use_id: None,
            project_dir: "/proj".to_string(),
            at,
        };
        for row in [
            event("s1", "tugdeck/styles/themes/brio.css", 1_000),
            event("s1", "tugdeck/src/main.tsx", 2_000),
            event("s2", "tugdeck/styles/themes/aria.css", 3_000),
        ] {
            ledger.record_file_event(&row).expect("record_file_event");
        }

        let for_s1 = ledger.list_file_events_for_session("s1", 100).unwrap();
        assert_eq!(for_s1.len(), 2);
        assert_eq!(for_s1[0].file_path, "tugdeck/styles/themes/brio.css");

        // The worked example's first move: which sessions touched a CSS file.
        let css = ledger
            .list_file_events_for_path_pattern("%.css", None, None, 100)
            .unwrap();
        assert_eq!(css.len(), 2);
        assert_eq!(
            css[0].file_path, "tugdeck/styles/themes/aria.css",
            "newest first"
        );

        let bounded = ledger
            .list_file_events_for_path_pattern("%.css", Some(2_500), None, 100)
            .unwrap();
        assert_eq!(bounded.len(), 1);
        assert_eq!(bounded[0].tug_session_id, "s2");
    }

    // ── CRUD round-trip per state transition ─────────────────────────────────

    #[test]
    fn record_spawn_inserts_live_row() {
        let l = fresh();
        let now = millis(0);
        l.record_spawn("s1", WS_A, "/proj/alpha", "card-1", now, "s1", None)
            .unwrap();

        let row = l.get("s1").unwrap().expect("row exists");
        assert_eq!(row.session_id, "s1");
        assert_eq!(row.workspace_key, WS_A);
        assert_eq!(row.project_dir, "/proj/alpha");
        assert_eq!(row.created_at, now);
        assert_eq!(row.last_used_at, now);
        assert_eq!(row.turn_count, 0);
        assert_eq!(row.last_user_prompt, None);
        assert_eq!(row.state, SessionState::Live);
        assert_eq!(row.card_id.as_deref(), Some("card-1"));
    }

    #[test]
    fn record_spawn_hydrates_from_scan_cache() {
        // Resuming an external session: the picker row came from the
        // scan cache, so the freshly-inserted ledger row must carry the
        // transcript's content — a bare zero-turn row would vanish from
        // the picker (turn_count == 0 rows are hidden).
        let l = fresh();
        l.upsert_scan_cache(&ScanCacheRow {
            session_id: "ext-1".into(),
            project_dir: "/proj/alpha".into(),
            file_size: 1_000,
            file_mtime: millis(5),
            excluded: false,
            turn_count: 42,
            last_user_prompt: Some("the last prompt".into()),
            name: Some("Scanned title".into()),
            created_at: millis(1),
            last_used_at: millis(5),
            parse_offset: 0,
            tail_hash: 0,
            cwd_checked: false,
            created_at_found: false,
            frontier_open: false,
            frontier_pending_close: false,
            frontier_pending_close_msg_id: None,
            frontier_leaf_uuid: None,
            effective_uuids: None,
            lineage_ancestors: None,
            line_id: None,
        })
        .unwrap();

        let now = millis(10);
        l.record_spawn("ext-1", WS_A, "/proj/alpha", "card-1", now, "ext-1", None)
            .unwrap();
        let row = l.get("ext-1").unwrap().expect("row exists");
        assert_eq!(row.turn_count, 42);
        assert_eq!(row.last_user_prompt.as_deref(), Some("the last prompt"));
        assert_eq!(row.name.as_deref(), Some("Scanned title"));
        // A scanned `aiTitle` hydrates the title but is NOT a user rename, so the
        // chip stays on the hash until the user actually `/rename`s.
        assert!(!row.name_user_set);
        assert_eq!(row.created_at, millis(1), "transcript birth, not now");
        assert_eq!(row.last_used_at, now);
        assert_eq!(row.state, SessionState::Live);
    }

    #[test]
    fn stale_rule_epoch_cache_row_is_a_miss_and_never_seeds_spawn() {
        // [P08] / Risk R05: a cache row written under a prior turn rule must
        // not survive the rule change. It is invisible to the scan hit-check
        // (so the file is re-parsed under the current rule) AND it must not
        // seed `record_spawn`'s MAX merge (so a pre-fix inflated count can't
        // be re-applied). Reconcile-on-replay then writes the authority.
        let l = fresh();
        l.upsert_scan_cache(&ScanCacheRow {
            session_id: "ext-stale".into(),
            project_dir: "/proj/alpha".into(),
            file_size: 1_000,
            file_mtime: millis(5),
            excluded: false,
            turn_count: 99, // inflated by the old, looser rule
            last_user_prompt: Some("stale prompt".into()),
            name: Some("Stale title".into()),
            created_at: millis(1),
            last_used_at: millis(5),
            parse_offset: 0,
            tail_hash: 0,
            cwd_checked: false,
            created_at_found: false,
            frontier_open: false,
            frontier_pending_close: false,
            frontier_pending_close_msg_id: None,
            frontier_leaf_uuid: None,
            effective_uuids: None,
            lineage_ancestors: None,
            line_id: None,
        })
        .unwrap();

        // Fresh upsert is at CURRENT_RULE_EPOCH and is visible.
        assert!(
            l.get_scan_cache("ext-stale").unwrap().is_some(),
            "a current-epoch row must be a cache hit"
        );

        // Simulate the row predating the rule change: stamp it a prior epoch.
        l.db.lock()
            .expect("ledger mutex")
            .execute(
                "UPDATE external_scan_cache SET rule_epoch = ?1 WHERE session_id = ?2",
                params![CURRENT_RULE_EPOCH - 1, "ext-stale"],
            )
            .unwrap();

        // Hit-check gate: the stale row is now invisible — a scan miss that
        // forces a faithful re-parse (and carries no resume seed).
        assert!(
            l.get_scan_cache("ext-stale").unwrap().is_none(),
            "a prior-epoch row must read as absent"
        );

        // Seed gate: record_spawn must not pull the inflated 99 through its
        // MAX merge — the fresh ledger row stays at 0 until reconcile.
        l.record_spawn(
            "ext-stale",
            WS_A,
            "/proj/alpha",
            "card-1",
            millis(10),
            "ext-stale",
            None,
        )
        .unwrap();
        let row = l.get("ext-stale").unwrap().expect("row exists");
        assert_eq!(
            row.turn_count, 0,
            "stale-epoch seed must not survive the MAX merge"
        );
        assert_eq!(
            row.last_user_prompt, None,
            "stale-epoch prompt must not seed either"
        );
    }

    #[test]
    fn record_spawn_backfills_sparse_existing_row_from_scan_cache() {
        // A row left behind by an earlier resume that predates the
        // hydration (zero turns, no prompt) heals on the next spawn —
        // without ever clobbering richer ledger values.
        let l = fresh();
        let t0 = millis(0);
        l.record_spawn("ext-1", WS_A, "/proj/alpha", "card-1", t0, "ext-1", None)
            .unwrap();
        l.mark_closed("ext-1").unwrap();
        assert_eq!(l.get("ext-1").unwrap().unwrap().turn_count, 0);

        l.upsert_scan_cache(&ScanCacheRow {
            session_id: "ext-1".into(),
            project_dir: "/proj/alpha".into(),
            file_size: 1_000,
            file_mtime: millis(5),
            excluded: false,
            turn_count: 7,
            last_user_prompt: Some("from disk".into()),
            name: None,
            created_at: millis(1),
            last_used_at: millis(5),
            parse_offset: 0,
            tail_hash: 0,
            cwd_checked: false,
            created_at_found: false,
            frontier_open: false,
            frontier_pending_close: false,
            frontier_pending_close_msg_id: None,
            frontier_leaf_uuid: None,
            effective_uuids: None,
            lineage_ancestors: None,
            line_id: None,
        })
        .unwrap();

        l.record_spawn(
            "ext-1",
            WS_A,
            "/proj/alpha",
            "card-2",
            millis(10),
            "ext-1",
            None,
        )
        .unwrap();
        let row = l.get("ext-1").unwrap().unwrap();
        assert_eq!(row.turn_count, 7, "backfilled from scan cache");
        assert_eq!(row.last_user_prompt.as_deref(), Some("from disk"));
        assert_eq!(row.created_at, t0, "existing created_at preserved");

        // Richer ledger values win: a recorded prompt and a higher count
        // (the engine reconcile wrote 17) survive a later spawn whose cache
        // row is staler (7).
        l.record_user_prompt("ext-1", "typed in tug").unwrap();
        l.reconcile_turn_count_from_engine("ext-1", 17).unwrap();
        l.record_spawn(
            "ext-1",
            WS_A,
            "/proj/alpha",
            "card-3",
            millis(40),
            "ext-1",
            None,
        )
        .unwrap();
        let row = l.get("ext-1").unwrap().unwrap();
        assert_eq!(row.turn_count, 17, "MAX keeps the richer count");
        assert_eq!(row.last_user_prompt.as_deref(), Some("typed in tug"));
    }

    #[test]
    fn record_spawn_ignores_excluded_scan_cache_rows() {
        let l = fresh();
        l.upsert_scan_cache(&ScanCacheRow {
            session_id: "ext-1".into(),
            project_dir: "/proj/alpha".into(),
            file_size: 1_000,
            file_mtime: millis(5),
            excluded: true,
            turn_count: 0,
            last_user_prompt: None,
            name: None,
            created_at: 0,
            last_used_at: 0,
            parse_offset: 0,
            tail_hash: 0,
            cwd_checked: false,
            created_at_found: false,
            frontier_open: false,
            frontier_pending_close: false,
            frontier_pending_close_msg_id: None,
            frontier_leaf_uuid: None,
            effective_uuids: None,
            lineage_ancestors: None,
            line_id: None,
        })
        .unwrap();
        let now = millis(10);
        l.record_spawn("ext-1", WS_A, "/proj/alpha", "card-1", now, "ext-1", None)
            .unwrap();
        let row = l.get("ext-1").unwrap().unwrap();
        assert_eq!(row.turn_count, 0);
        assert_eq!(row.created_at, now, "no seed: created_at falls to now");
    }

    #[test]
    fn record_user_prompt_overwrites_on_each_call() {
        let l = fresh();
        seed_live(&l, "s1", WS_A, "card-1", millis(0));
        l.record_user_prompt("s1", "Hello, world").unwrap();
        let r = l.get("s1").unwrap().unwrap();
        assert_eq!(r.last_user_prompt.as_deref(), Some("Hello, world"));

        // Subsequent calls overwrite — the picker shows the most-recent
        // prompt, so a later turn replaces the snippet.
        l.record_user_prompt("s1", "Different prompt").unwrap();
        let r = l.get("s1").unwrap().unwrap();
        assert_eq!(r.last_user_prompt.as_deref(), Some("Different prompt"));
    }

    #[test]
    fn record_user_prompt_missing_session_errors() {
        let l = fresh();
        let err = l.record_user_prompt("nope", "Hi").unwrap_err();
        assert!(matches!(err, LedgerError::NotFound(ref id) if id == "nope"));
    }

    #[test]
    fn rename_sets_clears_and_survives_respawn() {
        let l = fresh();
        let now = millis(0);
        seed_live(&l, "s1", WS_A, "card-1", now);
        let r = l.get("s1").unwrap().unwrap();
        assert_eq!(r.name, None);
        // A fresh spawn is never user-named.
        assert!(!r.name_user_set);

        // Set a name (trimmed by the parser; the ledger stores verbatim).
        l.rename("s1", Some("My session")).unwrap();
        let r = l.get("s1").unwrap().unwrap();
        assert_eq!(r.name.as_deref(), Some("My session"));
        // A `/rename` flips the provenance bit so the chip shows it.
        assert!(r.name_user_set);

        // A re-spawn (resume) must NOT clear the name OR its user-set bit.
        l.record_spawn("s1", WS_A, "/proj", "card-1", now + 1_000, "s1", None)
            .unwrap();
        let r = l.get("s1").unwrap().unwrap();
        assert_eq!(r.name.as_deref(), Some("My session"));
        assert!(r.name_user_set);

        // Clearing sets the name back to NULL and drops the user-set bit so the
        // chip falls back to the hash.
        l.rename("s1", None).unwrap();
        let r = l.get("s1").unwrap().unwrap();
        assert_eq!(r.name, None);
        assert!(!r.name_user_set);
    }

    #[test]
    fn rename_missing_session_errors() {
        let l = fresh();
        let err = l.rename("nope", Some("X")).unwrap_err();
        assert!(matches!(err, LedgerError::NotFound(ref id) if id == "nope"));
    }

    /// A user-set name is unique across lines, and the newest `/rename` takes
    /// it ([P11]): the previous holder loses the name and falls back to its
    /// callsign, and the write reports whom it took the name from.
    #[test]
    fn a_rename_to_a_taken_name_takes_it() {
        let l = fresh();
        let now = millis(0);
        seed_live(&l, "s1", WS_A, "card-1", now);
        seed_live(&l, "s2", WS_A, "card-2", now);
        let holder_tag = l.get("s1").unwrap().unwrap().tag.expect("a callsign");

        l.rename("s1", Some("the parser work")).unwrap();
        let displaced = l.rename("s2", Some("the parser work")).unwrap();
        assert_eq!(
            displaced,
            vec![DisplacedName {
                line_id: "s1".to_owned(),
                tag: holder_tag,
            }],
            "the write says whose name it took"
        );

        // The name moved: the previous holder is back to its callsign and the
        // line that asked for the name wears it.
        let a = l.get("s1").unwrap().unwrap();
        assert_eq!(a.name, None);
        assert!(!a.name_user_set);
        let b = l.get("s2").unwrap().unwrap();
        assert_eq!(b.name.as_deref(), Some("the parser work"));
        assert!(b.name_user_set);
    }

    #[test]
    fn renaming_a_line_to_the_name_it_already_wears_is_allowed() {
        let l = fresh();
        seed_live(&l, "s1", WS_A, "card-1", millis(0));
        l.rename("s1", Some("steady")).unwrap();

        // The `line_id != ?2` guard: without it a line would displace itself,
        // clearing the name in the same transaction that writes it.
        assert!(l.rename("s1", Some("steady")).unwrap().is_empty());
        let r = l.get("s1").unwrap().unwrap();
        assert_eq!(r.name.as_deref(), Some("steady"));
        assert!(r.name_user_set);
    }

    #[test]
    fn a_rename_ignores_an_auto_title_wearing_the_same_words() {
        // `name_user_set = 0` is a title the machine wrote, not a name the user
        // spent. Only a name somebody chose is taken by another line's rename.
        let l = fresh();
        let now = millis(0);
        seed_live(&l, "s1", WS_A, "card-1", now);
        seed_live(&l, "s2", WS_A, "card-2", now);
        l.record_auto_title("s1", "a shared spelling").unwrap();

        assert!(
            l.rename("s2", Some("a shared spelling"))
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            l.get("s1").unwrap().unwrap().name.as_deref(),
            Some("a shared spelling"),
            "the auto title is left alone"
        );
        assert_eq!(
            l.get("s2").unwrap().unwrap().name.as_deref(),
            Some("a shared spelling")
        );
    }

    #[test]
    fn clearing_a_name_displaces_nothing() {
        let l = fresh();
        let now = millis(0);
        seed_live(&l, "s1", WS_A, "card-1", now);
        seed_live(&l, "s2", WS_A, "card-2", now);
        l.rename("s1", Some("kept")).unwrap();

        assert!(l.rename("s2", None).unwrap().is_empty());
        assert_eq!(l.get("s1").unwrap().unwrap().name.as_deref(), Some("kept"));
    }

    #[test]
    fn renaming_an_unknown_line_writes_nothing() {
        let l = fresh();
        seed_live(&l, "s1", WS_A, "card-1", millis(0));
        l.rename("s1", Some("held")).unwrap();

        let err = l.rename("nope", Some("held")).unwrap_err();
        // The target's existence is proved BEFORE anything is displaced, so a
        // rename addressed at nothing cannot strip the name off the line that
        // wears it.
        assert!(matches!(err, LedgerError::NotFound(ref id) if id == "nope"));
        let r = l.get("s1").unwrap().unwrap();
        assert_eq!(r.name.as_deref(), Some("held"));
        assert!(r.name_user_set);
    }

    #[test]
    fn record_turn_touches_last_used_not_count() {
        // [P08]: the count is `engine(file)`, never a live `+1`. A live
        // `turn_complete` only marks the row recently used; the picker count
        // is refreshed by the scan, not by this path.
        let l = fresh();
        let t0 = millis(0);
        seed_live(&l, "s1", WS_A, "card-1", t0);

        let t1 = t0 + 1_000;
        l.record_turn("s1", t1).unwrap();
        let r = l.get("s1").unwrap().unwrap();
        assert_eq!(r.turn_count, 0, "record_turn no longer writes the count");
        assert_eq!(r.last_used_at, t1);

        let t2 = t0 + 2_000;
        l.record_turn("s1", t2).unwrap();
        let r = l.get("s1").unwrap().unwrap();
        assert_eq!(r.turn_count, 0);
        assert_eq!(r.last_used_at, t2, "still touches last_used_at");
    }

    #[test]
    fn reconcile_turn_count_from_engine_sets_any_state_without_touching_recency() {
        // The migration / scan-refresh writer: corrects a stale count on a
        // row of ANY state (live, closed, external) and leaves last_used_at
        // alone (a count refresh is not usage).
        let l = fresh();
        let t0 = millis(0);
        seed_live(&l, "s1", WS_A, "card-1", t0);
        l.record_turn("s1", t0 + 500).unwrap(); // sets last_used_at to t0+500
        l.mark_closed("s1").unwrap();

        // A closed row's stale count is corrected on re-scan.
        l.reconcile_turn_count_from_engine("s1", 81).unwrap();
        let r = l.get("s1").unwrap().unwrap();
        assert_eq!(r.turn_count, 81, "corrected regardless of closed state");
        assert_eq!(
            r.last_used_at,
            t0 + 500,
            "recency untouched by a count refresh"
        );

        // A never-recorded session is a silent no-op.
        l.reconcile_turn_count_from_engine("ghost", 7).unwrap();
        assert!(l.get("ghost").unwrap().is_none());
    }

    #[test]
    fn record_turn_no_op_on_closed_row() {
        let l = fresh();
        let t0 = millis(0);
        seed_live(&l, "s1", WS_A, "card-1", t0);
        l.mark_closed("s1").unwrap();

        // A late turn write must not resurrect the row.
        l.record_turn("s1", t0 + 1_000).unwrap();
        let r = l.get("s1").unwrap().unwrap();
        assert_eq!(r.turn_count, 0);
        assert_eq!(r.state, SessionState::Closed);
    }

    #[test]
    fn revive_on_activity_flips_a_demoted_row_back_to_live() {
        let l = fresh();
        let t0 = millis(0);
        seed_live(&l, "s1", WS_A, "card-1", t0);
        // The startup demote — the administrative close revival corrects.
        assert_eq!(l.demote_live_to_closed().unwrap(), 1);

        // Live-borne evidence corrects the demoted state, and the
        // previously live-gated activity writes bite again.
        assert!(l.revive_on_activity("s1", t0 + 1_000).unwrap());
        let r = l.get("s1").unwrap().unwrap();
        assert_eq!(r.state, SessionState::Live);
        assert_eq!(r.last_used_at, t0 + 1_000);
        l.record_turn("s1", t0 + 2_000).unwrap();
        assert_eq!(l.get("s1").unwrap().unwrap().last_used_at, t0 + 2_000);
    }

    #[test]
    fn revive_on_activity_never_resurrects_a_deliberate_close() {
        let l = fresh();
        let t0 = millis(0);
        // A user-closed card stays closed: `mark_closed` is not a demote.
        seed_live(&l, "s1", WS_A, "card-1", t0);
        l.mark_closed("s1").unwrap();
        assert!(!l.revive_on_activity("s1", t0 + 1_000).unwrap());
        assert_eq!(l.get("s1").unwrap().unwrap().state, SessionState::Closed);

        // Closing an already-demoted row strips its revivability too: the
        // demote beat the user's close to `closed`, but the close is the
        // later intent and outranks it.
        seed_live(&l, "s2", WS_A, "card-2", t0);
        l.demote_live_to_closed().unwrap();
        l.mark_closed("s2").unwrap();
        assert!(!l.revive_on_activity("s2", t0 + 1_000).unwrap());
        assert_eq!(l.get("s2").unwrap().unwrap().state, SessionState::Closed);
    }

    #[test]
    fn revive_on_activity_no_ops_on_live_and_absent_rows() {
        let l = fresh();
        let t0 = millis(0);
        // Absent: revival corrects a record, it never creates one.
        assert!(!l.revive_on_activity("ghost", t0).unwrap());
        assert!(l.get("ghost").unwrap().is_none());
        // Already live: nothing to correct.
        seed_live(&l, "s1", WS_A, "card-1", t0);
        assert!(!l.revive_on_activity("s1", t0 + 1_000).unwrap());
        assert_eq!(l.get("s1").unwrap().unwrap().last_used_at, t0);
    }

    #[test]
    fn set_turn_count_overwrites_and_live_turns_do_not_change_it() {
        // Reconcile SETs the row to the engine authority. Under [P08] a live
        // `turn_complete` after replay no longer increments — the count holds
        // at `engine(file)` until the next scan refresh.
        let l = fresh();
        let t0 = millis(0);
        seed_live(&l, "s1", WS_A, "card-1", t0);

        // Reconcile SETs to 10 (overwrite).
        l.set_turn_count("s1", 10, t0 + 100).unwrap();
        let r = l.get("s1").unwrap().unwrap();
        assert_eq!(r.turn_count, 10);
        assert_eq!(r.last_used_at, t0 + 100);

        // A live turn after replay touches recency but NOT the count.
        l.record_turn("s1", t0 + 200).unwrap();
        let r = l.get("s1").unwrap().unwrap();
        assert_eq!(r.turn_count, 10, "live turn does not write the count");
        assert_eq!(r.last_used_at, t0 + 200);
    }

    #[test]
    fn set_turn_count_corrects_an_inflated_max_seed() {
        // Risk R05 / [P08]: a record_spawn MAX seed can pull an inflated count
        // into the row; reconcile-after-spawn corrects it DOWN to the
        // authority. The seed is a current-epoch cache row (so it IS used).
        let l = fresh();
        l.upsert_scan_cache(&ScanCacheRow {
            session_id: "ext".into(),
            project_dir: "/proj/alpha".into(),
            file_size: 1_000,
            file_mtime: millis(5),
            excluded: false,
            turn_count: 99, // inflated estimate
            last_user_prompt: Some("p".into()),
            name: None,
            created_at: millis(1),
            last_used_at: millis(5),
            parse_offset: 0,
            tail_hash: 0,
            cwd_checked: false,
            created_at_found: false,
            frontier_open: false,
            frontier_pending_close: false,
            frontier_pending_close_msg_id: None,
            frontier_leaf_uuid: None,
            effective_uuids: None,
            lineage_ancestors: None,
            line_id: None,
        })
        .unwrap();
        l.record_spawn(
            "ext",
            WS_A,
            "/proj/alpha",
            "card-1",
            millis(10),
            "ext",
            None,
        )
        .unwrap();
        assert_eq!(
            l.get("ext").unwrap().unwrap().turn_count,
            99,
            "MAX seed pulls the (current-epoch) estimate in first"
        );

        // Reconcile to the segmenter's exact count (5) wins over the seed.
        l.set_turn_count("ext", 5, millis(11)).unwrap();
        assert_eq!(
            l.get("ext").unwrap().unwrap().turn_count,
            5,
            "reconcile corrects the inflated seed to the authority"
        );
    }

    #[test]
    fn set_turn_count_no_op_on_closed_or_missing_row() {
        let l = fresh();
        let t0 = millis(0);
        seed_live(&l, "s1", WS_A, "card-1", t0);
        // Establish a base count while live (the engine reconcile path).
        l.set_turn_count("s1", 1, t0 + 1).unwrap();
        l.mark_closed("s1").unwrap();

        // A reconcile arriving after close must not resurrect or rewrite.
        l.set_turn_count("s1", 99, t0 + 2).unwrap();
        let r = l.get("s1").unwrap().unwrap();
        assert_eq!(r.turn_count, 1);
        assert_eq!(r.state, SessionState::Closed);

        // A reconcile for a never-recorded session is a silent no-op.
        l.set_turn_count("ghost", 7, t0 + 3).unwrap();
        assert!(l.get("ghost").unwrap().is_none());
    }

    #[test]
    fn mark_closed_preserves_card_binding() {
        let l = fresh();
        seed_live(&l, "s1", WS_A, "card-1", millis(0));
        l.mark_closed("s1").unwrap();
        let r = l.get("s1").unwrap().unwrap();
        assert_eq!(r.state, SessionState::Closed);
        // card_id is preserved across the close transition so the
        // client-side restore can reconstruct the card→session map.
        assert_eq!(r.card_id.as_deref(), Some("card-1"));
    }

    #[test]
    fn mark_failed_retains_row_and_card_binding() {
        let l = fresh();
        seed_live(&l, "s1", WS_A, "card-1", millis(0));
        l.mark_failed("s1").unwrap();
        let r = l.get("s1").unwrap().unwrap();
        assert_eq!(r.state, SessionState::Failed);
        assert_eq!(r.card_id.as_deref(), Some("card-1"));
    }

    #[test]
    fn record_spawn_preserves_created_at_on_resume() {
        let l = fresh();
        let t0 = millis(2);
        seed_live(&l, "s1", WS_A, "card-1", t0);
        l.mark_closed("s1").unwrap();

        let t1 = millis(0);
        l.record_spawn("s1", WS_A, "/proj/alpha", "card-2", t1, "s1", None)
            .unwrap();
        let r = l.get("s1").unwrap().unwrap();
        assert_eq!(r.created_at, t0, "created_at must survive resume");
        assert_eq!(r.last_used_at, t1);
        assert_eq!(r.state, SessionState::Live);
        assert_eq!(r.card_id.as_deref(), Some("card-2"));
    }

    // ── list_with_card_id ────────────────────────────────────────────────────

    /// Both turn-having and zero-turn rows are returned. The client
    /// distinguishes them by `turn_count` and uses `mode=resume` for
    /// real conversations, `mode=new` (with same project_dir) for
    /// bound-but-empty sessions. This keeps the card's project
    /// binding across relaunches even when no conversation happened
    /// before the user quit.
    #[test]
    fn list_with_card_id_includes_zero_turn_rows() {
        let l = fresh();
        // s_used: had a real conversation (count from the engine reconcile).
        seed_live(&l, "s_used", WS_A, "card-1", millis(1));
        l.set_turn_count("s_used", 1, millis(2)).unwrap();
        // s_unused: spawn happened but no turns. Still surfaced so
        // the client retains the card→project binding on restore.
        seed_live(&l, "s_unused", WS_A, "card-2", millis(3));

        let rows = l.list_with_card_id().unwrap();
        let mut ids: Vec<&str> = rows.iter().map(|r| r.session_id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, vec!["s_unused", "s_used"]);
        // turn_count is preserved on the row so the client can branch.
        let used = rows.iter().find(|r| r.session_id == "s_used").unwrap();
        let unused = rows.iter().find(|r| r.session_id == "s_unused").unwrap();
        assert_eq!(used.turn_count, 1);
        assert_eq!(unused.turn_count, 0);
    }

    /// `card_id IS NULL` rows (headless tests, pre-binding spawns) are
    /// also excluded — restore is per-card, so a row without a card
    /// can't be matched to any deck card.
    #[test]
    fn list_with_card_id_excludes_null_card_id() {
        let l = fresh();
        // Insert a row directly with no card binding by recording a
        // spawn under "(empty)" then nulling the binding. The
        // `record_spawn` API requires a card_id, so we use raw SQL.
        let conn = l.db.lock().unwrap();
        conn.execute(
            "INSERT INTO lines (line_id, tag, name, name_user_set, card_id,
                                project_dir, created_at, last_used_at)
             VALUES ('headless', 'stocky-pixie', NULL, 0, NULL, ?1, ?2, ?2)",
            params!["/proj", millis(0)],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sessions (session_id, workspace_key, project_dir,
                                   created_at, last_used_at, turn_count,
                                   last_user_prompt, state, card_id, line_id)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, NULL, 'live', NULL, 'headless')",
            params!["headless", WS_A, "/proj", millis(0), millis(0)],
        )
        .unwrap();
        drop(conn);

        let rows = l.list_with_card_id().unwrap();
        assert!(rows.is_empty());
    }

    /// `state == 'failed'` rows are excluded — they're known
    /// unrecoverable, restoring would just resume_failed again.
    #[test]
    fn list_with_card_id_excludes_failed_rows() {
        let l = fresh();
        seed_live(&l, "s_failed", WS_A, "card-1", millis(0));
        l.record_turn("s_failed", millis(1)).unwrap();
        l.mark_failed("s_failed").unwrap();

        seed_live(&l, "s_ok", WS_A, "card-2", millis(2));
        l.record_turn("s_ok", millis(3)).unwrap();

        let rows = l.list_with_card_id().unwrap();
        let ids: Vec<&str> = rows.iter().map(|r| r.session_id.as_str()).collect();
        assert_eq!(ids, vec!["s_ok"]);
    }

    /// Closed rows that had real turns are still resumable — that's
    /// the whole point: a card whose user had a conversation, closed
    /// it, then reopened expects to see history.
    #[test]
    fn list_with_card_id_includes_closed_rows_with_turns() {
        let l = fresh();
        seed_live(&l, "s1", WS_A, "card-1", millis(0));
        l.record_turn("s1", millis(1)).unwrap();
        l.mark_closed("s1").unwrap();

        let rows = l.list_with_card_id().unwrap();
        let ids: Vec<&str> = rows.iter().map(|r| r.session_id.as_str()).collect();
        assert_eq!(ids, vec!["s1"]);
        assert_eq!(rows[0].state, SessionState::Closed);
        assert_eq!(rows[0].card_id.as_deref(), Some("card-1"));
    }

    /// Newest-first ordering by `last_used_at` so the client can pick
    /// the most recent binding per card. `millis(N)` returns a
    /// timestamp N days *ago*, so smaller `N` is more recent.
    #[test]
    fn list_with_card_id_orders_newest_first() {
        let l = fresh();
        // "fresh" was used most recently (smallest days-ago).
        seed_live(&l, "fresh", WS_A, "card-1", millis(5));
        l.record_turn("fresh", millis(1)).unwrap();
        // "stale" was used long ago.
        seed_live(&l, "stale", WS_A, "card-2", millis(20));
        l.record_turn("stale", millis(15)).unwrap();
        // "mid" sits between them.
        seed_live(&l, "mid", WS_A, "card-3", millis(10));
        l.record_turn("mid", millis(8)).unwrap();

        let rows = l.list_with_card_id().unwrap();
        let ids: Vec<&str> = rows.iter().map(|r| r.session_id.as_str()).collect();
        assert_eq!(ids, vec!["fresh", "mid", "stale"]);
    }

    // ── list_for_workspace ───────────────────────────────────────────────────

    #[test]
    fn list_for_workspace_orders_newest_first() {
        let l = fresh();
        seed_live(&l, "s1", WS_A, "c1", millis(3));
        seed_live(&l, "s2", WS_A, "c2", millis(1));
        seed_live(&l, "s3", WS_A, "c3", millis(2));
        seed_live(&l, "other", WS_B, "cb", millis(0));

        let rows = l.list_for_workspace(WS_A).unwrap();
        let ids: Vec<&str> = rows.iter().map(|r| r.session_id.as_str()).collect();
        assert_eq!(ids, vec!["s2", "s3", "s1"]);
    }

    // ── trash ───────────────────────────────────────────────────────────────

    #[test]
    fn trash_removes_closed_row() {
        let l = fresh();
        seed_live(&l, "s1", WS_A, "c1", millis(0));
        l.mark_closed("s1").unwrap();

        let outcome = l.trash("s1").unwrap();
        assert_eq!(outcome.session_id, "s1");
        assert_eq!(outcome.jsonl_moved_to, None);
        assert!(l.get("s1").unwrap().is_none());
    }

    #[test]
    fn trash_refuses_live_row() {
        let l = fresh();
        seed_live(&l, "s1", WS_A, "c1", millis(0));
        let err = l.trash("s1").unwrap_err();
        assert!(matches!(err, LedgerError::InvalidState(_)));
        assert!(l.get("s1").unwrap().is_some(), "row must remain");
    }

    #[test]
    fn trash_missing_session_errors() {
        let l = fresh();
        let err = l.trash("nope").unwrap_err();
        assert!(matches!(err, LedgerError::NotFound(ref id) if id == "nope"));
    }

    #[test]
    fn trash_resolves_symlink_aliased_project_dir_to_canonical_jsonl() {
        // A row recorded with a symlink-aliased project_dir (the
        // user-typed path) must still find — and move — the JSONL that
        // lives under the CANONICAL dir's encoding. This is the
        // `claude_project_dir` chokepoint working inside
        // `move_jsonl_to_trash`.
        let tmp = tempfile::tempdir().unwrap();
        let tmp_real = std::fs::canonicalize(tmp.path()).unwrap();
        let real_project = tmp_real.join("real-project");
        std::fs::create_dir_all(&real_project).unwrap();
        let alias = tmp_real.join("alias-project");
        std::os::unix::fs::symlink(&real_project, &alias).unwrap();

        let claude_root = tmp_real.join("projects");
        let canonical_str = real_project.to_str().unwrap();
        let session_dir = claude_root.join(encode_claude_project_name(canonical_str));
        std::fs::create_dir_all(&session_dir).unwrap();
        let jsonl = session_dir.join("s1.jsonl");
        std::fs::write(&jsonl, "{}").unwrap();

        let l =
            SessionLedger::open_with_claude_root(tmp_real.join("sessions.db"), claude_root.clone())
                .unwrap();
        l.record_spawn(
            "s1",
            WS_A,
            alias.to_str().unwrap(),
            "c1",
            millis(0),
            "s1",
            None,
        )
        .unwrap();
        l.mark_closed("s1").unwrap();

        let outcome = l.trash("s1").unwrap();
        assert!(
            outcome.jsonl_moved_to.is_some(),
            "alias-recorded row must locate the canonical-dir JSONL"
        );
        assert!(!jsonl.exists(), "JSONL must be moved to trash");
        assert!(session_dir.join(".tug-trash").exists());
    }

    // ── sweep_expired ────────────────────────────────────────────────────────

    #[test]
    fn sweep_expired_removes_stale_non_live_rows() {
        let l = fresh();
        let now = millis(0);
        let max_age_ms = DEV_LEDGER_MAX_AGE_DAYS * 86_400_000;

        // 91-day-old closed row — should be swept.
        seed_live(&l, "old", WS_A, "c", millis(91));
        l.mark_closed("old").unwrap();
        // 89-day-old closed row — survives.
        seed_live(&l, "fresh", WS_A, "c", millis(89));
        l.mark_closed("fresh").unwrap();

        let swept = l.sweep_expired(max_age_ms, now).unwrap();
        assert_eq!(swept, vec!["old".to_owned()]);
        assert!(l.get("old").unwrap().is_none());
        assert!(l.get("fresh").unwrap().is_some());
    }

    #[test]
    fn sweep_expired_leaves_live_rows_untouched() {
        let l = fresh();
        let now = millis(0);
        let max_age_ms = DEV_LEDGER_MAX_AGE_DAYS * 86_400_000;

        // Live row with a stale `last_used_at` (e.g., a card pinned open for
        // months). Sweep must not touch it.
        seed_live(&l, "pinned", WS_A, "card-pin", millis(200));
        let swept = l.sweep_expired(max_age_ms, now).unwrap();
        assert!(swept.is_empty());
        let r = l.get("pinned").unwrap().unwrap();
        assert_eq!(r.state, SessionState::Live);
    }

    #[test]
    fn sweep_expired_removes_failed_rows_too() {
        let l = fresh();
        let now = millis(0);
        let max_age_ms = DEV_LEDGER_MAX_AGE_DAYS * 86_400_000;

        seed_live(&l, "stale", WS_A, "c", millis(120));
        l.mark_failed("stale").unwrap();

        let swept = l.sweep_expired(max_age_ms, now).unwrap();
        assert_eq!(swept, vec!["stale".to_owned()]);
        assert!(l.get("stale").unwrap().is_none());
    }

    // ── the named-line guard ────────────────────────────────────────────────
    //
    // A `/rename` is the user's own word, and no automatic delete may cost
    // one. These exercise the two guarded paths, and the shape that broke the
    // obvious predicate: a named line every one of whose segments is doomed.

    /// A second segment on an existing line — the shape a rotation leaves.
    fn seed_segment(ledger: &SessionLedger, id: &str, line_id: &str, now: i64) {
        ledger
            .record_spawn(id, WS_A, "/proj", "c", now, line_id, None)
            .expect("record_spawn");
    }

    fn name_the_line(ledger: &SessionLedger, line_id: &str, name: &str) {
        ledger.rename(line_id, Some(name)).expect("rename");
    }

    #[test]
    fn sweep_spares_the_last_segment_of_a_named_line() {
        let l = fresh();
        let now = millis(0);
        let max_age_ms = DEV_LEDGER_MAX_AGE_DAYS * 86_400_000;

        // Long past the age cutoff, and the only segment its line has.
        seed_live(&l, "lens-xp-seg", WS_A, "c", millis(200));
        l.mark_closed("lens-xp-seg").unwrap();
        name_the_line(&l, "lens-xp-seg", "lens-xp");

        let swept = l.sweep_expired(max_age_ms, now).unwrap();
        assert!(swept.is_empty(), "a named line's last segment is not age");
        assert!(l.get("lens-xp-seg").unwrap().is_some());
    }

    #[test]
    fn sweep_takes_the_last_segment_of_an_unnamed_line() {
        let l = fresh();
        let now = millis(0);
        let max_age_ms = DEV_LEDGER_MAX_AGE_DAYS * 86_400_000;

        // Same age, same last-segment shape — the only difference is that
        // nobody typed a name for it. This is the control the guard needs:
        // without it the guard would read as "the sweep stopped working".
        seed_live(&l, "anon", WS_A, "c", millis(200));
        l.mark_closed("anon").unwrap();

        let swept = l.sweep_expired(max_age_ms, now).unwrap();
        assert_eq!(swept, vec!["anon".to_owned()]);
        assert!(l.get("anon").unwrap().is_none());
    }

    #[test]
    fn sweep_takes_the_older_segment_of_a_named_line() {
        let l = fresh();
        let now = millis(0);
        let max_age_ms = DEV_LEDGER_MAX_AGE_DAYS * 86_400_000;

        // Two segments of one named line; only the older one is expired, so
        // the guard has nothing to do and the sweep does its ordinary work.
        seed_live(&l, "old-seg", WS_A, "c", millis(200));
        l.mark_closed("old-seg").unwrap();
        seed_segment(&l, "new-seg", "old-seg", millis(5));
        l.mark_closed("new-seg").unwrap();
        name_the_line(&l, "old-seg", "dash-compact");

        let swept = l.sweep_expired(max_age_ms, now).unwrap();
        assert_eq!(swept, vec!["old-seg".to_owned()]);
        assert!(l.get("old-seg").unwrap().is_none());
        assert!(l.get("new-seg").unwrap().is_some());
    }

    #[test]
    fn sweep_keeps_the_newest_when_every_segment_of_a_named_line_expires() {
        let l = fresh();
        let now = millis(0);
        let max_age_ms = DEV_LEDGER_MAX_AGE_DAYS * 86_400_000;

        // The shape a row-at-a-time predicate gets wrong: asked on its own,
        // each of these two rows can point at the other as a survivor, and
        // both get deleted. The guard is set-aware, so the newest stands.
        seed_live(&l, "seg-older", WS_A, "c", millis(200));
        l.mark_closed("seg-older").unwrap();
        seed_segment(&l, "seg-newer", "seg-older", millis(150));
        l.mark_closed("seg-newer").unwrap();
        name_the_line(&l, "seg-older", "tripwire-xp");

        let swept = l.sweep_expired(max_age_ms, now).unwrap();
        assert_eq!(swept, vec!["seg-older".to_owned()]);
        assert!(l.get("seg-older").unwrap().is_none());
        assert!(
            l.get("seg-newer").unwrap().is_some(),
            "one segment survives so the name stays reachable"
        );
    }

    #[test]
    fn sweep_spares_a_named_line_whose_only_surviving_segment_is_live() {
        let l = fresh();
        let now = millis(0);
        let max_age_ms = DEV_LEDGER_MAX_AGE_DAYS * 86_400_000;

        // A live segment counts as a survivor, so the expired one goes.
        seed_live(&l, "seg-closed", WS_A, "c", millis(200));
        l.mark_closed("seg-closed").unwrap();
        seed_segment(&l, "seg-live", "seg-closed", millis(0));
        name_the_line(&l, "seg-closed", "layout-xp");

        let swept = l.sweep_expired(max_age_ms, now).unwrap();
        assert_eq!(swept, vec!["seg-closed".to_owned()]);
        assert!(l.get("seg-live").unwrap().is_some());
    }

    #[test]
    fn trash_for_project_dir_spares_the_last_segment_of_a_named_line() {
        let l = fresh();
        seed_live(&l, "named-seg", WS_A, "c", millis(0));
        l.mark_closed("named-seg").unwrap();
        name_the_line(&l, "named-seg", "dots-hacking");
        // An unnamed neighbour in the same project dir, to prove the path
        // still does its job around the row it spares.
        seed_live(&l, "anon-seg", WS_A, "c", millis(0));
        l.mark_closed("anon-seg").unwrap();

        let dropped = l.trash_for_project_dir("/proj").unwrap();
        assert_eq!(dropped, vec!["anon-seg".to_owned()]);
        assert!(l.get("named-seg").unwrap().is_some());
        assert!(l.get("anon-seg").unwrap().is_none());
    }

    #[test]
    fn trash_for_project_dir_keeps_the_newest_segment_of_a_named_line() {
        let l = fresh();
        // Both segments match the project dir, so both are doomed by the
        // criterion; the guard leaves the newest standing.
        seed_live(&l, "pd-older", WS_A, "c", millis(9));
        l.mark_closed("pd-older").unwrap();
        seed_segment(&l, "pd-newer", "pd-older", millis(1));
        l.mark_closed("pd-newer").unwrap();
        name_the_line(&l, "pd-older", "live-atoms-in-editing");

        let dropped = l.trash_for_project_dir("/proj").unwrap();
        assert_eq!(dropped, vec!["pd-older".to_owned()]);
        assert!(l.get("pd-newer").unwrap().is_some());
    }

    #[test]
    fn trash_is_unguarded_because_it_is_the_users_own_gesture() {
        let l = fresh();
        seed_live(&l, "named-seg", WS_A, "c", millis(0));
        l.mark_closed("named-seg").unwrap();
        name_the_line(&l, "named-seg", "ensure-dash-completion");

        // Explicit trashing is the one delete that may cost a name: the user
        // said so, and refusing it would be the ledger overruling them.
        l.trash("named-seg").unwrap();
        assert!(l.get("named-seg").unwrap().is_none());
    }

    // ── the line-first listing ──────────────────────────────────────────────
    //
    // A listing that walks `sessions` can only ever show a line that still has
    // one. The name lives on `lines` and outlives every segment, so the
    // listing enumerates lines and attaches their segments instead.

    /// Strand a line the way it was stranded for real: the `sessions` row
    /// goes — straight at the table, which is what the cap did — and the
    /// line, its name, and the mint naming its session stay. Not `trash`:
    /// the user's own gesture takes the name with it, which is the whole
    /// difference between the two.
    fn strand(ledger: &SessionLedger, session_id: &str) {
        {
            let conn = ledger.db.lock().unwrap();
            conn.execute(
                "DELETE FROM sessions WHERE session_id = ?1",
                params![session_id],
            )
            .expect("delete the segment");
        }
        assert!(
            ledger.get(session_id).unwrap().is_none(),
            "the segment is gone"
        );
    }

    #[test]
    fn a_named_line_lists_when_every_segment_is_gone() {
        let l = fresh();
        l.record_spawn("seg-1", WS_A, "/proj", "c", millis(3), "line-lens", None)
            .unwrap();
        l.mark_closed("seg-1").unwrap();
        name_the_line(&l, "line-lens", "lens-xp");
        strand(&l, "seg-1");

        let listed = l.list_for_project_dir("/proj").unwrap();
        let row = listed
            .iter()
            .find(|r| r.line_id == "line-lens")
            .expect("the named line is a row although no segment survives it");
        assert_eq!(row.name.as_deref(), Some("lens-xp"));
        assert!(row.name_user_set);
        assert_eq!(
            row.session_id, "seg-1",
            "the minted_tags join names a session recorded, never guessed"
        );
    }

    #[test]
    fn an_unnamed_stranded_line_does_not_list() {
        let l = fresh();
        l.record_spawn("anon-seg", WS_A, "/proj", "c", millis(3), "line-anon", None)
            .unwrap();
        l.mark_closed("anon-seg").unwrap();
        strand(&l, "anon-seg");

        // Nobody typed a name for this one, so there is nothing to preserve
        // and a row would be a session the user cannot place.
        let listed = l.list_for_project_dir("/proj").unwrap();
        assert!(listed.iter().all(|r| r.line_id != "line-anon"));
    }

    #[test]
    fn a_named_line_with_a_surviving_segment_lists_once() {
        let l = fresh();
        l.record_spawn("kept", WS_A, "/proj", "c", millis(3), "line-kept", None)
            .unwrap();
        l.mark_closed("kept").unwrap();
        name_the_line(&l, "line-kept", "layout-xp");

        // The stranded arm must not double a line that is listing perfectly
        // well through its own segment.
        let listed = l.list_for_project_dir("/proj").unwrap();
        let mine: Vec<_> = listed
            .iter()
            .filter(|r| r.line_id == "line-kept")
            .collect();
        assert_eq!(mine.len(), 1);
        assert_eq!(mine[0].session_id, "kept");
        assert_eq!(mine[0].name.as_deref(), Some("layout-xp"));
    }

    #[test]
    fn trashing_the_last_segment_of_a_named_line_unlists_it() {
        let l = fresh();
        l.record_spawn("gone", WS_A, "/proj", "c", millis(3), "line-gone", None)
            .unwrap();
        l.mark_closed("gone").unwrap();
        name_the_line(&l, "line-gone", "tugrev-bringup");

        // The user asked for this one to go, and its transcript went to
        // `.tug-trash` with it. The stranded arm must not turn round and
        // re-offer the line: that row would point at a transcript nothing can
        // open, which is the ghost the repair verb refuses to write.
        l.trash("gone").unwrap();

        let listed = l.list_for_project_dir("/proj").unwrap();
        assert!(
            listed.iter().all(|r| r.line_id != "line-gone"),
            "a line the user threw away does not come back as a name"
        );
        let line = l.get_line("line-gone").unwrap().expect("the line survives");
        assert!(
            line.name.is_none() && !line.name_user_set,
            "the one gesture that may cost a name has cost it"
        );
    }

    // ── trash_for_project_dir ───────────────────────────────────────────────

    #[test]
    fn trash_for_project_dir_drops_matching_rows_only() {
        let l = fresh();
        seed_live(&l, "matched-1", WS_A, "c", millis(0));
        l.mark_closed("matched-1").unwrap();
        seed_live(&l, "matched-2", WS_A, "c", millis(0));
        l.mark_failed("matched-2").unwrap();
        // Live match — survives (we don't reach into a card that's still open).
        seed_live(&l, "matched-live", WS_A, "card-x", millis(0));
        // Different project_dir — also survives.
        ledger_helper_record(&l, "other", WS_A, "/other/path", "c", millis(0));
        l.mark_closed("other").unwrap();

        let dropped = l.trash_for_project_dir("/proj").unwrap();
        let mut sorted = dropped.clone();
        sorted.sort();
        assert_eq!(sorted, vec!["matched-1".to_owned(), "matched-2".to_owned()]);
        assert!(l.get("matched-1").unwrap().is_none());
        assert!(l.get("matched-2").unwrap().is_none());
        assert!(l.get("matched-live").unwrap().is_some());
        assert!(l.get("other").unwrap().is_some());
    }

    fn ledger_helper_record(
        ledger: &SessionLedger,
        id: &str,
        ws: &str,
        project_dir: &str,
        card: &str,
        now: i64,
    ) {
        ledger
            .record_spawn(id, ws, project_dir, card, now, id, None)
            .expect("record_spawn");
    }

    // ── seat_line_bindings ───────────────────────────────────────────────────

    #[test]
    fn a_relaunch_seats_the_line_binding_on_the_resumed_segment() {
        let l = fresh();
        let line = "line-1";
        l.record_spawn("root", WS_A, "/proj", "card-1", millis(2), line, None)
            .unwrap();
        l.set_dash_binding("root", Some(("tugdash/demo#1", "demo")))
            .unwrap();
        // The rotation's segment: minted on the same line, forked from the
        // root, bound to nothing of its own.
        l.record_spawn("stage", WS_A, "/proj", "card-1", millis(1), line, None)
            .unwrap();
        l.set_fork_provenance("stage", "root", None).unwrap();
        l.demote_live_to_closed().unwrap();
        assert_eq!(
            l.resume_segment_for_line(line).unwrap().unwrap().session_id,
            "stage",
            "the relaunch seats the tip"
        );

        assert_eq!(l.seat_line_bindings().unwrap(), 1);
        let seat = l.get("stage").unwrap().unwrap();
        assert_eq!(seat.dash_id.as_deref(), Some("tugdash/demo#1"));
        assert_eq!(seat.dash_name.as_deref(), Some("demo"));
        assert!(
            l.get("root").unwrap().unwrap().dash_id.is_none(),
            "a binding is moved, never copied"
        );
        assert_eq!(
            l.seat_line_bindings().unwrap(),
            0,
            "seated once, nothing to move"
        );
    }

    #[test]
    fn seat_line_bindings_leaves_a_seated_or_unbound_line_alone() {
        let l = fresh();
        // Bound on the seat already.
        l.record_spawn("solo", WS_A, "/proj", "card-1", millis(1), "line-1", None)
            .unwrap();
        l.set_dash_binding("solo", Some(("tugdash/demo#1", "demo")))
            .unwrap();
        // Two segments, neither bound.
        l.record_spawn("a", WS_A, "/proj", "card-2", millis(2), "line-2", None)
            .unwrap();
        l.record_spawn("b", WS_A, "/proj", "card-2", millis(1), "line-2", None)
            .unwrap();
        l.set_fork_provenance("b", "a", None).unwrap();
        l.demote_live_to_closed().unwrap();

        assert_eq!(l.seat_line_bindings().unwrap(), 0);
        assert_eq!(
            l.get("solo").unwrap().unwrap().dash_id.as_deref(),
            Some("tugdash/demo#1")
        );
        assert!(l.get("b").unwrap().unwrap().dash_id.is_none());
    }

    // ── live_segment_of ──────────────────────────────────────────────────────

    /// The shape the Wheel leaves behind: a line whose stages have each
    /// rotated a fresh id, with only the newest segment live. `$TUG_SESSION_ID`
    /// inside that card still names the first one.
    fn rotated_line(l: &SessionLedger) {
        l.record_spawn(
            "seg-old",
            WS_A,
            "/proj",
            "card-1",
            millis(3),
            "line-1",
            None,
        )
        .unwrap();
        l.demote_live_to_closed().unwrap();
        l.record_spawn(
            "seg-mid",
            WS_A,
            "/proj",
            "card-1",
            millis(2),
            "line-1",
            None,
        )
        .unwrap();
        l.demote_live_to_closed().unwrap();
        l.record_spawn(
            "seg-new",
            WS_A,
            "/proj",
            "card-1",
            millis(1),
            "line-1",
            None,
        )
        .unwrap();
    }

    #[test]
    fn live_segment_of_expands_a_stale_id_to_the_seated_segment() {
        let l = fresh();
        rotated_line(&l);
        // The id the stage was spawned under, two rotations back.
        assert_eq!(
            l.live_segment_of("seg-old").unwrap().as_deref(),
            Some("seg-new"),
        );
        assert_eq!(
            l.live_segment_of("seg-new").unwrap().as_deref(),
            Some("seg-new"),
            "and the ordinary case resolves to itself"
        );
        assert_eq!(
            l.live_segment_of("never-seen").unwrap(),
            None,
            "an id this ledger has never seen is nobody's segment"
        );
    }

    #[test]
    fn a_line_whose_every_segment_closed_has_no_live_segment() {
        let l = fresh();
        rotated_line(&l);
        l.demote_live_to_closed().unwrap();
        assert_eq!(
            l.live_segment_of("seg-old").unwrap(),
            None,
            "the answer is that the card has gone, not the id that was asked"
        );
    }

    #[test]
    fn a_line_of_one_answers_for_itself_and_only_while_live() {
        let l = fresh();
        seed_live(&l, "solo", WS_A, "card-1", millis(1));
        assert_eq!(l.live_segment_of("solo").unwrap().as_deref(), Some("solo"));
        l.mark_closed("solo").unwrap();
        assert_eq!(l.live_segment_of("solo").unwrap(), None);
    }

    /// **The rotation-overlap window.** A rotation records the fresh segment
    /// and demotes the old one as two steps; between them both are live, and
    /// that is the window every `tugtool arc` verb issued from inside the
    /// retiring stage lands in.
    ///
    /// The caller-first tiebreak resolved to the *retiring* segment here — a
    /// bind that passes the live-guard, writes onto a row about to close, and
    /// strands: the seat has already run for the fresh segment and will not
    /// run again until a relaunch. The answer is the newest live segment,
    /// which is where the work now is.
    #[test]
    fn live_segment_of_prefers_the_fresh_segment_during_a_rotation_overlap() {
        let l = fresh();
        l.record_spawn(
            "retiring",
            WS_A,
            "/proj",
            "card-1",
            millis(2),
            "line-1",
            None,
        )
        .unwrap();
        // The overlap: recorded, not yet demoted.
        l.record_spawn("fresh", WS_A, "/proj", "card-1", millis(1), "line-1", None)
            .unwrap();
        assert_eq!(
            l.get("retiring").unwrap().unwrap().state,
            SessionState::Live,
            "the window is real: the old segment is still live",
        );

        assert_eq!(
            l.live_segment_of("retiring").unwrap().as_deref(),
            Some("fresh"),
            "a verb posted from the retiring stage lands on the segment the work moved to",
        );
        assert_eq!(
            l.live_segment_of("fresh").unwrap().as_deref(),
            Some("fresh"),
        );

        // And once the demote lands, the answer has not changed.
        l.mark_closed("retiring").unwrap();
        assert_eq!(
            l.live_segment_of("retiring").unwrap().as_deref(),
            Some("fresh"),
        );
    }

    // ── seat_line_binding ────────────────────────────────────────────────────

    #[test]
    fn a_rotation_carries_the_dash_onto_the_segment_it_seats() {
        let l = fresh();
        l.record_spawn(
            "stage-1",
            WS_A,
            "/proj",
            "card-1",
            millis(2),
            "line-1",
            None,
        )
        .unwrap();
        l.set_dash_binding("stage-1", Some(("tugdash/demo#1", "demo")))
            .unwrap();
        assert_eq!(
            l.bound_sessions_by_dash().unwrap().get("tugdash/demo#1"),
            Some(&vec!["stage-1".to_string()]),
        );

        // The Wheel seats the next stage: a fresh segment on the same line.
        l.demote_live_to_closed().unwrap();
        l.record_spawn(
            "stage-2",
            WS_A,
            "/proj",
            "card-1",
            millis(1),
            "line-1",
            None,
        )
        .unwrap();
        assert_eq!(
            l.bound_sessions_by_dash().unwrap().get("tugdash/demo#1"),
            None,
            "before the carry, a card mid-arc reads unbound the moment it rotates",
        );

        assert_eq!(
            l.seat_line_binding("stage-2").unwrap(),
            Some(("tugdash/demo#1".to_string(), "demo".to_string())),
            "and the carry is what the caller announces to the card",
        );
        assert_eq!(
            l.bound_sessions_by_dash().unwrap().get("tugdash/demo#1"),
            Some(&vec!["stage-2".to_string()]),
        );
        assert!(
            l.get("stage-1").unwrap().unwrap().dash_id.is_none(),
            "moved, never copied",
        );
        assert_eq!(
            l.seat_line_binding("stage-2").unwrap(),
            None,
            "seated once, nothing to move"
        );
    }

    #[test]
    fn seat_line_binding_leaves_an_unbound_or_already_bound_segment_alone() {
        let l = fresh();
        // A line with no dash anywhere on it — the ordinary spawn.
        l.record_spawn(
            "plain-1",
            WS_A,
            "/proj",
            "card-1",
            millis(2),
            "line-1",
            None,
        )
        .unwrap();
        l.record_spawn(
            "plain-2",
            WS_A,
            "/proj",
            "card-1",
            millis(1),
            "line-1",
            None,
        )
        .unwrap();
        assert_eq!(l.seat_line_binding("plain-2").unwrap(), None);

        // A segment that already carries its own binding keeps it, rather than
        // taking a sibling's.
        l.record_spawn("own-1", WS_A, "/proj", "card-2", millis(2), "line-2", None)
            .unwrap();
        l.set_dash_binding("own-1", Some(("tugdash/one#1", "one")))
            .unwrap();
        l.record_spawn("own-2", WS_A, "/proj", "card-2", millis(1), "line-2", None)
            .unwrap();
        l.set_dash_binding("own-2", Some(("tugdash/two#1", "two")))
            .unwrap();
        assert_eq!(l.seat_line_binding("own-2").unwrap(), None);
        assert_eq!(
            l.get("own-2").unwrap().unwrap().dash_name.as_deref(),
            Some("two"),
        );

        assert_eq!(
            l.seat_line_binding("never-seen").unwrap(),
            None,
            "and an id this ledger does not hold moves nothing"
        );
    }

    /// The seat carries the live-only guard its sibling has.
    ///
    /// Nothing moves onto a segment that has closed — and, crucially, the
    /// holder is not cleared either. A seat that moved the binding off a live
    /// holder and onto a corpse would leave the line reading *unbound* with
    /// no writer left to fix it.
    #[test]
    fn seat_line_binding_refuses_a_segment_that_is_not_live() {
        let l = fresh();
        l.record_spawn("holder", WS_A, "/proj", "card-1", millis(2), "line-1", None)
            .unwrap();
        l.set_dash_binding("holder", Some(("tugdash/demo#1", "demo")))
            .unwrap();
        l.record_spawn("corpse", WS_A, "/proj", "card-1", millis(1), "line-1", None)
            .unwrap();
        l.mark_closed("corpse").unwrap();

        assert_eq!(
            l.seat_line_binding("corpse").unwrap(),
            None,
            "the corpse refuses the seat instead of reporting a carry",
        );
        assert!(l.get("corpse").unwrap().unwrap().dash_id.is_none());
        assert_eq!(
            l.get("holder").unwrap().unwrap().dash_id.as_deref(),
            Some("tugdash/demo#1"),
            "and the live holder keeps what it had",
        );
    }

    // ── set_dash_binding's live-only guard ───────────────────────────────────

    #[test]
    fn a_binding_cannot_be_written_onto_a_demoted_segment() {
        let l = fresh();
        rotated_line(&l);
        assert!(
            !l.set_dash_binding("seg-old", Some(("tugdash/demo#1", "demo")))
                .unwrap(),
            "the corpse refuses the write instead of reporting a success about it",
        );
        assert!(l.get("seg-old").unwrap().unwrap().dash_id.is_none());
        assert!(
            l.set_dash_binding("seg-new", Some(("tugdash/demo#1", "demo")))
                .unwrap(),
            "and the seated segment takes it",
        );
    }

    #[test]
    fn clearing_a_stale_binding_off_a_dead_row_is_allowed() {
        let l = fresh();
        seed_live(&l, "solo", WS_A, "c1", millis(1));
        l.set_dash_binding("solo", Some(("tugdash/demo#1", "demo")))
            .unwrap();
        l.demote_live_to_closed().unwrap();
        assert!(
            l.set_dash_binding("solo", None).unwrap(),
            "housekeeping is not the hazard the guard is for",
        );
        assert!(l.get("solo").unwrap().unwrap().dash_id.is_none());
    }

    // ── the binding-write chokepoint ─────────────────────────────────────────

    /// Every session-keyed write of a dash binding goes through
    /// [`SessionLedger::set_dash_binding`] or one of the two seat verbs —
    /// **structurally**, not by convention.
    ///
    /// The live-only guard that refuses a binding onto a demoted segment is
    /// worth exactly as much as the number of writers that pass through it.
    /// `seat_line_binding` was a second writer that did not, and the fourth
    /// incident in this class came of a fifth writer nobody had noticed. This
    /// is the sibling of `tugcore`'s `no_ad_hoc_ledger_opens`: a new
    /// `UPDATE sessions SET dash_id …` anywhere in tugcast fails the build
    /// until it either goes through a sanctioned verb or is named here.
    ///
    /// `clear_dash_bindings_for_dash` is sanctioned on different grounds: it
    /// is keyed by **dash**, not by session, and removing a binding is
    /// shape-safe in the way writing one is not (the same asymmetry
    /// `set_dash_binding`'s own `?2 IS NULL` arm states).
    #[test]
    fn no_ad_hoc_binding_writes() {
        const SANCTIONED: &[&str] = &[
            "set_dash_binding",
            "seat_line_binding",
            "seat_line_bindings",
            "clear_dash_bindings_for_dash",
        ];
        let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        // A scan that matches nothing passes vacuously, which is the one way
        // a guard like this rots without anyone noticing.
        let mut seen = 0usize;
        let mut stack = vec![src_root.clone()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("read_dir") {
                let path = entry.expect("dir entry").path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                    continue;
                }
                let text = std::fs::read_to_string(&path).expect("read source");
                // Production text only: a test may quote the pattern, and
                // this one does.
                let text = match text.find("\n#[cfg(test)]\nmod tests") {
                    Some(cut) => text[..cut].to_string(),
                    None => text,
                };
                for (idx, _) in text.match_indices("UPDATE sessions SET") {
                    let window = &text[idx..text.len().min(idx + 200)];
                    if !window.contains("dash_id") {
                        continue;
                    }
                    // The enclosing item, found the way a reader finds it:
                    // the nearest `fn` above the statement.
                    let name = text[..idx]
                        .rmatch_indices("fn ")
                        .next()
                        .map(|(at, _)| {
                            text[at + 3..]
                                .split(|c: char| !(c.is_alphanumeric() || c == '_'))
                                .next()
                                .unwrap_or("")
                                .to_string()
                        })
                        .unwrap_or_default();
                    if !SANCTIONED.contains(&name.as_str()) {
                        offenders.push(format!(
                            "{}: binding UPDATE inside `{name}`",
                            path.strip_prefix(&src_root).unwrap_or(&path).display()
                        ));
                    } else {
                        seen += 1;
                    }
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "session-keyed dash-binding writes outside the sanctioned verbs — a writer that \
             skips them also skips the live-only guard, and writes a binding onto a segment \
             that has already closed: {offenders:#?}"
        );
        assert!(
            seen >= 4,
            "the scan found only {seen} sanctioned binding writes — it has stopped seeing the \
             code it guards"
        );
    }

    // ── demote_live_to_closed ────────────────────────────────────────────────

    #[test]
    fn demote_live_to_closed_transitions_only_live_rows() {
        let l = fresh();
        seed_live(&l, "live1", WS_A, "c1", millis(0));
        seed_live(&l, "live2", WS_A, "c2", millis(0));
        seed_live(&l, "closed1", WS_A, "c3", millis(1));
        l.mark_closed("closed1").unwrap();
        seed_live(&l, "failed1", WS_A, "c4", millis(2));
        l.mark_failed("failed1").unwrap();

        let demoted = l.demote_live_to_closed().unwrap();
        assert_eq!(demoted, 2);

        let r = l.get("live1").unwrap().unwrap();
        assert_eq!(r.state, SessionState::Closed);
        // card_id is preserved across the demote transition so the
        // client-side restore retains the binding after a tugcast crash.
        assert_eq!(r.card_id.as_deref(), Some("c1"));

        let r = l.get("live2").unwrap().unwrap();
        assert_eq!(r.state, SessionState::Closed);
        assert_eq!(r.card_id.as_deref(), Some("c2"));

        // Already-closed and failed rows untouched.
        assert_eq!(
            l.get("closed1").unwrap().unwrap().state,
            SessionState::Closed
        );
        assert_eq!(
            l.get("failed1").unwrap().unwrap().state,
            SessionState::Failed
        );
    }

    #[test]
    fn demote_live_to_closed_no_op_when_no_live_rows() {
        let l = fresh();
        seed_live(&l, "s1", WS_A, "c", millis(0));
        l.mark_closed("s1").unwrap();
        assert_eq!(l.demote_live_to_closed().unwrap(), 0);
    }

    // ── the channel's rename, carried forward ────────────────────────────────

    /// Write a database carrying the pre-rename schema: `gazette_posts` with
    /// its index, its external-content FTS5 shadow, and the three sync
    /// triggers — the shape a build from before the rename left behind.
    fn seed_pre_rename_posts(path: &Path, rows: &[(&str, &str)]) {
        let conn = rusqlite::Connection::open(path).expect("open pre-rename db");
        conn.execute_batch(
            "
            CREATE TABLE gazette_posts (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                at_ms       INTEGER NOT NULL,
                author      TEXT NOT NULL,
                session_id  TEXT,
                wake_reason TEXT,
                body        TEXT NOT NULL,
                refs        TEXT NOT NULL,
                elapsed_ms  INTEGER,
                project_dir TEXT,
                attachments TEXT,
                tokens      TEXT
            );
            CREATE INDEX gazette_posts_session ON gazette_posts(session_id);
            CREATE VIRTUAL TABLE gazette_posts_fts USING fts5(
                body, refs, tokens, content='gazette_posts', content_rowid='id'
            );
            CREATE TRIGGER gazette_posts_fts_insert AFTER INSERT ON gazette_posts
            BEGIN
                INSERT INTO gazette_posts_fts (rowid, body, refs, tokens)
                VALUES (new.id, new.body, new.refs, new.tokens);
            END;
            CREATE TRIGGER gazette_posts_fts_delete AFTER DELETE ON gazette_posts
            BEGIN
                INSERT INTO gazette_posts_fts (gazette_posts_fts, rowid, body, refs, tokens)
                VALUES ('delete', old.id, old.body, old.refs, old.tokens);
            END;
            CREATE TRIGGER gazette_posts_fts_update AFTER UPDATE ON gazette_posts
            BEGIN
                INSERT INTO gazette_posts_fts (gazette_posts_fts, rowid, body, refs, tokens)
                VALUES ('delete', old.id, old.body, old.refs, old.tokens);
                INSERT INTO gazette_posts_fts (rowid, body, refs, tokens)
                VALUES (new.id, new.body, new.refs, new.tokens);
            END;
            ",
        )
        .expect("seed pre-rename schema");
        for (i, (author, body)) in rows.iter().enumerate() {
            conn.execute(
                "INSERT INTO gazette_posts (at_ms, author, session_id, body, refs, tokens)
                 VALUES (?1, ?2, 's1', ?3, '[]', ?3)",
                params![1_000 + i as i64, author, body],
            )
            .expect("seed post");
        }
    }

    fn author_counts(ledger: &SessionLedger) -> Vec<(String, i64)> {
        let conn = ledger.db.lock().expect("ledger mutex");
        let mut stmt = conn
            .prepare("SELECT author, count(*) FROM overview_posts GROUP BY author ORDER BY author")
            .expect("prepare");
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .expect("query");
        rows.collect::<Result<Vec<_>, _>>().expect("collect")
    }

    /// The whole point of the rename migration: a database written before the
    /// channel was renamed opens with every post intact, the summarizer's
    /// rows re-attributed, and the full-text index answering again.
    #[test]
    fn pre_rename_posts_survive_the_move_to_overview_posts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sessions.db");
        seed_pre_rename_posts(
            &path,
            &[
                ("reporter", "landed the wake core"),
                ("reporter", "a distinctive digest"),
                ("operator", "an answer about s1"),
                ("user", "what is this"),
            ],
        );

        let ledger = SessionLedger::open_with_claude_root(
            &path,
            PathBuf::from("/tmp/tugcast-tests-no-trash"),
        )
        .expect("open migrates");

        let posts = ledger.list_overview_posts_tail(50).unwrap();
        assert_eq!(posts.len(), 4, "nothing is lost by the rename");
        assert_eq!(
            author_counts(&ledger),
            vec![
                ("observer".to_string(), 2),
                ("operator".to_string(), 1),
                ("user".to_string(), 1),
            ],
            "the summarizer's rows are re-attributed; the other two voices are untouched"
        );

        // The per-session read is the summarizer-only one, so it is also the
        // proof that the renamed author value is the one it now asks for.
        let mine = ledger.list_overview_posts_for_session("s1", 10).unwrap();
        assert_eq!(mine.len(), 2);
        assert!(mine.iter().all(|p| p.author == OverviewAuthor::Observer));

        // The FTS shadow was dropped, recreated against the renamed content
        // table, and rebuilt — a search that only the index can answer.
        let hits = ledger
            .search_overview_posts("distinctive", &OverviewSearchFilter::default(), 10)
            .expect("search");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].post.body, "a distinctive digest");
    }

    /// A second open finds no `gazette_posts` and returns at the guard, so the
    /// migration cannot run twice over its own output.
    #[test]
    fn the_rename_migration_is_a_no_op_on_a_database_it_already_moved() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sessions.db");
        seed_pre_rename_posts(&path, &[("reporter", "one"), ("user", "two")]);

        let first = SessionLedger::open_with_claude_root(
            &path,
            PathBuf::from("/tmp/tugcast-tests-no-trash"),
        )
        .expect("first open migrates");
        let before = author_counts(&first);
        drop(first);

        let second = SessionLedger::open_with_claude_root(
            &path,
            PathBuf::from("/tmp/tugcast-tests-no-trash"),
        )
        .expect("second open is a no-op");
        assert_eq!(author_counts(&second), before);
        assert_eq!(second.list_overview_posts_tail(50).unwrap().len(), 2);
    }

    /// A fresh database has no old table to find, and the CREATE batch is what
    /// gives it `overview_posts` — the migration must not object to that.
    #[test]
    fn a_fresh_database_skips_the_rename_migration_entirely() {
        let ledger = fresh();
        let post = overview_post(1_000, OverviewAuthor::Observer, "born renamed");
        ledger.record_overview_post(&post).expect("record");
        assert_eq!(author_counts(&ledger), vec![("observer".to_string(), 1)]);
    }

    // ── idempotent open ──────────────────────────────────────────────────────

    #[test]
    fn open_existing_file_is_idempotent() {
        let tmp = NamedTempFile::new().expect("temp file");
        let path = tmp.path().to_path_buf();
        // First open seeds the schema.
        let l1 = SessionLedger::open_with_claude_root(
            &path,
            PathBuf::from("/tmp/tugcast-tests-no-trash"),
        )
        .unwrap();
        l1.record_spawn("s1", WS_A, "/proj", "c1", millis(0), "s1", None)
            .unwrap();
        drop(l1);
        // Second open re-runs the idempotent DDL and finds the row intact.
        let l2 = SessionLedger::open_with_claude_root(
            &path,
            PathBuf::from("/tmp/tugcast-tests-no-trash"),
        )
        .unwrap();
        let r = l2.get("s1").unwrap().expect("row survives reopen");
        assert_eq!(r.session_id, "s1");
    }

    #[test]
    fn newer_changes_schema_locks_out_writes_without_mutation() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sessions.db");
        let changes_sibling = dir.path().join("sessions.db.changes");
        // A changes db stamped by a hypothetical future build, with a
        // future-shaped table this build knows nothing about.
        {
            let conn = Connection::open(&changes_sibling).unwrap();
            conn.execute_batch(
                "CREATE TABLE file_events (future_shape TEXT PRIMARY KEY);
                 INSERT INTO file_events VALUES ('precious');",
            )
            .unwrap();
            conn.pragma_update(None, "user_version", CHANGES_SCHEMA_VERSION + 1)
                .unwrap();
        }
        let ledger = SessionLedger::open_with_claude_root(
            &path,
            PathBuf::from("/tmp/tugcast-tests-no-trash"),
        )
        .unwrap();
        // Row writes to the shared tables are refused...
        let err = ledger
            .record_file_event(&FileEventRow {
                tug_session_id: "s1".into(),
                tool_use_id: "t1".into(),
                file_path: "a.rs".into(),
                tool_name: "Write".into(),
                op: "modified".into(),
                origin: "exact".into(),
                ambiguous: false,
                parent_tool_use_id: None,
                project_dir: "/proj".into(),
                at: 1,
            })
            .unwrap_err();
        assert!(matches!(err, LedgerError::InvalidState(_)), "{err:?}");
        // ...but shape-safe deletes are never gated ([LR5]): this one
        // fails on the future table's shape, not on the write lockout.
        let err = ledger
            .delete_changeset_draft("session", "s1", "/proj")
            .unwrap_err();
        assert!(matches!(err, LedgerError::Sqlite(_)), "{err:?}");
        // ...and the future schema was not reshaped or stamped down.
        drop(ledger);
        let conn = Connection::open(&changes_sibling).unwrap();
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            v,
            CHANGES_SCHEMA_VERSION + 1,
            "version must not be stamped down"
        );
        let body: String = conn
            .query_row("SELECT future_shape FROM file_events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(body, "precious", "future table left untouched");
    }

    /// A database stamped at the previous version migrates forward through
    /// its registered entry: the new child table appears, every existing row
    /// survives, and the stamp advances on the database and the sidecar
    /// together (the sidecar is what stops an older build rebuilding a newer
    /// schema after corruption).
    #[test]
    fn a_v1_changes_db_migrates_to_v2_keeping_its_rows() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sessions.db");
        let changes_sibling = dir.path().join("sessions.db.changes");
        {
            let conn = Connection::open(&changes_sibling).unwrap();
            conn.execute_batch(
                "CREATE TABLE file_events (
                    tug_session_id TEXT NOT NULL, tool_use_id TEXT NOT NULL,
                    file_path TEXT NOT NULL, tool_name TEXT NOT NULL,
                    op TEXT NOT NULL, origin TEXT NOT NULL,
                    ambiguous INTEGER NOT NULL DEFAULT 0,
                    parent_tool_use_id TEXT, project_dir TEXT NOT NULL,
                    at INTEGER NOT NULL,
                    PRIMARY KEY (tug_session_id, tool_use_id, file_path));
                 INSERT INTO file_events VALUES
                    ('s1','tu-1','a.rs','Write','write','exact',0,NULL,'/proj',1);",
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
        }
        std::fs::write(dir.path().join("sessions.db.changes.schema-version"), "1\n").unwrap();

        let ledger = SessionLedger::open_with_claude_root(
            &path,
            PathBuf::from("/tmp/tugcast-tests-no-trash"),
        )
        .unwrap();
        // The pre-existing row is still there and still readable.
        let rows = ledger.file_events_for_session("s1").unwrap();
        assert_eq!(rows.len(), 1);
        // …and the new table exists, so a spanned write lands.
        record_with_spans(
            &ledger,
            &sample_file_event("s1", "tu-2", "b.rs"),
            &[sample_span(0, "insert")],
        );
        assert_eq!(spans_of(&ledger, "s1").len(), 1);
        drop(ledger);

        let conn = Connection::open(&changes_sibling).unwrap();
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, CHANGES_SCHEMA_VERSION);
        assert_eq!(
            read_changes_schema_sidecar(&changes_sibling),
            Some(CHANGES_SCHEMA_VERSION),
            "the sidecar advances with the database"
        );
    }

    #[test]
    fn fresh_changes_schema_is_stamped_and_writable() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sessions.db");
        let ledger = SessionLedger::open_with_claude_root(
            &path,
            PathBuf::from("/tmp/tugcast-tests-no-trash"),
        )
        .unwrap();
        ledger
            .record_file_event(&FileEventRow {
                tug_session_id: "s1".into(),
                tool_use_id: "t1".into(),
                file_path: "a.rs".into(),
                tool_name: "Write".into(),
                op: "modified".into(),
                origin: "exact".into(),
                ambiguous: false,
                parent_tool_use_id: None,
                project_dir: "/proj".into(),
                at: 1,
            })
            .unwrap();
        drop(ledger);
        let conn = Connection::open(dir.path().join("sessions.db.changes")).unwrap();
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, CHANGES_SCHEMA_VERSION);
    }

    /// The single-writer contract end to end ([LR8]): two ledgers on one
    /// shared changes database, one real loopback endpoint between them.
    /// The instance that loses the claim forwards its writes to the owner,
    /// holds what it cannot deliver, and takes the claim over — draining
    /// what it held — once the owner is gone.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_non_owner_forwards_its_writes_and_takes_over_when_the_owner_exits() {
        let dir = tempfile::tempdir().expect("tempdir");
        let changes = dir.path().join("changes.db");
        let root = PathBuf::from("/tmp/tugcast-tests-no-trash");
        let event = |tool: &str, file: &str| FileEventRow {
            tug_session_id: "s1".into(),
            tool_use_id: tool.into(),
            file_path: file.into(),
            tool_name: "Write".into(),
            op: "modified".into(),
            origin: "exact".into(),
            ambiguous: false,
            parent_tool_use_id: None,
            project_dir: "/proj".into(),
            at: 1,
        };

        // The owner: claims the shared database and serves the endpoint a
        // non-owner forwards to.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let owner = Arc::new(
            SessionLedger::open_full(
                dir.path().join("owner.db"),
                Some(changes.clone()),
                root.clone(),
                port,
            )
            .expect("owner ledger"),
        );
        assert!(owner.owns_changes_writer());
        let app = axum::Router::new().route(
            "/api/changes-write",
            axum::routing::post({
                let ledger = Arc::clone(&owner);
                move |body: axum::body::Bytes| {
                    let ledger = Arc::clone(&ledger);
                    async move { crate::server::apply_changes_write(&ledger, &body) }
                }
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await });

        // The follower: same shared database, claim already taken.
        let follower = Arc::new(
            SessionLedger::open_full(
                dir.path().join("follower.db"),
                Some(changes.clone()),
                root,
                0,
            )
            .expect("follower ledger"),
        );
        assert!(
            !follower.owns_changes_writer(),
            "the second instance must not own the writer claim"
        );
        assert!(
            follower
                .changes_journal
                .lock()
                .expect("journal mutex")
                .is_none(),
            "a forwarder must not open the journal — opening rotates, and \
             rotation would rename the live owner's file out from under it"
        );

        // A forwarded write lands in the owner's database.
        let write = |ledger: Arc<SessionLedger>, row: FileEventRow| async move {
            tokio::task::spawn_blocking(move || ledger.record_file_event(&row))
                .await
                .expect("join")
        };
        write(Arc::clone(&follower), event("t1", "a.rs"))
            .await
            .expect("forwarded write");
        assert_eq!(
            owner.file_events_for_session("s1").unwrap().len(),
            1,
            "the owner applied the forwarded row"
        );
        assert_eq!(
            follower.file_events_for_session("s1").unwrap().len(),
            1,
            "the follower reads the shared database through its read-only attach"
        );

        // The follower's read-only attach must refuse a direct write, so a
        // path that ever escaped the forwarding route fails loudly.
        {
            let conn = follower.db.lock().expect("ledger mutex");
            assert!(
                conn.execute("DELETE FROM changes.file_events", []).is_err(),
                "a non-owner must not be able to write the shared database"
            );
        }

        // Owner unreachable but still holding the claim: the write is held.
        server.abort();
        let _ = server.await;
        write(Arc::clone(&follower), event("t2", "b.rs"))
            .await
            .expect("held write");
        assert!(!follower.owns_changes_writer(), "the claim is still held");
        assert_eq!(
            owner.file_events_for_session("s1").unwrap().len(),
            1,
            "the undeliverable row did not land"
        );

        // Owner gone: the next write takes the claim over and drains what
        // the follower was holding.
        drop(owner);
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        write(Arc::clone(&follower), event("t3", "c.rs"))
            .await
            .expect("write after takeover");
        assert!(
            follower.owns_changes_writer(),
            "the survivor took the writer claim"
        );
        let files: Vec<String> = follower
            .file_events_for_session("s1")
            .unwrap()
            .into_iter()
            .map(|r| r.file_path)
            .collect();
        assert_eq!(
            files,
            vec!["a.rs".to_string(), "b.rs".to_string(), "c.rs".to_string()],
            "nothing was lost across the takeover"
        );
        // The new owner journals what it drained and what it wrote: the
        // durable record survives the ownership change intact.
        let journaled: Vec<String> = crate::changes_journal::ChangesJournal::read_records(
            &crate::changes_journal::journal_path_for(&changes),
        )
        .into_iter()
        .filter_map(|r| match r {
            crate::changes_journal::Record::FileEvent { row, .. } => Some(row.file_path),
            _ => None,
        })
        .collect();
        assert_eq!(
            journaled,
            vec!["a.rs".to_string(), "b.rs".to_string(), "c.rs".to_string()],
            "owner-side and post-takeover appends form one continuous journal"
        );
    }

    /// The downgrade guard ([D112]): an older build must never
    /// quarantine-rebuild a corrupt changes.db whose sidecar records a
    /// newer schema — that would stamp the old schema over the
    /// machine-global truth. The file stays in place for a newer build
    /// to rebuild; this build opens degraded with shared writes refused.
    #[test]
    fn a_newer_schema_changes_db_is_never_rebuilt_by_an_older_build() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sessions.db");
        let changes = dir.path().join("sessions.db.changes");
        let root = PathBuf::from("/tmp/tugcast-tests-no-trash");
        drop(SessionLedger::open_with_claude_root(&path, root.clone()).unwrap());

        // A "newer build" stamped the sidecar; then the db went corrupt.
        std::fs::write(
            changes_schema_sidecar_path(&changes),
            format!("{}\n", CHANGES_SCHEMA_VERSION + 1),
        )
        .unwrap();
        std::fs::write(&changes, b"garbage, not a sqlite database").unwrap();

        let ledger = SessionLedger::open_with_claude_root(&path, root).expect("degraded open");
        assert!(
            changes.exists(),
            "the corrupt newer-schema database must stay in place"
        );
        assert!(
            std::fs::read_dir(dir.path())
                .unwrap()
                .filter_map(|e| e.ok())
                .all(|e| !e.file_name().to_string_lossy().contains("corrupt-")),
            "no quarantine sibling may be created"
        );
        let refused = ledger.record_file_event(&FileEventRow {
            tug_session_id: "s1".into(),
            tool_use_id: "t1".into(),
            file_path: "a.rs".into(),
            tool_name: "Write".into(),
            op: "modified".into(),
            origin: "exact".into(),
            ambiguous: false,
            parent_tool_use_id: None,
            project_dir: "/proj".into(),
            at: 1,
        });
        assert!(
            matches!(refused, Err(LedgerError::InvalidState(_))),
            "shared-table writes must be refused, got {refused:?}"
        );
    }

    /// A forwarded record arriving at an instance that is itself
    /// forwarding (stale routing) is refused, never forwarded onward —
    /// the structural guard against a forwarding loop.
    #[test]
    fn a_forwarding_instance_refuses_forwarded_records() {
        let dir = tempfile::tempdir().expect("tempdir");
        let changes = dir.path().join("changes.db");
        let root = PathBuf::from("/tmp/tugcast-tests-no-trash");
        let owner = SessionLedger::open_full(
            dir.path().join("owner.db"),
            Some(changes.clone()),
            root.clone(),
            0,
        )
        .expect("owner ledger");
        let follower =
            SessionLedger::open_full(dir.path().join("follower.db"), Some(changes), root, 0)
                .expect("follower ledger");
        assert!(!follower.owns_changes_writer());
        let result =
            follower.apply_forwarded_change(crate::changes_journal::Record::DeleteSession {
                session: "s1".into(),
            });
        assert!(
            matches!(result, Err(LedgerError::InvalidState(_))),
            "a non-owner must refuse, not relay: {result:?}"
        );
        drop(owner);
    }

    /// Regression: an eviction on a forwarding ledger whose owner has
    /// died takes the writer claim over during the post-commit settle.
    /// The settle routes through `write_change` → takeover → `db.lock()`,
    /// so the eviction path must have released the ledger mutex before
    /// settling — holding it across the settle self-deadlocked this exact
    /// scenario (lock order: `changes_access` strictly before `db`).
    #[test]
    fn eviction_on_a_forwarding_ledger_takes_over_without_self_deadlock() {
        let dir = tempfile::tempdir().expect("tempdir");
        let changes = dir.path().join("changes.db");
        let root = PathBuf::from("/tmp/tugcast-tests-no-trash");
        let owner = SessionLedger::open_full(
            dir.path().join("owner.db"),
            Some(changes.clone()),
            root.clone(),
            0,
        )
        .expect("owner ledger");
        assert!(owner.owns_changes_writer());
        let follower =
            SessionLedger::open_full(dir.path().join("follower.db"), Some(changes), root, 0)
                .expect("follower ledger");
        assert!(!follower.owns_changes_writer());
        drop(owner);

        let now = millis(0);
        let max_age_ms = DEV_LEDGER_MAX_AGE_DAYS * 86_400_000;
        seed_live(&follower, "old", WS_A, "c", millis(91));
        follower.mark_closed("old").unwrap();

        let swept = follower.sweep_expired(max_age_ms, now).unwrap();
        assert_eq!(swept, vec!["old".to_owned()]);
        assert!(
            follower.owns_changes_writer(),
            "the settle took the abandoned claim over"
        );
    }

    #[test]
    fn journal_rebuilds_changes_after_total_destruction() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sessions.db");
        let root = PathBuf::from("/tmp/tugcast-tests-no-trash");
        let event = |tool: &str, file: &str, at: i64| FileEventRow {
            tug_session_id: "s1".into(),
            tool_use_id: tool.into(),
            file_path: file.into(),
            tool_name: "Write".into(),
            op: "modified".into(),
            origin: "exact".into(),
            ambiguous: false,
            parent_tool_use_id: None,
            project_dir: "/proj".into(),
            at,
        };
        {
            let l = SessionLedger::open_with_claude_root(&path, root.clone()).unwrap();
            l.record_file_event(&event("t1", "a.rs", 1)).unwrap();
            l.record_file_event(&event("t2", "b.rs", 2)).unwrap();
            // A replayed duplicate must not double-journal.
            l.record_file_event(&event("t1", "a.rs", 1)).unwrap();
            l.upsert_changeset_draft(&ChangesetDraftRow {
                owner_kind: "session".into(),
                owner_id: "s1".into(),
                project_dir: "/proj".into(),
                fingerprint: "fp".into(),
                message: "draft msg".into(),
                updated_at: 9,
                edited: false,
                selection: None,
            })
            .unwrap();
        }
        // Total destruction: the changes sibling becomes garbage — nothing
        // for salvage to recover; only the journal can restore.
        let changes_sibling = dir.path().join("sessions.db.changes");
        std::fs::write(&changes_sibling, b"utterly destroyed").unwrap();

        let l = SessionLedger::open_with_claude_root(&path, root).unwrap();
        let rows = l.file_events_for_session("s1").unwrap();
        assert_eq!(rows.len(), 2, "journal replay restored both events");
        assert_eq!(rows[0].file_path, "a.rs");
        assert_eq!(rows[1].file_path, "b.rs");
        let draft = l
            .changeset_draft("session", "s1", "/proj")
            .unwrap()
            .expect("draft restored");
        assert_eq!(draft.message, "draft msg");
    }

    #[test]
    fn corrupt_db_files_are_quarantined_at_open() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sessions.db");
        let l1 = SessionLedger::open_with_claude_root(
            &path,
            PathBuf::from("/tmp/tugcast-tests-no-trash"),
        )
        .unwrap();
        l1.record_spawn("s1", WS_A, "/proj", "c1", millis(0), "s1", None)
            .unwrap();
        drop(l1);
        // Trash both the main db and the attached changes sibling.
        std::fs::write(&path, b"garbage, not a database").unwrap();
        let changes_sibling = dir.path().join("sessions.db.changes");
        std::fs::write(&changes_sibling, b"also garbage").unwrap();
        // Reopen: both files are quarantined and the ledger comes up fresh
        // and writable instead of erroring or compounding damage.
        let l2 = SessionLedger::open_with_claude_root(
            &path,
            PathBuf::from("/tmp/tugcast-tests-no-trash"),
        )
        .unwrap();
        l2.record_spawn("s2", WS_A, "/proj", "c2", millis(1), "s2", None)
            .unwrap();
        assert!(l2.get("s2").unwrap().is_some());
        let quarantined: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".corrupt-"))
            .collect();
        assert!(
            quarantined
                .iter()
                .any(|n| n.starts_with("sessions.db.corrupt-")),
            "main db quarantined: {quarantined:?}"
        );
        assert!(
            quarantined
                .iter()
                .any(|n| n.starts_with("sessions.db.changes.corrupt-")),
            "changes sibling quarantined: {quarantined:?}"
        );
    }

    #[test]
    fn distinct_workspaces_returns_unique_keys_sorted() {
        let l = fresh();
        seed_live(&l, "a1", WS_A, "c", millis(0));
        seed_live(&l, "a2", WS_A, "c", millis(1));
        seed_live(&l, "b1", WS_B, "c", millis(0));

        let ws = l.distinct_workspaces().unwrap();
        assert_eq!(ws, vec![WS_A.to_owned(), WS_B.to_owned()]);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    #[test]
    fn truncate_user_prompt_truncates_at_char_count_not_bytes() {
        // A multi-byte char repeated past the limit must not be sliced
        // mid-codepoint (`String::truncate` would panic; chars().take is
        // safe).
        let s: String = "🌊".repeat(USER_PROMPT_MAX_CHARS + 5);
        let out = truncate_user_prompt(&s);
        assert_eq!(out.chars().count(), USER_PROMPT_MAX_CHARS);
    }

    #[test]
    fn truncate_user_prompt_returns_short_inputs_unchanged() {
        let s = "Hello, world";
        assert_eq!(truncate_user_prompt(s), s);
    }

    #[test]
    fn encode_claude_project_name_replaces_every_non_alphanumeric() {
        assert_eq!(
            encode_claude_project_name("/Users/ken/src/foo.bar"),
            "-Users-ken-src-foo-bar"
        );
        assert_eq!(
            encode_claude_project_name("/u/src/tugtool"),
            "-u-src-tugtool"
        );
        // Underscores (and anything else outside [A-Za-z0-9-]) collapse
        // too — claude's on-disk naming for a dash worktree, verified on
        // 2.1.198.
        assert_eq!(
            encode_claude_project_name("/repo/.tugtree/tugdash__subagent-improvements"),
            "-repo--tugtree-tugdash--subagent-improvements"
        );
        assert_eq!(encode_claude_project_name("/tmp/a b"), "-tmp-a-b");
    }

    // ── trash mechanics (move + sweep) ───────────────────────────────────────
    //
    // Trash tests use a tempdir as the claude-projects-root so the move
    // operations don't touch `~/.claude/projects/` on the dev machine.

    fn fresh_ledger_with_root(root: &Path) -> SessionLedger {
        // Use an in-memory db (in-memory changes attach) but explicit claude root.
        let conn = Connection::open_in_memory().expect("open_in_memory");
        SessionLedger::attach_changes(&conn, None, false).expect("attach");
        let changes_write_ok = SessionLedger::configure(&conn, true).expect("configure");
        SessionLedger {
            db: Mutex::new(conn),
            claude_projects_root: root.to_path_buf(),
            sessions_changed: OnceLock::new(),
            changes_write_ok,
            changes_journal: Mutex::new(None),
            changes_access: Mutex::new(crate::changes_writer::ChangesAccess::Unclaimed),
            changes_db_path: None,
            writer_identity: crate::changes_writer::local_identity(0),
        }
    }

    fn write_jsonl(root: &Path, project_dir: &str, session_id: &str) -> PathBuf {
        let encoded = encode_claude_project_name(project_dir);
        let project_root = root.join(encoded);
        std::fs::create_dir_all(&project_root).expect("mkdir project root");
        let path = project_root.join(format!("{session_id}.jsonl"));
        std::fs::write(&path, b"{\"type\":\"placeholder\"}\n").expect("write jsonl");
        path
    }

    #[test]
    fn trash_moves_jsonl_to_trash() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let l = fresh_ledger_with_root(tmp.path());
        write_jsonl(tmp.path(), "/proj/x", "sess-doomed");

        l.record_spawn(
            "sess-doomed",
            "ws-1",
            "/proj/x",
            "c1",
            millis(0),
            "sess-doomed",
            None,
        )
        .unwrap();
        l.mark_closed("sess-doomed").unwrap();

        let outcome = l.trash("sess-doomed").unwrap();
        let dest = outcome.jsonl_moved_to.expect("moved to trash");
        assert!(dest.exists(), "trashed jsonl should exist at {dest:?}");
        // Source must be gone.
        let original = tmp
            .path()
            .join(encode_claude_project_name("/proj/x"))
            .join("sess-doomed.jsonl");
        assert!(!original.exists());
        // Trash structure: `<encoded>/.tug-trash/<deletedAt>/<sessionId>.jsonl`.
        assert!(dest.to_string_lossy().contains(".tug-trash"));
    }

    #[test]
    fn trash_succeeds_even_when_jsonl_is_missing() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let l = fresh_ledger_with_root(tmp.path());
        // No JSONL on disk — only the ledger row.
        l.record_spawn("ghost", "ws-1", "/proj/x", "c1", millis(0), "ghost", None)
            .unwrap();
        l.mark_closed("ghost").unwrap();

        let outcome = l.trash("ghost").unwrap();
        assert!(outcome.jsonl_moved_to.is_none());
        // Row deletion still committed.
        assert!(l.get("ghost").unwrap().is_none());
    }

    #[test]
    fn sweep_trash_removes_subdirs_older_than_cutoff() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let l = fresh_ledger_with_root(tmp.path());

        let trash_root = tmp
            .path()
            .join(encode_claude_project_name("/proj/x"))
            .join(".tug-trash");
        // Create three subdirs: 8 days ago (sweep), 6 days ago (keep),
        // 30 days ago (sweep).
        let now = millis(0);
        let day = 86_400_000_i64;
        let stale_old = now - 30 * day;
        let stale_mid = now - 8 * day;
        let fresh = now - 6 * day;
        for stamp in [stale_old, stale_mid, fresh] {
            let dir = trash_root.join(stamp.to_string());
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("placeholder.jsonl"), b"x").unwrap();
        }

        let removed = l.sweep_trash(7 * day, now);
        assert_eq!(removed, 2, "expected 8d and 30d dirs swept, 6d kept");
        assert!(!trash_root.join(stale_old.to_string()).exists());
        assert!(!trash_root.join(stale_mid.to_string()).exists());
        assert!(trash_root.join(fresh.to_string()).exists());
    }

    #[test]
    fn sweep_trash_no_op_when_root_missing() {
        // Root path does not exist on disk at all.
        let tmp = tempfile::tempdir().expect("tempdir");
        let nonexistent_root = tmp.path().join("does-not-exist");
        let l = fresh_ledger_with_root(&nonexistent_root);
        let removed = l.sweep_trash(7 * 86_400_000, millis(0));
        assert_eq!(removed, 0);
    }

    #[test]
    fn sweep_trash_no_op_when_no_project_dirs_have_trash() {
        // Project dirs exist under the root, but none of them has a
        // `.tug-trash/` subdir. Sweep is a no-op.
        let tmp = tempfile::tempdir().expect("tempdir");
        let l = fresh_ledger_with_root(tmp.path());
        std::fs::create_dir_all(tmp.path().join("-proj-clean")).unwrap();
        std::fs::create_dir_all(tmp.path().join("-proj-also-clean")).unwrap();
        let removed = l.sweep_trash(7 * 86_400_000, millis(0));
        assert_eq!(removed, 0);
    }

    /// Regression: A4 from the post-ship audit. Trash subdirs must be
    /// swept even when the ledger has no rows referencing the project_dir
    /// — the very path that creates the orphan (Trash every row for a
    /// project) leaves no ledger trace pointing back at the trash dir.
    #[test]
    fn sweep_trash_recovers_orphaned_project_dirs() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let l = fresh_ledger_with_root(tmp.path());

        // Build a trash subdir under a project_dir that the ledger has
        // NO rows for — simulating the post-Trash-everything state.
        let orphan_root = tmp
            .path()
            .join(encode_claude_project_name("/proj/orphan"))
            .join(".tug-trash");
        let now = millis(0);
        let day = 86_400_000_i64;
        let stale = now - 30 * day;
        let stale_dir = orphan_root.join(stale.to_string());
        std::fs::create_dir_all(&stale_dir).unwrap();
        std::fs::write(stale_dir.join("ghost.jsonl"), b"orphan").unwrap();

        // Sanity: the ledger knows nothing about /proj/orphan.
        let workspaces = l.distinct_workspaces().unwrap();
        assert!(!workspaces.contains(&"/proj/orphan".to_owned()));

        // Sweep finds and removes the orphaned dir anyway.
        let removed = l.sweep_trash(7 * day, now);
        assert_eq!(removed, 1);
        assert!(!stale_dir.exists());
    }

    // ── turns table ──────────────────────────────────────────────────────────
    //
    // Schema bootstrap, in-place v1→v2 migration, idempotent re-open,
    // CRUD round-trips per state, ordinal race under concurrent ledger
    // handles on the same file, and a failure-first proof that the
    // race protection is meaningful.

    fn has_table(conn: &Connection, name: &str) -> bool {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = ?1",
                params![name],
                |row| row.get(0),
            )
            .unwrap();
        count == 1
    }

    #[test]
    fn schema_bootstrap_creates_only_two_tables_and_no_migrations_table() {
        // Pin the no-migration policy ([DM08] — mid-turn-replay [Step 5.2](#step-5-2)):
        // bootstrap creates exactly `sessions` and `turns`, no `migrations` table.
        let l = fresh();
        let conn = l.db.lock().expect("ledger mutex");
        assert!(has_table(&conn, "sessions"));
        assert!(has_table(&conn, "turns"));
        assert!(!has_table(&conn, "migrations"));
    }

    #[test]
    fn turns_table_has_narrowed_journal_columns() {
        // Pin the narrowed schema. Five columns; no `claude_message_id`,
        // `partial_text`, `state`, `completed_at`, `ordinal`.
        let l = fresh();
        let conn = l.db.lock().expect("ledger mutex");
        let mut stmt = conn
            .prepare("SELECT name FROM pragma_table_info('turns') ORDER BY cid")
            .unwrap();
        let columns: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            columns,
            vec![
                "journal_id".to_string(),
                "session_id".to_string(),
                "user_text".to_string(),
                "user_attachments".to_string(),
                "created_at".to_string(),
            ],
        );
    }

    #[test]
    fn insert_pending_turn_round_trips_via_list_pending_turns_for_session() {
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        l.insert_pending_turn("s1", "j1", "hello", &[], millis(0))
            .unwrap();
        let rows = l.list_pending_turns_for_session("s1").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].journal_id, "j1");
        assert_eq!(rows[0].session_id, "s1");
        assert_eq!(rows[0].user_text, "hello");
        assert!(rows[0].user_attachments.is_empty());
    }

    // ── wheel_prompts: what the wheel put on the wire ────────────────────────
    //
    // Claude's JSONL records a prompt the wheel sent exactly as it records one
    // the user typed, so authorship has to be kept here or it is lost at the
    // next reload. These pin the two things the record must get right: it
    // survives, and it belongs to the LINE rather than to whichever session id
    // happened to be live when the wheel spoke.

    #[test]
    fn record_wheel_prompt_round_trips_for_the_line() {
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        assert!(
            l.record_wheel_prompt("s1", "w1", "/compact", millis(1))
                .unwrap()
        );
        assert_eq!(
            l.list_wheel_prompts_for_line("s1").unwrap(),
            vec!["/compact"]
        );
    }

    #[test]
    fn wheel_prompts_are_read_across_a_rotation() {
        // An arc rotates its card onto a fresh session id mid-run. Both
        // prompts are the same line's work, and asking from either segment
        // answers with both, oldest first — which is what lets a replay of the
        // whole lineage attribute every one of them.
        let l = fresh();
        l.record_spawn("s1", "ws", "/proj", "card-1", millis(0), "line-1", None)
            .unwrap();
        l.record_spawn("s2", "ws", "/proj", "card-1", millis(0), "line-1", None)
            .unwrap();
        // `millis` counts days ago, so the opener's stamp is the larger one.
        l.record_wheel_prompt("s1", "w1", "the opener", millis(3))
            .unwrap();
        l.record_wheel_prompt("s2", "w2", "/compact", millis(1))
            .unwrap();
        for asked_from in ["s1", "s2"] {
            assert_eq!(
                l.list_wheel_prompts_for_line(asked_from).unwrap(),
                vec!["the opener", "/compact"],
                "asked from {asked_from}",
            );
        }
    }

    #[test]
    fn another_lines_wheel_prompts_are_not_this_lines() {
        let l = fresh();
        l.record_spawn("s1", "ws", "/proj", "card-1", millis(0), "line-1", None)
            .unwrap();
        l.record_spawn("s2", "ws", "/proj", "card-2", millis(0), "line-2", None)
            .unwrap();
        l.record_wheel_prompt("s1", "w1", "mine", millis(1))
            .unwrap();
        l.record_wheel_prompt("s2", "w2", "theirs", millis(1))
            .unwrap();
        assert_eq!(l.list_wheel_prompts_for_line("s1").unwrap(), vec!["mine"]);
        assert_eq!(l.list_wheel_prompts_for_line("s2").unwrap(), vec!["theirs"]);
    }

    #[test]
    fn record_wheel_prompt_says_so_when_the_session_is_unknown() {
        // No row, no line to file against. The writer answers `false` rather
        // than reporting a record that does not exist — the caller logs it,
        // because the cost is a name on a row after the next reload.
        let l = fresh();
        assert!(
            !l.record_wheel_prompt("nobody", "w1", "hi", millis(0))
                .unwrap()
        );
        assert!(l.list_wheel_prompts_for_line("nobody").unwrap().is_empty());
    }

    #[test]
    fn a_wheel_prompt_is_not_deleted_when_its_turn_is_acknowledged() {
        // The `turns` journal is pending-only: the merger pops a row the
        // moment claude acknowledges. The wheel's record is not that — it is
        // durable for the life of the line, because a reload can happen at any
        // point after the acknowledgement.
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        l.insert_pending_turn("s1", "j1", "/compact", &[], millis(0))
            .unwrap();
        l.record_wheel_prompt("s1", "w1", "/compact", millis(0))
            .unwrap();
        l.delete_oldest_pending_for_session("s1").unwrap();
        assert!(l.list_pending_turns_for_session("s1").unwrap().is_empty());
        assert_eq!(
            l.list_wheel_prompts_for_line("s1").unwrap(),
            vec!["/compact"]
        );
    }

    #[test]
    fn insert_pending_turn_persists_user_attachments_round_trip() {
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        let attachments = vec![
            serde_json::json!({"filename": "a.txt", "content": "hi", "media_type": "text/plain"}),
        ];
        l.insert_pending_turn("s1", "j1", "with attachment", &attachments, millis(0))
            .unwrap();
        let rows = l.list_pending_turns_for_session("s1").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].user_attachments.len(), 1);
        assert_eq!(rows[0].user_attachments[0]["filename"], "a.txt");
    }

    #[test]
    fn list_pending_turns_for_session_orders_by_created_at_asc() {
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        l.insert_pending_turn("s1", "j_oldest", "first", &[], 1_000)
            .unwrap();
        l.insert_pending_turn("s1", "j_middle", "second", &[], 2_000)
            .unwrap();
        l.insert_pending_turn("s1", "j_newest", "third", &[], 3_000)
            .unwrap();
        let rows = l.list_pending_turns_for_session("s1").unwrap();
        let ids: Vec<&str> = rows.iter().map(|r| r.journal_id.as_str()).collect();
        assert_eq!(ids, vec!["j_oldest", "j_middle", "j_newest"]);
    }

    #[test]
    fn list_pending_turns_for_session_filters_by_session() {
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        seed_live(&l, "s2", "ws", "card-2", millis(0));
        l.insert_pending_turn("s1", "j_s1", "for s1", &[], millis(0))
            .unwrap();
        l.insert_pending_turn("s2", "j_s2", "for s2", &[], millis(0))
            .unwrap();
        let s1_rows = l.list_pending_turns_for_session("s1").unwrap();
        let s2_rows = l.list_pending_turns_for_session("s2").unwrap();
        assert_eq!(s1_rows.len(), 1);
        assert_eq!(s1_rows[0].user_text, "for s1");
        assert_eq!(s2_rows.len(), 1);
        assert_eq!(s2_rows[0].user_text, "for s2");
    }

    #[test]
    fn delete_oldest_pending_for_session_fifo_order() {
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        l.insert_pending_turn("s1", "j_oldest", "first", &[], 1_000)
            .unwrap();
        l.insert_pending_turn("s1", "j_middle", "second", &[], 2_000)
            .unwrap();
        l.insert_pending_turn("s1", "j_newest", "third", &[], 3_000)
            .unwrap();

        let popped = l.delete_oldest_pending_for_session("s1").unwrap();
        assert_eq!(
            popped.as_ref().map(|r| r.journal_id.as_str()),
            Some("j_oldest")
        );
        assert_eq!(popped.as_ref().map(|r| r.user_text.as_str()), Some("first"));

        let popped = l.delete_oldest_pending_for_session("s1").unwrap();
        assert_eq!(
            popped.as_ref().map(|r| r.journal_id.as_str()),
            Some("j_middle")
        );

        let popped = l.delete_oldest_pending_for_session("s1").unwrap();
        assert_eq!(
            popped.as_ref().map(|r| r.journal_id.as_str()),
            Some("j_newest")
        );

        // Fourth pop returns None — empty journal.
        assert!(l.delete_oldest_pending_for_session("s1").unwrap().is_none(),);
    }

    #[test]
    fn delete_oldest_pending_for_session_returns_none_on_empty_journal() {
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        // Session exists but no pending rows.
        assert!(l.delete_oldest_pending_for_session("s1").unwrap().is_none(),);
    }

    #[test]
    fn delete_oldest_pending_for_session_returns_none_on_unknown_session() {
        let l = fresh();
        assert!(
            l.delete_oldest_pending_for_session("never-existed")
                .unwrap()
                .is_none(),
        );
    }

    #[test]
    fn delete_oldest_pending_for_session_does_not_touch_other_sessions() {
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        seed_live(&l, "s2", "ws", "card-2", millis(0));
        l.insert_pending_turn("s1", "j_s1", "for s1", &[], 1_000)
            .unwrap();
        l.insert_pending_turn("s2", "j_s2", "for s2", &[], 1_000)
            .unwrap();

        l.delete_oldest_pending_for_session("s1").unwrap();

        let s2_rows = l.list_pending_turns_for_session("s2").unwrap();
        assert_eq!(s2_rows.len(), 1, "s2's pending row must be untouched");
    }

    #[test]
    fn cascade_delete_removes_journal_when_session_deleted() {
        // Pin the `turns_cascade_delete_on_session` trigger: trashing
        // a session also removes its journal rows.
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        l.mark_closed("s1").unwrap();
        l.insert_pending_turn("s1", "j1", "to be cascaded", &[], millis(0))
            .unwrap();
        assert_eq!(l.list_pending_turns_for_session("s1").unwrap().len(), 1,);

        l.trash("s1").unwrap();

        assert_eq!(
            l.list_pending_turns_for_session("s1").unwrap().len(),
            0,
            "cascade trigger must purge journal rows when the parent session row is deleted",
        );
    }

    // ---- turn_telemetry table ------------------------------------------

    fn sample_telemetry(session_id: &str, msg_id: &str, ended_at: i64) -> TurnTelemetryRow {
        TurnTelemetryRow {
            session_id: session_id.to_owned(),
            msg_id: msg_id.to_owned(),
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 20,
            total_cost_usd: 0.0123,
            wall_clock_ms: 4_000,
            awaiting_approval_ms: 200,
            transport_downtime_ms: 100,
            active_ms: 3_700,
            ttft_ms: Some(150),
            ttftc_ms: Some(300),
            reconnect_count: 0,
            max_stream_gap_ms: 90,
            ended_at,
            session_init_tokens: Some(18_575),
        }
    }

    #[test]
    fn record_turn_telemetry_round_trip_preserves_every_field() {
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        let row = sample_telemetry("s1", "msg-A", 1_000);
        l.record_turn_telemetry(&row).unwrap();
        let read = l.list_turn_telemetry("s1").unwrap();
        assert_eq!(read.len(), 1);
        assert_eq!(read[0], row);
    }

    #[test]
    fn record_turn_telemetry_persists_null_session_init_tokens() {
        // `window(0)` is nullable — a session that never observed a
        // first telemetry iteration records `None`, round-tripped as
        // SQL NULL.
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        let mut row = sample_telemetry("s1", "msg-A", 1_000);
        row.session_init_tokens = None;
        l.record_turn_telemetry(&row).unwrap();
        let read = l.list_turn_telemetry("s1").unwrap();
        assert_eq!(read[0].session_init_tokens, None);
    }

    #[test]
    fn opening_a_db_with_a_drifted_turn_telemetry_schema_rebuilds_it() {
        // Reproduces the silent-telemetry-loss failure: a DB created
        // before a `turn_telemetry` column change keeps its stale
        // shape, and every post-change `INSERT` fails. The bootstrap
        // guard must DROP the drifted table so the `CREATE TABLE`
        // rebuilds it — without it, this is invisible data loss.
        let tmp = NamedTempFile::new().expect("temp file");
        let path = tmp.path().to_path_buf();
        // A `turn_telemetry` of the prior 16-column shape (no
        // `session_init_tokens`), carrying a row.
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE turn_telemetry (
                    session_id                  TEXT NOT NULL,
                    msg_id                      TEXT NOT NULL,
                    input_tokens                INTEGER NOT NULL DEFAULT 0,
                    output_tokens               INTEGER NOT NULL DEFAULT 0,
                    cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
                    cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
                    total_cost_usd              REAL    NOT NULL DEFAULT 0,
                    wall_clock_ms               INTEGER NOT NULL DEFAULT 0,
                    awaiting_approval_ms        INTEGER NOT NULL DEFAULT 0,
                    transport_downtime_ms       INTEGER NOT NULL DEFAULT 0,
                    active_ms                   INTEGER NOT NULL DEFAULT 0,
                    ttft_ms                     INTEGER,
                    ttftc_ms                    INTEGER,
                    reconnect_count             INTEGER NOT NULL DEFAULT 0,
                    max_stream_gap_ms           INTEGER NOT NULL DEFAULT 0,
                    ended_at                    INTEGER NOT NULL,
                    PRIMARY KEY (session_id, msg_id)
                );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO turn_telemetry (session_id, msg_id, ended_at)
                 VALUES ('stale', 'm', 1)",
                [],
            )
            .unwrap();
        }
        // Open via SessionLedger — bootstrap's guard sees the drift
        // and rebuilds the table.
        let l = SessionLedger::open_with_claude_root(
            &path,
            PathBuf::from("/tmp/tugcast-tests-no-trash"),
        )
        .unwrap();
        // A write that lists `session_init_tokens` now succeeds — it
        // would have failed against the stale 16-column shape.
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        let row = sample_telemetry("s1", "msg-A", 1_000);
        l.record_turn_telemetry(&row).unwrap();
        assert_eq!(l.list_turn_telemetry("s1").unwrap(), vec![row]);
        // The rebuild dropped the stale row — recreate, not migrate.
        assert_eq!(l.list_turn_telemetry("stale").unwrap().len(), 0);
    }

    #[test]
    fn bootstrap_leaves_a_matching_turn_telemetry_untouched() {
        // The guard is a no-op on a current-shape DB: reopening keeps
        // the rows. (Drift-only — never a gratuitous rebuild.)
        let tmp = NamedTempFile::new().expect("temp file");
        let path = tmp.path().to_path_buf();
        {
            let l = SessionLedger::open_with_claude_root(
                &path,
                PathBuf::from("/tmp/tugcast-tests-no-trash"),
            )
            .unwrap();
            seed_live(&l, "s1", "ws", "card-1", millis(0));
            l.record_turn_telemetry(&sample_telemetry("s1", "msg-A", 1_000))
                .unwrap();
        }
        let l = SessionLedger::open_with_claude_root(
            &path,
            PathBuf::from("/tmp/tugcast-tests-no-trash"),
        )
        .unwrap();
        assert_eq!(l.list_turn_telemetry("s1").unwrap().len(), 1);
    }

    #[test]
    fn record_turn_telemetry_persists_nullable_ttft_fields_as_null() {
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        let mut row = sample_telemetry("s1", "msg-A", 1_000);
        row.ttft_ms = None;
        row.ttftc_ms = None;
        l.record_turn_telemetry(&row).unwrap();
        let read = l.list_turn_telemetry("s1").unwrap();
        assert_eq!(read[0].ttft_ms, None);
        assert_eq!(read[0].ttftc_ms, None);
    }

    #[test]
    fn record_turn_telemetry_idempotent_on_session_msg_pk() {
        // A repeat write for the same `(session_id, msg_id)` overwrites
        // — INSERT OR REPLACE — instead of erroring on the PK
        // constraint. This is what defends the supervisor's inbound
        // handler against a reconnecting client that re-emits the
        // same `record_turn_telemetry` after recovery.
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        let row_v1 = sample_telemetry("s1", "msg-A", 1_000);
        l.record_turn_telemetry(&row_v1).unwrap();
        let mut row_v2 = row_v1.clone();
        row_v2.total_cost_usd = 9.99;
        l.record_turn_telemetry(&row_v2).unwrap();
        let read = l.list_turn_telemetry("s1").unwrap();
        assert_eq!(read.len(), 1, "INSERT OR REPLACE keeps one row per PK");
        assert_eq!(read[0].total_cost_usd, 9.99);
    }

    #[test]
    fn list_turn_telemetry_orders_by_ended_at_ascending() {
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        l.record_turn_telemetry(&sample_telemetry("s1", "msg-newest", 3_000))
            .unwrap();
        l.record_turn_telemetry(&sample_telemetry("s1", "msg-middle", 2_000))
            .unwrap();
        l.record_turn_telemetry(&sample_telemetry("s1", "msg-oldest", 1_000))
            .unwrap();
        let read = l.list_turn_telemetry("s1").unwrap();
        let ids: Vec<&str> = read.iter().map(|r| r.msg_id.as_str()).collect();
        assert_eq!(ids, vec!["msg-oldest", "msg-middle", "msg-newest"]);
    }

    #[test]
    fn list_turn_telemetry_filters_by_session() {
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        seed_live(&l, "s2", "ws", "card-2", millis(0));
        l.record_turn_telemetry(&sample_telemetry("s1", "msg-1", 1_000))
            .unwrap();
        l.record_turn_telemetry(&sample_telemetry("s2", "msg-1", 1_000))
            .unwrap();
        assert_eq!(l.list_turn_telemetry("s1").unwrap().len(), 1);
        assert_eq!(l.list_turn_telemetry("s2").unwrap().len(), 1);
    }

    #[test]
    fn list_turn_telemetry_empty_for_unknown_session() {
        let l = fresh();
        assert_eq!(l.list_turn_telemetry("never-existed").unwrap().len(), 0);
    }

    #[test]
    fn cascade_delete_removes_turn_telemetry_when_session_deleted() {
        // Pin the `turn_telemetry_cascade_delete_on_session` trigger:
        // trashing a session also removes its telemetry rows. The
        // user-visible "trash cascades" contract extends to telemetry.
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        l.mark_closed("s1").unwrap();
        l.record_turn_telemetry(&sample_telemetry("s1", "msg-A", 1_000))
            .unwrap();
        l.record_turn_telemetry(&sample_telemetry("s1", "msg-B", 2_000))
            .unwrap();
        assert_eq!(l.list_turn_telemetry("s1").unwrap().len(), 2);

        l.trash("s1").unwrap();

        assert_eq!(
            l.list_turn_telemetry("s1").unwrap().len(),
            0,
            "cascade trigger must purge turn_telemetry rows when the parent session row is deleted",
        );
    }

    // ---- file_events table ---------------------------------------------

    fn sample_file_event(session_id: &str, tool_use_id: &str, path: &str) -> FileEventRow {
        FileEventRow {
            tug_session_id: session_id.to_owned(),
            tool_use_id: tool_use_id.to_owned(),
            file_path: path.to_owned(),
            tool_name: "Write".to_owned(),
            op: "write".to_owned(),
            origin: "exact".to_owned(),
            ambiguous: false,
            parent_tool_use_id: None,
            project_dir: "/proj".to_owned(),
            at: 1_700_000_000_000,
        }
    }

    // ---- file_event_spans: the children of a file_events row -----------

    fn sample_span(seq: i64, kind: &str) -> FileEventSpan {
        FileEventSpan {
            seq,
            kind: kind.to_owned(),
            anchor: format!("{{\"new_hash\":\"h{seq}\"}}"),
        }
    }

    /// Every `(tool_use_id, file_path, seq, kind)` span a session holds. A
    /// stranded span is invisible from the read side, so the R10 tests assert
    /// on the table itself.
    fn spans_of(ledger: &SessionLedger, session: &str) -> Vec<(String, String, i64, String)> {
        let conn = ledger.db.lock().expect("ledger mutex");
        let mut stmt = conn
            .prepare(
                "SELECT tool_use_id, file_path, seq, kind FROM changes.file_event_spans
                 WHERE tug_session_id = ?1 ORDER BY file_path, tool_use_id, seq",
            )
            .unwrap();
        let rows = stmt
            .query_map(params![session], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .unwrap();
        rows.map(|r| r.unwrap()).collect()
    }

    /// Total span rows in the table, whoever owns them — the orphan detector.
    fn total_spans(ledger: &SessionLedger) -> i64 {
        let conn = ledger.db.lock().expect("ledger mutex");
        conn.query_row("SELECT COUNT(*) FROM changes.file_event_spans", [], |r| {
            r.get(0)
        })
        .unwrap()
    }

    fn record_with_spans(ledger: &SessionLedger, row: &FileEventRow, spans: &[FileEventSpan]) {
        ledger
            .apply_forwarded_change(crate::changes_journal::Record::FileEvent {
                row: row.clone(),
                spans: spans.to_vec(),
            })
            .unwrap();
    }

    #[test]
    fn spans_land_with_their_row_and_replay_idempotently() {
        let l = fresh();
        let row = sample_file_event("s1", "tu-1", "a.rs");
        let spans = [sample_span(0, "insert"), sample_span(1, "replace")];
        record_with_spans(&l, &row, &spans);
        assert_eq!(spans_of(&l, "s1").len(), 2);

        // Replay re-applies the same record; the child key collapses it just
        // as the parent PK collapses the row.
        record_with_spans(&l, &row, &spans);
        assert_eq!(spans_of(&l, "s1").len(), 2, "replay is idempotent");
        assert_eq!(l.file_events_for_session("s1").unwrap().len(), 1);
    }

    #[test]
    fn a_batch_carries_each_rows_own_spans() {
        let l = fresh();
        let rows = vec![
            sample_file_event("s1", "claim:1", "a.rs"),
            sample_file_event("s1", "claim:1", "b.rs"),
        ];
        l.apply_forwarded_change(crate::changes_journal::Record::FileEventBatch {
            rows,
            spans: vec![vec![sample_span(0, "whole")], vec![sample_span(0, "whole")]],
        })
        .unwrap();
        let spans = spans_of(&l, "s1");
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0].1, "a.rs");
        assert_eq!(spans[1].1, "b.rs");
    }

    #[test]
    fn the_span_read_returns_only_proof_parents_and_carries_their_at() {
        let l = fresh();
        let proof = sample_file_event("s1", "tu-1", "a.rs");
        record_with_spans(&l, &proof, &[sample_span(0, "insert")]);
        let mut bracket = sample_file_event("s2", "tu-2", "a.rs");
        bracket.origin = "bash".to_owned();
        record_with_spans(&l, &bracket, &[sample_span(0, "insert")]);

        let rows = l
            .file_event_spans_for_paths("/proj", &["a.rs".to_owned()])
            .unwrap();
        assert_eq!(rows.len(), 1, "a bracket parent's spans must not read back");
        assert_eq!(rows[0].tug_session_id, "s1");
        assert_eq!(rows[0].at, proof.at, "the parent's at rides the span row");
    }

    /// A pre-v2 database (the owner is an older build) has no spans table.
    /// That is a vintage, not damage: the read degrades to span-less — every
    /// owner claims the whole file — rather than erroring into the health
    /// flag.
    #[test]
    fn a_database_without_the_spans_table_reads_as_span_less() {
        let l = fresh();
        {
            let conn = l.db.lock().expect("ledger mutex");
            conn.execute_batch("DROP TABLE changes.file_event_spans")
                .unwrap();
        }
        let rows = l
            .file_event_spans_for_paths("/proj", &["a.rs".to_owned()])
            .unwrap();
        assert!(rows.is_empty());
    }

    /// Risk R10: a rewrite that *renames* the parent must carry its spans to
    /// the new `file_path`. The repo-relative backfill runs rewrites in bulk,
    /// so this is the common path, not a corner.
    #[test]
    fn a_rewrite_carries_its_spans_to_the_new_path() {
        let l = fresh();
        let row = sample_file_event("sess", "tu-1", "/proj/a.txt");
        record_with_spans(&l, &row, &[sample_span(0, "insert")]);

        l.backfill_file_events_repo_relative(
            "/proj",
            &[FileEventRewrite {
                tug_session_id: "sess".to_owned(),
                tool_use_id: "tu-1".to_owned(),
                old_file_path: "/proj/a.txt".to_owned(),
                new_file_path: "a.txt".to_owned(),
            }],
        )
        .unwrap();

        let spans = spans_of(&l, "sess");
        assert_eq!(spans.len(), 1, "the span survived the rewrite");
        assert_eq!(spans[0].1, "a.txt", "and moved with its parent");
    }

    /// Risk R10, the other rewrite branch: when the legacy row merges into an
    /// existing survivor the legacy row is deleted — its spans must go with
    /// it rather than being stranded under a key nothing names.
    #[test]
    fn a_rewrite_that_merges_into_a_survivor_strands_no_spans() {
        let l = fresh();
        let abs = sample_file_event("sess", "tu-1", "/proj/a.txt");
        record_with_spans(&l, &abs, &[sample_span(0, "insert")]);
        let rel = sample_file_event("sess", "tu-1", "a.txt");
        record_with_spans(&l, &rel, &[sample_span(0, "replace")]);

        l.backfill_file_events_repo_relative(
            "/proj",
            &[FileEventRewrite {
                tug_session_id: "sess".to_owned(),
                tool_use_id: "tu-1".to_owned(),
                old_file_path: "/proj/a.txt".to_owned(),
                new_file_path: "a.txt".to_owned(),
            }],
        )
        .unwrap();

        let spans = spans_of(&l, "sess");
        assert_eq!(spans.len(), 1, "no orphan left behind: {spans:?}");
        assert_eq!(spans[0].1, "a.txt");
        assert_eq!(spans[0].3, "replace", "the survivor's own span is kept");
    }

    #[test]
    fn purge_out_of_repo_takes_the_spans_with_the_row() {
        let l = fresh();
        let row = sample_file_event("s1", "tu-2", "/away/note.md");
        record_with_spans(&l, &row, &[sample_span(0, "whole")]);
        record_with_spans(
            &l,
            &sample_file_event("s1", "tu-1", "a.rs"),
            &[sample_span(0, "insert")],
        );

        l.purge_file_events_out_of_repo(
            "/proj",
            &[FileEventKey {
                tug_session_id: "s1".to_owned(),
                tool_use_id: "tu-2".to_owned(),
                file_path: "/away/note.md".to_owned(),
            }],
        )
        .unwrap();

        let spans = spans_of(&l, "s1");
        assert_eq!(spans.len(), 1, "only the purged row's span went");
        assert_eq!(spans[0].1, "a.rs");
    }

    #[test]
    fn evicting_a_session_takes_its_spans() {
        let l = fresh();
        seed_live(&l, "s1", WS_A, "card", millis(9));
        record_with_spans(
            &l,
            &sample_file_event("s1", "tu-1", "a.rs"),
            &[sample_span(0, "insert")],
        );
        record_with_spans(
            &l,
            &sample_file_event("s2", "tu-1", "b.rs"),
            &[sample_span(0, "insert")],
        );

        l.apply_forwarded_change(crate::changes_journal::Record::DeleteSession {
            session: "s1".to_owned(),
        })
        .unwrap();

        assert!(spans_of(&l, "s1").is_empty(), "the evicted session's spans");
        assert_eq!(total_spans(&l), 1, "another session's spans are untouched");
    }

    #[test]
    fn severing_and_disclaiming_take_their_spans() {
        let l = fresh();
        record_with_spans(
            &l,
            &sample_file_event("dead", "tu-1", "a.rs"),
            &[sample_span(0, "insert")],
        );
        record_with_spans(
            &l,
            &sample_file_event("dead", "tu-2", "b.rs"),
            &[sample_span(0, "insert")],
        );
        record_with_spans(
            &l,
            &sample_file_event("live", "claim:1", "a.rs"),
            &[sample_span(0, "whole")],
        );

        l.sever_file_ownership_except("/proj", &["a.rs".to_owned()], &["live".to_owned()])
            .unwrap();
        let dead = spans_of(&l, "dead");
        assert_eq!(dead.len(), 1, "severed row's span went: {dead:?}");
        assert_eq!(dead[0].1, "b.rs");
        assert_eq!(spans_of(&l, "live").len(), 1, "claimant keeps its span");

        l.disclaim_file_ownership("/proj", &["a.rs".to_owned()], &["live".to_owned()])
            .unwrap();
        assert!(
            spans_of(&l, "live").is_empty(),
            "renouncing the file renounces its evidence"
        );
    }

    #[test]
    fn record_file_event_round_trip_preserves_every_field() {
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        let mut row = sample_file_event("s1", "tu-A", "/proj/src/foo.rs");
        row.tool_name = "Bash".to_owned();
        row.op = "modified".to_owned();
        row.origin = "bash".to_owned();
        row.ambiguous = true;
        row.parent_tool_use_id = Some("tu-parent".to_owned());
        l.record_file_event(&row).unwrap();
        let read = l.file_events_for_session("s1").unwrap();
        assert_eq!(read, vec![row]);
    }

    #[test]
    fn backfill_collapses_duplicate_absolute_and_relative_rows() {
        let l = fresh();
        seed_live(&l, "sess", "ws", "card", millis(0));
        // The transitional pair: same (session, tool_use), one absolute + one
        // repo-relative (the replay row), differing ambiguous / at.
        let mut abs = sample_file_event("sess", "tu-1", "/proj/a.txt");
        abs.ambiguous = true;
        abs.at = 10;
        l.record_file_event(&abs).unwrap();
        let mut rel = sample_file_event("sess", "tu-1", "a.txt");
        rel.ambiguous = false;
        rel.at = 20;
        l.record_file_event(&rel).unwrap();

        let rewrites = vec![FileEventRewrite {
            tug_session_id: "sess".to_owned(),
            tool_use_id: "tu-1".to_owned(),
            old_file_path: "/proj/a.txt".to_owned(),
            new_file_path: "a.txt".to_owned(),
        }];
        let changed = l
            .backfill_file_events_repo_relative("/proj", &rewrites)
            .unwrap();
        assert_eq!(changed, 1);

        // The whole statement did not abort on the PK conflict.
        let rows = l.file_events_for_session("sess").unwrap();
        assert_eq!(rows.len(), 1, "the pair collapsed to one row");
        assert_eq!(rows[0].file_path, "a.txt");
        assert!(rows[0].ambiguous, "ambiguous OR-folded onto the survivor");
        assert_eq!(rows[0].at, 20, "later at kept");
        assert_eq!(rows[0].project_dir, "/proj");
    }

    #[test]
    fn record_file_event_idempotent_on_session_tool_path_pk() {
        // Replay re-emits the full history and subagent-tail re-streams
        // background children from offset 0, so the same frame can arrive
        // twice. ON CONFLICT DO NOTHING keeps one row and the first write
        // wins — a re-streamed live frame does not flip an already-
        // recorded `origin` (#replay-idempotency).
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        let first = {
            let mut r = sample_file_event("s1", "tu-A", "/proj/foo.rs");
            r.origin = "replay".to_owned();
            r
        };
        l.record_file_event(&first).unwrap();
        // Same PK, different non-key columns — must NOT overwrite.
        let second = {
            let mut r = sample_file_event("s1", "tu-A", "/proj/foo.rs");
            r.origin = "exact".to_owned();
            r.op = "edit".to_owned();
            r
        };
        l.record_file_event(&second).unwrap();
        let read = l.file_events_for_session("s1").unwrap();
        assert_eq!(read.len(), 1, "ON CONFLICT DO NOTHING keeps one row per PK");
        assert_eq!(read[0].origin, "replay", "first write wins");
        assert_eq!(read[0].op, "write");
    }

    #[test]
    fn record_file_events_lands_the_whole_batch() {
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        let rows = vec![
            sample_file_event("s1", "claim:1", "/proj/a.rs"),
            sample_file_event("s1", "claim:1", "/proj/b.rs"),
            sample_file_event("s1", "claim:1", "/proj/c.rs"),
        ];
        l.record_file_events(&rows).unwrap();
        assert_eq!(l.file_events_for_session("s1").unwrap().len(), 3);

        // Re-applying the same batch is a no-op: every row collapses on the
        // primary key, exactly as a single replayed insert does.
        l.record_file_events(&rows).unwrap();
        assert_eq!(l.file_events_for_session("s1").unwrap().len(), 3);
    }

    #[test]
    fn record_file_events_tolerates_a_duplicate_row_within_the_batch() {
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        let rows = vec![
            sample_file_event("s1", "claim:1", "/proj/a.rs"),
            sample_file_event("s1", "claim:1", "/proj/a.rs"),
            sample_file_event("s1", "claim:1", "/proj/b.rs"),
        ];
        l.record_file_events(&rows).unwrap();
        let read = l.file_events_for_session("s1").unwrap();
        assert_eq!(read.len(), 2, "the duplicate was conflict-ignored");
    }

    #[test]
    fn record_file_events_replays_from_the_journal_after_destruction() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sessions.db");
        let root = PathBuf::from("/tmp/tugcast-tests-no-trash");
        {
            let l = SessionLedger::open_with_claude_root(&path, root.clone()).unwrap();
            l.record_file_events(&[
                sample_file_event("s1", "claim:1", "/proj/a.rs"),
                sample_file_event("s1", "claim:1", "/proj/b.rs"),
            ])
            .unwrap();
        }
        std::fs::write(dir.path().join("sessions.db.changes"), b"destroyed").unwrap();

        let l = SessionLedger::open_with_claude_root(&path, root).unwrap();
        let rows = l.file_events_for_session("s1").unwrap();
        assert_eq!(rows.len(), 2, "the batch record replayed whole");
    }

    #[test]
    fn record_file_event_distinct_paths_of_one_bash_call_are_separate_rows() {
        // A Bash call touching N files yields N rows sharing tool_use_id.
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        l.record_file_event(&sample_file_event("s1", "tu-bash", "/proj/a.rs"))
            .unwrap();
        l.record_file_event(&sample_file_event("s1", "tu-bash", "/proj/b.rs"))
            .unwrap();
        assert_eq!(l.file_events_for_session("s1").unwrap().len(), 2);
    }

    #[test]
    fn file_events_for_session_filters_by_session() {
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        seed_live(&l, "s2", "ws", "card-2", millis(0));
        l.record_file_event(&sample_file_event("s1", "tu-1", "/proj/a.rs"))
            .unwrap();
        l.record_file_event(&sample_file_event("s2", "tu-1", "/proj/b.rs"))
            .unwrap();
        assert_eq!(l.file_events_for_session("s1").unwrap().len(), 1);
        assert_eq!(l.file_events_for_session("s2").unwrap().len(), 1);
    }

    #[test]
    fn file_events_for_project_joins_owner_display_fields() {
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        l.rename("s1", Some("my session")).unwrap();
        l.record_file_event(&sample_file_event("s1", "tu-1", "/proj/a.rs"))
            .unwrap();
        let read = l.file_events_for_project("/proj").unwrap();
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].owner_name.as_deref(), Some("my session"));
        assert!(read[0].owner_name_user_set);
        assert!(read[0].owner_live);
        assert_eq!(read[0].event.tug_session_id, "s1");

        // A closed session's events read back owner_live = false.
        l.demote_live_to_closed().unwrap();
        let read = l.file_events_for_project("/proj").unwrap();
        assert!(!read[0].owner_live);
    }

    #[test]
    fn file_events_for_project_keeps_events_with_no_session_row() {
        // LEFT JOIN: an event whose session row was evicted still shows
        // up (unattributed/unknown-owner bucket), never silently dropped.
        let l = fresh();
        l.record_file_event(&sample_file_event("ghost", "tu-1", "/proj/a.rs"))
            .unwrap();
        let read = l.file_events_for_project("/proj").unwrap();
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].owner_name, None);
        assert!(!read[0].owner_name_user_set);
    }

    #[test]
    fn file_events_for_project_filters_by_project_dir() {
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        let mut here = sample_file_event("s1", "tu-1", "/proj/a.rs");
        here.project_dir = "/proj".to_owned();
        let mut elsewhere = sample_file_event("s1", "tu-2", "/other/b.rs");
        elsewhere.project_dir = "/other".to_owned();
        l.record_file_event(&here).unwrap();
        l.record_file_event(&elsewhere).unwrap();
        assert_eq!(l.file_events_for_project("/proj").unwrap().len(), 1);
        assert_eq!(l.file_events_for_project("/other").unwrap().len(), 1);
    }

    #[test]
    fn sever_file_ownership_except_removes_other_sessions_rows_only() {
        // A claim severs prior owners ([D120]): the dead originator's rows for
        // the claimed paths go, the claimant's stay, and an unrelated path is
        // untouched.
        let l = fresh();
        // Dead owner `dead` holds a.rs + b.rs; claimant `live` re-recorded a.rs.
        l.record_file_event(&sample_file_event("dead", "tu-1", "a.rs"))
            .unwrap();
        l.record_file_event(&sample_file_event("dead", "tu-2", "b.rs"))
            .unwrap();
        l.record_file_event(&sample_file_event("live", "claim:1", "a.rs"))
            .unwrap();

        let deleted = l
            .sever_file_ownership_except("/proj", &["a.rs".to_owned()], &["live".to_owned()])
            .unwrap();
        assert_eq!(deleted, 1, "only dead's a.rs row is removed");

        let remaining = l.file_events_for_project("/proj").unwrap();
        let owns: Vec<(&str, &str)> = remaining
            .iter()
            .map(|r| (r.event.tug_session_id.as_str(), r.event.file_path.as_str()))
            .collect();
        assert!(owns.contains(&("live", "a.rs")), "claimant keeps its row");
        assert!(owns.contains(&("dead", "b.rs")), "unclaimed path untouched");
        assert!(
            !owns.contains(&("dead", "a.rs")),
            "dead originator no longer owns the claimed path"
        );
    }

    #[test]
    fn sever_keeps_every_segment_in_the_keep_set() {
        // The keep set is a line's whole segment history ([P01]): a claim
        // arriving under the current id must not sever rows the same
        // conversation wrote under an id it rotated away from.
        let l = fresh();
        l.record_file_event(&sample_file_event("seg-old", "tu-1", "a.rs"))
            .unwrap();
        l.record_file_event(&sample_file_event("seg-new", "claim:1", "a.rs"))
            .unwrap();
        l.record_file_event(&sample_file_event("stranger", "tu-2", "a.rs"))
            .unwrap();

        let deleted = l
            .sever_file_ownership_except(
                "/proj",
                &["a.rs".to_owned()],
                &["seg-new".to_owned(), "seg-old".to_owned()],
            )
            .unwrap();
        assert_eq!(deleted, 1, "only the stranger's row goes");

        let owns: Vec<String> = l
            .file_events_for_project("/proj")
            .unwrap()
            .iter()
            .map(|r| r.event.tug_session_id.clone())
            .collect();
        assert!(
            owns.contains(&"seg-old".to_owned()),
            "the line's older segment survives"
        );
        assert!(owns.contains(&"seg-new".to_owned()));
        assert!(!owns.contains(&"stranger".to_owned()));
    }

    #[test]
    fn disclaim_empties_the_whole_segment_set() {
        // A disclaim renounces the LINE's hold ([P01]): rows under every
        // segment id go, or an older segment silently re-owns the file on
        // the next recompose.
        let l = fresh();
        l.record_file_event(&sample_file_event("seg-old", "tu-1", "a.rs"))
            .unwrap();
        l.record_file_event(&sample_file_event("seg-new", "tu-2", "a.rs"))
            .unwrap();
        l.record_file_event(&sample_file_event("other", "tu-3", "a.rs"))
            .unwrap();

        let deleted = l
            .disclaim_file_ownership(
                "/proj",
                &["a.rs".to_owned()],
                &["seg-new".to_owned(), "seg-old".to_owned()],
            )
            .unwrap();
        assert_eq!(deleted, 2, "both segments' rows are renounced");

        let owns: Vec<String> = l
            .file_events_for_project("/proj")
            .unwrap()
            .iter()
            .map(|r| r.event.tug_session_id.clone())
            .collect();
        assert_eq!(
            owns,
            vec!["other".to_owned()],
            "the other owner is untouched"
        );
    }

    #[test]
    fn line_ownership_reports_seat_segments_and_liveness() {
        let l = fresh();
        l.record_spawn("seg-old", "ws", "/proj", "card", 0, "line-1", Some("badge"))
            .unwrap();
        l.mark_closed("seg-old").unwrap();
        l.record_spawn("seg-new", "ws", "/proj", "card", 1, "line-1", None)
            .unwrap();

        let own = l.line_ownership("line-1").unwrap().expect("line exists");
        assert_eq!(own.seat_id, "seg-new", "the live segment seats the line");
        assert!(own.any_live);
        assert_eq!(own.segment_ids.len(), 2);
        assert!(own.segment_ids.contains(&"seg-old".to_owned()));

        // Both closed: the line reads dead, and the seat is still answered
        // (the tip), because the ownership expansion needs an id either way.
        l.mark_closed("seg-new").unwrap();
        let own = l.line_ownership("line-1").unwrap().expect("line exists");
        assert!(!own.any_live);
        assert_eq!(own.seat_id, "seg-new");

        assert!(
            l.line_ownership("line-unknown").unwrap().is_none(),
            "a line no sessions row wears answers None"
        );
    }

    #[test]
    fn insert_file_event_stamps_the_writers_line() {
        // The v3 stamp ([P01]): a row written by a session the ledger has
        // lined carries its line, so it stays attributed to the line even
        // where the sessions join can no longer answer.
        let l = fresh();
        l.record_spawn("seg-1", "ws", "/proj", "card", 0, "line-9", Some("badge"))
            .unwrap();
        l.record_file_event(&sample_file_event("seg-1", "tu-1", "a.rs"))
            .unwrap();
        l.record_file_event(&sample_file_event("nobody", "tu-2", "b.rs"))
            .unwrap();

        let rows = l.file_events_for_project("/proj").unwrap();
        let line_of = |id: &str| {
            rows.iter()
                .find(|r| r.event.tug_session_id == id)
                .expect("row present")
                .line_id
                .clone()
        };
        assert_eq!(line_of("seg-1").as_deref(), Some("line-9"));
        assert_eq!(line_of("nobody"), None, "an unlined writer stamps nothing");
    }

    #[test]
    fn disclaim_removes_only_the_requesting_sessions_rows_for_those_paths() {
        // The inverse of a claim: `mine` gives up a.rs — every row it holds on
        // that path (proof and bracket alike) goes, `other`'s row on the same
        // path survives as sole ownership, and `mine`'s other path is untouched.
        let l = fresh();
        l.record_file_event(&sample_file_event("mine", "tu-1", "a.rs"))
            .unwrap();
        l.record_file_event(&sample_file_event("mine", "tu-bash", "a.rs"))
            .unwrap();
        l.record_file_event(&sample_file_event("mine", "tu-2", "b.rs"))
            .unwrap();
        l.record_file_event(&sample_file_event("other", "tu-3", "a.rs"))
            .unwrap();

        let deleted = l
            .disclaim_file_ownership("/proj", &["a.rs".to_owned()], &["mine".to_owned()])
            .unwrap();
        assert_eq!(deleted, 2, "both of mine's a.rs rows removed");

        let owns: Vec<(String, String)> = l
            .file_events_for_project("/proj")
            .unwrap()
            .iter()
            .map(|r| (r.event.tug_session_id.clone(), r.event.file_path.clone()))
            .collect();
        assert!(
            owns.contains(&("other".to_owned(), "a.rs".to_owned())),
            "the other owner becomes sole owner"
        );
        assert!(
            owns.contains(&("mine".to_owned(), "b.rs".to_owned())),
            "an undisclaimed path is untouched"
        );
        assert!(
            !owns.iter().any(|(s, p)| s == "mine" && p == "a.rs"),
            "the disclaiming session holds nothing on the path"
        );

        // Idempotent: disclaiming again deletes nothing and does not error.
        assert_eq!(
            l.disclaim_file_ownership("/proj", &["a.rs".to_owned()], &["mine".to_owned()])
                .unwrap(),
            0
        );
    }

    /// `file_events.file_path` has held more than one spelling over the life
    /// of the table — new capture writes the repo-relative key, older rows are
    /// absolute — and the read side reconciles them (`repo_relative_key`, plus
    /// the opportunistic backfill). The delete side does not: it matches the
    /// stored string. A session that disclaims a file whose row predates the
    /// backfill keeps owning it, and every existing disclaim test seeds via
    /// claim, which writes the new form, so none of them would notice.
    #[test]
    fn disclaim_matches_a_legacy_absolute_file_path() {
        let l = fresh();
        // The legacy form: an absolute path under the project dir.
        l.record_file_event(&sample_file_event("mine", "tu-1", "/proj/a.rs"))
            .unwrap();
        // The new form, same file, so the fix cannot be "match absolute only".
        l.record_file_event(&sample_file_event("mine", "tu-2", "a.rs"))
            .unwrap();

        let deleted = l
            .disclaim_file_ownership("/proj", &["a.rs".to_owned()], &["mine".to_owned()])
            .unwrap();

        assert_eq!(deleted, 2, "both spellings of the same file are renounced");
        assert!(
            l.file_events_for_session("mine").unwrap().is_empty(),
            "the disclaiming session holds nothing on the path in any spelling"
        );
    }

    /// The same gap on the sever side — [L27]'s fix-the-class rule applied to
    /// a SQL predicate: a claim severs other sessions' rows for the path, and
    /// a legacy-form row must be severed too or the claim leaves the file
    /// shared when it reported sole ownership.
    #[test]
    fn sever_matches_a_legacy_absolute_file_path() {
        let l = fresh();
        l.record_file_event(&sample_file_event("other", "tu-1", "/proj/a.rs"))
            .unwrap();
        l.record_file_event(&sample_file_event("other", "tu-2", "a.rs"))
            .unwrap();
        l.record_file_event(&sample_file_event("mine", "tu-3", "a.rs"))
            .unwrap();

        let deleted = l
            .sever_file_ownership_except("/proj", &["a.rs".to_owned()], &["mine".to_owned()])
            .unwrap();

        assert_eq!(deleted, 2, "both of the other session's spellings go");
        assert!(l.file_events_for_session("other").unwrap().is_empty());
        assert_eq!(
            l.file_events_for_session("mine").unwrap().len(),
            1,
            "the claiming session keeps its own row"
        );
    }

    /// Matching the absolute spelling must not widen into a suffix match: a
    /// row for `vendor/a.rs` is a different file from `a.rs` and survives.
    #[test]
    fn disclaim_does_not_over_delete_a_path_that_merely_ends_the_same() {
        let l = fresh();
        l.record_file_event(&sample_file_event("mine", "tu-1", "vendor/a.rs"))
            .unwrap();
        l.record_file_event(&sample_file_event("mine", "tu-2", "/proj/vendor/a.rs"))
            .unwrap();
        l.record_file_event(&sample_file_event("mine", "tu-3", "/proj/a.rs"))
            .unwrap();

        let deleted = l
            .disclaim_file_ownership("/proj", &["a.rs".to_owned()], &["mine".to_owned()])
            .unwrap();

        assert_eq!(deleted, 1, "only the named file, in either spelling");
        let left: Vec<String> = l
            .file_events_for_session("mine")
            .unwrap()
            .iter()
            .map(|r| r.file_path.clone())
            .collect();
        assert_eq!(
            left.len(),
            2,
            "both spellings of vendor/a.rs survive: {left:?}"
        );
    }

    #[test]
    fn disclaim_is_scoped_to_its_project() {
        let l = fresh();
        l.record_file_event(&sample_file_event("mine", "tu-1", "a.rs"))
            .unwrap();
        let elsewhere = {
            let mut r = sample_file_event("mine", "tu-2", "a.rs");
            r.project_dir = "/other".to_owned();
            r
        };
        l.record_file_event(&elsewhere).unwrap();

        l.disclaim_file_ownership("/proj", &["a.rs".to_owned()], &["mine".to_owned()])
            .unwrap();
        assert!(l.file_events_for_project("/proj").unwrap().is_empty());
        assert_eq!(l.file_events_for_project("/other").unwrap().len(), 1);
    }

    #[test]
    fn disclaim_replays_from_the_journal_after_destruction() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sessions.db");
        let root = PathBuf::from("/tmp/tugcast-tests-no-trash");
        {
            let l = SessionLedger::open_with_claude_root(&path, root.clone()).unwrap();
            l.record_file_event(&sample_file_event("mine", "tu-1", "a.rs"))
                .unwrap();
            l.record_file_event(&sample_file_event("mine", "tu-2", "b.rs"))
                .unwrap();
            l.disclaim_file_ownership("/proj", &["a.rs".to_owned()], &["mine".to_owned()])
                .unwrap();
        }
        std::fs::write(dir.path().join("sessions.db.changes"), b"destroyed").unwrap();

        // Replay re-inserts both rows and then re-applies the delete, so the
        // renunciation survives the rebuild rather than being undone by it.
        let l = SessionLedger::open_with_claude_root(&path, root).unwrap();
        let rows = l.file_events_for_session("mine").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].file_path, "b.rs");
    }

    #[test]
    fn purge_out_of_repo_deletes_by_key_and_leaves_the_rest() {
        let l = fresh();
        l.record_file_event(&sample_file_event("s1", "tu-1", "a.rs"))
            .unwrap();
        l.record_file_event(&sample_file_event("s1", "tu-2", "/away/note.md"))
            .unwrap();
        l.record_file_event(&sample_file_event("s2", "tu-3", "/away/other.md"))
            .unwrap();

        let keys = vec![
            FileEventKey {
                tug_session_id: "s1".to_owned(),
                tool_use_id: "tu-2".to_owned(),
                file_path: "/away/note.md".to_owned(),
            },
            FileEventKey {
                tug_session_id: "s2".to_owned(),
                tool_use_id: "tu-3".to_owned(),
                file_path: "/away/other.md".to_owned(),
            },
        ];
        assert_eq!(l.purge_file_events_out_of_repo("/proj", &keys).unwrap(), 2);
        let remaining = l.file_events_for_project("/proj").unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].event.file_path, "a.rs");

        // Re-applying the same purge deletes nothing more — several tugcasts
        // race the same sweep, and a quarantine replay re-applies it.
        assert_eq!(l.purge_file_events_out_of_repo("/proj", &keys).unwrap(), 0);
        assert_eq!(l.file_events_for_project("/proj").unwrap().len(), 1);
    }

    /// The purge rides the journal as one record carrying its explicit keys,
    /// and replaying that journal reconstructs the post-purge state — twice
    /// over, since replay must be idempotent.
    #[test]
    fn purge_out_of_repo_journals_and_replays_to_the_same_state() {
        let dir = tempfile::tempdir().unwrap();
        let claude_root = dir.path().join("claude");
        let changes = dir.path().join("changes.db");
        let owner = SessionLedger::open_full(
            dir.path().join("owner.db"),
            Some(changes.clone()),
            claude_root.clone(),
            0,
        )
        .expect("owner ledger");
        owner
            .record_file_event(&sample_file_event("s1", "tu-1", "a.rs"))
            .unwrap();
        owner
            .record_file_event(&sample_file_event("s1", "tu-2", "/away/note.md"))
            .unwrap();
        let keys = vec![FileEventKey {
            tug_session_id: "s1".to_owned(),
            tool_use_id: "tu-2".to_owned(),
            file_path: "/away/note.md".to_owned(),
        }];
        owner.purge_file_events_out_of_repo("/proj", &keys).unwrap();

        let journal = crate::changes_journal::journal_path_for(&changes);
        let records = crate::changes_journal::ChangesJournal::read_records(&journal);
        let batched = records.iter().any(|r| {
            matches!(r, crate::changes_journal::Record::PurgeOutOfRepo { keys, .. } if keys.len() == 1)
        });
        assert!(batched, "one record carries the batch: {records:?}");

        // A fresh database replaying the journal lands on the same state.
        let rebuilt = SessionLedger::open_full(
            dir.path().join("rebuilt.db"),
            Some(dir.path().join("rebuilt-changes.db")),
            claude_root,
            0,
        )
        .expect("rebuilt ledger");
        rebuilt.replay_changes_journal(&journal);
        let after_one = rebuilt.file_events_for_project("/proj").unwrap();
        assert_eq!(after_one.len(), 1);
        assert_eq!(after_one[0].event.file_path, "a.rs");

        rebuilt.replay_changes_journal(&journal);
        assert_eq!(
            rebuilt.file_events_for_project("/proj").unwrap(),
            after_one,
            "replay is idempotent"
        );
    }

    #[test]
    fn cascade_delete_removes_file_events_when_session_deleted() {
        // Pin the `file_events_cascade_delete_on_session` trigger: trashing
        // a session takes its attribution rows with it.
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        l.mark_closed("s1").unwrap();
        l.record_file_event(&sample_file_event("s1", "tu-A", "/proj/a.rs"))
            .unwrap();
        l.record_file_event(&sample_file_event("s1", "tu-B", "/proj/b.rs"))
            .unwrap();
        assert_eq!(l.file_events_for_session("s1").unwrap().len(), 2);

        l.trash("s1").unwrap();

        assert_eq!(
            l.file_events_for_session("s1").unwrap().len(),
            0,
            "cascade trigger must purge file_events when the parent session row is deleted",
        );
    }

    #[test]
    fn legacy_instance_file_events_migrate_into_the_shared_changes_ledger() {
        // A pre-shared-ledger instance db carries file_events in MAIN. Opening
        // it copies the rows into the attached changes ledger (PK-idempotent)
        // and drops the legacy table, so evicted rows can never resurrect.
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("sessions.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE file_events (
                    tug_session_id      TEXT NOT NULL,
                    tool_use_id         TEXT NOT NULL,
                    file_path           TEXT NOT NULL,
                    tool_name           TEXT NOT NULL,
                    op                  TEXT NOT NULL,
                    origin              TEXT NOT NULL,
                    ambiguous           INTEGER NOT NULL DEFAULT 0,
                    parent_tool_use_id  TEXT,
                    project_dir         TEXT NOT NULL,
                    at                  INTEGER NOT NULL,
                    PRIMARY KEY (tug_session_id, tool_use_id, file_path)
                );
                INSERT INTO file_events
                    (tug_session_id, tool_use_id, file_path, tool_name, op, origin, project_dir, at)
                VALUES ('legacy-sess', 'tu-1', 'a.rs', 'Write', 'write', 'exact', '/proj', 42);",
            )
            .unwrap();
        }

        let l = SessionLedger::open_with_claude_root(
            &path,
            PathBuf::from("/tmp/tugcast-tests-no-trash"),
        )
        .unwrap();
        let rows = l.file_events_for_session("legacy-sess").unwrap();
        assert_eq!(rows.len(), 1, "the legacy row migrated into changes");
        assert_eq!(rows[0].file_path, "a.rs");
        assert_eq!(rows[0].at, 42);
        drop(l);

        // The legacy MAIN table is gone; a reopen neither errors nor
        // resurrects anything.
        {
            let conn = Connection::open(&path).unwrap();
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='file_events'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 0, "legacy main.file_events dropped after migration");
        }
        let l2 = SessionLedger::open_with_claude_root(
            &path,
            PathBuf::from("/tmp/tugcast-tests-no-trash"),
        )
        .unwrap();
        assert_eq!(
            l2.file_events_for_session("legacy-sess").unwrap().len(),
            1,
            "the shared changes ledger persists across reopen"
        );
    }

    #[test]
    fn opening_a_db_with_a_drifted_file_events_schema_rebuilds_it() {
        // file_events is advisory + fully rebuildable, so a stale on-disk
        // shape is DROPPED and recreated (never migrated) — the same guard
        // that protects turn_telemetry from silent INSERT failures.
        let tmp = NamedTempFile::new().expect("temp file");
        let path = tmp.path().to_path_buf();
        // A prior shape missing the `parent_tool_use_id` column, carrying a row.
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE file_events (
                    tug_session_id TEXT NOT NULL,
                    tool_use_id    TEXT NOT NULL,
                    file_path      TEXT NOT NULL,
                    tool_name      TEXT NOT NULL,
                    op             TEXT NOT NULL,
                    origin         TEXT NOT NULL,
                    ambiguous      INTEGER NOT NULL DEFAULT 0,
                    project_dir    TEXT NOT NULL,
                    at             INTEGER NOT NULL,
                    PRIMARY KEY (tug_session_id, tool_use_id, file_path)
                );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO file_events
                    (tug_session_id, tool_use_id, file_path, tool_name, op, origin, project_dir, at)
                 VALUES ('stale', 'tu', '/p/x', 'Write', 'write', 'exact', '/p', 1)",
                [],
            )
            .unwrap();
        }
        // Open via SessionLedger — the bootstrap guard sees the drift and
        // rebuilds the table with the current shape.
        let l = SessionLedger::open_with_claude_root(
            &path,
            PathBuf::from("/tmp/tugcast-tests-no-trash"),
        )
        .unwrap();
        // A write listing `parent_tool_use_id` now succeeds — it would have
        // failed against the stale shape.
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        let mut row = sample_file_event("s1", "tu-A", "/proj/a.rs");
        row.parent_tool_use_id = Some("tu-parent".to_owned());
        l.record_file_event(&row).unwrap();
        assert_eq!(l.file_events_for_session("s1").unwrap(), vec![row]);
        // The rebuild dropped the stale row — recreate, not migrate.
        assert_eq!(l.file_events_for_session("stale").unwrap().len(), 0);
    }

    #[test]
    fn bootstrap_leaves_a_matching_file_events_untouched() {
        // Drift-only: reopening a current-shape DB keeps the rows.
        let tmp = NamedTempFile::new().expect("temp file");
        let path = tmp.path().to_path_buf();
        {
            let l = SessionLedger::open_with_claude_root(
                &path,
                PathBuf::from("/tmp/tugcast-tests-no-trash"),
            )
            .unwrap();
            seed_live(&l, "s1", "ws", "card-1", millis(0));
            l.record_file_event(&sample_file_event("s1", "tu-A", "/proj/a.rs"))
                .unwrap();
        }
        let l = SessionLedger::open_with_claude_root(
            &path,
            PathBuf::from("/tmp/tugcast-tests-no-trash"),
        )
        .unwrap();
        assert_eq!(l.file_events_for_session("s1").unwrap().len(), 1);
    }

    // ---- changeset_drafts table ----------------------------------------

    fn sample_draft(
        owner_kind: &str,
        owner_id: &str,
        project_dir: &str,
        fingerprint: &str,
        message: &str,
    ) -> ChangesetDraftRow {
        ChangesetDraftRow {
            owner_kind: owner_kind.to_owned(),
            owner_id: owner_id.to_owned(),
            project_dir: project_dir.to_owned(),
            fingerprint: fingerprint.to_owned(),
            message: message.to_owned(),
            updated_at: 1_700_000_000_000,
            edited: false,
            selection: None,
        }
    }

    #[test]
    fn changeset_draft_round_trip_preserves_edited_and_selection() {
        let l = SessionLedger::open_in_memory().unwrap();
        let mut row = sample_draft("session", "s1", "/proj", "fp-1", "Hand-tuned message");
        row.edited = true;
        row.selection = Some(r#"{"include":["a.rs"],"exclude":["shared.rs"]}"#.to_owned());
        l.upsert_changeset_draft(&row).unwrap();
        assert_eq!(
            l.changeset_draft("session", "s1", "/proj").unwrap(),
            Some(row.clone())
        );
        assert_eq!(l.changeset_drafts_for_project("/proj").unwrap(), vec![row]);
    }

    #[test]
    fn legacy_per_instance_changeset_drafts_migrate_into_changes() {
        // Drafts written by a pre-machine-global build live in
        // `main.changeset_drafts`; opening the ledger copies them into the
        // attached changes schema and drops the local table.
        let tmp = NamedTempFile::new().expect("temp file");
        let path = tmp.path().to_path_buf();
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE changeset_drafts (
                    owner_kind   TEXT NOT NULL,
                    owner_id     TEXT NOT NULL,
                    project_dir  TEXT NOT NULL,
                    fingerprint  TEXT NOT NULL,
                    message      TEXT NOT NULL,
                    updated_at   INTEGER NOT NULL,
                    PRIMARY KEY (owner_kind, owner_id, project_dir)
                );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO changeset_drafts
                    (owner_kind, owner_id, project_dir, fingerprint, message, updated_at)
                 VALUES ('session', 's1', '/proj', 'fp-1', 'Legacy draft', 42)",
                [],
            )
            .unwrap();
        }
        let l = SessionLedger::open_with_claude_root(
            &path,
            PathBuf::from("/tmp/tugcast-tests-no-trash"),
        )
        .unwrap();
        let migrated = l
            .changeset_draft("session", "s1", "/proj")
            .unwrap()
            .expect("legacy draft migrated");
        assert_eq!(migrated.message, "Legacy draft");
        assert_eq!(migrated.updated_at, 42);
        assert!(!migrated.edited, "legacy rows default unedited");
        assert!(migrated.selection.is_none());
        // The legacy table is gone from the instance db.
        let conn = Connection::open(&path).unwrap();
        let legacy: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM main.sqlite_master
                 WHERE type = 'table' AND name = 'changeset_drafts'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(legacy, 0);
    }

    #[test]
    fn changeset_draft_upsert_read_and_supersede() {
        let l = SessionLedger::open_in_memory().unwrap();
        let row = sample_draft("session", "s1", "/proj", "fp-1", "Add a thing\n\n- detail");
        l.upsert_changeset_draft(&row).unwrap();
        assert_eq!(
            l.changeset_draft("session", "s1", "/proj").unwrap(),
            Some(row.clone())
        );

        // Re-upsert on the same key supersedes in place (no duplicate row).
        let mut newer = row.clone();
        newer.fingerprint = "fp-2".to_owned();
        newer.message = "Add a better thing".to_owned();
        newer.updated_at = 1_700_000_001_000;
        l.upsert_changeset_draft(&newer).unwrap();
        assert_eq!(
            l.changeset_draft("session", "s1", "/proj").unwrap(),
            Some(newer.clone())
        );
        assert_eq!(
            l.changeset_drafts_for_project("/proj").unwrap(),
            vec![newer]
        );

        // A different owner kind on the same id/project is a distinct row.
        let dash = sample_draft("dash", "tugdash/x", "/proj", "fp-d", "Dash join message");
        l.upsert_changeset_draft(&dash).unwrap();
        assert_eq!(l.changeset_drafts_for_project("/proj").unwrap().len(), 2);
        assert!(
            l.changeset_draft("session", "missing", "/proj")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn opening_a_db_with_a_drifted_changeset_drafts_schema_rebuilds_it() {
        // changeset_drafts is advisory + regenerable, so a stale on-disk
        // shape is DROPPED and recreated (never migrated).
        let tmp = NamedTempFile::new().expect("temp file");
        let path = tmp.path().to_path_buf();
        // A prior shape missing the `fingerprint` column, carrying a row.
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE changeset_drafts (
                    owner_kind   TEXT NOT NULL,
                    owner_id     TEXT NOT NULL,
                    project_dir  TEXT NOT NULL,
                    message      TEXT NOT NULL,
                    updated_at   INTEGER NOT NULL,
                    PRIMARY KEY (owner_kind, owner_id, project_dir)
                );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO changeset_drafts (owner_kind, owner_id, project_dir, message, updated_at)
                 VALUES ('session', 'stale', '/p', 'old', 1)",
                [],
            )
            .unwrap();
        }
        let l = SessionLedger::open_with_claude_root(
            &path,
            PathBuf::from("/tmp/tugcast-tests-no-trash"),
        )
        .unwrap();
        // A write listing `fingerprint` now succeeds; the stale row is gone.
        l.upsert_changeset_draft(&sample_draft("session", "s1", "/p", "fp", "msg"))
            .unwrap();
        assert_eq!(l.changeset_drafts_for_project("/p").unwrap().len(), 1);
        assert!(
            l.changeset_draft("session", "stale", "/p")
                .unwrap()
                .is_none()
        );
    }

    // ---- session_metadata table ----------------------------------------

    fn sample_metadata_payload(model: &str) -> Vec<u8> {
        serde_json::json!({
            "type": "system_metadata",
            "session_id": "s1",
            "cwd": "/home/user/project",
            "tools": ["Read", "Bash"],
            "model": model,
            "permissionMode": "default",
            "slash_commands": ["help"],
            "plugins": [],
            "agents": [],
            "skills": ["tugplug:plan"],
            "mcp_servers": [],
            "version": "2.1.105",
            "output_style": "",
            "fast_mode_state": "",
            "apiKeySource": "anthropic",
            "ipc_version": 2,
        })
        .to_string()
        .into_bytes()
    }

    #[test]
    fn record_session_metadata_round_trip() {
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        let payload = sample_metadata_payload("claude-opus-4-7[1m]");
        l.record_session_metadata("s1", &payload, 5_000).unwrap();
        let read = l.get_session_metadata("s1").unwrap().unwrap();
        assert_eq!(read.session_id, "s1");
        assert_eq!(read.payload, payload);
        assert_eq!(read.captured_at, 5_000);
    }

    #[test]
    fn get_session_metadata_returns_none_for_unknown_session() {
        let l = fresh();
        assert!(l.get_session_metadata("never-existed").unwrap().is_none());
    }

    #[test]
    fn record_session_metadata_idempotent_on_session_pk() {
        // Steady-state operation: the bridge intercept runs the merge
        // on every outbound `system_metadata` line. Writes for the same
        // session must overwrite, not duplicate-key.
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        let v1 = sample_metadata_payload("claude-opus-4-7");
        let v2 = sample_metadata_payload("claude-opus-4-7[1m]");
        l.record_session_metadata("s1", &v1, 1_000).unwrap();
        l.record_session_metadata("s1", &v2, 2_000).unwrap();
        let read = l.get_session_metadata("s1").unwrap().unwrap();
        assert_eq!(read.payload, v2);
        assert_eq!(read.captured_at, 2_000);
    }

    #[test]
    fn record_session_metadata_accepts_malformed_blob() {
        // The schema column type is BLOB with no JSON validation, so
        // the ledger persists whatever bytes the caller hands it.
        // Round-trip succeeds; downstream JSON deserialization is the
        // bridge's responsibility (and the bridge falls back to
        // pass-through on a parse error — see Task 3).
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        let garbage = b"this-is-not-json".to_vec();
        l.record_session_metadata("s1", &garbage, 1_000).unwrap();
        let read = l.get_session_metadata("s1").unwrap().unwrap();
        assert_eq!(read.payload, garbage);
    }

    #[test]
    fn cascade_delete_removes_session_metadata_when_session_deleted() {
        // Pin the `session_metadata_cascade_delete_on_session` trigger:
        // trashing a session also removes its metadata row. Mirrors
        // the `turn_telemetry` cascade contract.
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        l.mark_closed("s1").unwrap();
        l.record_session_metadata("s1", &sample_metadata_payload("claude-opus-4-7"), 1_000)
            .unwrap();
        assert!(l.get_session_metadata("s1").unwrap().is_some());

        l.trash("s1").unwrap();

        assert!(
            l.get_session_metadata("s1").unwrap().is_none(),
            "cascade trigger must purge session_metadata when parent session row is deleted",
        );
    }

    // ---- session_capabilities table -------------------------------------

    fn sample_capabilities_payload(version: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "type": "session_capabilities",
            "version": version,
            "models": [{ "value": "default", "displayName": "Default" }],
            "commands": ["tugplug:implement", "tugplug:devise", "commit"],
        }))
        .unwrap()
    }

    #[test]
    fn record_session_capabilities_round_trip() {
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        let payload = sample_capabilities_payload("2.1.207");
        l.record_session_capabilities("s1", &payload, 5_000)
            .unwrap();
        let read = l.get_session_capabilities("s1").unwrap().unwrap();
        assert_eq!(read.session_id, "s1");
        assert_eq!(read.payload, payload);
        assert_eq!(read.captured_at, 5_000);
    }

    #[test]
    fn get_session_capabilities_returns_none_for_unknown_session() {
        let l = fresh();
        assert!(
            l.get_session_capabilities("never-existed")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn record_session_capabilities_idempotent_on_session_pk() {
        // Every spawn's handshake re-persists; only the most recent
        // catalog matters. Same-session writes overwrite, never
        // duplicate-key.
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        let v1 = sample_capabilities_payload("2.1.204");
        let v2 = sample_capabilities_payload("2.1.207");
        l.record_session_capabilities("s1", &v1, 1_000).unwrap();
        l.record_session_capabilities("s1", &v2, 2_000).unwrap();
        let read = l.get_session_capabilities("s1").unwrap().unwrap();
        assert_eq!(read.payload, v2);
        assert_eq!(read.captured_at, 2_000);
    }

    #[test]
    fn cascade_delete_removes_session_capabilities_when_session_deleted() {
        // Pin the `session_capabilities_cascade_delete_on_session`
        // trigger: trashing a session also removes its capabilities row.
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        l.mark_closed("s1").unwrap();
        l.record_session_capabilities("s1", &sample_capabilities_payload("2.1.207"), 1_000)
            .unwrap();
        assert!(l.get_session_capabilities("s1").unwrap().is_some());

        l.trash("s1").unwrap();

        assert!(
            l.get_session_capabilities("s1").unwrap().is_none(),
            "cascade trigger must purge session_capabilities when parent session row is deleted",
        );
    }

    // ---- context_breakdown_latest table --------------------------------

    fn sample_breakdown_payload(messages_tokens: i64, autocompact_enabled: bool) -> Vec<u8> {
        let mut categories = vec![
            serde_json::json!({ "id": "system_prompt", "label": "System prompt", "tokens": 4_200 }),
            serde_json::json!({ "id": "system_tools",  "label": "System tools",  "tokens": 9_100 }),
            serde_json::json!({ "id": "custom_agents", "label": "Custom agents", "tokens": 14_600 }),
            serde_json::json!({ "id": "memory_files",  "label": "Memory files",  "tokens": 1_080 }),
            serde_json::json!({ "id": "skills",        "label": "Skills",        "tokens": 10_700 }),
            serde_json::json!({ "id": "messages",      "label": "Messages",      "tokens": messages_tokens }),
        ];
        if autocompact_enabled {
            categories.push(serde_json::json!({
                "id": "autocompact_buffer",
                "label": "Autocompact buffer",
                "tokens": 33_000,
            }));
        }
        serde_json::json!({
            "type": "context_breakdown",
            "tug_session_id": "s1",
            "context_max": 200_000,
            "categories": categories,
        })
        .to_string()
        .into_bytes()
    }

    #[test]
    fn record_context_breakdown_round_trip() {
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        let payload = sample_breakdown_payload(38_500, false);
        l.record_context_breakdown("s1", &payload, 5_000).unwrap();
        let read = l.get_context_breakdown("s1").unwrap().unwrap();
        assert_eq!(read.session_id, "s1");
        assert_eq!(read.payload, payload);
        assert_eq!(read.captured_at, 5_000);
    }

    #[test]
    fn get_context_breakdown_returns_none_for_unknown_session() {
        let l = fresh();
        assert!(l.get_context_breakdown("never-existed").unwrap().is_none());
    }

    #[test]
    fn record_context_breakdown_idempotent_on_session_pk() {
        // Steady-state operation: tugcode emits a fresh frame on every
        // turn_complete, and the reducer dispatches one persist per
        // frame. Writes for the same session must overwrite, not
        // duplicate-key. Mirrors `record_session_metadata` semantics.
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        let v1 = sample_breakdown_payload(10_000, false);
        let v2 = sample_breakdown_payload(42_000, true);
        l.record_context_breakdown("s1", &v1, 1_000).unwrap();
        l.record_context_breakdown("s1", &v2, 2_000).unwrap();
        let read = l.get_context_breakdown("s1").unwrap().unwrap();
        assert_eq!(read.payload, v2);
        assert_eq!(read.captured_at, 2_000);
    }

    #[test]
    fn record_context_breakdown_accepts_arbitrary_blob() {
        // The schema column type is BLOB with no JSON validation, so
        // the ledger persists whatever bytes the caller hands it.
        // Round-trip succeeds; downstream JSON deserialization is the
        // supervisor / renderer's responsibility (and the renderer
        // already falls back to the cost_update-derived view on a
        // parse failure — see the "Fallback contract" section of the
        // parent plan step).
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        let garbage = b"this-is-not-json".to_vec();
        l.record_context_breakdown("s1", &garbage, 1_000).unwrap();
        let read = l.get_context_breakdown("s1").unwrap().unwrap();
        assert_eq!(read.payload, garbage);
    }

    #[test]
    fn get_context_breakdown_filters_by_session() {
        // Sessions are isolated; a write to one must not surface on a
        // read of another. The popover binds per-session, so cross-
        // session bleed would surface as the wrong breakdown in the
        // wrong card.
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        seed_live(&l, "s2", "ws", "card-2", millis(0));
        let p1 = sample_breakdown_payload(10_000, false);
        let p2 = sample_breakdown_payload(88_000, true);
        l.record_context_breakdown("s1", &p1, 1_000).unwrap();
        l.record_context_breakdown("s2", &p2, 1_000).unwrap();
        assert_eq!(l.get_context_breakdown("s1").unwrap().unwrap().payload, p1);
        assert_eq!(l.get_context_breakdown("s2").unwrap().unwrap().payload, p2);
    }

    #[test]
    fn cascade_delete_removes_context_breakdown_when_session_deleted() {
        // Pin the `context_breakdown_latest_cascade_delete_on_session`
        // trigger: trashing a session also removes its breakdown row.
        // The user-visible "trash cascades" contract extends to the
        // context breakdown.
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        l.mark_closed("s1").unwrap();
        l.record_context_breakdown("s1", &sample_breakdown_payload(5_000, false), 1_000)
            .unwrap();
        assert!(l.get_context_breakdown("s1").unwrap().is_some());

        l.trash("s1").unwrap();

        assert!(
            l.get_context_breakdown("s1").unwrap().is_none(),
            "cascade trigger must purge context_breakdown_latest when parent session row is deleted",
        );
    }

    // ---- session_state_changes table -----------------------------------

    #[test]
    fn record_session_state_change_appends_distinct_triples() {
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        assert!(
            l.record_session_state_change("s1", 100, "idle", "online", false)
                .unwrap()
        );
        assert!(
            l.record_session_state_change("s1", 200, "submitting", "online", false)
                .unwrap()
        );
        assert!(
            l.record_session_state_change("s1", 300, "submitting", "offline", false)
                .unwrap()
        );
        let rows = l.list_session_state_changes("s1").unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].phase, "idle");
        assert_eq!(rows[0].transport_state, "online");
        assert!(!rows[0].interrupt_in_flight);
        assert_eq!(rows[1].phase, "submitting");
        assert_eq!(rows[2].transport_state, "offline");
        // ids are monotonic in insertion order
        assert!(rows[0].id < rows[1].id);
        assert!(rows[1].id < rows[2].id);
        // at_ms is preserved verbatim
        assert_eq!(rows[0].at_ms, 100);
        assert_eq!(rows[1].at_ms, 200);
        assert_eq!(rows[2].at_ms, 300);
    }

    #[test]
    fn record_session_state_change_dedupes_against_most_recent_triple() {
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        assert!(
            l.record_session_state_change("s1", 100, "idle", "online", false)
                .unwrap()
        );
        // Same triple — dedupes (returns false; no row written).
        assert!(
            !l.record_session_state_change("s1", 150, "idle", "online", false)
                .unwrap()
        );
        assert!(
            !l.record_session_state_change("s1", 200, "idle", "online", false)
                .unwrap()
        );
        // A real change — accepted.
        assert!(
            l.record_session_state_change("s1", 300, "submitting", "online", false)
                .unwrap()
        );
        // Now back to the original triple — accepted again, because
        // the dedupe is against the MOST RECENT row, not "has this
        // ever been written."
        assert!(
            l.record_session_state_change("s1", 400, "idle", "online", false)
                .unwrap()
        );
        let rows = l.list_session_state_changes("s1").unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].at_ms, 100);
        assert_eq!(rows[1].at_ms, 300);
        assert_eq!(rows[2].at_ms, 400);
    }

    #[test]
    fn record_session_state_change_detects_interrupt_axis_flip() {
        // Dedupe must compare ALL three axes — flipping
        // `interrupt_in_flight` without changing phase or transport
        // produces a new row.
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        l.record_session_state_change("s1", 100, "submitting", "online", false)
            .unwrap();
        assert!(
            l.record_session_state_change("s1", 200, "submitting", "online", true)
                .unwrap()
        );
        assert!(
            l.record_session_state_change("s1", 300, "submitting", "online", false)
                .unwrap()
        );
        let rows = l.list_session_state_changes("s1").unwrap();
        assert_eq!(rows.len(), 3);
        let flags: Vec<bool> = rows.iter().map(|r| r.interrupt_in_flight).collect();
        assert_eq!(flags, vec![false, true, false]);
    }

    #[test]
    fn list_session_state_changes_filters_by_session() {
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        seed_live(&l, "s2", "ws", "card-2", millis(0));
        l.record_session_state_change("s1", 100, "idle", "online", false)
            .unwrap();
        l.record_session_state_change("s2", 200, "submitting", "online", false)
            .unwrap();
        l.record_session_state_change("s1", 300, "submitting", "online", false)
            .unwrap();
        let s1 = l.list_session_state_changes("s1").unwrap();
        let s2 = l.list_session_state_changes("s2").unwrap();
        assert_eq!(s1.len(), 2);
        assert_eq!(s2.len(), 1);
        assert!(s1.iter().all(|r| r.session_id == "s1"));
        assert!(s2.iter().all(|r| r.session_id == "s2"));
    }

    #[test]
    fn list_session_state_changes_returns_empty_for_unknown_session() {
        let l = fresh();
        assert_eq!(
            l.list_session_state_changes("never-existed").unwrap().len(),
            0
        );
    }

    #[test]
    fn cascade_delete_removes_session_state_changes_when_session_deleted() {
        // Pin the `session_state_changes_cascade_delete_on_session`
        // trigger: trashing a session must take its state-change log
        // with it. Same "trash cascades" contract as the other
        // session-scoped tables in this file.
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        l.record_session_state_change("s1", 100, "idle", "online", false)
            .unwrap();
        l.record_session_state_change("s1", 200, "submitting", "online", false)
            .unwrap();
        l.mark_closed("s1").unwrap();
        assert_eq!(l.list_session_state_changes("s1").unwrap().len(), 2);

        l.trash("s1").unwrap();

        assert_eq!(
            l.list_session_state_changes("s1").unwrap().len(),
            0,
            "cascade trigger must purge session_state_changes when parent session row is deleted",
        );
    }

    #[test]
    fn record_session_state_change_writes_independently_per_session() {
        // Dedupe is scoped to the session: writing triple X for s1 must
        // not block triple X for s2 (cross-session bleed would mean a
        // popover renders the wrong card's history).
        let l = fresh();
        seed_live(&l, "s1", "ws", "card-1", millis(0));
        seed_live(&l, "s2", "ws", "card-2", millis(0));
        assert!(
            l.record_session_state_change("s1", 100, "idle", "online", false)
                .unwrap()
        );
        assert!(
            l.record_session_state_change("s2", 100, "idle", "online", false)
                .unwrap()
        );
        assert_eq!(l.list_session_state_changes("s1").unwrap().len(), 1);
        assert_eq!(l.list_session_state_changes("s2").unwrap().len(), 1);
    }

    #[test]
    fn default_path_routes_via_tug_instance_id() {
        use std::ffi::OsString;
        use std::sync::Mutex;

        // `default_path` reads from the process environment. Use a mutex
        // to serialize the two cases (set / unset) so other tests using
        // env-var-keyed paths can't race us.
        static ENV_MUTEX: Mutex<()> = Mutex::new(());
        let _guard = ENV_MUTEX.lock().unwrap();

        // The `TUG_SESSIONS_DB` override resolves ahead of everything this
        // test is about, and the cargo test env forces one. Lift it for the
        // duration so the layers beneath it are the ones being read.
        let prior_db: Option<OsString> = std::env::var_os("TUG_SESSIONS_DB");
        unsafe {
            std::env::remove_var("TUG_SESSIONS_DB");
        }
        let prior: Option<OsString> = std::env::var_os("TUG_INSTANCE_ID");
        unsafe {
            std::env::set_var("TUG_INSTANCE_ID", "ledger-test");
        }
        let p = SessionLedger::default_path().expect("default_path with id");
        assert!(
            p.ends_with("Tug/instances/ledger-test/sessions.db"),
            "expected per-instance path, got {}",
            p.display()
        );

        unsafe {
            std::env::remove_var("TUG_INSTANCE_ID");
        }
        let p = SessionLedger::default_path().expect("default_path legacy");
        assert!(
            p.ends_with("sessions.db") && !p.to_string_lossy().contains("/instances/"),
            "expected legacy path, got {}",
            p.display()
        );

        unsafe {
            match prior {
                Some(v) => std::env::set_var("TUG_INSTANCE_ID", v),
                None => std::env::remove_var("TUG_INSTANCE_ID"),
            }
            if let Some(v) = prior_db {
                std::env::set_var("TUG_SESSIONS_DB", v);
            }
        }
    }

    // ── the ink anchor: reading a transcript's newest assistant message id ────

    /// A ledger whose Claude transcripts live under a tempdir, so an anchor
    /// read has a real file to walk.
    struct AnchorFixture {
        sessions: SessionLedger,
        _dir: tempfile::TempDir,
    }

    impl AnchorFixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("tempdir");
            let sessions = SessionLedger::open_with_claude_root(
                dir.path().join("sessions.db"),
                dir.path().join("projects"),
            )
            .expect("ledger");
            Self {
                sessions,
                _dir: dir,
            }
        }

        /// Seed a session row and write `body` as its transcript.
        fn seed(&self, session: &str, body: &str) {
            self.sessions
                .record_spawn(session, "ws", "/proj", "card-1", 1, session, None)
                .expect("record_spawn");
            let (dir, _) = claude_project_dir(self.sessions.claude_projects_root(), "/proj");
            std::fs::create_dir_all(&dir).expect("create project dir");
            std::fs::write(dir.join(format!("{session}.jsonl")), body).expect("write jsonl");
        }
    }

    fn assistant_line(id: &str) -> String {
        format!(
            "{{\"type\":\"assistant\",\"message\":{{\"id\":\"{id}\",\"role\":\"assistant\"}}}}\n"
        )
    }

    #[test]
    fn the_anchor_is_the_newest_assistant_message_id() {
        let fx = AnchorFixture::new();
        let body = format!(
            "{}{}{}{}",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\"}}\n",
            assistant_line("msg_01FIRST"),
            "{\"type\":\"user\",\"message\":{\"role\":\"user\"}}\n",
            assistant_line("msg_01LAST"),
        );
        fx.seed("s1", &body);

        assert_eq!(
            fx.sessions.latest_assistant_msg_id("s1", None).as_deref(),
            Some("msg_01LAST"),
        );
    }

    #[test]
    fn trailing_non_assistant_lines_do_not_hide_the_anchor() {
        // A receipt is written after the turn settles, and what sits between
        // the turn's last assistant line and EOF is exactly this: results,
        // summaries, the next user prompt.
        let fx = AnchorFixture::new();
        let body = format!(
            "{}{}{}",
            assistant_line("msg_01ANCHOR"),
            "{\"type\":\"user\",\"message\":{\"role\":\"user\"}}\n",
            "{\"type\":\"summary\",\"summary\":\"a compaction line\"}\n",
        );
        fx.seed("s1", &body);

        assert_eq!(
            fx.sessions.latest_assistant_msg_id("s1", None).as_deref(),
            Some("msg_01ANCHOR"),
        );
    }

    #[test]
    fn sidechain_and_meta_assistant_lines_are_never_the_anchor() {
        // Replay drops both, so their ids never become a turn's `msgId` — an
        // anchor naming one could never resolve on the deck.
        let fx = AnchorFixture::new();
        let body = format!(
            "{}{}{}",
            assistant_line("msg_01REAL"),
            "{\"type\":\"assistant\",\"isSidechain\":true,\"message\":{\"id\":\"msg_01SIDE\"}}\n",
            "{\"type\":\"assistant\",\"isMeta\":true,\"message\":{\"id\":\"msg_01META\"}}\n",
        );
        fx.seed("s1", &body);

        assert_eq!(
            fx.sessions.latest_assistant_msg_id("s1", None).as_deref(),
            Some("msg_01REAL"),
        );
    }

    #[test]
    fn a_malformed_line_is_skipped_rather_than_fatal() {
        let fx = AnchorFixture::new();
        let body = format!(
            "{}{}{}",
            assistant_line("msg_01GOOD"),
            "{ this is not json\n",
            "\n",
        );
        fx.seed("s1", &body);

        assert_eq!(
            fx.sessions.latest_assistant_msg_id("s1", None).as_deref(),
            Some("msg_01GOOD"),
        );
    }

    #[test]
    fn an_assistant_line_with_no_message_id_is_not_an_anchor() {
        let fx = AnchorFixture::new();
        let body = format!(
            "{}{}",
            assistant_line("msg_01REAL"),
            "{\"type\":\"assistant\",\"message\":{\"id\":\"\"}}\n",
        );
        fx.seed("s1", &body);

        assert_eq!(
            fx.sessions.latest_assistant_msg_id("s1", None).as_deref(),
            Some("msg_01REAL"),
        );
    }

    #[test]
    fn the_anchor_read_survives_a_mid_line_seek_boundary() {
        // A long transcript: the read seeks to the last 64 KiB and lands in the
        // middle of some line. That partial first fragment is discarded, and
        // the real anchor further down the tail is still found.
        let fx = AnchorFixture::new();
        let filler = "x".repeat(4_000);
        let mut body = String::new();
        for i in 0..40 {
            body.push_str(&format!(
                "{{\"type\":\"user\",\"n\":{i},\"pad\":\"{filler}\"}}\n"
            ));
        }
        body.push_str(&assistant_line("msg_01TAIL"));
        body.push_str("{\"type\":\"user\",\"message\":{\"role\":\"user\"}}\n");
        fx.seed("s1", &body);
        assert!(
            body.len() as u64 > ANCHOR_TAIL_BYTES,
            "the fixture must actually exceed the tail window",
        );

        assert_eq!(
            fx.sessions.latest_assistant_msg_id("s1", None).as_deref(),
            Some("msg_01TAIL"),
        );
    }

    #[test]
    fn an_anchor_older_than_the_tail_window_is_a_none_not_a_wrong_guess() {
        // The one documented loss: a turn whose distance to EOF exceeds the
        // window. It degrades to the timestamp fallback rather than reaching
        // for a nearer line that is not the turn the row follows.
        let fx = AnchorFixture::new();
        let filler = "x".repeat(4_000);
        let mut body = assistant_line("msg_01FARBACK");
        for i in 0..40 {
            body.push_str(&format!(
                "{{\"type\":\"user\",\"n\":{i},\"pad\":\"{filler}\"}}\n"
            ));
        }
        fx.seed("s1", &body);

        assert_eq!(fx.sessions.latest_assistant_msg_id("s1", None), None);
    }

    #[test]
    fn a_transcript_with_no_assistant_line_yields_no_anchor() {
        let fx = AnchorFixture::new();
        fx.seed(
            "s1",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\"}}\n",
        );
        assert_eq!(fx.sessions.latest_assistant_msg_id("s1", None), None);
    }

    #[test]
    fn an_empty_transcript_yields_no_anchor() {
        let fx = AnchorFixture::new();
        fx.seed("s1", "");
        assert_eq!(fx.sessions.latest_assistant_msg_id("s1", None), None);
    }

    #[test]
    fn a_missing_transcript_or_unknown_session_yields_no_anchor() {
        let fx = AnchorFixture::new();
        // A session row with no file on disk — a zero-turn session.
        fx.sessions
            .record_spawn("s1", "ws", "/proj", "card-1", 1, "s1", None)
            .expect("record_spawn");
        assert_eq!(fx.sessions.latest_assistant_msg_id("s1", None), None);
        // And a session the ledger has never heard of, from either source.
        assert_eq!(fx.sessions.latest_assistant_msg_id("nobody", None), None);
        assert_eq!(
            fx.sessions.latest_assistant_msg_id("nobody", Some("/proj")),
            None
        );
    }

    #[test]
    fn a_caller_supplied_project_dir_reads_the_transcript_with_no_session_row() {
        // The window the app-test found: a card accepts a `$` command seconds
        // before tugcode announces its session and the ledger row is written.
        // Looking the project dir up in a row that does not exist yet stamps a
        // NULL anchor on a session whose transcript is on disk the whole time,
        // so every gateway passes the project dir it already holds.
        let fx = AnchorFixture::new();
        let (dir, _) = claude_project_dir(fx.sessions.claude_projects_root(), "/proj");
        std::fs::create_dir_all(&dir).expect("create project dir");
        std::fs::write(dir.join("unannounced.jsonl"), assistant_line("msg_01EARLY"))
            .expect("write jsonl");

        assert_eq!(
            fx.sessions.latest_assistant_msg_id("unannounced", None),
            None,
            "the ledger cannot answer for a session it has never seen",
        );
        assert_eq!(
            fx.sessions
                .latest_assistant_msg_id("unannounced", Some("/proj"))
                .as_deref(),
            Some("msg_01EARLY"),
        );
    }

    #[test]
    fn the_caller_supplied_project_dir_wins_over_the_row() {
        // Two spellings of one session cannot both be right, and the caller's
        // is the one that located the shell it is writing ink for.
        let fx = AnchorFixture::new();
        fx.seed("s1", &assistant_line("msg_01ROW"));
        let (other, _) = claude_project_dir(fx.sessions.claude_projects_root(), "/elsewhere");
        std::fs::create_dir_all(&other).expect("create project dir");
        std::fs::write(other.join("s1.jsonl"), assistant_line("msg_01CALLER"))
            .expect("write jsonl");

        assert_eq!(
            fx.sessions
                .latest_assistant_msg_id("s1", Some("/elsewhere"))
                .as_deref(),
            Some("msg_01CALLER"),
        );
        // An empty hint is not a hint; the row still answers.
        assert_eq!(
            fx.sessions
                .latest_assistant_msg_id("s1", Some(""))
                .as_deref(),
            Some("msg_01ROW"),
        );
    }
}
