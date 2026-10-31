//! `semantic.db`: one ledger per instance, written only by tugcast, holding what
//! has been chunked and embedded. It can always be rebuilt from its sources, so a
//! corrupt file is quarantined and started over with nothing salvaged.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use parking_lot::{Mutex, RwLock};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use tracing::{info, warn};
use tugsem_core::{
    ArenaRow, CREATE_SCHEMA, Hit, MIGRATIONS, Passage, SCHEMA_VERSION, Scored, TopK, VectorArena,
    decode_vector, encode_vector, quantize,
};

use crate::ledger_integrity::{Probe, is_corruption, quarantine, quick_check_read_only};

#[derive(Debug, thiserror::Error)]
pub(crate) enum SemanticError {
    #[error("semantic index: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("semantic index is schema {on_disk}, and this build reads {supported}")]
    SchemaTooNew { on_disk: i64, supported: i64 },
}

/// What a source was last indexed from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SourceState {
    pub content_hash: String,
    pub model: Option<String>,
}

/// One source's passages, ready to replace what the index holds for it. Every
/// vector belongs to `model`, so a source's chunks are never of two models.
pub(crate) struct Replacement<'a> {
    pub kind: &'a str,
    pub id: &'a str,
    pub content_hash: &'a str,
    pub model: Option<&'a str>,
    pub passages: &'a [Passage],
    /// One per passage, or empty when nothing was embedded.
    pub vectors: &'a [Option<Vec<f32>>],
    /// What a reader wants of the source beyond its text, as JSON.
    pub meta: Option<&'a str>,
    /// Rows for the text shadow alone, written after `passages` with continuing
    /// ordinals. They never carry a vector or a model.
    pub lexical: &'a [Passage],
}

pub(crate) struct SemanticIndex {
    path: PathBuf,
    db: Mutex<Connection>,
    /// A connection of its own for reads, so a read and a write do not wait on one
    /// mutex, and neither waits on the other in the file because it is WAL.
    reader: Mutex<Connection>,
    /// Every stored vector, for a question to scan. Writers move it under the `db`
    /// lock once their transaction commits, so it cannot disagree with the file.
    arena: RwLock<Option<VectorArena>>,
    /// Sessions whose removal waits for the settling pass, so a user's gesture never
    /// waits on it. `Some` until that pass ends, and then never again.
    deferred: Mutex<Option<Vec<String>>>,
}

/// What settling the index did, as a reading quotes it. Empty when it had already
/// settled.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct SettleReport {
    /// The schema the file was at, if it was older than this build reads.
    pub migrated_from: Option<i64>,
    /// The bytes of the file and its WAL before and after a re-encode's compaction.
    pub compacted: Option<(u64, u64)>,
    pub vectors: usize,
    pub arena_bytes: usize,
    pub migrate_ms: u128,
    pub compact_ms: u128,
    pub load_ms: u128,
    pub check_ms: u128,
    /// A corrupt verdict sent the file to quarantine, and the index started over.
    pub quarantined: bool,
}

impl std::fmt::Display for SettleReport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(from) = self.migrated_from {
            write!(f, "migrated from schema {from} in {} ms, ", self.migrate_ms)?;
        }
        if let Some((before, after)) = self.compacted {
            write!(
                f,
                "compacted {before} to {after} bytes in {} ms, ",
                self.compact_ms
            )?;
        }
        if self.quarantined {
            write!(f, "quarantined and started over, ")?;
        }
        write!(
            f,
            "{} vectors in {} bytes loaded in {} ms, checked in {} ms",
            self.vectors, self.arena_bytes, self.load_ms, self.check_ms
        )
    }
}

/// A passage as a search shows it: the hit, and what `Hit` does not carry.
pub(crate) struct FoundPassage {
    pub chunk_id: i64,
    pub hit: Hit,
    pub meta: Option<String>,
    pub lexical_only: bool,
}

/// Where a source sits in the `sources` primary key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SourceKey {
    pub kind: String,
    pub id: String,
}

/// One stored passage as the embedder should read it again.
pub(crate) struct EmbeddableChunk {
    pub id: i64,
    pub text: String,
}

/// Where a transcript's reader stopped: enough to resume its file past a verified
/// tail, with the segmenter's frontier and the effective records up to there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TranscriptCursor {
    pub session_id: String,
    pub path: String,
    pub offset: i64,
    pub tail_hash: i64,
    pub turn_count: i64,
    pub shown_turn: i64,
    pub open: bool,
    pub pending_close: bool,
    pub pending_close_msg_id: Option<String>,
    pub leaf_uuid: Option<String>,
    pub effective_uuids: Option<Vec<u8>>,
    /// The labels of the calls with no result yet, as JSON. `None` when there are none,
    /// and from a cursor written before they were kept.
    pub open_labels: Option<String>,
}

/// The SQL that keeps a row to `kinds` and to a source-id prefix, and its values in
/// order. The prefix is a range over the primary key, as `session_source_ids` reads it,
/// so a scope costs its own rows rather than a walk of every source.
fn in_kinds_and_scope(kinds: &[&str], scope: Option<&str>) -> (String, Vec<String>) {
    let marks = vec!["?"; kinds.len()].join(", ");
    let mut sql = format!("chunks.source_kind IN ({marks})");
    let mut values: Vec<String> = kinds.iter().map(|kind| kind.to_string()).collect();
    if let Some(prefix) = scope {
        sql.push_str(" AND chunks.source_id >= ? AND chunks.source_id < ?");
        values.push(prefix.to_string());
        values.push(after_prefix(prefix));
    }
    (sql, values)
}

/// The first string past everything that begins with `prefix`.
fn after_prefix(prefix: &str) -> String {
    let mut end = prefix.to_string();
    match end.pop().and_then(|last| char::from_u32(last as u32 + 1)) {
        Some(next) => end.push(next),
        None => end.push(char::MAX),
    }
    end
}

/// One term as FTS5 reads it: quoted, so a word FTS5 would take for an operator is
/// only ever a word.
fn fts_term(term: &str) -> String {
    format!("\"{}\"", term.replace('"', "\"\""))
}

/// One stored vector as the ledger holds it.
struct StoredBlob {
    chunk_id: i64,
    model: String,
    blob: Vec<u8>,
}

/// The rows `blobs` are, for the arena.
fn arena_rows(blobs: &[StoredBlob]) -> impl Iterator<Item = ArenaRow<'_>> {
    blobs.iter().map(|stored| ArenaRow {
        chunk_id: stored.chunk_id,
        model: &stored.model,
        blob: &stored.blob,
    })
}

/// What the file holds for one source's vectors.
fn stored_blobs(conn: &Connection, kind: &str, id: &str) -> Result<Vec<StoredBlob>, SemanticError> {
    let mut stmt = conn.prepare(
        "SELECT id, model, vector FROM chunks WHERE source_kind = ?1 AND source_id = ?2 \
         AND vector IS NOT NULL AND model IS NOT NULL",
    )?;
    let blobs = stmt
        .query_map(params![kind, id], |row| {
            Ok(StoredBlob {
                chunk_id: row.get(0)?,
                model: row.get(1)?,
                blob: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(blobs)
}

/// Every model and dimension the ledger has an offset for.
fn known_spaces(conn: &Connection) -> Result<HashSet<(String, usize)>, SemanticError> {
    let mut stmt = conn.prepare("SELECT model, dims FROM vector_offsets")?;
    let spaces = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get::<_, i64>(1)? as usize)))?
        .collect::<Result<_, _>>()?;
    Ok(spaces)
}

/// Every stored vector, read into an arena a source at a time. A blob of a dimension
/// its model has no offset for is not a vector this schema wrote, so it is passed over.
fn load_arena(conn: &Connection) -> Result<VectorArena, SemanticError> {
    let spaces = known_spaces(conn)?;
    let mut stmt = conn.prepare(
        "SELECT source_kind, source_id, id, model, vector FROM chunks \
         WHERE vector IS NOT NULL AND model IS NOT NULL ORDER BY source_kind, source_id",
    )?;
    let mut rows = stmt.query([])?;
    let mut arena = VectorArena::new();
    let mut source: Option<(String, String)> = None;
    let mut blobs: Vec<StoredBlob> = Vec::new();
    while let Some(row) = rows.next()? {
        let kind = row.get_ref(0)?.as_str().map_err(rusqlite::Error::from)?;
        let id = row.get_ref(1)?.as_str().map_err(rusqlite::Error::from)?;
        if source
            .as_ref()
            .is_none_or(|(held_kind, held_id)| held_kind != kind || held_id != id)
        {
            if let Some((held_kind, held_id)) = source.take() {
                arena.insert_source(&held_kind, &held_id, arena_rows(&blobs));
                blobs.clear();
            }
            source = Some((kind.to_string(), id.to_string()));
        }
        let stored = StoredBlob {
            chunk_id: row.get(2)?,
            model: row.get(3)?,
            blob: row.get(4)?,
        };
        let dims = stored.blob.len().saturating_sub(4);
        if spaces.contains(&(stored.model.clone(), dims)) {
            blobs.push(stored);
        }
    }
    if let Some((kind, id)) = source {
        arena.insert_source(&kind, &id, arena_rows(&blobs));
    }
    arena.shrink_to_fit();
    Ok(arena)
}

/// The offset to store each of `vectors` less, per dimension: the one already frozen
/// for `model`, or the mean of this write's, frozen now.
fn frozen_offsets<'v>(
    conn: &Connection,
    model: &str,
    vectors: impl Iterator<Item = &'v [f32]>,
) -> Result<HashMap<usize, Vec<f32>>, SemanticError> {
    let mut by_dims: HashMap<usize, Vec<&[f32]>> = HashMap::new();
    for vector in vectors {
        by_dims.entry(vector.len()).or_default().push(vector);
    }
    let mut offsets = HashMap::with_capacity(by_dims.len());
    for (dims, group) in by_dims {
        let stored: Option<Vec<u8>> = conn
            .query_row(
                "SELECT offset FROM vector_offsets WHERE model = ?1 AND dims = ?2",
                params![model, dims as i64],
                |row| row.get(0),
            )
            .optional()?;
        let offset = match stored.as_deref().and_then(decode_vector) {
            Some(offset) if offset.len() == dims => offset,
            _ => {
                let mut sums = vec![0.0_f64; dims];
                for vector in &group {
                    add_to(&mut sums, vector);
                }
                let offset = mean_of(&sums, group.len() as u64);
                freeze_offset(conn, model, &offset)?;
                offset
            }
        };
        offsets.insert(dims, offset);
    }
    Ok(offsets)
}

fn add_to(sums: &mut [f64], vector: &[f32]) {
    for (sum, value) in sums.iter_mut().zip(vector) {
        *sum += f64::from(*value);
    }
}

fn mean_of(sums: &[f64], count: u64) -> Vec<f32> {
    sums.iter().map(|sum| (sum / count as f64) as f32).collect()
}

fn freeze_offset(conn: &Connection, model: &str, offset: &[f32]) -> Result<(), SemanticError> {
    conn.execute(
        "INSERT OR REPLACE INTO vector_offsets (model, dims, offset) VALUES (?1, ?2, ?3)",
        params![model, offset.len() as i64, encode_vector(offset)],
    )?;
    Ok(())
}

struct StoredVectorRow {
    id: i64,
    model: Option<String>,
    blob: Vec<u8>,
}

/// A page of the vectors past `after`, read through before anything is written, so
/// no update happens under an open scan.
fn vector_page(conn: &Connection, after: i64) -> Result<Vec<StoredVectorRow>, SemanticError> {
    const PAGE: i64 = 1024;
    let mut stmt = conn.prepare(
        "SELECT id, model, vector FROM chunks WHERE id > ?1 AND vector IS NOT NULL \
         ORDER BY id LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![after, PAGE], |row| {
            Ok(StoredVectorRow {
                id: row.get(0)?,
                model: row.get(1)?,
                blob: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Turn a ledger's float vectors into quantized ones: an offset per model and length
/// from the mean of every row, then each row against it. It keeps running sums and
/// walks in pages, so nothing holds half a gigabyte of floats. A blob that is not a
/// vector of whole floats under a model loses its vector and its model, and is found
/// lexically as a chunk stored with no embedder is.
fn reencode_vectors(conn: &Connection) -> Result<(), SemanticError> {
    let mut sums: HashMap<(String, usize), (Vec<f64>, u64)> = HashMap::new();
    let mut update = conn.prepare("UPDATE chunks SET model = ?2, vector = ?3 WHERE id = ?1")?;
    let mut after = 0;
    loop {
        let page = vector_page(conn, after)?;
        let Some(last) = page.last() else { break };
        after = last.id;
        for row in &page {
            let vector = decode_vector(&row.blob).filter(|vector| !vector.is_empty());
            if let (Some(model), Some(vector)) = (&row.model, vector) {
                let (total, count) = sums
                    .entry((model.clone(), vector.len()))
                    .or_insert_with(|| (vec![0.0; vector.len()], 0));
                add_to(total, &vector);
                *count += 1;
            } else {
                update.execute(params![row.id, None::<String>, None::<Vec<u8>>])?;
            }
        }
    }
    let mut offsets: HashMap<(String, usize), Vec<f32>> = HashMap::with_capacity(sums.len());
    for ((model, dims), (total, count)) in sums {
        let offset = mean_of(&total, count);
        freeze_offset(conn, &model, &offset)?;
        offsets.insert((model, dims), offset);
    }
    let mut after = 0;
    loop {
        let page = vector_page(conn, after)?;
        let Some(last) = page.last() else { break };
        after = last.id;
        for row in page {
            // The first pass left only whole floats under a model.
            let (Some(model), Some(vector)) = (row.model, decode_vector(&row.blob)) else {
                continue;
            };
            let blob = quantize(&vector, &offsets[&(model.clone(), vector.len())]);
            update.execute(params![row.id, model, blob])?;
        }
    }
    Ok(())
}

/// The first schema whose vectors are quantized.
const QUANTIZED_SCHEMA: i64 = 4;

/// Bring the file to this build's schema: all of it for a fresh file, the pending
/// migrations for an older one, and a refusal for a newer one.
fn apply_schema(conn: &Connection, on_disk: i64) -> Result<(), SemanticError> {
    let schema = tugcore::ledger_db::LedgerSchema {
        db: rusqlite::DatabaseName::Main,
        version: SCHEMA_VERSION,
        migrations: MIGRATIONS,
        already_applied: tugcore::ledger_db::no_migration_error_absorbed,
    };
    let migrated = tugcore::ledger_db::migrate::<SemanticError>(conn, &schema, |conn| {
        conn.execute_batch(CREATE_SCHEMA)?;
        // `create` also runs on every later version step, where the vectors are
        // already quantized and must not be read as floats.
        if on_disk > 0 && on_disk < QUANTIZED_SCHEMA {
            reencode_vectors(conn)?;
        }
        Ok(())
    })?;
    if let tugcore::ledger_db::Migrated::TooNew { on_disk } = migrated {
        return Err(SemanticError::SchemaTooNew {
            on_disk,
            supported: SCHEMA_VERSION,
        });
    }
    Ok(())
}

/// The writer and the reader on `path`. A file older than this build reads is left as
/// it is, for the settling pass.
fn open_connections(path: &Path) -> Result<(Connection, Connection), SemanticError> {
    let conn = tugcore::ledger_db::open(path)?;
    let on_disk = tugcore::ledger_db::schema_version(&conn)?;
    if !(1..SCHEMA_VERSION).contains(&on_disk) {
        apply_schema(&conn, on_disk)?;
    }
    let reader = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    reader.busy_timeout(Duration::from_secs(5))?;
    Ok((conn, reader))
}

/// The bytes `path` and its WAL take on disk.
fn bytes_on_disk(path: &Path) -> u64 {
    let mut wal = path.as_os_str().to_owned();
    wal.push("-wal");
    [path, Path::new(&wal)]
        .iter()
        .filter_map(|file| std::fs::metadata(file).ok())
        .map(|meta| meta.len())
        .sum()
}

/// Give a re-encode's freed pages back. A `VACUUM` in WAL mode shrinks the file only
/// once it is checkpointed, and the WAL holds its own size until it is truncated.
fn compact(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch("VACUUM")?;
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
}

impl SemanticIndex {
    /// Open a ledger and settle it, for a test with nothing else to do first.
    #[cfg(test)]
    pub(crate) fn open(path: impl AsRef<Path>) -> Result<Self, SemanticError> {
        let index = Self::open_unsettled(path)?;
        index.settle()?;
        Ok(index)
    }

    /// Open a ledger on the startup path: connections, and the schema of a fresh or
    /// current file. Nothing here reads the file's body, so what it costs does not
    /// grow with the file, and until [`settle`](Self::settle) has run no search
    /// answers. A header that is no database is quarantined at once, or the index
    /// would be absent every boot.
    pub(crate) fn open_unsettled(path: impl AsRef<Path>) -> Result<Self, SemanticError> {
        let path = path.as_ref();
        let (conn, reader) = match open_connections(path) {
            Err(SemanticError::Sqlite(err)) if is_corruption(&err) => {
                quarantine(path, "semantic", &format!("unopenable: {err}"));
                open_connections(path)?
            }
            opened => opened?,
        };
        Ok(Self {
            path: path.to_path_buf(),
            db: Mutex::new(conn),
            reader: Mutex::new(reader),
            arena: RwLock::new(None),
            deferred: Mutex::new(Some(Vec::new())),
        })
    }

    /// Do what the startup path left, on a blocking task: a pending migration, one
    /// compaction if it re-encoded, the arena's load, a read-only check of the file,
    /// and last the removals deferred meanwhile. A corrupt verdict starts the index
    /// over in place. An index that cannot settle stays lexical, and the removals run
    /// on that path too. A second call does nothing.
    pub(crate) fn settle(&self) -> Result<SettleReport, SemanticError> {
        if self.deferred.lock().is_none() {
            return Ok(SettleReport::default());
        }
        let mut report = SettleReport::default();
        let settled = self.settle_file(&mut report);
        let sessions = self.deferred.lock().take().unwrap_or_default();
        for session in sessions {
            if let Err(err) = super::ingest::remove_session_now(self, &session) {
                warn!("semantic index: a deferred removal failed: {err}");
            }
        }
        settled.map(|()| {
            info!("semantic index settled: {report}");
            report
        })
    }

    fn settle_file(&self, report: &mut SettleReport) -> Result<(), SemanticError> {
        let failed = self.migrate_and_load(report).err();
        let verdict = match &failed {
            Some(SemanticError::Sqlite(err)) if is_corruption(err) => {
                Probe::Corrupt(err.to_string())
            }
            _ => {
                let checking = Instant::now();
                let verdict = quick_check_read_only(&self.path);
                report.check_ms = checking.elapsed().as_millis();
                verdict
            }
        };
        match verdict {
            Probe::Healthy => {}
            Probe::Corrupt(detail) => {
                self.rebuild_empty(&detail)?;
                report.quarantined = true;
                report.vectors = 0;
                report.arena_bytes = 0;
                return Ok(());
            }
            Probe::Unverified(detail) => {
                warn!("semantic index: the file could not be checked: {detail}");
            }
        }
        failed.map_or(Ok(()), Err)
    }

    /// The pending migration, its compaction, and the arena. The worker has not started
    /// and a removal defers, so nothing is waiting on `db` for as long as this holds it.
    fn migrate_and_load(&self, report: &mut SettleReport) -> Result<(), SemanticError> {
        let conn = self.db.lock();
        let on_disk = tugcore::ledger_db::schema_version(&conn)?;
        if on_disk < SCHEMA_VERSION {
            let migrating = Instant::now();
            apply_schema(&conn, on_disk)?;
            report.migrated_from = Some(on_disk);
            report.migrate_ms = migrating.elapsed().as_millis();
        }
        if on_disk > 0 && on_disk < QUANTIZED_SCHEMA {
            let compacting = Instant::now();
            let before = bytes_on_disk(&self.path);
            if let Err(err) = compact(&conn) {
                warn!("semantic index: the compaction failed: {err}");
            }
            report.compacted = Some((before, bytes_on_disk(&self.path)));
            report.compact_ms = compacting.elapsed().as_millis();
        }
        let loading = Instant::now();
        let arena = load_arena(&conn)?;
        report.load_ms = loading.elapsed().as_millis();
        report.vectors = arena.vectors();
        report.arena_bytes = arena.bytes();
        *self.arena.write() = Some(arena);
        Ok(())
    }

    /// Answer a corrupt verdict in place: the connections close, the file goes to
    /// quarantine and a fresh one takes its path, so every owner's handle stays good.
    /// A late reader on the old file comes back empty or missing, which is what a chunk
    /// removed under it already means.
    fn rebuild_empty(&self, detail: &str) -> Result<(), SemanticError> {
        let mut db = self.db.lock();
        let mut reader = self.reader.lock();
        for held in [&mut *db, &mut *reader] {
            let closing = std::mem::replace(held, Connection::open_in_memory()?);
            if let Err((_, err)) = closing.close() {
                warn!("semantic index: a connection would not close: {err}");
            }
        }
        *self.arena.write() = None;
        quarantine(&self.path, "semantic", detail);
        (*db, *reader) = open_connections(&self.path)?;
        *self.arena.write() = Some(VectorArena::new());
        Ok(())
    }

    /// Hold `session`'s removal for the settling pass, if it has not ended. A caller
    /// told `true` is done: the pass removes it, and until then no search answers.
    pub(crate) fn defer_session_removal(&self, session: &str) -> bool {
        match self.deferred.lock().as_mut() {
            Some(sessions) => {
                sessions.push(session.to_string());
                true
            }
            None => false,
        }
    }

    /// Whether the arena is loaded, which is what a search reads.
    pub(crate) fn can_scan(&self) -> bool {
        self.arena.read().is_some()
    }

    /// What `kind`/`id` was last indexed from, if it has been.
    pub(crate) fn source_state(
        &self,
        kind: &str,
        id: &str,
    ) -> Result<Option<SourceState>, SemanticError> {
        let conn = self.db.lock();
        let state = conn
            .query_row(
                "SELECT content_hash, model FROM sources WHERE source_kind = ?1 AND source_id = ?2",
                params![kind, id],
                |row| {
                    Ok(SourceState {
                        content_hash: row.get(0)?,
                        model: row.get(1)?,
                    })
                },
            )
            .optional()?;
        Ok(state)
    }

    /// The ids of every source of `kind`.
    pub(crate) fn source_ids(&self, kind: &str) -> Result<Vec<String>, SemanticError> {
        let conn = self.db.lock();
        let mut stmt = conn.prepare("SELECT source_id FROM sources WHERE source_kind = ?1")?;
        let ids = stmt
            .query_map(params![kind], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(ids)
    }

    /// The ids of the sources of `kind` drawn from `session`, read as a range of the
    /// primary key. `0` is the character after `/`, so the range holds every id that
    /// begins with the session and a `/`, and no other session's.
    pub(crate) fn session_source_ids(
        &self,
        kind: &str,
        session: &str,
    ) -> Result<Vec<String>, SemanticError> {
        self.source_ids_between(kind, &format!("{session}/"), &format!("{session}0"))
    }

    /// The ids of the sources of `kind` from `start` up to and not including `end`, read
    /// as a range of the primary key.
    pub(crate) fn source_ids_between(
        &self,
        kind: &str,
        start: &str,
        end: &str,
    ) -> Result<Vec<String>, SemanticError> {
        let conn = self.reader.lock();
        let mut stmt = conn.prepare(
            "SELECT source_id FROM sources \
             WHERE source_kind = ?1 AND source_id >= ?2 AND source_id < ?3",
        )?;
        let ids = stmt
            .query_map(params![kind, start, end], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(ids)
    }

    /// A page of the sources past `after`, in key order, whose model is not `live`
    /// and which hold a passage a model reads. Help is not among them: it is
    /// re-ingested from its documents. The next page starts from the last key of
    /// this one, so it does not walk past what earlier pages finished.
    pub(crate) fn stale_sources(
        &self,
        live: &str,
        after: Option<&SourceKey>,
        limit: usize,
    ) -> Result<Vec<SourceKey>, SemanticError> {
        let (after_kind, after_id) =
            after.map_or(("", ""), |key| (key.kind.as_str(), key.id.as_str()));
        let conn = self.reader.lock();
        let mut stmt = conn.prepare(
            "SELECT source_kind, source_id FROM sources \
             WHERE (source_kind, source_id) > (?1, ?2) \
               AND source_kind != 'help' \
               AND model IS NOT ?3 \
               AND EXISTS (SELECT 1 FROM chunks \
                           WHERE chunks.source_kind = sources.source_kind \
                             AND chunks.source_id = sources.source_id \
                             AND chunks.lexical_only = 0) \
             ORDER BY source_kind, source_id LIMIT ?4",
        )?;
        let keys = stmt
            .query_map(params![after_kind, after_id, live, limit as i64], |row| {
                Ok(SourceKey {
                    kind: row.get(0)?,
                    id: row.get(1)?,
                })
            })?
            .collect::<Result<Vec<SourceKey>, _>>()?;
        Ok(keys)
    }

    /// A source's passages as the embedder reads them, in order, leaving out its
    /// lexical rows.
    pub(crate) fn embeddable_chunks(
        &self,
        kind: &str,
        id: &str,
    ) -> Result<Vec<EmbeddableChunk>, SemanticError> {
        let conn = self.reader.lock();
        let mut stmt = conn.prepare(
            "SELECT id, ordinal, span_start, span_end, context, body FROM chunks \
             WHERE source_kind = ?1 AND source_id = ?2 AND lexical_only = 0 ORDER BY ordinal",
        )?;
        let chunks = stmt
            .query_map(params![kind, id], |row| {
                let passage = Passage {
                    ordinal: row.get::<_, i64>(1)? as usize,
                    start: row.get::<_, i64>(2)? as usize,
                    end: row.get::<_, i64>(3)? as usize,
                    context: row.get(4)?,
                    body: row.get(5)?,
                };
                Ok(EmbeddableChunk {
                    id: row.get(0)?,
                    text: passage.embedding_text(),
                })
            })?
            .collect::<Result<Vec<EmbeddableChunk>, _>>()?;
        Ok(chunks)
    }

    /// Replace everything held for one source, in one transaction, so a reader
    /// never sees a source half old and half new.
    pub(crate) fn replace_source(&self, source: &Replacement<'_>) -> Result<(), SemanticError> {
        let mut conn = self.db.lock();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM chunks WHERE source_kind = ?1 AND source_id = ?2",
            params![source.kind, source.id],
        )?;
        let offsets = match source.model {
            Some(model) => frozen_offsets(
                &tx,
                model,
                source.vectors.iter().flatten().map(Vec::as_slice),
            )?,
            None => HashMap::new(),
        };
        {
            let mut insert = tx.prepare(
                "INSERT INTO chunks (source_kind, source_id, ordinal, span_start, span_end, \
                 context, body, model, vector, lexical_only) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            )?;
            for (index, passage) in source.passages.iter().enumerate() {
                let vector = source
                    .model
                    .and(source.vectors.get(index))
                    .and_then(|vector| vector.as_deref());
                insert.execute(params![
                    source.kind,
                    source.id,
                    passage.ordinal as i64,
                    passage.start as i64,
                    passage.end as i64,
                    passage.context,
                    passage.body,
                    vector.and(source.model),
                    vector.map(|vector| quantize(vector, &offsets[&vector.len()])),
                    false,
                ])?;
            }
            for (index, row) in source.lexical.iter().enumerate() {
                insert.execute(params![
                    source.kind,
                    source.id,
                    (source.passages.len() + index) as i64,
                    row.start as i64,
                    row.end as i64,
                    row.context,
                    row.body,
                    None::<&str>,
                    None::<Vec<u8>>,
                    true,
                ])?;
            }
        }
        tx.execute(
            "INSERT INTO sources (source_kind, source_id, content_hash, model, meta) \
             VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT (source_kind, source_id) \
             DO UPDATE SET content_hash = excluded.content_hash, model = excluded.model, \
             meta = excluded.meta",
            params![
                source.kind,
                source.id,
                source.content_hash,
                source.model,
                source.meta
            ],
        )?;
        let blobs = stored_blobs(&tx, source.kind, source.id)?;
        tx.commit()?;
        self.hold_in_arena(source.kind, source.id, &blobs);
        Ok(())
    }

    /// Say what the file now holds for a source. The caller has committed it and still
    /// holds `db`.
    fn hold_in_arena(&self, kind: &str, id: &str, blobs: &[StoredBlob]) {
        if let Some(arena) = self.arena.write().as_mut() {
            arena.insert_source(kind, id, arena_rows(blobs));
        }
    }

    /// Say what a source's `meta` is now, when only that has moved.
    pub(crate) fn set_source_meta(
        &self,
        kind: &str,
        id: &str,
        meta: &str,
    ) -> Result<(), SemanticError> {
        self.db.lock().execute(
            "UPDATE sources SET meta = ?3 \
             WHERE source_kind = ?1 AND source_id = ?2 AND meta IS NOT ?3",
            params![kind, id, meta],
        )?;
        Ok(())
    }

    /// Remove a source and its chunks. Retention follows the source.
    pub(crate) fn remove_source(&self, kind: &str, id: &str) -> Result<(), SemanticError> {
        self.remove_sources(kind, &[id])
    }

    /// Remove several sources of one kind and their chunks, in one transaction.
    pub(crate) fn remove_sources(
        &self,
        kind: &str,
        ids: &[impl AsRef<str>],
    ) -> Result<(), SemanticError> {
        let mut conn = self.db.lock();
        let tx = conn.transaction()?;
        {
            let mut chunks =
                tx.prepare("DELETE FROM chunks WHERE source_kind = ?1 AND source_id = ?2")?;
            let mut sources =
                tx.prepare("DELETE FROM sources WHERE source_kind = ?1 AND source_id = ?2")?;
            for id in ids {
                chunks.execute(params![kind, id.as_ref()])?;
                sources.execute(params![kind, id.as_ref()])?;
            }
        }
        tx.commit()?;
        if let Some(arena) = self.arena.write().as_mut() {
            for id in ids {
                arena.remove_source(kind, id.as_ref());
            }
        }
        Ok(())
    }

    /// Give a source's stored passages new vectors, in one transaction, so a reader
    /// never sees a source under two models. A source removed since these were read
    /// matches nothing here and stays removed.
    pub(crate) fn replace_vectors(
        &self,
        key: &SourceKey,
        model: &str,
        vectors: &[(i64, Option<&[f32]>)],
    ) -> Result<(), SemanticError> {
        let mut conn = self.db.lock();
        let tx = conn.transaction()?;
        {
            let offsets =
                frozen_offsets(&tx, model, vectors.iter().filter_map(|(_, vector)| *vector))?;
            let mut update =
                tx.prepare("UPDATE chunks SET model = ?2, vector = ?3 WHERE id = ?1")?;
            for (id, vector) in vectors {
                update.execute(params![
                    id,
                    vector.and(Some(model)),
                    vector.map(|vector| quantize(vector, &offsets[&vector.len()])),
                ])?;
            }
        }
        tx.execute(
            "UPDATE sources SET model = ?3 WHERE source_kind = ?1 AND source_id = ?2",
            params![key.kind, key.id, model],
        )?;
        let blobs = stored_blobs(&tx, &key.kind, &key.id)?;
        tx.commit()?;
        self.hold_in_arena(&key.kind, &key.id, &blobs);
        Ok(())
    }

    /// How far `stream` has been read, 0 before any of it has.
    pub(crate) fn mark(&self, stream: &str) -> Result<i64, SemanticError> {
        let conn = self.reader.lock();
        let mark = conn
            .query_row(
                "SELECT last_id FROM stream_marks WHERE stream = ?1",
                params![stream],
                |row| row.get(0),
            )
            .optional()?;
        Ok(mark.unwrap_or(0))
    }

    pub(crate) fn set_mark(&self, stream: &str, last_id: i64) -> Result<(), SemanticError> {
        let conn = self.db.lock();
        conn.execute(
            "INSERT INTO stream_marks (stream, last_id) VALUES (?1, ?2) \
             ON CONFLICT (stream) DO UPDATE SET last_id = excluded.last_id",
            params![stream, last_id],
        )?;
        Ok(())
    }

    /// Where a session's transcript reader stopped, if it has started.
    pub(crate) fn cursor(&self, session: &str) -> Result<Option<TranscriptCursor>, SemanticError> {
        let conn = self.reader.lock();
        let cursor = conn
            .query_row(
                "SELECT session_id, path, offset, tail_hash, turn_count, shown_turn, open, \
                 pending_close, pending_close_msg_id, leaf_uuid, effective_uuids, open_labels \
                 FROM transcript_cursors WHERE session_id = ?1",
                params![session],
                |row| {
                    Ok(TranscriptCursor {
                        session_id: row.get(0)?,
                        path: row.get(1)?,
                        offset: row.get(2)?,
                        tail_hash: row.get(3)?,
                        turn_count: row.get(4)?,
                        shown_turn: row.get(5)?,
                        open: row.get(6)?,
                        pending_close: row.get(7)?,
                        pending_close_msg_id: row.get(8)?,
                        leaf_uuid: row.get(9)?,
                        effective_uuids: row.get(10)?,
                        open_labels: row.get(11)?,
                    })
                },
            )
            .optional()?;
        Ok(cursor)
    }

    pub(crate) fn set_cursor(&self, cursor: &TranscriptCursor) -> Result<(), SemanticError> {
        let conn = self.db.lock();
        conn.execute(
            "INSERT OR REPLACE INTO transcript_cursors (session_id, path, offset, tail_hash, \
             turn_count, shown_turn, open, pending_close, pending_close_msg_id, leaf_uuid, \
             effective_uuids, open_labels) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                cursor.session_id,
                cursor.path,
                cursor.offset,
                cursor.tail_hash,
                cursor.turn_count,
                cursor.shown_turn,
                cursor.open,
                cursor.pending_close,
                cursor.pending_close_msg_id,
                cursor.leaf_uuid,
                cursor.effective_uuids,
                cursor.open_labels,
            ],
        )?;
        Ok(())
    }

    /// Every session with a cursor, and the file its cursor is in.
    pub(crate) fn cursor_paths(&self) -> Result<Vec<(String, String)>, SemanticError> {
        let conn = self.reader.lock();
        let mut stmt = conn.prepare("SELECT session_id, path FROM transcript_cursors")?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub(crate) fn delete_cursor(&self, session: &str) -> Result<(), SemanticError> {
        let conn = self.db.lock();
        conn.execute(
            "DELETE FROM transcript_cursors WHERE session_id = ?1",
            params![session],
        )?;
        Ok(())
    }

    /// A read-only connection for one long read, so a scan does not hold the shared
    /// reader behind its mutex for as long as it runs.
    fn scan_connection(&self) -> Result<Connection, SemanticError> {
        let conn = Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.busy_timeout(Duration::from_secs(5))?;
        Ok(conn)
    }

    /// The `depth` chunks nearest `query`, best first, of `model` among `kinds` within
    /// `scope`, a source-id prefix, whose source `keep` allows, and how many were
    /// compared. A score ranks inside this answer and means nothing beyond it. This
    /// holds the arena's read lock for its tens of milliseconds, so scans run together
    /// and a write waits.
    pub(crate) fn rank_vectors(
        &self,
        kinds: &[&str],
        model: &str,
        scope: Option<&str>,
        keep: impl FnMut(&str) -> bool,
        query: &[f32],
        depth: usize,
    ) -> (Vec<Scored>, usize) {
        let arena = self.arena.read();
        let Some(arena) = arena.as_ref() else {
            return (Vec::new(), 0);
        };
        let mut top = TopK::new(depth);
        let handed = arena.scan(model, query, kinds, scope, keep, &mut top);
        (top.into_ranked(), handed)
    }

    /// The chunks among `kinds` within `scope` that hold any of `terms`, best first by
    /// BM25, with a hit in the context line (a title, a heading) counting for more than
    /// one in the body, walking rows until `depth` of them pass `keep`, so a row it
    /// refuses takes no place.
    pub(crate) fn lexical_chunks(
        &self,
        kinds: &[&str],
        scope: Option<&str>,
        terms: &[String],
        keep: impl FnMut(&str) -> bool,
        depth: usize,
    ) -> Result<Vec<i64>, SemanticError> {
        self.lexical_walk(kinds, scope, terms, " OR ", keep, depth)
    }

    /// Whether some one chunk `keep` allows holds every one of `terms`. No terms at all
    /// asks nothing, so it is held.
    pub(crate) fn holds_all_kept(
        &self,
        kinds: &[&str],
        scope: Option<&str>,
        terms: &[String],
        keep: impl FnMut(&str) -> bool,
    ) -> Result<bool, SemanticError> {
        if terms.is_empty() {
            return Ok(true);
        }
        let found = self.lexical_walk(kinds, scope, terms, " AND ", keep, 1)?;
        Ok(!found.is_empty())
    }

    fn lexical_walk(
        &self,
        kinds: &[&str],
        scope: Option<&str>,
        terms: &[String],
        joined_by: &str,
        mut keep: impl FnMut(&str) -> bool,
        depth: usize,
    ) -> Result<Vec<i64>, SemanticError> {
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let query = terms
            .iter()
            .map(|term| fts_term(term))
            .collect::<Vec<_>>()
            .join(joined_by);
        let conn = self.scan_connection()?;
        let (filter, mut values) = in_kinds_and_scope(kinds, scope);
        values.insert(0, query);
        let mut stmt = conn.prepare(&format!(
            "SELECT chunks.id, chunks.source_id FROM chunks_fts \
             JOIN chunks ON chunks.id = chunks_fts.rowid \
             WHERE chunks_fts MATCH ? AND {filter} \
             ORDER BY bm25(chunks_fts, 4.0, 1.0)"
        ))?;
        let mut rows = stmt.query(rusqlite::params_from_iter(&values))?;
        let mut found = Vec::new();
        while found.len() < depth {
            let Some(row) = rows.next()? else {
                break;
            };
            if keep(row.get_ref(1)?.as_str().map_err(rusqlite::Error::from)?) {
                found.push(row.get(0)?);
            }
        }
        Ok(found)
    }

    /// The passages of these chunks as a search shows them, with no score yet. A chunk
    /// that has since gone is not among them.
    pub(crate) fn passages_by_ids(&self, ids: &[i64]) -> Result<Vec<FoundPassage>, SemanticError> {
        let conn = self.scan_connection()?;
        let mut stmt = conn.prepare(
            "SELECT chunks.source_kind, chunks.source_id, chunks.ordinal, chunks.span_start, \
             chunks.span_end, chunks.context, chunks.body, chunks.lexical_only, sources.meta \
             FROM chunks JOIN sources ON sources.source_kind = chunks.source_kind \
             AND sources.source_id = chunks.source_id WHERE chunks.id = ?1",
        )?;
        let mut found = Vec::with_capacity(ids.len());
        for &chunk_id in ids {
            let passage = stmt
                .query_row(params![chunk_id], |row| {
                    Ok(FoundPassage {
                        chunk_id,
                        hit: Hit {
                            source_kind: row.get(0)?,
                            source_id: row.get(1)?,
                            ordinal: row.get::<_, i64>(2)? as usize,
                            start: row.get::<_, i64>(3)? as usize,
                            end: row.get::<_, i64>(4)? as usize,
                            context: row.get(5)?,
                            body: row.get(6)?,
                            score: 0.0,
                        },
                        lexical_only: row.get(7)?,
                        meta: row.get(8)?,
                    })
                })
                .optional()?;
            found.extend(passage);
        }
        Ok(found)
    }

    #[cfg(test)]
    pub(crate) fn chunks(&self) -> Vec<StoredChunk> {
        let conn = self.db.lock();
        let offsets: HashMap<(String, usize), Vec<f32>> = conn
            .prepare("SELECT model, dims, offset FROM vector_offsets")
            .unwrap()
            .query_map([], |row| {
                let offset: Vec<u8> = row.get(2)?;
                Ok((
                    (row.get(0)?, row.get::<_, i64>(1)? as usize),
                    decode_vector(&offset).unwrap(),
                ))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT source_id, ordinal, context, body, model, vector, lexical_only, source_kind, id \
                 FROM chunks \
                 ORDER BY source_id, ordinal",
            )
            .unwrap();
        stmt.query_map([], |row| {
            let model: Option<String> = row.get(4)?;
            let vector = row.get::<_, Option<Vec<u8>>>(5)?.map(|blob| {
                let offset = &offsets[&(model.clone().unwrap(), blob.len() - 4)];
                tugsem_core::dequantize(&blob, offset).unwrap()
            });
            Ok(StoredChunk {
                source_id: row.get(0)?,
                ordinal: row.get(1)?,
                context: row.get(2)?,
                body: row.get(3)?,
                model,
                vector,
                lexical_only: row.get(6)?,
                source_kind: row.get(7)?,
                id: row.get(8)?,
            })
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
    }

    /// What a source's `meta` holds.
    #[cfg(test)]
    pub(crate) fn source_meta(&self, kind: &str, id: &str) -> Option<String> {
        self.db
            .lock()
            .query_row(
                "SELECT meta FROM sources WHERE source_kind = ?1 AND source_id = ?2",
                params![kind, id],
                |row| row.get(0),
            )
            .unwrap()
    }

    /// Hold one small source, for a test that only needs something to be there.
    #[cfg(test)]
    pub(crate) fn store_for_test(&self, kind: &str, id: &str) {
        self.replace_source(&Replacement {
            kind,
            id,
            content_hash: "hash",
            model: None,
            passages: &tugsem_core::chunk("ctx", "Some words."),
            vectors: &[],
            meta: None,
            lexical: &[],
        })
        .unwrap();
    }

    /// Hold the writer's lock, as a long write does.
    #[cfg(test)]
    pub(crate) fn hold_writer_for_test(&self) -> impl Drop + '_ {
        self.db.lock()
    }

    /// Hold the arena's read lock, as a scan does.
    #[cfg(test)]
    pub(crate) fn arena_read_for_test(&self) -> impl Drop + '_ {
        self.arena.read()
    }

    /// How many chunks the text shadow finds for an FTS5 query.
    #[cfg(test)]
    pub(crate) fn lexical_matches(&self, query: &str) -> i64 {
        let conn = self.db.lock();
        conn.query_row(
            "SELECT count(*) FROM chunks_fts WHERE chunks_fts MATCH ?1",
            params![query],
            |row| row.get(0),
        )
        .unwrap()
    }
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct StoredChunk {
    pub source_id: String,
    pub ordinal: i64,
    pub context: String,
    pub body: String,
    pub model: Option<String>,
    pub vector: Option<Vec<f32>>,
    pub lexical_only: bool,
    pub source_kind: String,
    pub id: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tugsem_core::chunk;

    fn open(dir: &tempfile::TempDir) -> SemanticIndex {
        SemanticIndex::open(dir.path().join("semantic.db")).unwrap()
    }

    fn store(index: &SemanticIndex, id: &str, text: &str, model: Option<&str>) {
        let passages = chunk("ctx", text);
        let vectors: Vec<Option<Vec<f32>>> = passages
            .iter()
            .map(|_| model.map(|_| vec![1.0, 0.0]))
            .collect();
        index
            .replace_source(&Replacement {
                kind: "help",
                id,
                content_hash: "hash",
                model,
                passages: &passages,
                vectors: &vectors,
                meta: None,
                lexical: &[],
            })
            .unwrap();
    }

    #[test]
    fn a_fresh_ledger_is_stamped_and_reopens_with_what_it_held() {
        let dir = tempfile::tempdir().unwrap();
        let index = open(&dir);
        store(&index, "a", "Opening an arc takes one prompt.", Some("m"));
        drop(index);

        let index = open(&dir);
        let conn = index.db.lock();
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        drop(conn);
        assert_eq!(version, SCHEMA_VERSION);
        assert_eq!(index.chunks().len(), 1);
    }

    #[test]
    fn a_ledger_from_a_newer_build_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        drop(open(&dir));
        let path = dir.path().join("semantic.db");
        let conn = tugcore::ledger_db::open(&path).unwrap();
        conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .unwrap();
        drop(conn);
        assert!(matches!(
            SemanticIndex::open(&path),
            Err(SemanticError::SchemaTooNew { .. })
        ));
    }

    #[test]
    fn opening_unsettled_runs_no_check_and_no_reencode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("semantic.db");
        let index = SemanticIndex::open(&path).unwrap();
        for (at, vector) in pooled(4, 8).iter().enumerate() {
            store_vector(&index, &format!("s{at}"), "m", vector);
        }
        as_float_ledger(&index, 3);
        let before = blobs(&index);
        drop(index);

        let index = SemanticIndex::open_unsettled(&path).unwrap();
        assert_eq!(blobs(&index), before);
        let version: i64 = index
            .db
            .lock()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 3);
        assert!(!index.can_scan());

        let damaged = dir.path().join("damaged.db");
        let index = filled_ledger(&damaged);
        drop(index);
        damage_body(&damaged);
        assert!(SemanticIndex::open_unsettled(&damaged).is_ok());
        assert!(damaged.exists());
        assert!(corrupt_files(&dir).is_empty());
    }

    #[test]
    fn a_header_that_is_no_database_is_quarantined_at_open() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("semantic.db");
        std::fs::write(&path, b"this is not a sqlite database at all").unwrap();

        let index = SemanticIndex::open_unsettled(&path).unwrap();
        assert_eq!(corrupt_files(&dir).len(), 1);
        assert!(index.source_ids("help").unwrap().is_empty());
    }

    #[test]
    fn settle_quarantines_a_damaged_body_and_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("semantic.db");
        drop(filled_ledger(&path));
        damage_body(&path);

        let index = SemanticIndex::open_unsettled(&path).unwrap();
        let report = index.settle().unwrap();
        assert!(report.quarantined, "{report}");
        assert_eq!(report.vectors, 0);
        assert_eq!(corrupt_files(&dir).len(), 1);

        assert!(index.source_ids("help").unwrap().is_empty());
        store_vector(&index, "after", "m", &[1.0, 0.0]);
        assert_eq!(index.source_ids("help").unwrap(), ["after"]);
        assert_eq!(ranked(&index, "m", &[1.0, 0.0]).len(), 1);
        assert_eq!(index.lexical_matches("after"), 1);
    }

    #[test]
    fn a_reencode_compacts_the_file_and_a_second_settle_does_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("semantic.db");
        let index = SemanticIndex::open(&path).unwrap();
        for (at, vector) in pooled(200, 64).iter().enumerate() {
            store_vector(&index, &format!("s{at:03}"), "m", vector);
        }
        as_float_ledger(&index, 3);
        drop(index);

        let index = SemanticIndex::open_unsettled(&path).unwrap();
        let report = index.settle().unwrap();
        assert_eq!(report.migrated_from, Some(3));
        assert_eq!(report.vectors, 200);
        assert!(report.arena_bytes >= 200 * 64);
        let (before, after) = report.compacted.expect("a re-encode compacts");
        assert!(after < before, "{report}");
        let wal = std::fs::metadata(dir.path().join("semantic.db-wal")).unwrap();
        assert_eq!(wal.len(), 0, "the checkpoint truncates the WAL");
        assert_eq!(index.settle().unwrap(), SettleReport::default());
    }

    #[test]
    fn a_current_ledger_settles_with_no_migration_and_no_compaction() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("semantic.db");
        drop(filled_ledger(&path));

        let report = SemanticIndex::open_unsettled(&path)
            .unwrap()
            .settle()
            .unwrap();
        assert_eq!(report.migrated_from, None);
        assert_eq!(report.compacted, None);
        assert!(!report.quarantined);
        assert!(report.vectors > 0);
    }

    #[test]
    fn a_removal_before_settle_never_touches_the_writer() {
        let dir = tempfile::tempdir().unwrap();
        let index = SemanticIndex::open_unsettled(dir.path().join("semantic.db")).unwrap();
        let held = index.hold_writer_for_test();
        assert!(super::super::ingest::remove_session_sources(&index, "session").is_ok());
        drop(held);
    }

    /// A ledger with enough in it to have pages worth damaging, all of them in the file,
    /// since closing leaves a WAL behind that would answer for a damaged page.
    fn filled_ledger(path: &Path) -> SemanticIndex {
        let index = SemanticIndex::open(path).unwrap();
        let text = "The words of a passage long enough to fill a page or two. ".repeat(4);
        for at in 0..200 {
            store(&index, &format!("s{at:03}"), &text, Some("m"));
        }
        compact(&index.db.lock()).unwrap();
        index
    }

    /// Scribble on interior pages, sparing the header, so the file still opens and only
    /// reading its body finds the damage.
    fn damage_body(path: &Path) {
        use std::io::{Seek, SeekFrom, Write};
        let mut file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        let len = file.metadata().unwrap().len();
        assert!(len > 8192, "too small to scribble on safely");
        file.seek(SeekFrom::Start(4096 + 32)).unwrap();
        file.write_all(&[0xAB; 512]).unwrap();
        file.seek(SeekFrom::Start(len - 2048)).unwrap();
        file.write_all(&[0xCD; 1024]).unwrap();
    }

    /// The quarantined databases beside a ledger, by name.
    fn corrupt_files(dir: &tempfile::TempDir) -> Vec<String> {
        std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".corrupt-") && !name.ends_with("-wal"))
            .filter(|name| !name.ends_with("-shm"))
            .collect()
    }

    #[test]
    fn replacing_a_source_keeps_the_text_shadow_in_step() {
        let dir = tempfile::tempdir().unwrap();
        let index = open(&dir);
        store(&index, "a", "The word at0339 is here.", Some("m"));
        assert_eq!(index.lexical_matches("at0339"), 1);

        store(&index, "a", "Something else entirely.", Some("m"));
        assert_eq!(index.lexical_matches("at0339"), 0);
        assert_eq!(index.lexical_matches("entirely"), 1);
        assert_eq!(index.chunks().len(), 1);
    }

    #[test]
    fn removing_a_source_removes_its_chunks_and_nobody_elses() {
        let dir = tempfile::tempdir().unwrap();
        let index = open(&dir);
        store(&index, "a", "First source.", Some("m"));
        store(&index, "b", "Second source.", Some("m"));

        index.remove_source("help", "a").unwrap();
        assert_eq!(index.source_state("help", "a").unwrap(), None);
        assert_eq!(index.source_ids("help").unwrap(), vec!["b"]);
        assert_eq!(index.lexical_matches("First"), 0);
        assert_eq!(index.lexical_matches("Second"), 1);
    }

    #[test]
    fn a_source_stored_with_no_model_is_found_lexically_and_carries_no_vector() {
        let dir = tempfile::tempdir().unwrap();
        let index = open(&dir);
        store(&index, "a", "No embedder was running.", None);
        let chunks = index.chunks();
        assert_eq!(chunks[0].model, None);
        assert_eq!(chunks[0].vector, None);
        assert_eq!(index.lexical_matches("embedder"), 1);
        assert_eq!(
            index.source_state("help", "a").unwrap().unwrap().model,
            None
        );
    }

    #[test]
    fn a_passage_the_model_could_not_embed_is_stored_with_no_model_of_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let index = open(&dir);
        let passages = chunk("ctx", "One paragraph.");
        index
            .replace_source(&Replacement {
                kind: "help",
                id: "a",
                content_hash: "hash",
                model: Some("m"),
                passages: &passages,
                vectors: &[None],
                meta: None,
                lexical: &[],
            })
            .unwrap();
        assert_eq!(index.chunks()[0].model, None);
        assert_eq!(
            index
                .source_state("help", "a")
                .unwrap()
                .unwrap()
                .model
                .as_deref(),
            Some("m")
        );
    }

    /// The shape a schema-1 file has on disk, before any migration.
    const SCHEMA_1: &str = "
        CREATE TABLE sources (
            source_kind TEXT NOT NULL, source_id TEXT NOT NULL,
            content_hash TEXT NOT NULL, model TEXT,
            PRIMARY KEY (source_kind, source_id)
        );
        CREATE TABLE chunks (
            id INTEGER PRIMARY KEY, source_kind TEXT NOT NULL, source_id TEXT NOT NULL,
            ordinal INTEGER NOT NULL, span_start INTEGER NOT NULL, span_end INTEGER NOT NULL,
            context TEXT NOT NULL, body TEXT NOT NULL, model TEXT, vector BLOB,
            UNIQUE (source_kind, source_id, ordinal)
        );
        CREATE INDEX chunks_model ON chunks (model);
        CREATE VIRTUAL TABLE chunks_fts USING fts5(
            context, body, content='chunks', content_rowid='id', tokenize='porter unicode61'
        );
        CREATE TRIGGER chunks_fts_insert AFTER INSERT ON chunks BEGIN
            INSERT INTO chunks_fts (rowid, context, body) VALUES (new.id, new.context, new.body);
        END;
        CREATE TRIGGER chunks_fts_delete AFTER DELETE ON chunks BEGIN
            INSERT INTO chunks_fts (chunks_fts, rowid, context, body)
            VALUES ('delete', old.id, old.context, old.body);
        END;
        INSERT INTO sources VALUES ('help', 'features#a', 'h1', 'm');
        INSERT INTO sources VALUES ('session', 's1/turn-1', 'h2', 'm');
        INSERT INTO chunks (source_kind, source_id, ordinal, span_start, span_end, context, body, model)
        VALUES ('help', 'features#a', 0, 0, 4, 'ctx', 'helpful', 'm'),
               ('session', 's1/turn-1', 0, 0, 4, 'ctx', 'privately', 'm');
        PRAGMA user_version = 1;
    ";

    #[test]
    fn a_schema_4_ledger_gains_the_column_and_is_not_reencoded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("semantic.db");
        let index = SemanticIndex::open(&path).unwrap();
        for (at, vector) in pooled(4, 8).iter().enumerate() {
            store_vector(&index, &format!("s{at}"), "m", vector);
        }
        let before = blobs(&index);
        {
            let conn = index.db.lock();
            drop_open_labels(&conn);
            conn.execute(
                "INSERT INTO transcript_cursors (session_id, path, offset, tail_hash, \
                 turn_count, shown_turn, open, pending_close) \
                 VALUES ('old', '/p/old.jsonl', 1, 2, 3, 4, 0, 0)",
                [],
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 4).unwrap();
        }
        drop(index);

        let index = SemanticIndex::open_unsettled(&path).unwrap();
        let report = index.settle().unwrap();
        assert_eq!(report.migrated_from, Some(4));
        assert_eq!(report.compacted, None, "only a re-encode compacts");
        assert_eq!(blobs(&index), before);
        assert_eq!(index.cursor("old").unwrap().unwrap().open_labels, None);
    }

    #[test]
    fn a_schema_1_ledger_keeps_its_help_and_loses_the_placeholder_kind() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("semantic.db");
        let conn = tugcore::ledger_db::open(&path).unwrap();
        conn.execute_batch(SCHEMA_1).unwrap();
        drop(conn);

        let index = SemanticIndex::open(&path).unwrap();
        let conn = index.db.lock();
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        let indexes: Vec<String> = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'chunks_k%' \
                 OR name = 'chunks_model'",
            )
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        drop(conn);
        assert_eq!(version, SCHEMA_VERSION);
        assert_eq!(indexes, ["chunks_kind_model"]);
        assert_eq!(index.source_ids("help").unwrap(), ["features#a"]);
        assert!(index.source_ids("session").unwrap().is_empty());
        assert_eq!(index.lexical_matches("helpful"), 1);
        assert_eq!(index.lexical_matches("privately"), 0);
        assert!(!index.chunks()[0].lexical_only);
        index.set_mark("facts", 3).unwrap();
        assert_eq!(index.mark("facts").unwrap(), 3);
    }

    #[test]
    fn a_schema_2_ledger_renames_its_tags_and_keeps_its_vectors() {
        const KIND: &str = "document";
        const CONTEXTUAL: &str = "nl-contextual-r1";
        const SENTENCE: &str = "nl-sentence-r2";
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("semantic.db");
        let index = SemanticIndex::open(&path).unwrap();
        let floats = vec![0.25_f32, -0.5];
        for (id, model) in [("a", "nl-contextual-en-r1"), ("b", "nl-sentence-en-r2")] {
            index
                .replace_source(&Replacement {
                    kind: KIND,
                    id,
                    content_hash: "hash",
                    model: Some(model),
                    passages: &chunk("ctx", "One paragraph."),
                    vectors: &[Some(floats.clone())],
                    meta: None,
                    lexical: &[],
                })
                .unwrap();
        }
        as_float_ledger(&index, 2);
        drop(index);

        let index = SemanticIndex::open(&path).unwrap();
        let after = index.chunks();
        let tags: Vec<&str> = after
            .iter()
            .map(|chunk| chunk.model.as_deref().unwrap())
            .collect();
        assert_eq!(tags, [CONTEXTUAL, SENTENCE]);
        for chunk in &after {
            assert_eq!(chunk.vector.as_ref(), Some(&floats));
        }
        for (id, tag) in [("a", CONTEXTUAL), ("b", SENTENCE)] {
            let state = index.source_state(KIND, id).unwrap().unwrap();
            assert_eq!(state.model.as_deref(), Some(tag));
        }
        // A source is current under its renamed tag, so a live model of that tag
        // re-embeds nothing, and only the other model's source reads stale.
        for (live, other) in [(CONTEXTUAL, "b"), (SENTENCE, "a")] {
            let stale = index.stale_sources(live, None, 10).unwrap();
            let stale: Vec<&str> = stale.iter().map(|key| key.id.as_str()).collect();
            assert_eq!(stale, [other]);
        }
    }

    /// Put a current ledger back as schema `version` wrote it: floats, no offsets, and
    /// no labels on its cursors.
    fn as_float_ledger(index: &SemanticIndex, version: i64) {
        let vectors: Vec<(i64, Vec<f32>)> = index
            .chunks()
            .into_iter()
            .filter_map(|chunk| Some((chunk.id, chunk.vector?)))
            .collect();
        let conn = index.db.lock();
        for (id, vector) in vectors {
            conn.execute(
                "UPDATE chunks SET vector = ?2 WHERE id = ?1",
                params![id, encode_vector(&vector)],
            )
            .unwrap();
        }
        conn.execute_batch("DELETE FROM vector_offsets").unwrap();
        drop_open_labels(&conn);
        conn.pragma_update(None, "user_version", version).unwrap();
    }

    fn drop_open_labels(conn: &Connection) {
        conn.execute_batch("ALTER TABLE transcript_cursors DROP COLUMN open_labels")
            .unwrap();
    }

    /// Unit vectors sharing a large component, the same every run.
    fn pooled(count: usize, dims: usize) -> Vec<Vec<f32>> {
        let mut seed = 0x2545_f491_4f6c_dd1d_u64;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed % 2001) as f32 / 1000.0 - 1.0
        };
        let shared: Vec<f32> = (0..dims).map(|_| next()).collect();
        (0..count)
            .map(|_| {
                let raw: Vec<f32> = shared.iter().map(|s| s * 2.0 + next()).collect();
                let norm = raw.iter().map(|v| v * v).sum::<f32>().sqrt();
                raw.iter().map(|v| v / norm).collect()
            })
            .collect()
    }

    fn store_vector(index: &SemanticIndex, id: &str, model: &str, vector: &[f32]) {
        index
            .replace_source(&Replacement {
                kind: "help",
                id,
                content_hash: "hash",
                model: Some(model),
                passages: &chunk("ctx", &format!("The words of {id}.")),
                vectors: &[Some(vector.to_vec())],
                meta: None,
                lexical: &[],
            })
            .unwrap();
    }

    /// Every chunk near `query`, as `(chunk, score)`.
    fn ranked(index: &SemanticIndex, model: &str, query: &[f32]) -> Vec<(i64, f32)> {
        let (scored, handed) = index.rank_vectors(&["help"], model, None, |_| true, query, 1000);
        assert_eq!(scored.len(), handed);
        scored.iter().map(|item| (item.id, item.score)).collect()
    }

    fn blobs(index: &SemanticIndex) -> Vec<(i64, Option<Vec<u8>>)> {
        index
            .db
            .lock()
            .prepare("SELECT id, vector FROM chunks ORDER BY id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn a_schema_3_ledger_is_reencoded_and_ranks_as_it_did() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("semantic.db");
        let vectors = pooled(61, 64);
        let (query, stored) = vectors.split_first().unwrap();
        let index = SemanticIndex::open(&path).unwrap();
        for (at, vector) in stored.iter().enumerate() {
            store_vector(&index, &format!("s{at:02}"), "m", vector);
        }
        store_vector(&index, "malformed", "m", stored[0].as_slice());
        let ids: HashMap<String, i64> = index
            .chunks()
            .into_iter()
            .map(|chunk| (chunk.source_id, chunk.id))
            .collect();
        as_float_ledger(&index, 3);
        index
            .db
            .lock()
            .execute(
                "UPDATE chunks SET vector = x'010203' WHERE id = ?1",
                params![ids["malformed"]],
            )
            .unwrap();
        drop(index);

        let mut floats: Vec<(i64, f32)> = stored
            .iter()
            .enumerate()
            .map(|(at, vector)| {
                (
                    ids[&format!("s{at:02}")],
                    tugsem_core::cosine(query, vector).unwrap(),
                )
            })
            .collect();
        floats.sort_by(|a, b| b.1.total_cmp(&a.1));

        let index = SemanticIndex::open(&path).unwrap();
        let after = ranked(&index, "m", query);
        assert_eq!(after.len(), stored.len());
        assert_eq!(after[0].0, floats[0].0, "the same top hit");
        let best: HashSet<i64> = floats[..10].iter().map(|item| item.0).collect();
        let kept = after[..10].iter().filter(|item| best.contains(&item.0));
        assert!(kept.count() >= 9, "{after:?}\n{floats:?}");

        let offsets: i64 = index
            .db
            .lock()
            .query_row(
                "SELECT count(*) FROM vector_offsets WHERE model = 'm' AND dims = 64",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(offsets, 1);

        let chunks = index.chunks();
        let malformed = chunks
            .iter()
            .find(|chunk| chunk.source_id == "malformed")
            .unwrap();
        assert_eq!((&malformed.vector, &malformed.model), (&None, &None));
        assert_eq!(index.lexical_matches("malformed"), 1);
        for (at, vector) in stored.iter().enumerate() {
            let id = format!("s{at:02}");
            let chunk = chunks.iter().find(|chunk| chunk.source_id == id).unwrap();
            let back = chunk.vector.as_ref().unwrap();
            for (value, was) in back.iter().zip(vector) {
                assert!((value - was).abs() < 0.01, "{value} {was}");
            }
        }
    }

    #[test]
    fn reopening_a_quantized_ledger_changes_no_blob() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("semantic.db");
        let vectors = pooled(5, 16);
        let index = SemanticIndex::open(&path).unwrap();
        for (at, vector) in vectors.iter().enumerate() {
            store_vector(&index, &format!("s{at}"), "m", vector);
        }
        let before = blobs(&index);
        assert!(before.iter().all(|(_, blob)| blob.is_some()));
        drop(index);
        assert_eq!(blobs(&SemanticIndex::open(&path).unwrap()), before);
    }

    #[test]
    fn the_first_write_freezes_the_offset_and_later_ones_keep_it() {
        let dir = tempfile::tempdir().unwrap();
        let index = open(&dir);
        store_vector(&index, "a", "m", &[0.6, 0.8]);
        let offset = || -> Vec<u8> {
            index
                .db
                .lock()
                .query_row("SELECT offset FROM vector_offsets", [], |row| row.get(0))
                .unwrap()
        };
        let frozen = offset();
        assert_eq!(decode_vector(&frozen).unwrap(), [0.6, 0.8]);
        store_vector(&index, "b", "m", &[0.8, 0.6]);
        assert_eq!(offset(), frozen);
    }

    #[test]
    fn the_arena_agrees_with_the_file_after_every_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("semantic.db");
        let vectors = pooled(10, 32);
        let query = &vectors[0];
        let index = SemanticIndex::open(&path).unwrap();
        let agree = |index: &SemanticIndex| {
            let fresh = SemanticIndex::open(&path).unwrap();
            for model in ["old", "new"] {
                assert_eq!(ranked(index, model, query), ranked(&fresh, model, query));
            }
        };

        for (at, vector) in vectors[1..7].iter().enumerate() {
            store_vector(&index, &format!("s{at}"), "old", vector);
        }
        agree(&index);
        assert_eq!(ranked(&index, "old", query).len(), 6);

        // Replaced, with the same words and another vector.
        store_vector(&index, "s0", "old", &vectors[7]);
        agree(&index);

        // Moved to another model.
        let key = SourceKey {
            kind: "help".to_string(),
            id: "s1".to_string(),
        };
        let chunk_id = index.embeddable_chunks("help", "s1").unwrap().remove(0).id;
        index
            .replace_vectors(&key, "new", &[(chunk_id, Some(&vectors[8]))])
            .unwrap();
        agree(&index);
        assert_eq!(ranked(&index, "old", query).len(), 5);
        assert_eq!(ranked(&index, "new", query).len(), 1);

        // Moved, with a passage the new model has no vector for.
        let key = SourceKey {
            kind: "help".to_string(),
            id: "s2".to_string(),
        };
        let chunk_id = index.embeddable_chunks("help", "s2").unwrap().remove(0).id;
        index
            .replace_vectors(&key, "new", &[(chunk_id, None)])
            .unwrap();
        agree(&index);
        assert_eq!(ranked(&index, "old", query).len(), 4);

        index.remove_sources("help", &["s3", "s4"]).unwrap();
        agree(&index);
        assert_eq!(ranked(&index, "old", query).len(), 2);

        // A re-embed of a source that has since gone leaves it gone.
        index.remove_source("help", "s5").unwrap();
        let key = SourceKey {
            kind: "help".to_string(),
            id: "s5".to_string(),
        };
        index
            .replace_vectors(&key, "new", &[(i64::MAX, Some(&vectors[9]))])
            .unwrap();
        agree(&index);
    }

    #[test]
    fn a_read_held_open_neither_blocks_a_write_nor_sees_it() {
        let dir = tempfile::tempdir().unwrap();
        let index = open(&dir);
        store(&index, "a", "First source.", Some("m"));
        store(&index, "b", "Second source.", Some("m"));

        let reader = index.reader.lock();
        let mut stmt = reader
            .prepare("SELECT source_id FROM chunks ORDER BY source_id")
            .unwrap();
        let mut rows = stmt.query([]).unwrap();
        let first: String = rows.next().unwrap().unwrap().get(0).unwrap();
        assert_eq!(first, "a");

        index.remove_source("help", "b").unwrap();
        store(&index, "c", "Third source.", Some("m"));
        assert_eq!(index.chunks().len(), 2);

        let second: String = rows.next().unwrap().unwrap().get(0).unwrap();
        assert_eq!(second, "b");
        assert!(rows.next().unwrap().is_none());
        drop(rows);
        drop(stmt);
        drop(reader);

        assert_eq!(index.chunks().len(), 2);
    }

    #[test]
    fn marks_and_cursors_outlive_the_connection() {
        let dir = tempfile::tempdir().unwrap();
        let index = open(&dir);
        assert_eq!(index.mark("facts").unwrap(), 0);
        index.set_mark("facts", 41).unwrap();
        index.set_mark("facts", 42).unwrap();
        let cursor = TranscriptCursor {
            session_id: "s1".to_string(),
            path: "/p/s1.jsonl".to_string(),
            offset: 1024,
            tail_hash: -7,
            turn_count: 3,
            shown_turn: 4,
            open: true,
            pending_close: false,
            pending_close_msg_id: Some("msg".to_string()),
            leaf_uuid: None,
            effective_uuids: Some(vec![1, 2, 3]),
            open_labels: Some(r#"{"t1":"cargo test"}"#.to_string()),
        };
        index.set_cursor(&cursor).unwrap();
        drop(index);

        let index = open(&dir);
        assert_eq!(index.mark("facts").unwrap(), 42);
        assert_eq!(index.cursor("s1").unwrap(), Some(cursor));
        index.delete_cursor("s1").unwrap();
        assert_eq!(index.cursor("s1").unwrap(), None);
    }

    #[test]
    fn a_sessions_range_holds_its_sources_and_no_longer_named_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let index = open(&dir);
        for id in ["s1/a.0", "s1/b.0", "s10/a.0", "s1-x/a.0", "s0/a.0"] {
            index.store_for_test("transcript", id);
        }
        index.store_for_test("fact", "s1/9");
        let mut ids = index.session_source_ids("transcript", "s1").unwrap();
        ids.sort();
        assert_eq!(ids, ["s1/a.0", "s1/b.0"]);
    }

    #[test]
    fn only_sources_a_model_reads_and_not_of_the_live_model_are_stale() {
        let dir = tempfile::tempdir().unwrap();
        let index = open(&dir);
        let passages = chunk("ctx", "Words a model reads.");
        let vectors: &[Option<Vec<f32>>] = &[Some(vec![1.0, 0.0])];
        let write = |kind: &str, id: &str, model: Option<&str>, passages: &[Passage]| {
            index
                .replace_source(&Replacement {
                    kind,
                    id,
                    content_hash: "hash",
                    model,
                    passages,
                    vectors: if model.is_some() && !passages.is_empty() {
                        vectors
                    } else {
                        &[]
                    },
                    meta: None,
                    lexical: &chunk("ctx", "A lexical row."),
                })
                .unwrap();
        };
        write("help", "h", Some("old"), &passages);
        write("fact", "s/1", Some("old"), &passages);
        write("fact", "s/2", Some("live"), &passages);
        write("fact", "s/3", None, &passages);
        write("fact", "s/4", Some("old"), &[]);

        let ids =
            |page: Vec<SourceKey>| -> Vec<String> { page.into_iter().map(|key| key.id).collect() };
        let page = index.stale_sources("live", None, 1).unwrap();
        let after = page[0].clone();
        assert_eq!(ids(page), ["s/1"]);
        let page = index.stale_sources("live", Some(&after), 5).unwrap();
        assert_eq!(ids(page), ["s/3"]);
    }

    #[test]
    fn lexical_rows_follow_the_passages_with_no_vector_or_model() {
        let dir = tempfile::tempdir().unwrap();
        let index = open(&dir);
        let passages = chunk("ctx", "The head of a log.");
        let lexical = tugsem_core::lexical_spans("ctx", "line one\nline two\n");
        index
            .replace_source(&Replacement {
                kind: "transcript",
                id: "s/u.0",
                content_hash: "hash",
                model: Some("m"),
                passages: &passages,
                vectors: &[Some(vec![1.0, 0.0])],
                meta: Some("{\"turn\":1}"),
                lexical: &lexical,
            })
            .unwrap();
        let chunks = index.chunks();
        assert_eq!(chunks.len(), 2);
        assert!(!chunks[0].lexical_only);
        assert!(chunks[1].lexical_only);
        assert_eq!(chunks[1].ordinal, 1);
        assert_eq!(chunks[1].model, None);
        assert_eq!(chunks[1].vector, None);
        assert_eq!(
            index
                .embeddable_chunks("transcript", "s/u.0")
                .unwrap()
                .len(),
            1
        );
        assert_eq!(chunks.iter().filter(|c| c.vector.is_some()).count(), 1);
        let meta: Option<String> = index
            .db
            .lock()
            .query_row("SELECT meta FROM sources", [], |row| row.get(0))
            .unwrap();
        assert_eq!(meta.as_deref(), Some("{\"turn\":1}"));
    }
}
