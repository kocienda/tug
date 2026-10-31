//! The index's shape, as data: its migrations and its vector encoding. The
//! caller owns the file and runs these.

/// The schema's version, which a caller stamps into `PRAGMA user_version`.
pub const SCHEMA_VERSION: i64 = 5;

/// The migrations from older schemas, each keyed by the on-disk version it
/// upgrades from. A change to [`CREATE_SCHEMA`] bumps [`SCHEMA_VERSION`] and adds
/// one here, because a database stamped with an older version takes these and not
/// a fresh create's shape.
///
/// The `session` kind only ever held what tests wrote, and its rows have no reader
/// in this shape. The index on `model` alone goes because `help.search` filters on
/// kind and model both, and it would send a question about help past every
/// transcript row, through each row's body, to read its kind.
///
/// The model tag stops naming a language, since the helper now detects each text's.
/// The tags are renamed in place and nothing is re-embedded, because the language
/// argument does not move the Latin model's vector: a stored one is the same bytes
/// the new helper would write, and a new tag with no rename would strand them all.
///
/// Schema 4 stores vectors as [`quantize`](crate::quantize) writes them, which is no
/// statement here because SQL cannot do it: an offset is a mean over floats and a
/// blob is a computed encoding. The caller re-encodes in its `create` step, which
/// runs after these and so sees the renamed tags, and only when it upgrades a file
/// older than 4, since `create` also runs on every later version step.
///
/// Schema 5 keeps a transcript's unanswered tool calls in its cursor. A schema 1 file
/// has no cursors yet, and `create` runs after these, so the table is made here first.
pub const MIGRATIONS: &[(i64, &str)] = &[
    (
        1,
        "
        ALTER TABLE sources ADD COLUMN meta TEXT;
        ALTER TABLE chunks ADD COLUMN lexical_only INTEGER NOT NULL DEFAULT 0;
        DELETE FROM chunks WHERE source_kind = 'session';
        DELETE FROM sources WHERE source_kind = 'session';
        DROP INDEX IF EXISTS chunks_model;
        ",
    ),
    (
        2,
        "
        UPDATE chunks SET model = 'nl-contextual-r' || substr(model, 19)
            WHERE model LIKE 'nl-contextual-en-r%';
        UPDATE chunks SET model = 'nl-sentence-r' || substr(model, 17)
            WHERE model LIKE 'nl-sentence-en-r%';
        UPDATE sources SET model = 'nl-contextual-r' || substr(model, 19)
            WHERE model LIKE 'nl-contextual-en-r%';
        UPDATE sources SET model = 'nl-sentence-r' || substr(model, 17)
            WHERE model LIKE 'nl-sentence-en-r%';
        ",
    ),
    (
        4,
        "
        CREATE TABLE IF NOT EXISTS transcript_cursors (
            session_id           TEXT PRIMARY KEY,
            path                 TEXT NOT NULL,
            offset               INTEGER NOT NULL,
            tail_hash            INTEGER NOT NULL,
            turn_count           INTEGER NOT NULL,
            shown_turn           INTEGER NOT NULL,
            open                 INTEGER NOT NULL,
            pending_close        INTEGER NOT NULL,
            pending_close_msg_id TEXT,
            leaf_uuid            TEXT,
            effective_uuids      BLOB
        );
        ALTER TABLE transcript_cursors ADD COLUMN open_labels TEXT;
        ",
    ),
];

/// The current shape, idempotently.
///
/// `sources` says what each source was indexed from, which is how a caller knows
/// not to re-embed one whose content and live model are both unchanged. A chunk's
/// `model` and `vector` are null when it was stored with no embedder running, and
/// such a chunk is still found lexically. A `lexical_only` chunk never has either:
/// it is a stretch of a body too long for any model to read. `chunks_fts` is the
/// text shadow for BM25, kept in step by the documented external-content triggers.
///
/// `stream_marks` says how far a stream of rows has been read, and
/// `transcript_cursors` where each transcript's reader stopped. Its `open_labels` is
/// JSON of tool-call id to label for the calls with no result yet, so a result read
/// past the cursor is labelled as a whole read would label it.
///
/// `vector_offsets` holds what a model's vectors at one dimension are stored less.
/// Each is frozen at the first write and never moves, or every blob written before
/// would mean something else.
pub const CREATE_SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS sources (
        source_kind  TEXT NOT NULL,
        source_id    TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        model        TEXT,
        meta         TEXT,
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
        lexical_only INTEGER NOT NULL DEFAULT 0,
        UNIQUE (source_kind, source_id, ordinal)
    );

    CREATE INDEX IF NOT EXISTS chunks_kind_model ON chunks (source_kind, model);

    CREATE TABLE IF NOT EXISTS vector_offsets (
        model  TEXT NOT NULL,
        dims   INTEGER NOT NULL,
        offset BLOB NOT NULL,
        PRIMARY KEY (model, dims)
    );

    CREATE TABLE IF NOT EXISTS stream_marks (
        stream  TEXT PRIMARY KEY,
        last_id INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transcript_cursors (
        session_id           TEXT PRIMARY KEY,
        path                 TEXT NOT NULL,
        offset               INTEGER NOT NULL,
        tail_hash            INTEGER NOT NULL,
        turn_count           INTEGER NOT NULL,
        shown_turn           INTEGER NOT NULL,
        open                 INTEGER NOT NULL,
        pending_close        INTEGER NOT NULL,
        pending_close_msg_id TEXT,
        leaf_uuid            TEXT,
        effective_uuids      BLOB,
        open_labels          TEXT
    );

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

/// A whole vector as a blob of little-endian 32-bit floats: what an offset is stored
/// as, and what a chunk's vector was before schema 4.
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
}
