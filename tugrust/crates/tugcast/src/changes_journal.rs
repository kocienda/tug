//! Append-only journal for the machine-global changes ledger.
//!
//! Every mutation of the shared `changes.*` tables is appended here as
//! one fsync'd JSON line, under the same ledger mutex as the SQLite
//! apply and immediately after it — so the journal's order is the apply
//! order. A mutation is journaled when it landed (`touched > 0`) **and
//! when its apply failed**: a database degrading mid-run must not
//! swallow the durable record — the post-quarantine rebuild replays
//! exactly the writes the corrupt database refused. Only a no-op apply
//! (a replayed duplicate hitting its `ON CONFLICT DO NOTHING` key) is
//! skipped, so session replays never bloat the journal. The one window
//! the journal does not cover is a crash between a successful apply and
//! its append — that row exists in the database and is carried by
//! salvage and the `VACUUM INTO` snapshots instead.
//!
//! When the open-time integrity gate quarantines a corrupt `changes.db`,
//! the fresh database is reconstructed as: bootstrap schema → salvage
//! readable rows → **replay this journal**, whose records are idempotent
//! (inserts land on `ON CONFLICT DO NOTHING` / `INSERT OR REPLACE` keys,
//! deletes re-delete) so re-applying rows the salvage already carried is
//! harmless, and deletes the salvage resurrected are re-applied.
//!
//! The journal lives beside the database (`changes.db.journal.jsonl` for
//! `changes.db`) and is opened **only by the writer-claim owner** — an
//! open rotates an oversized journal to `<name>.old` (one prior
//! generation kept), and rotation is the owner's act alone: a forwarding
//! instance opening it would rename the live owner's file out from under
//! its append fd. The owner opens it only *after* any quarantine replay,
//! so rotation can never empty the very rebuild that needs it. The
//! journal begins at the moment this code first runs on a machine — rows
//! older than it come from salvage and the snapshots, never from here.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::session_ledger::{
    ChangesetDraftRow, FileEventKey, FileEventRewrite, FileEventRow, FileEventSpan,
};

/// Rotate the journal at open when it exceeds this size. Attribution rows
/// are ~200 bytes; this horizon is years of normal use.
const ROTATE_BYTES: u64 = 32 * 1024 * 1024;

/// One journaled mutation of the shared changes tables.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum Record {
    /// `record_file_event` — idempotent insert on the natural PK, carrying
    /// the row's sub-file evidence. `spans` defaults to empty so journal
    /// lines written before span capture existed still parse.
    #[serde(rename = "fe")]
    FileEvent {
        row: FileEventRow,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        spans: Vec<FileEventSpan>,
    },
    /// `record_file_events` — one user gesture's whole batch of attribution
    /// rows, applied in a single transaction so the batch lands whole or not
    /// at all. Each row keeps the single insert's `ON CONFLICT DO NOTHING`
    /// semantics, so replay is idempotent.
    ///
    /// `spans` is index-parallel to `rows` — `spans[i]` belongs to `rows[i]`,
    /// and a shorter (or empty) vector means the remaining rows carry none.
    /// A parallel vector rather than a row-and-spans pair because the pair
    /// would change the shape of every `fe_batch` line already on disk.
    #[serde(rename = "fe_batch")]
    FileEventBatch {
        rows: Vec<FileEventRow>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        spans: Vec<Vec<FileEventSpan>>,
    },
    /// Session eviction / deletion: drop every attribution row of one session.
    #[serde(rename = "fe_del_session")]
    DeleteSession { session: String },
    /// Ownership severing ([D120]): drop other sessions' rows for paths.
    ///
    /// The kept owner is a **line** of work ([P01]): `keep_session` is its
    /// seat segment and `keep_sessions` the rest of the line's segment ids,
    /// so a claim never severs the claimant's own rows written under an id
    /// it has since rotated away from. Split this way (head + defaulted
    /// tail) so every `fe_sever` line written before lines existed still
    /// parses, keeping exactly its one id.
    #[serde(rename = "fe_sever")]
    Sever {
        project_dir: String,
        paths: Vec<String>,
        keep_session: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        keep_sessions: Vec<String>,
    },
    /// Ownership renunciation: drop one session's own rows for the named
    /// paths. The inverse of a claim — the file leaves this session's
    /// changeset and degrades to another live owner or to unattributed.
    ///
    /// The renouncing owner is a line, on the same head-plus-tail shape as
    /// `Sever`: `session` is the id the gesture arrived under, `sessions`
    /// the rest of its line's segments — a disclaim empties the whole
    /// line's ownership, not just the current id's slice of it.
    #[serde(rename = "fe_disclaim")]
    Disclaim {
        project_dir: String,
        paths: Vec<String>,
        session: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        sessions: Vec<String>,
    },
    /// Legacy-row canonicalization rewrite (collision-safe, idempotent).
    #[serde(rename = "fe_rewrite")]
    Rewrite {
        canonical_project_dir: String,
        rewrite: FileEventRewrite,
    },
    /// Purge of rows naming files outside the project's repo — the sweep of
    /// what was written before capture learned to skip them. Carries the
    /// explicit row keys, so replay is exact and idempotent, and one record
    /// carries the whole batch (the forwarder queue is bounded, [LR8]).
    /// `project_dir` records the scope the purge was computed for; the delete
    /// matches on the primary key alone, which is already unique.
    #[serde(rename = "fe_purge_out_of_repo")]
    PurgeOutOfRepo {
        project_dir: String,
        keys: Vec<FileEventKey>,
    },
    /// Maintained draft upsert (`INSERT OR REPLACE` on the owner key).
    #[serde(rename = "draft")]
    Draft { row: ChangesetDraftRow },
    /// Maintained draft deletion by owner key.
    #[serde(rename = "draft_del")]
    DraftDelete {
        owner_kind: String,
        owner_id: String,
        project_dir: String,
    },
}

impl Record {
    /// Whether this record creates or reshapes rows, as opposed to
    /// removing them. Deletes are shape-safe and stay allowed when the
    /// `user_version` gate has locked this build out of the shared tables
    /// ([LR5]); inserts and updates against an unknown shape are not.
    pub fn shapes_rows(&self) -> bool {
        match self {
            Record::FileEvent { .. }
            | Record::FileEventBatch { .. }
            | Record::Rewrite { .. }
            | Record::Draft { .. } => true,
            Record::DeleteSession { .. }
            | Record::Sever { .. }
            | Record::Disclaim { .. }
            | Record::PurgeOutOfRepo { .. }
            | Record::DraftDelete { .. } => false,
        }
    }
}

/// Open journal handle. Appends serialize under an internal lock; every
/// append is flushed with `sync_data` so a crash never loses an
/// acknowledged attribution row.
pub struct ChangesJournal {
    file: Mutex<File>,
    path: PathBuf,
}

/// `<changes-db-path>.journal.jsonl`.
pub fn journal_path_for(changes_db: &Path) -> PathBuf {
    let mut name = changes_db.as_os_str().to_owned();
    name.push(".journal.jsonl");
    PathBuf::from(name)
}

impl ChangesJournal {
    /// Open (creating if needed) the journal beside `changes_db`,
    /// rotating an oversized file to `<name>.old` first. Owner-only: the
    /// caller must hold (or have just taken) the writer claim, and must
    /// have finished any quarantine replay — see the module doc. Returns
    /// `None` (with a loud log) when the journal cannot be opened — the
    /// ledger still works, minus journal durability.
    pub fn open(changes_db: &Path) -> Option<Self> {
        let path = journal_path_for(changes_db);
        Self::rotate_if_oversized(&path, ROTATE_BYTES);
        match OpenOptions::new().create(true).append(true).open(&path) {
            Ok(file) => Some(Self {
                file: Mutex::new(file),
                path,
            }),
            Err(err) => {
                tracing::error!(
                    journal = %path.display(),
                    error = %err,
                    "cannot open changes journal — attribution mutations will not be journaled"
                );
                None
            }
        }
    }

    /// Rename `path` to `<name>.old` when it exceeds `limit` bytes. One
    /// prior generation is kept; a second rotation replaces it.
    fn rotate_if_oversized(path: &Path, limit: u64) {
        let Ok(meta) = std::fs::metadata(path) else {
            return;
        };
        if meta.len() <= limit {
            return;
        }
        let old = path.with_extension("jsonl.old");
        if let Err(err) = std::fs::rename(path, &old) {
            tracing::warn!(journal = %path.display(), error = %err, "journal rotation failed; continuing to append");
        }
    }

    /// Append one record durably. Failures are logged and latch the
    /// process-global degraded flag — a journal that cannot append is a
    /// durability outage the deck must not report as healthy — but are
    /// never propagated: the SQLite apply is still the serving copy.
    pub fn append(&self, record: &Record) {
        let mut line = match serde_json::to_vec(record) {
            Ok(v) => v,
            Err(err) => {
                tracing::warn!(error = %err, "changes journal record failed to serialize");
                return;
            }
        };
        line.push(b'\n');
        let mut file = self.file.lock().expect("journal mutex poisoned");
        if let Err(err) = file.write_all(&line).and_then(|()| file.sync_data()) {
            tracing::error!(
                journal = %self.path.display(),
                error = %err,
                "changes journal append failed"
            );
            crate::ledger_integrity::health::note_degraded("changes-journal");
        }
    }

    /// Read every parseable record from the journal at `path`, oldest
    /// first, tolerating a torn final line. Missing file → empty.
    pub fn read_records(path: &Path) -> Vec<Record> {
        let Ok(text) = std::fs::read_to_string(path) else {
            return Vec::new();
        };
        let mut records = Vec::new();
        let mut dropped = 0usize;
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Record>(line) {
                Ok(rec) => records.push(rec),
                Err(_) => dropped += 1,
            }
        }
        if dropped > 0 {
            tracing::warn!(
                journal = %path.display(),
                dropped,
                "unparseable journal lines skipped during replay"
            );
        }
        records
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_row() -> FileEventRow {
        FileEventRow {
            tug_session_id: "s1".into(),
            tool_use_id: "t1".into(),
            file_path: "src/a.rs".into(),
            tool_name: "Write".into(),
            op: "modified".into(),
            origin: "exact".into(),
            ambiguous: false,
            parent_tool_use_id: None,
            project_dir: "/proj".into(),
            at: 42,
        }
    }

    #[test]
    fn append_then_read_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("changes.db");
        let journal = ChangesJournal::open(&db).unwrap();
        journal.append(&Record::FileEvent {
            row: sample_row(),
            spans: Vec::new(),
        });
        journal.append(&Record::DeleteSession {
            session: "s9".into(),
        });
        let records = ChangesJournal::read_records(&journal_path_for(&db));
        assert_eq!(records.len(), 2);
        assert!(
            matches!(&records[0], Record::FileEvent { row, .. } if row.file_path == "src/a.rs")
        );
        assert!(matches!(&records[1], Record::DeleteSession { session } if session == "s9"));
    }

    /// A delete is shape-safe, so it must stay permitted when the
    /// `user_version` gate has locked this build out of the shared tables
    /// ([LR5]). Classifying the purge as row-shaping would disable it exactly
    /// when the ledger is already degraded.
    #[test]
    fn purge_does_not_shape_rows() {
        assert!(
            !Record::PurgeOutOfRepo {
                project_dir: "/proj".into(),
                keys: Vec::new(),
            }
            .shapes_rows()
        );
    }

    /// Journal lines written before span capture existed carry no `spans`
    /// key at all. They must still parse — a replay that dropped them would
    /// lose exactly the attribution the rebuild exists to restore.
    #[test]
    fn a_span_less_line_from_before_the_spans_field_still_parses() {
        let line = r#"{"t":"fe","row":{"tug_session_id":"s1","tool_use_id":"t1",
            "file_path":"src/a.rs","tool_name":"Write","op":"modified",
            "origin":"exact","ambiguous":false,"parent_tool_use_id":null,
            "project_dir":"/proj","at":42}}"#
            .replace('\n', "");
        let record: Record = serde_json::from_str(&line).expect("v1 line parses");
        match record {
            Record::FileEvent { row, spans } => {
                assert_eq!(row.file_path, "src/a.rs");
                assert!(spans.is_empty());
            }
            other => panic!("wrong variant: {other:?}"),
        }

        let batch = r#"{"t":"fe_batch","rows":[]}"#;
        assert!(matches!(
            serde_json::from_str::<Record>(batch).expect("v1 batch line parses"),
            Record::FileEventBatch { rows, spans } if rows.is_empty() && spans.is_empty()
        ));
    }

    #[test]
    fn rotation_keeps_one_prior_generation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("changes.db.journal.jsonl");
        std::fs::write(&path, b"x".repeat(64)).unwrap();

        // Under the limit: untouched.
        ChangesJournal::rotate_if_oversized(&path, 64);
        assert!(path.exists());
        assert!(!path.with_extension("jsonl.old").exists());

        // Over the limit: renamed aside, original gone.
        ChangesJournal::rotate_if_oversized(&path, 63);
        assert!(!path.exists());
        assert_eq!(
            std::fs::read(path.with_extension("jsonl.old"))
                .unwrap()
                .len(),
            64
        );
    }

    #[test]
    fn torn_final_line_is_tolerated() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("changes.db");
        let journal = ChangesJournal::open(&db).unwrap();
        journal.append(&Record::FileEvent {
            row: sample_row(),
            spans: Vec::new(),
        });
        let path = journal_path_for(&db);
        let mut text = std::fs::read_to_string(&path).unwrap();
        text.push_str("{\"t\":\"fe\",\"row\":{\"tug_ses"); // torn write
        std::fs::write(&path, text).unwrap();
        let records = ChangesJournal::read_records(&path);
        assert_eq!(records.len(), 1);
    }
}
