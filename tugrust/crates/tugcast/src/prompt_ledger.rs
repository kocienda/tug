//! PromptLedger — sqlite-backed persistence for the user's prompt corpus.
//!
//! One append-only row per prompt submitted from a Session card's composer,
//! keyed by `session_id` (the tug session id, stable across `--resume`). The
//! deck's Up-arrow recall reads it back a page at a time; nothing else writes
//! it, and nothing deletes from it.
//!
//! **Machine-global**, beside `changes.db` rather than inside an instance
//! directory (`tugcore::instance::prompt_history_db_path`): the prompts are
//! the user's corpus, not an instance's, so a release build and a debug build
//! recall the same history. Several tugcast processes may therefore append
//! concurrently — WAL plus the 5 s busy timeout from
//! `tugcore::ledger_db::apply_pragmas` covers it, because an append is one
//! short single-row transaction.
//!
//! **Nothing here trims.** The corpus is unbounded on purpose: the previous
//! home for this data (a tugbank defaults domain, re-serialized into the boot
//! frame on every write) forced entry caps, a byte cap, and a thumbnail cap,
//! and each of those silently destroyed prompts the user had written. Row
//! storage has no such pressure — a prompt averages a couple hundred bytes,
//! so a hundred thousand of them cost tens of megabytes.
//!
//! Atoms persist as **references, never pixels**: the JSON in `atoms_json`
//! carries the stored original's `path`, and previews are re-baked from those
//! bytes on recall. The one consequence for the rest of the tree is that
//! `draft_gc` must treat this table as a reachability root — an attachment
//! referenced only by a prompt row is still referenced (see `draft_gc`).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};
use tugbank_core::TugbankClient;

/// Current on-disk schema version, stamped into `PRAGMA user_version`.
pub const PROMPT_HISTORY_SCHEMA_VERSION: i64 = 1;

/// Registered migrations, each keyed by the on-disk version it upgrades *from*.
/// Every migration whose `from` is at or above the version found on disk is
/// applied in order. Empty at v1; a schema change adds an entry here and bumps
/// [`PROMPT_HISTORY_SCHEMA_VERSION`] — never edits the DDL below alone.
const PROMPT_HISTORY_MIGRATIONS: &[(i64, &str)] = &[];

const CREATE_PROMPT_HISTORY_SQL: &str = "
    CREATE TABLE IF NOT EXISTS prompt_history (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id       TEXT    NOT NULL,
        route            TEXT    NOT NULL,
        text             TEXT    NOT NULL,
        atoms_json       TEXT    NOT NULL,
        project_path     TEXT    NOT NULL,
        submitted_at_ms  INTEGER NOT NULL,
        client_entry_id  TEXT    NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_prompt_history_session
        ON prompt_history(session_id, id);
";

#[derive(Debug, thiserror::Error)]
pub enum PromptLedgerError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("prompt history schema on disk is v{on_disk}, newer than this build's v{supported}")]
    SchemaTooNew { on_disk: i64, supported: i64 },
}

/// A prompt to append. `client_entry_id` is minted by the composer and carries
/// the idempotency contract: a retried append, or a re-run migration, lands the
/// same row once.
#[derive(Debug, Clone)]
pub struct NewPromptEntry {
    pub session_id: String,
    pub route: String,
    pub text: String,
    /// Serialized reference-only atom array (`[]` when the prompt had none).
    pub atoms_json: String,
    pub project_path: String,
    pub submitted_at_ms: i64,
    pub client_entry_id: String,
}

/// A persisted prompt, serialized into the page-read response. `atoms` is the
/// parsed array rather than the stored string — the deck consumes objects.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PromptRow {
    pub id: i64,
    pub session_id: String,
    pub route: String,
    pub text: String,
    pub atoms: serde_json::Value,
    pub project_path: String,
    pub submitted_at_ms: i64,
    pub client_entry_id: String,
}

pub struct PromptLedger {
    db: Mutex<Connection>,
}

impl PromptLedger {
    /// The machine-global ledger path. Distinct from every other ledger's
    /// `default_path`, which derive from the per-instance data dir.
    pub fn default_path() -> PathBuf {
        tugcore::instance::prompt_history_db_path()
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, PromptLedgerError> {
        // Integrity gate: quarantine a corrupt file and salvage readable rows
        // into the fresh one (see `ledger_integrity`).
        let gate = crate::ledger_integrity::integrity_gate(path.as_ref(), "prompt-history");
        let conn = tugcore::ledger_db::open(path)?;
        let ledger = Self::from_conn(conn)?;
        if let crate::ledger_integrity::GateOutcome::Quarantined { corrupt_path } = &gate {
            let db = ledger.db.lock().expect("prompt ledger poisoned");
            crate::ledger_integrity::salvage_into(
                &db,
                "main",
                corrupt_path,
                &["prompt_history"],
                "prompt-history",
            );
        }
        Ok(ledger)
    }

    /// In-memory ledger for tests.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, PromptLedgerError> {
        let conn = Connection::open_in_memory()?;
        Self::from_conn(conn)
    }

    fn from_conn(conn: Connection) -> Result<Self, PromptLedgerError> {
        tugcore::ledger_db::apply_pragmas(&conn)?;
        // A version newer than this build means a newer instance owns the
        // shape: refuse the open outright rather than writing rows against an
        // unknown schema. The caller treats an unopenable ledger as absent,
        // and an absent ledger is loud on both sides — the routes unregister
        // and the composer says so.
        let on_disk: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if on_disk > PROMPT_HISTORY_SCHEMA_VERSION {
            return Err(PromptLedgerError::SchemaTooNew {
                on_disk,
                supported: PROMPT_HISTORY_SCHEMA_VERSION,
            });
        }
        if on_disk > 0 && on_disk < PROMPT_HISTORY_SCHEMA_VERSION {
            for (from, sql) in PROMPT_HISTORY_MIGRATIONS {
                if *from >= on_disk {
                    conn.execute_batch(sql)?;
                }
            }
        }
        conn.execute_batch(CREATE_PROMPT_HISTORY_SQL)?;
        conn.pragma_update(None, "user_version", PROMPT_HISTORY_SCHEMA_VERSION)?;
        Ok(Self {
            db: Mutex::new(conn),
        })
    }

    /// Append one prompt and return its ledger id. A `client_entry_id` already
    /// present is not re-inserted; the existing row's id comes back, which is
    /// what makes both the client's retry ladder and the tugbank import
    /// idempotent.
    pub fn append(&self, entry: &NewPromptEntry) -> Result<i64, PromptLedgerError> {
        let conn = self.db.lock().expect("prompt ledger mutex");
        let inserted = conn.execute(
            "INSERT INTO prompt_history
                (session_id, route, text, atoms_json, project_path, submitted_at_ms, client_entry_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(client_entry_id) DO NOTHING",
            params![
                entry.session_id,
                entry.route,
                entry.text,
                entry.atoms_json,
                entry.project_path,
                entry.submitted_at_ms,
                entry.client_entry_id,
            ],
        )?;
        if inserted > 0 {
            return Ok(conn.last_insert_rowid());
        }
        let id: i64 = conn.query_row(
            "SELECT id FROM prompt_history WHERE client_entry_id = ?1",
            params![entry.client_entry_id],
            |r| r.get(0),
        )?;
        Ok(id)
    }

    /// One keyset page of a session's prompts, newest-backward: rows strictly
    /// older than `before` (the whole tail when `None`), at most `limit` of
    /// them, returned **ascending** so the deck can prepend a page as a block.
    /// The bool is `has_more` — whether older rows remain past this page.
    ///
    /// Keyset rather than offset because the table grows under the reader: an
    /// `OFFSET` page slides by one every time a prompt is appended mid-scroll,
    /// silently skipping a row.
    pub fn list_page(
        &self,
        session_id: &str,
        before: Option<i64>,
        limit: usize,
    ) -> Result<(Vec<PromptRow>, bool), PromptLedgerError> {
        let conn = self.db.lock().expect("prompt ledger mutex");
        let mut stmt = conn.prepare(
            "SELECT id, session_id, route, text, atoms_json, project_path, submitted_at_ms, client_entry_id FROM (
                 SELECT id, session_id, route, text, atoms_json, project_path, submitted_at_ms, client_entry_id
                 FROM prompt_history
                 WHERE session_id = ?1 AND (?2 IS NULL OR id < ?2)
                 ORDER BY id DESC LIMIT ?3
             ) ORDER BY id ASC",
        )?;
        // One row past the page is the probe: its existence — not its content —
        // is the answer to "is there more?".
        let rows = stmt.query_map(
            params![session_id, before, limit as i64 + 1],
            prompt_row_from,
        )?;
        let mut fetched = rows.collect::<Result<Vec<_>, _>>()?;
        let has_more = fetched.len() > limit;
        if has_more {
            // The page came back oldest-first, so the probe is at the front.
            fetched.remove(0);
        }
        Ok((fetched, has_more))
    }

    /// Complete a record whose attachment upload resolved after the prompt was
    /// submitted: set `path` on the one atom matching `atom_id`. The single
    /// permitted update on an append-only table, because it finishes a row
    /// rather than rewriting history.
    ///
    /// An absent entry or atom is `Ok(false)` and writes nothing — the backfill
    /// is best-effort by design (the card may close before the upload lands).
    pub fn set_atom_path(
        &self,
        client_entry_id: &str,
        atom_id: &str,
        path: &str,
    ) -> Result<bool, PromptLedgerError> {
        let conn = self.db.lock().expect("prompt ledger mutex");
        let stored: Option<String> = conn
            .query_row(
                "SELECT atoms_json FROM prompt_history WHERE client_entry_id = ?1",
                params![client_entry_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(stored) = stored else {
            return Ok(false);
        };
        let Ok(mut atoms) = serde_json::from_str::<Vec<serde_json::Value>>(&stored) else {
            return Ok(false);
        };
        let mut patched = false;
        for atom in atoms.iter_mut() {
            let matches = atom.get("id").and_then(|v| v.as_str()) == Some(atom_id);
            if matches {
                if let Some(obj) = atom.as_object_mut() {
                    obj.insert(
                        "path".to_string(),
                        serde_json::Value::String(path.to_string()),
                    );
                    patched = true;
                }
            }
        }
        if !patched {
            return Ok(false);
        }
        conn.execute(
            "UPDATE prompt_history SET atoms_json = ?1 WHERE client_entry_id = ?2",
            params![serde_json::Value::Array(atoms).to_string(), client_entry_id],
        )?;
        Ok(true)
    }

    /// Every `atoms_json` string that could name an attachment — the prompt
    /// ledger's contribution to the `draft_gc` reachability root set. Rows with
    /// no atoms cannot reference anything, so they are skipped.
    pub fn atoms_json_with_refs(&self) -> Result<Vec<String>, PromptLedgerError> {
        let conn = self.db.lock().expect("prompt ledger mutex");
        let mut stmt =
            conn.prepare("SELECT atoms_json FROM prompt_history WHERE atoms_json != '[]'")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Whether a row with this client entry id is present. The migration's
    /// verification step, run before it deletes anything.
    pub fn has_entry(&self, client_entry_id: &str) -> Result<bool, PromptLedgerError> {
        let conn = self.db.lock().expect("prompt ledger mutex");
        let found: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM prompt_history WHERE client_entry_id = ?1",
                params![client_entry_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    }
}

/// One entry as the retired tugbank domain stored it. Camel-cased because it
/// was written by the deck; `sessionId` and `projectPath` are optional because
/// the shape predates both.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyHistoryEntry {
    id: String,
    route: String,
    text: String,
    timestamp: i64,
    #[serde(default)]
    project_path: String,
    #[serde(default)]
    atoms: Vec<serde_json::Value>,
}

/// The reference-only form of a legacy atom: the same object with any persisted
/// thumbnail dropped. Pixels were never the durable part — the stored original
/// at `path` is, and the preview re-bakes from it on recall.
fn strip_atom_pixels(atom: &serde_json::Value) -> serde_json::Value {
    let mut atom = atom.clone();
    if let Some(obj) = atom.as_object_mut() {
        obj.remove("thumbnailDataUrl");
    }
    atom
}

/// Import the tugbank prompt-history domain into the ledger and retire it.
///
/// Per key: parse the stored list, append every entry, verify every one of them
/// is readable back out of the ledger, and only then delete the tugbank key.
/// Returns how many entries were imported.
///
/// The ordering is the whole safety story, and it is the same shape the
/// attachment migration uses: a crash or a failure at any point leaves the
/// tugbank key in place, so an entry can exist in both homes but never in
/// neither. `UNIQUE(client_entry_id)` makes the re-run harmless.
///
/// A key whose value will not parse, or whose entries will not verify, is left
/// where it is with a `warn!` and retried next launch — one bad key never costs
/// its neighbours their migration.
///
/// The tugbank **key** is the session id, because it is the identity the deck
/// fetched the list under; the per-entry `sessionId` field is not consulted, so
/// migration cannot split one session's recall across two.
pub fn migrate_prompt_history(bank: &TugbankClient, ledger: &PromptLedger) -> usize {
    let snapshot = match bank.read_domain(crate::defaults::PROMPT_HISTORY_DOMAIN) {
        Ok(snapshot) => snapshot,
        Err(err) => {
            warn!(error = %err, "prompt-history migration: domain unreadable; nothing imported");
            return 0;
        }
    };
    let mut imported = 0usize;
    for (session_id, value) in snapshot {
        // The domain has been written as both a JSON value and a JSON string
        // over its life; both are the same list.
        let parsed: Result<Vec<LegacyHistoryEntry>, _> = match &value {
            tugbank_core::Value::Json(json) => serde_json::from_value(json.clone()),
            tugbank_core::Value::String(text) => serde_json::from_str(text),
            _ => {
                warn!(session = %session_id, "prompt-history migration: unexpected value kind; key left in place");
                continue;
            }
        };
        let entries = match parsed {
            Ok(entries) => entries,
            Err(err) => {
                warn!(session = %session_id, error = %err, "prompt-history migration: unparseable value; key left in place");
                continue;
            }
        };

        let mut client_entry_ids = Vec::with_capacity(entries.len());
        let mut failed = false;
        for entry in &entries {
            let atoms: Vec<serde_json::Value> = entry.atoms.iter().map(strip_atom_pixels).collect();
            let new = NewPromptEntry {
                session_id: session_id.clone(),
                route: entry.route.clone(),
                text: entry.text.clone(),
                atoms_json: serde_json::Value::Array(atoms).to_string(),
                project_path: entry.project_path.clone(),
                submitted_at_ms: entry.timestamp,
                client_entry_id: entry.id.clone(),
            };
            if let Err(err) = ledger.append(&new) {
                warn!(session = %session_id, error = %err, "prompt-history migration: append failed; key left in place");
                failed = true;
                break;
            }
            client_entry_ids.push(entry.id.clone());
        }
        if failed {
            continue;
        }

        // Verify before the old copy goes. A row that cannot be read back is
        // not migrated, whatever the insert reported.
        let verified = client_entry_ids
            .iter()
            .all(|id| ledger.has_entry(id).unwrap_or(false));
        if !verified {
            warn!(session = %session_id, "prompt-history migration: entries did not verify; key left in place");
            continue;
        }

        match bank.delete(crate::defaults::PROMPT_HISTORY_DOMAIN, &session_id) {
            Ok(_) => imported += client_entry_ids.len(),
            Err(err) => {
                // The rows are in the ledger and verified, so recall already
                // works; the stale key just costs a re-import next launch.
                warn!(session = %session_id, error = %err, "prompt-history migration: imported but tugbank key not removed");
                imported += client_entry_ids.len();
            }
        }
    }
    if imported > 0 {
        info!(count = imported, "imported prompt-history entries");
    }
    imported
}

fn prompt_row_from(row: &rusqlite::Row<'_>) -> rusqlite::Result<PromptRow> {
    let atoms_json: String = row.get(4)?;
    Ok(PromptRow {
        id: row.get(0)?,
        session_id: row.get(1)?,
        route: row.get(2)?,
        text: row.get(3)?,
        // An unparseable atom array degrades to "no atoms" rather than
        // failing the whole page: the prompt's text is the thing being
        // recalled, and it is still perfectly good.
        atoms: serde_json::from_str(&atoms_json)
            .unwrap_or_else(|_| serde_json::Value::Array(Vec::new())),
        project_path: row.get(5)?,
        submitted_at_ms: row.get(6)?,
        client_entry_id: row.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(session: &str, n: usize) -> NewPromptEntry {
        NewPromptEntry {
            session_id: session.to_string(),
            route: "❯".to_string(),
            text: format!("prompt {n}"),
            atoms_json: "[]".to_string(),
            project_path: String::new(),
            submitted_at_ms: 1_700_000_000_000 + n as i64,
            client_entry_id: format!("{session}-{n}"),
        }
    }

    #[test]
    fn append_assigns_monotonic_ids() {
        let ledger = PromptLedger::open_in_memory().unwrap();
        let a = ledger.append(&entry("s1", 1)).unwrap();
        let b = ledger.append(&entry("s1", 2)).unwrap();
        let c = ledger.append(&entry("s2", 3)).unwrap();
        assert!(a < b && b < c, "ids climb across sessions: {a} {b} {c}");
    }

    #[test]
    fn duplicate_client_entry_id_returns_the_original_id_and_inserts_nothing() {
        let ledger = PromptLedger::open_in_memory().unwrap();
        let first = ledger.append(&entry("s1", 1)).unwrap();

        // A retry carries the same client entry id with (possibly) different
        // freight; the row that already landed wins.
        let mut retry = entry("s1", 1);
        retry.text = "clobber attempt".to_string();
        let second = ledger.append(&retry).unwrap();

        assert_eq!(first, second, "the retry echoes the original id");
        let (rows, _) = ledger.list_page("s1", None, 50).unwrap();
        assert_eq!(rows.len(), 1, "no second row");
        assert_eq!(rows[0].text, "prompt 1", "the landed row is untouched");
    }

    #[test]
    fn list_page_returns_a_session_ascending_and_ignores_other_sessions() {
        let ledger = PromptLedger::open_in_memory().unwrap();
        for n in 1..=3 {
            ledger.append(&entry("s1", n)).unwrap();
        }
        ledger.append(&entry("s2", 9)).unwrap();

        let (rows, has_more) = ledger.list_page("s1", None, 50).unwrap();
        assert!(!has_more);
        assert_eq!(
            rows.iter().map(|r| r.text.as_str()).collect::<Vec<_>>(),
            ["prompt 1", "prompt 2", "prompt 3"],
        );
    }

    #[test]
    fn list_page_probes_has_more_across_page_boundaries() {
        let ledger = PromptLedger::open_in_memory().unwrap();
        for n in 1..=10 {
            ledger.append(&entry("s1", n)).unwrap();
        }

        // A page exactly the size of the remaining tail reports no more.
        let (all, has_more) = ledger.list_page("s1", None, 10).unwrap();
        assert_eq!(all.len(), 10);
        assert!(!has_more, "ten rows, page of ten: nothing older remains");

        // A short page reports more and hands back the NEWEST rows.
        let (newest, has_more) = ledger.list_page("s1", None, 4).unwrap();
        assert!(has_more);
        assert_eq!(
            newest.iter().map(|r| r.text.as_str()).collect::<Vec<_>>(),
            ["prompt 7", "prompt 8", "prompt 9", "prompt 10"],
        );
    }

    #[test]
    fn list_page_before_cursor_is_exclusive_and_walks_backward() {
        let ledger = PromptLedger::open_in_memory().unwrap();
        for n in 1..=10 {
            ledger.append(&entry("s1", n)).unwrap();
        }
        let (newest, _) = ledger.list_page("s1", None, 4).unwrap();
        let oldest_loaded = newest.first().unwrap().id;

        let (older, has_more) = ledger.list_page("s1", Some(oldest_loaded), 4).unwrap();
        assert!(has_more, "two rows still older than this page");
        assert_eq!(
            older.iter().map(|r| r.text.as_str()).collect::<Vec<_>>(),
            ["prompt 3", "prompt 4", "prompt 5", "prompt 6"],
            "the cursor row itself is excluded",
        );

        let (last, has_more) = ledger
            .list_page("s1", Some(older.first().unwrap().id), 4)
            .unwrap();
        assert!(!has_more, "the walk reaches the beginning");
        assert_eq!(
            last.iter().map(|r| r.text.as_str()).collect::<Vec<_>>(),
            ["prompt 1", "prompt 2"],
        );
    }

    #[test]
    fn set_atom_path_patches_only_the_matching_atom() {
        let ledger = PromptLedger::open_in_memory().unwrap();
        let mut e = entry("s1", 1);
        e.atoms_json = serde_json::json!([
            {"id": "atom-a", "position": 0, "type": "image", "label": "a.png", "value": "a.png"},
            {"id": "atom-b", "position": 8, "type": "image", "label": "b.png", "value": "b.png"},
        ])
        .to_string();
        ledger.append(&e).unwrap();

        assert!(
            ledger
                .set_atom_path("s1-1", "atom-b", "/tmp/draft/b.png")
                .unwrap()
        );

        let (rows, _) = ledger.list_page("s1", None, 10).unwrap();
        let atoms = rows[0].atoms.as_array().unwrap();
        assert!(atoms[0].get("path").is_none(), "atom-a is untouched");
        assert_eq!(atoms[1]["path"], "/tmp/draft/b.png");
    }

    #[test]
    fn set_atom_path_is_a_no_op_for_an_absent_entry_or_atom() {
        let ledger = PromptLedger::open_in_memory().unwrap();
        let mut e = entry("s1", 1);
        e.atoms_json =
            serde_json::json!([{"id": "atom-a", "position": 0, "type": "image"}]).to_string();
        ledger.append(&e).unwrap();

        assert!(!ledger.set_atom_path("nope", "atom-a", "/tmp/x").unwrap());
        assert!(!ledger.set_atom_path("s1-1", "atom-z", "/tmp/x").unwrap());

        let (rows, _) = ledger.list_page("s1", None, 10).unwrap();
        assert!(rows[0].atoms[0].get("path").is_none());
    }

    #[test]
    fn atoms_json_with_refs_skips_rows_that_cannot_reference_anything() {
        let ledger = PromptLedger::open_in_memory().unwrap();
        ledger.append(&entry("s1", 1)).unwrap();
        let mut with = entry("s1", 2);
        with.atoms_json =
            serde_json::json!([{"id": "atom-a", "path": "/tmp/draft/uuid.png"}]).to_string();
        ledger.append(&with).unwrap();

        let refs = ledger.atoms_json_with_refs().unwrap();
        assert_eq!(refs.len(), 1, "the atomless prompt contributes nothing");
        assert!(refs[0].contains("/tmp/draft/uuid.png"));
    }

    #[test]
    fn a_fresh_database_lands_at_the_current_schema_version() {
        let ledger = PromptLedger::open_in_memory().unwrap();
        let conn = ledger.db.lock().unwrap();
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, PROMPT_HISTORY_SCHEMA_VERSION);
    }

    // ── The tugbank import ──────────────────────────────────────────────────

    fn bank() -> (TugbankClient, tempfile::NamedTempFile) {
        let tmp = tempfile::NamedTempFile::new().expect("temp file");
        let bank = TugbankClient::open(tmp.path()).expect("open bank");
        (bank, tmp)
    }

    fn seed_legacy(bank: &TugbankClient, session: &str, value: serde_json::Value) {
        bank.set(
            crate::defaults::PROMPT_HISTORY_DOMAIN,
            session,
            tugbank_core::Value::Json(value),
        )
        .unwrap();
    }

    fn legacy_entry(session: &str, n: usize) -> serde_json::Value {
        serde_json::json!({
            "id": format!("{session}-{n}"),
            "sessionId": session,
            "route": "❯",
            "text": format!("legacy {n}"),
            "projectPath": "",
            "timestamp": 1_700_000_000_000i64 + n as i64,
            "atoms": [],
        })
    }

    #[test]
    fn migration_imports_every_entry_and_retires_the_key() {
        let (bank, _tmp) = bank();
        seed_legacy(
            &bank,
            "s1",
            serde_json::json!([legacy_entry("s1", 1), legacy_entry("s1", 2)]),
        );
        seed_legacy(&bank, "s2", serde_json::json!([legacy_entry("s2", 1)]));
        let ledger = PromptLedger::open_in_memory().unwrap();

        assert_eq!(migrate_prompt_history(&bank, &ledger), 3);

        let (s1, _) = ledger.list_page("s1", None, 50).unwrap();
        assert_eq!(
            s1.iter().map(|r| r.text.as_str()).collect::<Vec<_>>(),
            ["legacy 1", "legacy 2"],
        );
        let (s2, _) = ledger.list_page("s2", None, 50).unwrap();
        assert_eq!(s2.len(), 1, "entries land under their own session");

        let remaining = bank
            .read_domain(crate::defaults::PROMPT_HISTORY_DOMAIN)
            .unwrap();
        assert!(remaining.is_empty(), "every migrated key is retired");
    }

    /// A persisted thumbnail is dropped on the way in — the stored original is
    /// the durable part, and the preview re-bakes from it.
    #[test]
    fn migration_strips_thumbnails_but_keeps_the_stored_path() {
        let (bank, _tmp) = bank();
        seed_legacy(
            &bank,
            "s1",
            serde_json::json!([{
                "id": "s1-1",
                "route": "❯",
                "text": "look",
                "projectPath": "",
                "timestamp": 1i64,
                "atoms": [{
                    "id": "atom-a",
                    "position": 0,
                    "type": "image",
                    "label": "shot.png",
                    "value": "shot.png",
                    "path": "/d/uuid.png",
                    "thumbnailDataUrl": "data:image/png;base64,AAAA",
                }],
            }]),
        );
        let ledger = PromptLedger::open_in_memory().unwrap();

        assert_eq!(migrate_prompt_history(&bank, &ledger), 1);

        let (rows, _) = ledger.list_page("s1", None, 10).unwrap();
        let atom = &rows[0].atoms[0];
        assert_eq!(atom["path"], "/d/uuid.png");
        assert_eq!(atom["label"], "shot.png");
        assert!(
            atom.get("thumbnailDataUrl").is_none(),
            "no pixels persist: {atom}",
        );
    }

    /// Idempotence is the crash-safety story: a re-run inserts nothing new and
    /// cannot double a session's recall.
    #[test]
    fn a_second_migration_run_is_a_no_op() {
        let (bank, _tmp) = bank();
        seed_legacy(
            &bank,
            "s1",
            serde_json::json!([legacy_entry("s1", 1), legacy_entry("s1", 2)]),
        );
        let ledger = PromptLedger::open_in_memory().unwrap();
        assert_eq!(migrate_prompt_history(&bank, &ledger), 2);

        // Nothing is left in tugbank, so there is nothing to import.
        assert_eq!(migrate_prompt_history(&bank, &ledger), 0);

        // And the crash case: the key survived the delete last time.
        seed_legacy(
            &bank,
            "s1",
            serde_json::json!([legacy_entry("s1", 1), legacy_entry("s1", 2)]),
        );
        assert_eq!(migrate_prompt_history(&bank, &ledger), 2);
        let (rows, _) = ledger.list_page("s1", None, 50).unwrap();
        assert_eq!(rows.len(), 2, "the re-import added no duplicate rows");
    }

    /// One unparseable key costs only itself: its neighbours migrate, and it
    /// stays in place to be retried rather than being dropped on the floor.
    #[test]
    fn a_malformed_key_survives_while_its_neighbours_migrate() {
        let (bank, _tmp) = bank();
        seed_legacy(
            &bank,
            "s-good",
            serde_json::json!([legacy_entry("s-good", 1)]),
        );
        seed_legacy(
            &bank,
            "s-bad",
            serde_json::json!({"not": "a list of entries"}),
        );
        let ledger = PromptLedger::open_in_memory().unwrap();

        assert_eq!(migrate_prompt_history(&bank, &ledger), 1);

        let remaining = bank
            .read_domain(crate::defaults::PROMPT_HISTORY_DOMAIN)
            .unwrap();
        assert!(!remaining.contains_key("s-good"), "the good key retired");
        assert!(
            remaining.contains_key("s-bad"),
            "the bad key is kept for another launch",
        );
    }

    /// The domain was written as a JSON string in earlier vintages; both read.
    #[test]
    fn migration_accepts_a_list_stored_as_a_json_string() {
        let (bank, _tmp) = bank();
        bank.set(
            crate::defaults::PROMPT_HISTORY_DOMAIN,
            "s1",
            tugbank_core::Value::String(serde_json::json!([legacy_entry("s1", 1)]).to_string()),
        )
        .unwrap();
        let ledger = PromptLedger::open_in_memory().unwrap();

        assert_eq!(migrate_prompt_history(&bank, &ledger), 1);
        let (rows, _) = ledger.list_page("s1", None, 10).unwrap();
        assert_eq!(rows[0].text, "legacy 1");
    }

    /// An empty list is still a key worth retiring: it is what the domain is
    /// left holding for a session whose prompts were all evicted by the old
    /// caps, and leaving it behind keeps the domain alive for nothing.
    #[test]
    fn migration_retires_a_key_holding_an_empty_list() {
        let (bank, _tmp) = bank();
        seed_legacy(&bank, "s-empty", serde_json::json!([]));
        let ledger = PromptLedger::open_in_memory().unwrap();

        assert_eq!(migrate_prompt_history(&bank, &ledger), 0);
        let remaining = bank
            .read_domain(crate::defaults::PROMPT_HISTORY_DOMAIN)
            .unwrap();
        assert!(remaining.is_empty());
    }

    #[test]
    fn a_newer_schema_refuses_to_open() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", 999i64).unwrap();
        match PromptLedger::from_conn(conn) {
            Err(PromptLedgerError::SchemaTooNew { on_disk, supported }) => {
                assert_eq!((on_disk, supported), (999, PROMPT_HISTORY_SCHEMA_VERSION));
            }
            Err(other) => panic!("unexpected error: {other}"),
            Ok(_) => panic!("a newer schema must not open"),
        }
    }
}
