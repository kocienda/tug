//! The index's shape, as data: its migrations and its vector encoding. The
//! caller owns the file and runs these.

/// The schema's version, which a caller stamps into `PRAGMA user_version`.
pub const SCHEMA_VERSION: i64 = 1;

/// The migrations from older schemas, each keyed by the on-disk version it
/// upgrades from. There are none yet. A change to [`CREATE_SCHEMA`] bumps
/// [`SCHEMA_VERSION`] and adds one here, because a database stamped with an older
/// version takes these and not a fresh create's shape.
pub const MIGRATIONS: &[(i64, &str)] = &[];

/// The current shape, idempotently.
///
/// `sources` says what each source was indexed from, which is how a caller knows
/// not to re-embed one whose content and live model are both unchanged. A chunk's
/// `model` and `vector` are null when it was stored with no embedder running, and
/// such a chunk is still found lexically. `chunks_fts` is the text shadow for
/// BM25, kept in step by the documented external-content triggers.
pub const CREATE_SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS sources (
        source_kind  TEXT NOT NULL,
        source_id    TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        model        TEXT,
        PRIMARY KEY (source_kind, source_id)
    );

    CREATE TABLE IF NOT EXISTS chunks (
        id          INTEGER PRIMARY KEY,
        source_kind TEXT NOT NULL,
        source_id   TEXT NOT NULL,
        ordinal     INTEGER NOT NULL,
        span_start  INTEGER NOT NULL,
        span_end    INTEGER NOT NULL,
        context     TEXT NOT NULL,
        body        TEXT NOT NULL,
        model       TEXT,
        vector      BLOB,
        UNIQUE (source_kind, source_id, ordinal)
    );

    CREATE INDEX IF NOT EXISTS chunks_model ON chunks (model);

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        context,
        body,
        content='chunks',
        content_rowid='id',
        tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS chunks_fts_insert AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts (rowid, context, body)
        VALUES (new.id, new.context, new.body);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_fts_delete AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts (chunks_fts, rowid, context, body)
        VALUES ('delete', old.id, old.context, old.body);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_fts_update AFTER UPDATE OF context, body ON chunks BEGIN
        INSERT INTO chunks_fts (chunks_fts, rowid, context, body)
        VALUES ('delete', old.id, old.context, old.body);
        INSERT INTO chunks_fts (rowid, context, body)
        VALUES (new.id, new.context, new.body);
    END;
";

/// A vector as the blob the store holds: little-endian 32-bit floats.
pub fn encode_vector(vector: &[f32]) -> Vec<u8> {
    vector
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

/// The vector a blob holds, or `None` for one that is not a whole number of
/// floats.
pub fn decode_vector(blob: &[u8]) -> Option<Vec<f32>> {
    let chunks = blob.chunks_exact(4);
    if !chunks.remainder().is_empty() {
        return None;
    }
    Some(
        chunks
            .map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_512_float_vector_round_trips_through_its_blob() {
        let vector: Vec<f32> = (0..512).map(|index| (index as f32 * 0.37).sin()).collect();
        let blob = encode_vector(&vector);
        assert_eq!(blob.len(), 2048);
        assert_eq!(decode_vector(&blob), Some(vector));
    }

    #[test]
    fn a_blob_that_is_not_whole_floats_is_refused() {
        assert_eq!(decode_vector(&[0, 1, 2]), None);
        assert_eq!(decode_vector(&[]), Some(Vec::new()));
    }

    #[test]
    fn the_schema_holds_what_the_brief_names() {
        let schema = CREATE_SCHEMA;
        for column in [
            "source_kind",
            "source_id",
            "span_start",
            "span_end",
            "model",
            "vector",
            "body",
        ] {
            assert!(schema.contains(column), "{column}");
        }
        assert!(schema.contains("USING fts5"));
    }
}
