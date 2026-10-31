//! `semantic.db`: one ledger per instance, written only by tugcast, holding what
//! has been chunked and embedded. It can always be rebuilt from its sources, so a
//! corrupt file is quarantined and started over with nothing salvaged.

use std::path::Path;

use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, params};
use tugsem_core::{CREATE_SCHEMA, MIGRATIONS, Passage, SCHEMA_VERSION, encode_vector};

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
}

pub(crate) struct SemanticIndex {
    db: Mutex<Connection>,
}

/// One stored passage's vector, for ranking.
pub(crate) struct StoredVector {
    pub id: i64,
    pub source_id: String,
    pub vector: Vec<f32>,
}

/// The SQL that keeps a row to a source-id prefix, the numbered parameter being that
/// prefix or null for every source. `substr` because a prefix is text, not a pattern.
fn in_scope(param: u8) -> String {
    format!("(?{param} IS NULL OR substr(chunks.source_id, 1, length(?{param})) = ?{param})")
}

/// One term as FTS5 reads it: quoted, so a word FTS5 would take for an operator is
/// only ever a word.
fn fts_term(term: &str) -> String {
    format!("\"{}\"", term.replace('"', "\"\""))
}

impl SemanticIndex {
    pub(crate) fn open(path: impl AsRef<Path>) -> Result<Self, SemanticError> {
        crate::ledger_integrity::integrity_gate(path.as_ref(), "semantic");
        let conn = tugcore::ledger_db::open(path)?;
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
        Ok(Self {
            db: Mutex::new(conn),
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
                 context, body, model, vector) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
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
                ])?;
            }
        }
        tx.execute(
            "INSERT INTO sources (source_kind, source_id, content_hash, model) \
             VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT (source_kind, source_id) \
             DO UPDATE SET content_hash = excluded.content_hash, model = excluded.model",
            params![source.kind, source.id, source.content_hash, source.model],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Remove a source and its chunks. Retention follows the source.
    pub(crate) fn remove_source(&self, kind: &str, id: &str) -> Result<(), SemanticError> {
        let mut conn = self.db.lock();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM chunks WHERE source_kind = ?1 AND source_id = ?2",
            params![kind, id],
        )?;
        tx.execute(
            "DELETE FROM sources WHERE source_kind = ?1 AND source_id = ?2",
            params![kind, id],
        )?;
        tx.commit()?;
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
        let conn = self.db.lock();
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
        let conn = self.db.lock();
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
        let conn = self.db.lock();
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

    #[cfg(test)]
    pub(crate) fn chunks(&self) -> Vec<StoredChunk> {
        let conn = self.db.lock();
        let mut stmt = conn
            .prepare(
                "SELECT source_id, ordinal, context, body, model, vector FROM chunks \
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
            })
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
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
}
