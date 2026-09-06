//! Jots document model + HTTP handlers for `/api/jots`.
//!
//! Backs the machine-global `jots.json` (resolved by
//! [`tugcore::instance::jots_path`]) with a small versioned-JSON model,
//! validation, atomic (temp-file + rename) writes, and a SHA-256 content hash
//! the frontend uses for echo suppression. `GET`/`PUT /api/jots` are the
//! only writers; the JOTS feed (`feeds/jots.rs`) reads and pushes.

use std::collections::HashSet;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::Extension;
use axum::body::Bytes;
use axum::extract::ConnectInfo;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::warn;

/// The only document version this build reads and writes.
pub const JOTS_VERSION: u32 = 1;

/// Whole-document size cap at the `PUT` boundary. Jots are a personal
/// phrasebook (kilobytes); anything approaching this is misuse. The frame the
/// feed publishes embeds the whole document, so an oversized file is exactly
/// the kind of write to reject at the boundary.
pub const MAX_JOTS_DOC_BYTES: usize = 1024 * 1024;

// ── Document model (Spec S01) ──────────────────────────────────────────────

/// One atom standing in a jot's text: its identity plus the byte-agnostic
/// index of the `U+FFFC` it occupies in that text.
///
/// A jot has no bytes store and no asset base, and its file is a text
/// document, so an image atom's payload does not go in here — the atom travels
/// as metadata and its chip draws in the pending state the composer already
/// uses for an image whose bytes were evicted. Nothing is dropped; what cannot
/// be carried is shown as not carried.
///
/// Mirrors `JotAtom` in `tugdeck/src/lib/jots-doc.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JotAtom {
    /// Index of the `U+FFFC` this atom stands at, in the jot's `text`.
    pub position: u32,
    #[serde(rename = "type")]
    pub atom_type: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub value: String,
    /// Bytes-store key for an image atom, absent for every self-contained one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

/// One reusable jot: an opaque, client-generated `id` (stable across edits,
/// unique within the document) and its `text`. There is no title — a row's
/// handle is the *incipit*, the opening line of `text`, derived in the UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Jot {
    pub id: String,
    #[serde(default)]
    pub text: String,
    /// Absolute project roots this jot's text was written against — the
    /// provenance of whatever was pasted in.
    ///
    /// A jot is usually a passage lifted out of a transcript, and such a
    /// passage cites files the way people do: relative to a repo root the
    /// sentence never names. The text survives the copy; the root only
    /// survives if it is carried, so a Tug copy puts it on the pasteboard and
    /// the paste records it here. A reader tries each root and takes the first
    /// that names a real file.
    ///
    /// A LIST because a jot accumulates: pasted into twice from two projects,
    /// it is about both, and dropping the first root to record the second
    /// would put out links that were working a moment ago.
    ///
    /// Absent on every jot written before this existed, and on any jot typed
    /// rather than pasted — which is why it defaults empty and is omitted from
    /// the file when it is.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub origins: Vec<String>,
    /// The atoms standing in `text` — one per `U+FFFC` in it, in document
    /// order.
    ///
    /// A jot is where a chip goes to be kept: a file mention, a commit, a
    /// session citation pasted out of a transcript. The text alone records
    /// only the placeholder character each chip stands at, so a jot saved
    /// without this field reopens showing an anonymous `U+FFFC` and no way to
    /// say what had been there.
    ///
    /// Additive and optional the way `origins` is, and named on BOTH sides for
    /// the same reason: a reader that does not name the field drops it on the
    /// next save, and "additive and optional" is free on the write side and
    /// never free on the read side.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub atoms: Vec<JotAtom>,
}

/// The whole jots document. Array position is display order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JotsDoc {
    pub version: u32,
    /// The `snippets` alias reads a document written under the old name, which
    /// is what [`migrate_from_snippets`] hands this parser.
    #[serde(alias = "snippets")]
    pub jots: Vec<Jot>,
}

impl JotsDoc {
    /// The empty document served when `jots.json` is missing.
    pub fn empty() -> Self {
        Self {
            version: JOTS_VERSION,
            jots: Vec::new(),
        }
    }
}

/// Validate a document against Spec S01 (write path). Rejects a version this
/// build does not write, empty ids, and duplicate ids.
pub fn validate(doc: &JotsDoc) -> Result<(), String> {
    if doc.version != JOTS_VERSION {
        return Err(format!(
            "unsupported version {}, expected {JOTS_VERSION}",
            doc.version
        ));
    }
    let mut seen: HashSet<&str> = HashSet::new();
    for jot in &doc.jots {
        if jot.id.is_empty() {
            return Err("jot id must be non-empty".to_owned());
        }
        if !seen.insert(jot.id.as_str()) {
            return Err(format!("duplicate jot id: {}", jot.id));
        }
    }
    Ok(())
}

// ── Serialization + hashing ────────────────────────────────────────────────

/// The canonical on-disk byte form: pretty JSON + trailing newline, so the
/// file stays hand-editable and diff-able. The content hash is taken over
/// exactly these bytes, so a `PUT`'s returned hash matches the feed frame's.
pub fn serialize_doc(doc: &JotsDoc) -> Vec<u8> {
    let mut bytes = serde_json::to_vec_pretty(doc).expect("JotsDoc always serializes");
    bytes.push(b'\n');
    bytes
}

/// Lowercase hex of the SHA-256 of `bytes`.
pub fn hash_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

// ── File IO ────────────────────────────────────────────────────────────────

/// Outcome of reading `jots.json`. `hash` is `None` only when the file
/// existed but could not be read as a valid document (`error` then carries the
/// reason). A missing file reads as the empty document with no error.
#[derive(Debug, Clone)]
pub struct ReadOutcome {
    pub doc: JotsDoc,
    pub hash: Option<String>,
    pub error: Option<String>,
}

/// Read and parse `jots.json`.
///
/// - missing file → empty document, hash of the canonical empty form, no error
/// - valid file → parsed document, hash of the file bytes, no error
/// - unknown-version / parse error / unreadable → empty document, no hash, and
///   an `error` message (the caller refuses to clobber such a file)
pub fn read_jots(path: &Path) -> ReadOutcome {
    match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<JotsDoc>(&bytes) {
            Ok(doc) if doc.version == JOTS_VERSION => ReadOutcome {
                doc,
                hash: Some(hash_bytes(&bytes)),
                error: None,
            },
            Ok(doc) => ReadOutcome {
                error: Some(format!(
                    "jots.json version {} is newer than this build supports ({JOTS_VERSION}); leaving it untouched",
                    doc.version
                )),
                doc: JotsDoc::empty(),
                hash: None,
            },
            Err(e) => ReadOutcome {
                doc: JotsDoc::empty(),
                hash: None,
                error: Some(format!("jots.json is not valid JSON: {e}")),
            },
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let doc = JotsDoc::empty();
            let hash = hash_bytes(&serialize_doc(&doc));
            ReadOutcome {
                doc,
                hash: Some(hash),
                error: None,
            }
        }
        Err(e) => ReadOutcome {
            doc: JotsDoc::empty(),
            hash: None,
            error: Some(format!("could not read jots.json: {e}")),
        },
    }
}

/// Atomically write `doc` to `path` (temp file in the same directory, then
/// `rename`) so concurrent readers never see a torn file. Returns the content
/// hash of the bytes written.
pub fn write_jots_atomic(path: &Path, doc: &JotsDoc) -> std::io::Result<String> {
    use std::io::Write as _;

    let bytes = serialize_doc(doc);
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;

    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(&bytes)?;
    tmp.flush()?;
    tmp.persist(path).map_err(|e| e.error)?;

    Ok(hash_bytes(&bytes))
}

// ── Migration from the pre-rename file ─────────────────────────────────────

/// Name of the pre-rename document, which lived beside `jots.json` in the same
/// machine-global directory.
const LEGACY_FILE_NAME: &str = "snippets.json";

/// Seed `jots.json` from a pre-rename `snippets.json` sitting beside it.
///
/// Runs once at startup, before the feed reads the file. A no-op unless
/// `jots.json` is absent and the legacy file is present and readable — the
/// legacy file is only ever *copied*, never moved or rewritten, so a build
/// from before the rename keeps working against it. Returns whether a document
/// was written.
///
/// The copy goes through the document model rather than the raw bytes so the
/// result is canonical (the legacy array key is read by [`JotsDoc`]'s serde
/// alias and written back under the current name). A corrupt or
/// newer-versioned legacy file migrates nothing and leaves both files alone.
pub fn migrate_from_snippets(jots_path: &Path) -> bool {
    if jots_path.exists() {
        return false;
    }
    let legacy = jots_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(LEGACY_FILE_NAME);
    if !legacy.exists() {
        return false;
    }

    let outcome = read_jots(&legacy);
    if let Some(reason) = outcome.error {
        warn!(error = %reason, "jots migration: legacy file unreadable, leaving it alone");
        return false;
    }
    match write_jots_atomic(jots_path, &outcome.doc) {
        Ok(_) => true,
        Err(e) => {
            warn!(error = %e, "jots migration: could not write jots.json");
            false
        }
    }
}

// ── HTTP state + handlers (Spec S02) ───────────────────────────────────────

/// Shared state for the jots HTTP handlers: the resolved file path plus a
/// [`tokio::sync::Notify`] the `PUT` handler pulses so the JOTS feed rebuilds
/// immediately (rather than waiting on the filesystem-watcher debounce).
pub(crate) struct JotsState {
    pub(crate) path: PathBuf,
    pub(crate) rebuild: Arc<tokio::sync::Notify>,
}

impl JotsState {
    pub(crate) fn new(path: PathBuf, rebuild: Arc<tokio::sync::Notify>) -> Arc<Self> {
        Arc::new(Self { path, rebuild })
    }
}

/// Request body for `PUT /api/jots`.
#[derive(Debug, Deserialize)]
struct PutJotsBody {
    doc: JotsDoc,
}

/// Return a 403 for non-loopback connections; `None` when the caller may
/// proceed. Mirrors the guard in `defaults.rs`.
fn check_loopback(handler: &str, addr: SocketAddr) -> Option<Response> {
    if addr.ip().is_loopback() {
        return None;
    }
    warn!("{handler}: rejected non-loopback connection from {addr}");
    Some(
        (
            StatusCode::FORBIDDEN,
            axum::Json(serde_json::json!({"status": "error", "message": "forbidden"})),
        )
            .into_response(),
    )
}

/// Handle `GET /api/jots`. Always 200 (even for a corrupt file, which
/// returns the empty document with a populated `error`, matching the feed
/// frame shape).
pub(crate) async fn get_jots(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Extension(state): Extension<Arc<JotsState>>,
) -> Response {
    if let Some(resp) = check_loopback("get_jots", addr) {
        return resp;
    }

    let path = state.path.clone();
    match tokio::task::spawn_blocking(move || read_jots(&path)).await {
        Ok(outcome) => (
            StatusCode::OK,
            axum::Json(serde_json::json!({
                "doc": outcome.doc,
                "hash": outcome.hash,
                "error": outcome.error,
            })),
        )
            .into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(serde_json::json!({"status": "error", "message": "internal error"})),
        )
            .into_response(),
    }
}

/// Handle `PUT /api/jots`. Validates (S01 + size cap), refuses to clobber
/// an unreadable on-disk file (409), and atomically writes on success.
pub(crate) async fn put_jots(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Extension(state): Extension<Arc<JotsState>>,
    body: Bytes,
) -> Response {
    if let Some(resp) = check_loopback("put_jots", addr) {
        return resp;
    }

    if body.len() > MAX_JOTS_DOC_BYTES {
        warn!(
            bytes = body.len(),
            limit = MAX_JOTS_DOC_BYTES,
            "put_jots: rejecting oversized document"
        );
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            axum::Json(serde_json::json!({
                "status": "error",
                "message": format!(
                    "jots document too large: {} bytes exceeds the {} byte limit",
                    body.len(),
                    MAX_JOTS_DOC_BYTES
                ),
            })),
        )
            .into_response();
    }

    let parsed: PutJotsBody = match serde_json::from_slice(&body) {
        Ok(b) => b,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(
                    serde_json::json!({"status": "error", "message": format!("invalid JSON: {e}")}),
                ),
            )
                .into_response();
        }
    };

    if let Err(detail) = validate(&parsed.doc) {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"status": "error", "message": detail})),
        )
            .into_response();
    }

    let path = state.path.clone();
    let result = tokio::task::spawn_blocking(move || {
        // Refuse to overwrite a file we could not read (corrupt or a newer
        // version): `error.is_some()` only happens when the file existed.
        let existing = read_jots(&path);
        if let Some(reason) = existing.error {
            return Err(PutError::Clobber(reason));
        }
        write_jots_atomic(&path, &parsed.doc).map_err(|e| PutError::Io(e.to_string()))
    })
    .await;

    match result {
        Ok(Ok(hash)) => {
            // Force an immediate feed rebuild so the writer's own frontend sees
            // the change without waiting on the filesystem-watcher debounce.
            state.rebuild.notify_one();
            (
                StatusCode::OK,
                axum::Json(serde_json::json!({"hash": hash})),
            )
                .into_response()
        }
        Ok(Err(PutError::Clobber(reason))) => (
            StatusCode::CONFLICT,
            axum::Json(serde_json::json!({"status": "error", "message": reason})),
        )
            .into_response(),
        Ok(Err(PutError::Io(reason))) => {
            warn!(error = %reason, "put_jots: write failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({"status": "error", "message": "internal error"})),
            )
                .into_response()
        }
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(serde_json::json!({"status": "error", "message": "internal error"})),
        )
            .into_response(),
    }
}

/// Internal failure reasons for the `PUT` write path.
enum PutError {
    /// The on-disk file exists but is unreadable/corrupt — refuse to clobber.
    Clobber(String),
    /// The atomic write itself failed.
    Io(String),
}

// ── Unit tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn doc_with(ids: &[&str]) -> JotsDoc {
        JotsDoc {
            version: JOTS_VERSION,
            jots: ids
                .iter()
                .map(|id| Jot {
                    id: (*id).to_owned(),
                    text: format!("body of {id}"),
                    origins: Vec::new(),
                    atoms: Vec::new(),
                })
                .collect(),
        }
    }

    /// A jot's provenance survives the file, which is the whole point of
    /// storing it: the roots a pasted passage was written against are what let
    /// a relative path in it still name a file after a restart.
    ///
    /// The risk this pins is silent: `serialize_doc` writes a TYPED struct, so
    /// a field the model does not know is dropped on the next save — the
    /// frontend would record an origin, the next write would erase it, and
    /// nothing would report a thing.
    #[test]
    fn origins_round_trip_through_the_file() {
        let doc = JotsDoc {
            version: JOTS_VERSION,
            jots: vec![Jot {
                id: "jt_a".into(),
                text: "see lib/a.ts".into(),
                origins: vec!["/alpha".into(), "/beta".into()],
                atoms: Vec::new(),
            }],
        };
        let bytes = serialize_doc(&doc);
        let parsed: JotsDoc = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed, doc);
    }

    /// Absent on every jot written before this existed, and omitted again on
    /// the way out — so adding the field does not rewrite a file nobody
    /// changed.
    #[test]
    fn a_jot_without_origins_reads_and_writes_without_the_field() {
        let parsed: JotsDoc =
            serde_json::from_str(r#"{"version":1,"jots":[{"id":"jt_a","text":"t"}]}"#).unwrap();
        assert!(parsed.jots[0].origins.is_empty());
        let text = String::from_utf8(serialize_doc(&parsed)).unwrap();
        assert!(!text.contains("origins"), "got: {text}");
    }

    /// The atoms standing in a jot's text survive the file, for exactly the
    /// reason `origins` does and with exactly the same failure if they do not:
    /// `serialize_doc` writes a TYPED struct, so a field the model does not
    /// name is dropped on the next save. The frontend would record the chips,
    /// the next write would erase them, and nothing would report a thing —
    /// the jot would simply reopen one day with a bare `U+FFFC` where a file
    /// mention had been.
    #[test]
    fn atoms_round_trip_through_the_file() {
        let doc = JotsDoc {
            version: JOTS_VERSION,
            jots: vec![Jot {
                id: "jt_a".into(),
                text: "see \u{fffc} and \u{fffc}".into(),
                origins: Vec::new(),
                atoms: vec![
                    JotAtom {
                        position: 4,
                        atom_type: "file".into(),
                        label: "atom-text.ts".into(),
                        value: "tugdeck/src/lib/atom-text.ts".into(),
                        id: None,
                    },
                    JotAtom {
                        position: 10,
                        atom_type: "image".into(),
                        label: "shot.png".into(),
                        value: "shot.png".into(),
                        id: Some("1f8c2e04-7b3a-4d51-9c60-2a8e5f7b1d33".into()),
                    },
                ],
            }],
        };
        let bytes = serialize_doc(&doc);
        let parsed: JotsDoc = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed, doc);
        // A second save is the one that used to lose it: read, write, read.
        let again: JotsDoc = serde_json::from_slice(&serialize_doc(&parsed)).unwrap();
        assert_eq!(again, doc);
        // The image atom's bytes are NOT in the file — the jot has no bytes
        // store, so the atom travels as metadata and its chip draws pending.
        let text = String::from_utf8(bytes).unwrap();
        assert!(!text.contains("bytes"), "got: {text}");
        assert!(!text.contains("data:"), "got: {text}");
    }

    /// The wire spelling is the frontend's: `type`, not `atom_type`. A rename
    /// on either side is a silent drop of every atom in the file, which is the
    /// same failure the field exists to stop.
    #[test]
    fn an_atom_reads_the_shape_the_frontend_writes() {
        let parsed: JotsDoc = serde_json::from_str(
            r#"{"version":1,"jots":[{"id":"jt_a","text":"￼","atoms":[
                 {"position":0,"type":"commit","label":"commit:64747b8c","value":"64747b8c9a"}]}]}"#,
        )
        .unwrap();
        let atom = &parsed.jots[0].atoms[0];
        assert_eq!(atom.atom_type, "commit");
        assert_eq!(atom.label, "commit:64747b8c");
        assert_eq!(atom.value, "64747b8c9a");
        assert_eq!(atom.id, None);
        let text = String::from_utf8(serialize_doc(&parsed)).unwrap();
        assert!(text.contains(r#""type": "commit""#), "got: {text}");
        assert!(!text.contains("atom_type"), "got: {text}");
    }

    /// Absent on every jot written before this existed, and omitted again on
    /// the way out — so adding the field does not rewrite a file nobody
    /// changed, and a jot of plain prose stays plain in the file.
    #[test]
    fn a_jot_without_atoms_reads_and_writes_without_the_field() {
        let parsed: JotsDoc = serde_json::from_str(
            r#"{"version":1,"jots":[{"id":"jt_a","text":"plain prose","origins":["/alpha"]}]}"#,
        )
        .unwrap();
        assert!(parsed.jots[0].atoms.is_empty());
        let text = String::from_utf8(serialize_doc(&parsed)).unwrap();
        assert!(!text.contains("atoms"), "got: {text}");
        // The neighbouring optional field is untouched by the new one.
        assert!(text.contains("origins"), "got: {text}");
    }

    /// Degradation is graceful where it is unavoidable: a jot whose atoms were
    /// lost keeps the chip's plain form in its text rather than a bare
    /// placeholder, and the document still reads.
    #[test]
    fn a_jot_whose_atoms_were_lost_still_reads() {
        let parsed: JotsDoc = serde_json::from_str(
            r#"{"version":1,"jots":[{"id":"jt_a","text":"see [a.ts](<lib/a.ts>)"}]}"#,
        )
        .unwrap();
        assert!(parsed.jots[0].atoms.is_empty());
        assert_eq!(parsed.jots[0].text, "see [a.ts](<lib/a.ts>)");
        assert!(validate(&parsed).is_ok());
    }

    #[test]
    fn validate_accepts_unique_ids() {
        assert!(validate(&doc_with(&["sn_a", "sn_b"])).is_ok());
        assert!(validate(&JotsDoc::empty()).is_ok());
    }

    #[test]
    fn validate_rejects_duplicate_ids() {
        let err = validate(&doc_with(&["sn_a", "sn_a"])).unwrap_err();
        assert!(err.contains("duplicate"), "got: {err}");
    }

    #[test]
    fn validate_rejects_empty_id() {
        let err = validate(&doc_with(&[""])).unwrap_err();
        assert!(err.contains("non-empty"), "got: {err}");
    }

    #[test]
    fn validate_rejects_wrong_version() {
        let doc = JotsDoc {
            version: 2,
            jots: Vec::new(),
        };
        assert!(validate(&doc).is_err());
    }

    #[test]
    fn missing_file_reads_as_empty_with_hash() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("jots.json");
        let outcome = read_jots(&path);
        assert_eq!(outcome.doc, JotsDoc::empty());
        assert!(outcome.error.is_none());
        assert!(outcome.hash.is_some());
    }

    #[test]
    fn atomic_write_round_trips_and_hash_is_stable() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("jots.json");
        let doc = doc_with(&["sn_a", "sn_b"]);

        let write_hash = write_jots_atomic(&path, &doc).unwrap();
        let outcome = read_jots(&path);
        assert_eq!(outcome.doc, doc);
        assert_eq!(outcome.error, None);
        // The read hash equals the write hash — the echo-suppression contract.
        assert_eq!(outcome.hash.as_deref(), Some(write_hash.as_str()));
    }

    #[test]
    fn corrupt_file_surfaces_error_and_no_hash() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("jots.json");
        std::fs::write(&path, b"{ this is not json").unwrap();
        let outcome = read_jots(&path);
        assert!(outcome.error.is_some());
        assert!(outcome.hash.is_none());
        assert_eq!(outcome.doc, JotsDoc::empty());
    }

    /// The pre-rename on-disk shape: same document, legacy array key.
    fn write_legacy(dir: &Path, ids: &[&str]) -> PathBuf {
        let rows: Vec<String> = ids
            .iter()
            .map(|id| format!(r#"{{"id":"{id}","text":"body of {id}"}}"#))
            .collect();
        let path = dir.join(LEGACY_FILE_NAME);
        std::fs::write(
            &path,
            format!(r#"{{"version":1,"snippets":[{}]}}"#, rows.join(",")),
        )
        .unwrap();
        path
    }

    #[test]
    fn migration_seeds_jots_from_legacy_and_leaves_it_in_place() {
        let dir = TempDir::new().unwrap();
        let legacy = write_legacy(dir.path(), &["sn_a", "sn_b"]);
        let legacy_before = std::fs::read(&legacy).unwrap();
        let path = dir.path().join("jots.json");

        assert!(migrate_from_snippets(&path));

        let outcome = read_jots(&path);
        assert_eq!(outcome.error, None);
        assert_eq!(outcome.doc, doc_with(&["sn_a", "sn_b"]));
        // The legacy file is copied, never moved or rewritten.
        assert_eq!(std::fs::read(&legacy).unwrap(), legacy_before);
    }

    #[test]
    fn migration_does_not_run_twice() {
        let dir = TempDir::new().unwrap();
        write_legacy(dir.path(), &["sn_a"]);
        let path = dir.path().join("jots.json");
        assert!(migrate_from_snippets(&path));

        // A second launch finds jots.json present and leaves the user's edits
        // alone, however far they have since diverged from the legacy file.
        write_jots_atomic(&path, &doc_with(&["jt_new"])).unwrap();
        assert!(!migrate_from_snippets(&path));
        assert_eq!(read_jots(&path).doc, doc_with(&["jt_new"]));
    }

    #[test]
    fn migration_is_a_no_op_without_a_legacy_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("jots.json");
        assert!(!migrate_from_snippets(&path));
        assert!(!path.exists());
    }

    #[test]
    fn migration_leaves_a_corrupt_legacy_file_alone() {
        let dir = TempDir::new().unwrap();
        let legacy = dir.path().join(LEGACY_FILE_NAME);
        std::fs::write(&legacy, b"{ not json").unwrap();
        let path = dir.path().join("jots.json");

        assert!(!migrate_from_snippets(&path));
        assert!(!path.exists());
        assert_eq!(std::fs::read(&legacy).unwrap(), b"{ not json");
    }

    #[test]
    fn newer_version_file_is_read_only() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("jots.json");
        std::fs::write(&path, br#"{"version":99,"jots":[]}"#).unwrap();
        let outcome = read_jots(&path);
        assert!(outcome.error.is_some());
        assert!(outcome.hash.is_none());
    }
}
