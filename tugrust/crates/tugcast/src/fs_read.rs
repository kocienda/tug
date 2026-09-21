//! HTTP handler for `GET /api/fs/read` — UTF-8 file reads for the Text card.
//!
//! Returns the full text of one file plus the metadata the frontend's
//! autosave engine needs to write it back safely: the canonicalized path
//! (so the client and the watcher agree on identity), a sha256 of the
//! content bytes (the baseline for hash-conditional writes), size, mtime,
//! and a read-only probe.
//!
//! Loopback-only, like the other `/api` handlers. Accepts any absolute
//! path — the trust boundary is loopback + the local user, matching
//! `fs_complete` — but refuses paths matching the secret-file denylist
//! and rejects non-UTF-8 or oversized content with structured errors so
//! the frontend can present them.

use std::net::SocketAddr;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use axum::extract::{ConnectInfo, Query};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tracing::warn;

use crate::feeds::secret_filter::SecretFilter;
use crate::path_resolver::resolve_to_claude_form;

/// Cap on file size served as editable text. Bounds both the response
/// payload and the cost of the frontend's full-content autosave writes.
pub(crate) const MAX_READ_BYTES: u64 = 8 * 1024 * 1024;

/// Query string for `GET /api/fs/read`: the absolute path to read.
#[derive(Debug, Deserialize)]
pub(crate) struct ReadQuery {
    path: String,
}

/// Build the `{ "error": … }` JSON error response the fs endpoints share.
pub(crate) fn fs_error(status: StatusCode, error: &str) -> (StatusCode, Value) {
    (status, json!({ "error": error }))
}

/// Hex-encoded sha256 of raw content bytes — the hash form both fs
/// endpoints and the frontend baseline agree on.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// True when `path` matches the secret-file denylist. Matching runs the
/// builtin `SecretFilter` over the root-relative form (for `**/…` glob
/// patterns like `.ssh`) and over the basename (for root-anchored
/// patterns like `.env`, which would otherwise only match at a
/// workspace root the fs endpoints don't have).
pub(crate) fn is_secret_path(path: &Path) -> bool {
    let filter = SecretFilter::builtin_only();
    let rel = path.to_string_lossy();
    let rel = rel.trim_start_matches('/');
    if filter.is_secret(rel) {
        return true;
    }
    match path.file_name() {
        Some(name) => filter.is_secret(&name.to_string_lossy()),
        None => false,
    }
}

/// Validate + canonicalize an inbound path string. `~` / `~/…` expands
/// to the user's home (matching `fs_complete`); other relative paths
/// are rejected; secret-filtered paths are refused. The canonical form
/// (via `resolve_to_claude_form`, which falls back to the input when
/// the file does not exist yet) is what all downstream fs work and the
/// response `path` field use.
pub(crate) fn guard_absolute_path(raw: &str) -> Result<PathBuf, (StatusCode, Value)> {
    let expanded: PathBuf;
    let mut path = Path::new(raw);
    if raw == "~" || raw.starts_with("~/") {
        let Some(home) = dirs::home_dir() else {
            return Err(fs_error(StatusCode::BAD_REQUEST, "bad_path"));
        };
        expanded = home.join(raw.trim_start_matches('~').trim_start_matches('/'));
        path = &expanded;
    }
    if !path.is_absolute() {
        return Err(fs_error(StatusCode::BAD_REQUEST, "bad_path"));
    }
    // Reject `..` traversal. `resolve_to_claude_form` leaves `..` intact for
    // a path that does not exist yet (canonicalize fails, so it returns the
    // raw path), and `fs_write`'s parent-creation carve-out gates on a
    // lexical `starts_with` against the Tug roots — which a `..` segment
    // slips straight past to `create_dir_all` outside the root. No
    // legitimate caller sends `..`; both fs endpoints share this guard.
    if path.components().any(|c| c == Component::ParentDir) {
        return Err(fs_error(StatusCode::BAD_REQUEST, "bad_path"));
    }
    let canonical = resolve_to_claude_form(path);
    if is_secret_path(&canonical) {
        return Err(fs_error(StatusCode::FORBIDDEN, "denied"));
    }
    Ok(canonical)
}

/// Milliseconds since the Unix epoch for a file's mtime; 0 when the
/// platform can't report one.
pub(crate) fn mtime_ms(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Bytes read from a file, paired with the `stat` that describes THOSE
/// bytes — never one taken before the read.
pub(crate) struct StableRead {
    pub(crate) bytes: Vec<u8>,
    pub(crate) metadata: std::fs::Metadata,
}

/// Attempts a guarded read makes before giving up and reporting what it
/// last saw.
const STABLE_READ_ATTEMPTS: usize = 3;

/// Pause between guarded-read attempts — long enough for a writer mid
/// truncate-and-rewrite to get its bytes down, short enough that a reader
/// waiting on the answer never notices.
const STABLE_READ_RETRY: std::time::Duration = std::time::Duration::from_millis(25);

/// Read a file without catching a writer halfway.
///
/// A plain `read` between a truncate and the rewrite that follows it
/// returns the empty file, and nothing in the bytes says so. This brackets
/// the read with a `stat` on each side and accepts the result only when the
/// two agree on `(len, mtime, ino)` AND the byte count matches the length
/// the file claimed — the signature of a file nobody was writing. A
/// disagreement is retried up to [`STABLE_READ_ATTEMPTS`] times,
/// [`STABLE_READ_RETRY`] apart.
///
/// A file under continuous rewrite never settles, so the last attempt is
/// returned regardless: this is a guard against a torn read, not a lock.
/// The metadata returned is always the one taken AFTER the bytes, so a
/// caller hashing the bytes and reporting the size is reporting one file.
pub(crate) fn read_stable(path: &Path) -> std::io::Result<StableRead> {
    let mut last: Option<StableRead> = None;
    for attempt in 0..STABLE_READ_ATTEMPTS {
        let before = std::fs::metadata(path)?;
        let bytes = std::fs::read(path)?;
        let after = std::fs::metadata(path)?;
        let settled =
            same_file_state(&before, &after) && bytes.len() as u64 == after.len();
        let read = StableRead {
            bytes,
            metadata: after,
        };
        if settled {
            return Ok(read);
        }
        last = Some(read);
        if attempt + 1 < STABLE_READ_ATTEMPTS {
            std::thread::sleep(STABLE_READ_RETRY);
        }
    }
    // The loop body assigns `last` on every non-returning pass, and
    // STABLE_READ_ATTEMPTS is nonzero, so this is always `Some`.
    Ok(last.expect("a guarded read makes at least one attempt"))
}

/// Whether two stats of the same path describe the same file in the same
/// state — the length, the mtime, and (on unix) the inode.
fn same_file_state(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
    if a.len() != b.len() || mtime_ms(a) != mtime_ms(b) {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if a.ino() != b.ino() {
            return false;
        }
    }
    true
}

/// Read `canonical` and produce the response payload. Pure and
/// synchronous so it can be unit-tested directly; the handler runs it
/// under `spawn_blocking`.
fn read_file(canonical: &Path) -> (StatusCode, Value) {
    let metadata = match std::fs::metadata(canonical) {
        Ok(md) => md,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return fs_error(StatusCode::NOT_FOUND, "not_found");
        }
        Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
            return fs_error(StatusCode::FORBIDDEN, "denied");
        }
        Err(_) => return fs_error(StatusCode::INTERNAL_SERVER_ERROR, "internal"),
    };
    if !metadata.is_file() {
        return fs_error(StatusCode::BAD_REQUEST, "bad_path");
    }
    if metadata.len() > MAX_READ_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            json!({ "error": "too_large", "size": metadata.len() }),
        );
    }
    // The guarded read, not a bare one: a save that truncates and rewrites
    // would otherwise be served as an empty file with nothing in the payload
    // to say the bytes were caught mid-write. `metadata` above still gates
    // the size check, so an oversized file is refused without reading it.
    let read = match read_stable(canonical) {
        Ok(read) => read,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return fs_error(StatusCode::NOT_FOUND, "not_found");
        }
        Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
            return fs_error(StatusCode::FORBIDDEN, "denied");
        }
        Err(_) => return fs_error(StatusCode::INTERNAL_SERVER_ERROR, "internal"),
    };
    // Every field below describes the bytes that were actually read: the
    // guarded read's own trailing stat, never the one taken before it.
    let metadata = read.metadata;
    let bytes = read.bytes;
    let sha256 = sha256_hex(&bytes);
    let content = match String::from_utf8(bytes) {
        Ok(content) => content,
        Err(_) => return fs_error(StatusCode::UNPROCESSABLE_ENTITY, "binary"),
    };
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut body = json!({
        "path": canonical.to_string_lossy(),
        "content": content,
        "sha256": sha256,
        "size": metadata.len(),
        "mtimeMs": mtime_ms(&metadata),
        "readOnly": metadata.permissions().readonly(),
    });
    insert_identity(&mut body, &metadata);
    (StatusCode::OK, body)
}

/// Add the file's `(dev, ino)` identity to a response object.
///
/// This pair is what survives a rename on the same volume, so a client
/// holding it can tell "my file moved" from "a different file appeared where
/// mine was" — which content hashing cannot do once the move carried an edit
/// with it. Additive and unix-only: a client that finds the fields absent
/// falls back to matching on the content hash.
pub(crate) fn insert_identity(body: &mut Value, metadata: &std::fs::Metadata) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let Some(object) = body.as_object_mut() {
            object.insert("dev".to_string(), json!(metadata.dev()));
            object.insert("ino".to_string(), json!(metadata.ino()));
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (body, metadata);
    }
}

/// Handle `GET /api/fs/read?path=<abs>`. Restricted to loopback.
pub(crate) async fn get_fs_read(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(query): Query<ReadQuery>,
) -> Response {
    if !addr.ip().is_loopback() {
        warn!("get_fs_read: rejected non-loopback connection from {addr}");
        return (
            StatusCode::FORBIDDEN,
            axum::Json(json!({ "error": "denied" })),
        )
            .into_response();
    }
    let canonical = match guard_absolute_path(&query.path) {
        Ok(canonical) => canonical,
        Err((status, body)) => return (status, axum::Json(body)).into_response(),
    };
    let result = tokio::task::spawn_blocking(move || read_file(&canonical)).await;
    match result {
        Ok((status, body)) => (status, axum::Json(body)).into_response(),
        Err(_join_err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "error": "internal" })),
        )
            .into_response(),
    }
}

// ── Unit tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_round_trips_content_and_hash() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hello.txt");
        std::fs::write(&path, "hello tug\n").unwrap();

        let (status, body) = read_file(&path);
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["content"], "hello tug\n");
        assert_eq!(body["sha256"], sha256_hex(b"hello tug\n"));
        assert_eq!(body["size"], 10);
        assert_eq!(body["readOnly"], false);
        assert!(body["mtimeMs"].as_u64().unwrap() > 0);
    }

    #[cfg(unix)]
    #[test]
    fn read_reports_the_files_dev_and_ino() {
        use std::os::unix::fs::MetadataExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("identified.txt");
        std::fs::write(&path, "who am i\n").unwrap();
        let metadata = std::fs::metadata(&path).unwrap();

        let (status, body) = read_file(&path);
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["dev"].as_u64().unwrap(), metadata.dev());
        assert_eq!(body["ino"].as_u64().unwrap(), metadata.ino());
    }

    #[cfg(unix)]
    #[test]
    fn a_rename_carries_the_identity_and_a_rewrite_does_not() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("before.txt");
        std::fs::write(&original, "body\n").unwrap();
        let (_, before) = read_file(&original);

        // A rename keeps the same file, so the identity follows it — which is
        // the whole reason a card can follow a move that also changed content.
        let moved = dir.path().join("after.txt");
        std::fs::rename(&original, &moved).unwrap();
        std::fs::write(&moved, "body, edited\n").unwrap();
        let (_, after_move) = read_file(&moved);
        assert_eq!(after_move["dev"], before["dev"]);
        assert_eq!(after_move["ino"], before["ino"]);
        assert_ne!(after_move["sha256"], before["sha256"]);

        // Unlink-and-recreate at one path is a different file. The path is what
        // settles a replace-in-place: the read reports the recreated bytes
        // whatever the identity did.
        std::fs::remove_file(&moved).unwrap();
        std::fs::write(&moved, "recreated\n").unwrap();
        let (_, after_replace) = read_file(&moved);
        assert_eq!(after_replace["sha256"], sha256_hex(b"recreated\n"));

        // APFS never reuses an inode number, so on the platform the app ships
        // on the identity does not follow the recreate — the property the Text
        // card's rename-following leans on. Linux recycles a freed inode
        // immediately and can hand the new file the old number, so this is
        // asserted only where it is true.
        #[cfg(target_os = "macos")]
        assert_ne!(after_replace["ino"], before["ino"]);
    }

    #[test]
    fn read_echoes_canonical_path_for_symlinked_input() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("real.txt");
        std::fs::write(&target, "x").unwrap();
        let link = dir.path().join("alias.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let canonical = guard_absolute_path(link.to_str().unwrap()).unwrap();
        let (status, body) = read_file(&canonical);
        assert_eq!(status, StatusCode::OK);
        // The canonical target basename, not the symlink's, comes back.
        assert!(
            body["path"].as_str().unwrap().ends_with("real.txt"),
            "expected canonical path, got {}",
            body["path"]
        );
    }

    #[test]
    fn read_missing_file_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let (status, body) = read_file(&dir.path().join("absent.txt"));
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "not_found");
    }

    #[test]
    fn read_directory_is_bad_path() {
        let dir = tempfile::tempdir().unwrap();
        let (status, body) = read_file(dir.path());
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "bad_path");
    }

    #[test]
    fn relative_path_is_rejected() {
        let err = guard_absolute_path("relative/file.txt").unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1["error"], "bad_path");
    }

    #[test]
    fn parent_dir_traversal_is_rejected() {
        // A `..` segment must never survive the guard — it defeats
        // fs_write's lexical Tug-root check on parent creation.
        for traversal in [
            "/Users/me/Library/Application Support/Tug/Autosave Information/../../../../tmp/x.json",
            "/project/../etc/passwd",
            "~/../../../tmp/escape.txt",
        ] {
            let err = guard_absolute_path(traversal).unwrap_err();
            assert_eq!(
                err.0,
                StatusCode::BAD_REQUEST,
                "expected reject for {traversal}"
            );
            assert_eq!(err.1["error"], "bad_path");
        }
    }

    #[test]
    fn tilde_expands_to_home() {
        let home = dirs::home_dir().unwrap();
        let canonical = guard_absolute_path("~/some-file.txt").unwrap();
        assert!(canonical.starts_with(&home) || canonical.ends_with("some-file.txt"));
        assert!(canonical.is_absolute());
    }

    #[test]
    fn binary_content_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blob.bin");
        std::fs::write(&path, [0xff, 0xfe, 0x00, 0x80]).unwrap();

        let (status, body) = read_file(&path);
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body["error"], "binary");
    }

    #[test]
    fn oversized_file_is_too_large() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.txt");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_READ_BYTES + 1).unwrap();
        drop(file);

        let (status, body) = read_file(&path);
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(body["error"], "too_large");
        assert_eq!(body["size"], MAX_READ_BYTES + 1);
    }

    #[test]
    fn secret_files_are_denied() {
        for denied in ["/project/.env", "/home/user/.ssh/config", "/tmp/server.pem"] {
            let err = guard_absolute_path(denied).unwrap_err();
            assert_eq!(err.0, StatusCode::FORBIDDEN, "expected denial for {denied}");
            assert_eq!(err.1["error"], "denied");
        }
        assert!(guard_absolute_path("/project/src/main.rs").is_ok());
    }

    #[test]
    fn read_only_bit_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("locked.txt");
        std::fs::write(&path, "x").unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&path, perms).unwrap();

        let (status, body) = read_file(&path);
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["readOnly"], true);

        // Restore writability so the tempdir can clean up everywhere.
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o644);
        std::fs::set_permissions(&path, perms).unwrap();
    }
}
