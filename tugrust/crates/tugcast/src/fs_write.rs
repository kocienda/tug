//! HTTP handler for `POST /api/fs/write` — atomic, hash-conditional file
//! writes for the Text card's live-autosave engine.
//!
//! Every write is conditional on the caller's `baselineSha256` (the hash
//! of the content it last read or wrote): a mismatch means someone else
//! wrote the file since, and the caller gets a `409` carrying the
//! current disk hash so it can offer an explicit choice instead of
//! silently clobbering. A `null` baseline means "create a new file" and
//! fails when the target already exists.
//!
//! Writes are atomic: content lands in a hidden temp file in the target
//! directory (same filesystem), is fsynced, inherits the original's
//! permission bits, and is renamed over the target — a reader never
//! observes a partial file.
//!
//! Loopback-only; same any-absolute-path + secret-denylist posture as
//! `fs_read`. Missing parent directories are created only under a
//! Tug-owned root — the drafts root (untitled-buffer autosave) or the
//! Autosave Information root (manual-mode set-aside autosave); elsewhere
//! they are an error.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use axum::extract::ConnectInfo;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use tracing::warn;

use crate::fs_read::{MAX_READ_BYTES, fs_error, guard_absolute_path, mtime_ms, sha256_hex};

/// Max request body for a write. `fs_read` serves files up to
/// `MAX_READ_BYTES` (8 MiB); the JSON envelope escapes the content (a
/// control byte becomes `\u00XX`, up to 6×) and adds the `path`/baseline
/// fields, so the body ceiling must sit well above the file-content
/// ceiling — otherwise a file that opened fine would 413 on save, silently
/// removing the crash-safety net (manual mode) or wedging autosave. Sized
/// for the worst-case escaping so "anything that reads can be written back"
/// holds; loopback-only keeps the larger ceiling off the DoS surface.
pub(crate) const MAX_WRITE_BODY_BYTES: usize = 6 * (MAX_READ_BYTES as usize) + 64 * 1024;

/// JSON body for `POST /api/fs/write`. `baselineSha256: null` requests
/// create-new semantics. `delete: true` removes the file instead of
/// writing (still hash-conditional — the draft-GC path; `content` is
/// ignored).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WriteRequest {
    path: String,
    content: String,
    baseline_sha256: Option<String>,
    #[serde(default)]
    delete: bool,
}

/// The directory untitled-draft buffers autosave into. The one place
/// `fs_write` will create missing parent directories.
pub(crate) fn drafts_root() -> Option<PathBuf> {
    Some(tugcore::instance::base_data_dir().join("Drafts"))
}

/// The directory manual-mode set-aside autosave records live in. The
/// second Tug-owned root under which `fs_write` will create missing
/// parent directories.
pub(crate) fn asides_root() -> Option<PathBuf> {
    Some(tugcore::instance::base_data_dir().join("Autosave Information"))
}

/// Process-wide monotonic counter that makes every temp filename unique, so
/// two concurrent writes can never share — and corrupt — one temp file. The
/// former `pid`-only suffix collided for same-process concurrent writes to
/// one path; this and the per-path lock below close that race.
fn next_temp_seq() -> u64 {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// Serialize writes to the same file: two concurrent writes to one path must
/// not interleave read-adjudicate-rename (a lost update). A fixed pool of
/// locks indexed by path hash gives same-path writes the same lock with no
/// per-path map to grow or GC; distinct paths that collide onto one lock
/// just over-serialize briefly — immaterial for debounced autosave writes.
fn write_lock_for(path: &Path) -> &'static parking_lot::Mutex<()> {
    use std::hash::{Hash, Hasher};
    const SHARDS: usize = 64;
    static LOCKS: std::sync::OnceLock<Vec<parking_lot::Mutex<()>>> = std::sync::OnceLock::new();
    let locks = LOCKS.get_or_init(|| (0..SHARDS).map(|_| parking_lot::Mutex::new(())).collect());
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    &locks[(hasher.finish() as usize) % SHARDS]
}

/// Read the target's current bytes for the baseline comparison.
/// `Ok(None)` = file does not exist.
fn read_existing(canonical: &Path) -> Result<Option<Vec<u8>>, (StatusCode, Value)> {
    match std::fs::read(canonical) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
            Err(fs_error(StatusCode::FORBIDDEN, "denied"))
        }
        Err(_) => Err(fs_error(StatusCode::INTERNAL_SERVER_ERROR, "internal")),
    }
}

/// Perform the guarded write. Pure and synchronous so it can be
/// unit-tested directly; the handler runs it under `spawn_blocking`.
fn write_file(
    canonical: &Path,
    content: &str,
    baseline: Option<&str>,
    delete: bool,
) -> (StatusCode, Value) {
    let existing = match read_existing(canonical) {
        Ok(existing) => existing,
        Err(err) => return err,
    };

    // Adjudicate the baseline before any bytes move.
    match (&existing, baseline) {
        (Some(bytes), Some(baseline)) => {
            let disk = sha256_hex(bytes);
            if disk != baseline {
                return (
                    StatusCode::CONFLICT,
                    json!({ "error": "conflict", "diskSha256": disk }),
                );
            }
        }
        (Some(bytes), None) => {
            // Create-new requested, but the target already exists.
            return (
                StatusCode::CONFLICT,
                json!({ "error": "conflict", "diskSha256": sha256_hex(bytes) }),
            );
        }
        (None, Some(_)) => {
            // The caller had a baseline but the file vanished out from
            // under it — deletion is a user decision, never overridden.
            return (StatusCode::CONFLICT, json!({ "error": "missing" }));
        }
        (None, None) => {}
    }

    if delete {
        // Hash-adjudicated removal (draft GC). A missing file already
        // returned above unless the caller asked to create-new-and-
        // delete, which is a no-op success.
        if existing.is_some() && std::fs::remove_file(canonical).is_err() {
            return fs_error(StatusCode::INTERNAL_SERVER_ERROR, "internal");
        }
        return (StatusCode::OK, json!({ "deleted": true }));
    }

    let Some(parent) = canonical.parent() else {
        return fs_error(StatusCode::BAD_REQUEST, "bad_path");
    };
    let Some(file_name) = canonical.file_name() else {
        return fs_error(StatusCode::BAD_REQUEST, "bad_path");
    };
    if !parent.is_dir() {
        let under_tug_root = drafts_root().is_some_and(|root| parent.starts_with(&root))
            || asides_root().is_some_and(|root| parent.starts_with(&root));
        if !under_tug_root {
            return fs_error(StatusCode::NOT_FOUND, "parent_missing");
        }
        if std::fs::create_dir_all(parent).is_err() {
            return fs_error(StatusCode::INTERNAL_SERVER_ERROR, "internal");
        }
    }

    // Preserve the original's permission bits across the rename.
    let permissions = existing
        .is_some()
        .then(|| std::fs::metadata(canonical).ok().map(|md| md.permissions()))
        .flatten();

    let temp_path = parent.join(format!(
        ".{}.tug-tmp-{}-{}",
        file_name.to_string_lossy(),
        std::process::id(),
        next_temp_seq(),
    ));
    let write_result = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut file = std::fs::File::create(&temp_path)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        drop(file);
        if let Some(permissions) = permissions {
            std::fs::set_permissions(&temp_path, permissions)?;
        }
        std::fs::rename(&temp_path, canonical)?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
        return fs_error(StatusCode::INTERNAL_SERVER_ERROR, "internal");
    }

    let mtime = std::fs::metadata(canonical)
        .map(|md| mtime_ms(&md))
        .unwrap_or(0);
    (
        StatusCode::OK,
        json!({ "sha256": sha256_hex(content.as_bytes()), "mtimeMs": mtime }),
    )
}

/// Handle `POST /api/fs/write`. Restricted to loopback.
pub(crate) async fn post_fs_write(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    axum::Json(request): axum::Json<WriteRequest>,
) -> Response {
    if !addr.ip().is_loopback() {
        warn!("post_fs_write: rejected non-loopback connection from {addr}");
        return (
            StatusCode::FORBIDDEN,
            axum::Json(json!({ "error": "denied" })),
        )
            .into_response();
    }
    let canonical = match guard_absolute_path(&request.path) {
        Ok(canonical) => canonical,
        Err((status, body)) => return (status, axum::Json(body)).into_response(),
    };
    let WriteRequest {
        content,
        baseline_sha256,
        delete,
        ..
    } = request;
    let result = tokio::task::spawn_blocking(move || {
        // Serialize concurrent writes to the same path (lost-update / shared
        // temp race). Held for the whole read-adjudicate-rename.
        let _lock = write_lock_for(&canonical).lock();
        write_file(&canonical, &content, baseline_sha256.as_deref(), delete)
    })
    .await;
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
    fn write_round_trips_against_matching_baseline() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.txt");
        std::fs::write(&path, "v1").unwrap();

        let (status, body) = write_file(&path, "v2", Some(&sha256_hex(b"v1")), false);
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["sha256"], sha256_hex(b"v2"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "v2");
        // No temp residue.
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("tug-tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn stale_baseline_conflicts_with_disk_hash() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.txt");
        std::fs::write(&path, "externally changed").unwrap();

        let (status, body) =
            write_file(&path, "mine", Some(&sha256_hex(b"what I last saw")), false);
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "conflict");
        assert_eq!(body["diskSha256"], sha256_hex(b"externally changed"));
        // Nothing was written.
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "externally changed"
        );
    }

    #[test]
    fn create_new_succeeds_and_rejects_existing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fresh.txt");

        let (status, body) = write_file(&path, "hello", None, false);
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["sha256"], sha256_hex(b"hello"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello");

        let (status, body) = write_file(&path, "again", None, false);
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "conflict");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello");
    }

    #[test]
    fn vanished_file_with_baseline_reports_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gone.txt");

        let (status, body) = write_file(&path, "content", Some(&sha256_hex(b"old")), false);
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "missing");
        assert!(!path.exists());
    }

    #[test]
    fn permission_bits_survive_the_rename() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("private.txt");
        std::fs::write(&path, "v1").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();

        let (status, _) = write_file(&path, "v2", Some(&sha256_hex(b"v1")), false);
        assert_eq!(status, StatusCode::OK);
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn delete_is_hash_conditional() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("draft.txt");
        std::fs::write(&path, "draft content").unwrap();

        // Stale baseline → refuse to delete.
        let (status, body) = write_file(&path, "", Some(&sha256_hex(b"stale")), true);
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "conflict");
        assert!(path.exists());

        // Matching baseline → removed.
        let (status, body) = write_file(&path, "", Some(&sha256_hex(b"draft content")), true);
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["deleted"], true);
        assert!(!path.exists());
    }

    #[test]
    fn concurrent_writes_to_one_path_leave_no_torn_file_or_temp() {
        use std::sync::Arc;
        use std::thread;

        let dir = tempfile::tempdir().unwrap();
        let path = Arc::new(dir.path().join("hot.txt"));
        std::fs::write(&*path, "seed").unwrap();

        let mut handles = Vec::new();
        for i in 0..16 {
            let path = Arc::clone(&path);
            handles.push(thread::spawn(move || {
                // Same lock the handler takes: serialize the read + write so
                // the baseline can't go stale under us, and use a unique temp.
                let _lock = write_lock_for(&path).lock();
                let disk = std::fs::read(&*path).unwrap();
                write_file(
                    &path,
                    &format!("write-{i}"),
                    Some(&sha256_hex(&disk)),
                    false,
                )
            }));
        }
        for h in handles {
            let _ = h.join();
        }

        // The final file is exactly one clean write — never torn or interleaved.
        let final_content = std::fs::read_to_string(&*path).unwrap();
        assert!(
            (0..16).any(|i| final_content == format!("write-{i}")),
            "unexpected final content: {final_content:?}"
        );
        // No temp residue from any of the 16 writes.
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("tug-tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn missing_parent_outside_drafts_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("no/such/dir/file.txt");

        let (status, body) = write_file(&path, "content", None, false);
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "parent_missing");
    }

    #[test]
    fn missing_parents_under_asides_root_are_created() {
        use parking_lot::Mutex;
        use std::ffi::OsString;

        // Env mutation is process-global; serialize with the other
        // env-sensitive tests via a local mutex, and restore after.
        static ENV_MUTEX: Mutex<()> = Mutex::new(());
        let _guard = ENV_MUTEX.lock();

        let data = tempfile::tempdir().unwrap();
        let key = tugcore::instance::ENV_DATA_DIR;
        let prior: Option<OsString> = std::env::var_os(key);
        unsafe {
            std::env::set_var(key, data.path());
        }

        // asides_root() now resolves under the temp data dir; a nested
        // aside path has no existing parent and must be created by the write.
        let root = asides_root().expect("asides_root under temp data dir");
        assert!(root.starts_with(data.path()));
        let path = root.join("aside-deadbeef.json");
        assert!(!path.parent().unwrap().exists());

        let (status, body) = write_file(&path, "{}", None, false);

        unsafe {
            match &prior {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }

        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}");
    }
}
