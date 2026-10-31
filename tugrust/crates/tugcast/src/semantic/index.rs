//! `semantic.db`: one ledger per instance, written only by tugcast, holding what
//! has been chunked and embedded. It can always be rebuilt from its sources, so a
//! corrupt file is quarantined and started over with nothing salvaged.

use std::path::{Path, PathBuf};
use std::time::Duration;

use parking_lot::Mutex;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use tugsem_core::{CREATE_SCHEMA, Hit, MIGRATIONS, Passage, SCHEMA_VERSION, encode_vector};

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
}

/// A passage as a search shows it: the hit, and what `Hit` does not carry.
pub(crate) struct FoundPassage {
    pub chunk_id: i64,
    pub hit: Hit,
    pub meta: Option<String>,
    pub lexical_only: bool,
}

/// One stored passage's vector, for ranking.
pub(crate) struct StoredVector {
    pub id: i64,
    pub source_id: String,
    pub vector: Vec<f32>,
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
}

/// The SQL that keeps a row to a source-id prefix, the numbered parameter being that
/// prefix or null for every source. `substr` because a prefix is text, not a pattern.
fn in_scope(param: u8) -> String {
    format!("(?{param} IS NULL OR substr(chunks.source_id, 1, length(?{param})) = ?{param})")
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

impl SemanticIndex {
    pub(crate) fn open(path: impl AsRef<Path>) -> Result<Self, SemanticError> {
        crate::ledger_integrity::integrity_gate(path.as_ref(), "semantic");
        let conn = tugcore::ledger_db::open(path.as_ref())?;
        tugcore::ledger_db::apply_pragmas(&conn)?;
        let schema = tugcore::ledger_db::LedgerSchema {
            db: rusqlite::DatabaseName::Main,
            version: SCHEMA_VERSION,
            migrations: MIGRATIONS,
            already_applied: tugcore::ledger_db::no_migration_error_absorbed,
        };
        let migrated = tugcore::ledger_db::migrate::<SemanticError>(&conn, &schema, |conn| {
            conn.execute_batch(CREATE_SCHEMA)?;
            Ok(())
        })?;
        if let tugcore::ledger_db::Migrated::TooNew { on_disk } = migrated {
            return Err(SemanticError::SchemaTooNew {
                on_disk,
                supported: SCHEMA_VERSION,
            });
        }
        let reader = Connection::open_with_flags(
            path.as_ref(),
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        reader.busy_timeout(Duration::from_secs(5))?;
        Ok(Self {
            path: path.as_ref().to_path_buf(),
            db: Mutex::new(conn),
            reader: Mutex::new(reader),
        })
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
        {
            let mut insert = tx.prepare(
                "INSERT INTO chunks (source_kind, source_id, ordinal, span_start, span_end, \
                 context, body, model, vector, lexical_only) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            )?;
            for (index, passage) in source.passages.iter().enumerate() {
                let vector = source.vectors.get(index).and_then(Option::as_deref);
                insert.execute(params![
                    source.kind,
                    source.id,
                    passage.ordinal as i64,
                    passage.start as i64,
                    passage.end as i64,
                    passage.context,
                    passage.body,
                    vector.and(source.model),
                    vector.map(encode_vector),
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
        tx.commit()?;
        Ok(())
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
            let mut update =
                tx.prepare("UPDATE chunks SET model = ?2, vector = ?3 WHERE id = ?1")?;
            for (id, vector) in vectors {
                update.execute(params![
                    id,
                    vector.and(Some(model)),
                    vector.map(encode_vector),
                ])?;
            }
        }
        tx.execute(
            "UPDATE sources SET model = ?3 WHERE source_kind = ?1 AND source_id = ?2",
            params![key.kind, key.id, model],
        )?;
        tx.commit()?;
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
                 pending_close, pending_close_msg_id, leaf_uuid, effective_uuids \
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
             effective_uuids) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
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

    /// Every vector of `model` among the sources of `kind` within `scope`, a
    /// source-id prefix. A passage stored with no vector, or under another model, is
    /// not in the comparison at all.
    pub(crate) fn vectors(
        &self,
        kind: &str,
        model: &str,
        scope: Option<&str>,
    ) -> Result<Vec<StoredVector>, SemanticError> {
        let conn = self.reader.lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT id, source_id, vector FROM chunks \
             WHERE source_kind = ?1 AND model = ?2 AND vector IS NOT NULL AND {}",
            in_scope(3)
        ))?;
        let rows = stmt.query_map(params![kind, model, scope], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ))
        })?;
        let mut vectors = Vec::new();
        for row in rows {
            let (id, source_id, blob) = row?;
            if let Some(vector) = tugsem_core::decode_vector(&blob) {
                vectors.push(StoredVector {
                    id,
                    source_id,
                    vector,
                });
            }
        }
        Ok(vectors)
    }

    /// The sources of `kind` within `scope` whose passages hold any of `terms`, a
    /// passage per row and best first by BM25, with a hit in the context line (a
    /// title, a heading) counting for more than one in the body.
    pub(crate) fn lexical_sources(
        &self,
        kind: &str,
        scope: Option<&str>,
        terms: &[String],
    ) -> Result<Vec<String>, SemanticError> {
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let query = terms
            .iter()
            .map(|term| fts_term(term))
            .collect::<Vec<_>>()
            .join(" OR ");
        let conn = self.reader.lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT chunks.source_id FROM chunks_fts \
             JOIN chunks ON chunks.id = chunks_fts.rowid \
             WHERE chunks_fts MATCH ?1 AND chunks.source_kind = ?2 AND {} \
             ORDER BY bm25(chunks_fts, 4.0, 1.0)",
            in_scope(3)
        ))?;
        let sources = stmt
            .query_map(params![query, kind, scope], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(sources)
    }

    /// Whether some one passage of `kind` within `scope` holds every one of `terms`.
    /// No terms at all asks nothing, so it is held.
    pub(crate) fn holds_all(
        &self,
        kind: &str,
        scope: Option<&str>,
        terms: &[String],
    ) -> Result<bool, SemanticError> {
        if terms.is_empty() {
            return Ok(true);
        }
        let query = terms
            .iter()
            .map(|term| fts_term(term))
            .collect::<Vec<_>>()
            .join(" AND ");
        let conn = self.reader.lock();
        let found = conn
            .query_row(
                &format!(
                    "SELECT 1 FROM chunks_fts JOIN chunks ON chunks.id = chunks_fts.rowid \
                     WHERE chunks_fts MATCH ?1 AND chunks.source_kind = ?2 AND {} LIMIT 1",
                    in_scope(3)
                ),
                params![query, kind, scope],
                |_| Ok(()),
            )
            .optional()?;
        Ok(found.is_some())
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

    /// Hand `score` every vector of `model` among `kinds` within `scope`, a source-id
    /// prefix, whose source `keep` allows, retaining nothing, and answer how many it
    /// was handed.
    pub(crate) fn scan_vectors(
        &self,
        kinds: &[&str],
        model: &str,
        scope: Option<&str>,
        mut keep: impl FnMut(&str) -> bool,
        mut score: impl FnMut(i64, &[u8]),
    ) -> Result<usize, SemanticError> {
        let conn = self.scan_connection()?;
        let (filter, mut values) = in_kinds_and_scope(kinds, scope);
        values.insert(0, model.to_string());
        let mut stmt = conn.prepare(&format!(
            "SELECT chunks.id, chunks.source_id, chunks.vector FROM chunks \
             WHERE chunks.model = ? AND chunks.vector IS NOT NULL AND {filter}"
        ))?;
        let mut rows = stmt.query(rusqlite::params_from_iter(&values))?;
        let mut handed = 0;
        while let Some(row) = rows.next()? {
            if keep(row.get_ref(1)?.as_str().map_err(rusqlite::Error::from)?) {
                score(
                    row.get(0)?,
                    row.get_ref(2)?.as_blob().map_err(rusqlite::Error::from)?,
                );
                handed += 1;
            }
        }
        Ok(handed)
    }

    /// The chunks among `kinds` within `scope` that hold any of `terms`, best first by
    /// BM25 under the same weights as `lexical_sources`, walking rows until `depth` of
    /// them pass `keep`, so a row it refuses takes no place.
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
        let mut stmt = conn
            .prepare(
                "SELECT source_id, ordinal, context, body, model, vector, lexical_only, source_kind \
                 FROM chunks \
                 ORDER BY source_id, ordinal",
            )
            .unwrap();
        stmt.query_map([], |row| {
            Ok(StoredChunk {
                source_id: row.get(0)?,
                ordinal: row.get(1)?,
                context: row.get(2)?,
                body: row.get(3)?,
                model: row.get(4)?,
                vector: row
                    .get::<_, Option<Vec<u8>>>(5)?
                    .map(|blob| tugsem_core::decode_vector(&blob).unwrap()),
                lexical_only: row.get(6)?,
                source_kind: row.get(7)?,
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
        assert_eq!(version, 2);
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

        let left = index.vectors("help", "m", None).unwrap();
        assert_eq!(left.len(), 2);
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
        assert_eq!(index.vectors("transcript", "m", None).unwrap().len(), 1);
        let meta: Option<String> = index
            .db
            .lock()
            .query_row("SELECT meta FROM sources", [], |row| row.get(0))
            .unwrap();
        assert_eq!(meta.as_deref(), Some("{\"turn\":1}"));
    }
}
