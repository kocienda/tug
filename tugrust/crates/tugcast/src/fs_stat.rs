//! HTTP handler for `POST /api/fs/stat` — batch file-existence probes.
//!
//! The frontend's recently-open file surfaces list stored MRU paths
//! that may have been deleted or moved since they were recorded. This
//! endpoint answers "is this still an
//! openable file?" for a batch of paths in one round trip, keyed by the
//! inbound path string so the client maps results without re-deriving
//! canonical forms.
//!
//! Loopback-only, like the other `/api/fs` handlers, and gated by the
//! same path guard: a relative / traversing / secret-denylisted path
//! reports `false` (not reachable) rather than erroring, since the
//! caller's question is precisely "can I open this?".

use std::net::SocketAddr;

use axum::extract::ConnectInfo;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tracing::warn;

use crate::fs_read::guard_absolute_path;

/// Cap on paths per request — bounds the stat work; the MRU stores that
/// call this hold far fewer entries.
pub(crate) const MAX_STAT_PATHS: usize = 64;

/// What kind of filesystem entry counts as "exists" for a probe. Defaults to
/// `File` so the Text-card MRU caller (which omits the field) is unchanged; the
/// session picker's project-path recents send `Dir`.
///
/// `Any` asks the looser question the transcript annotator needs: not "is this
/// an openable regular file?" but "is there something here at all?" A reference
/// in ink can name a directory, a symlink, a hard link, or a device node, and
/// all of them are real things worth pointing at — refusing them because they
/// are not `is_file()` would leave true references inert. Callers that need the
/// stricter reading keep asking for it.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum StatKind {
    #[default]
    File,
    Dir,
    Any,
}

/// Request body for `POST /api/fs/stat`.
#[derive(Debug, Deserialize)]
pub(crate) struct StatRequest {
    paths: Vec<String>,
    #[serde(default)]
    kind: StatKind,
}

/// Probe each path and build the
/// `{ "exists": { path: bool }, "canonical": { path: canonicalPath } }`
/// payload. `kind` selects whether a file or a directory counts as reachable.
/// `canonical` carries the resolved form (via the same `resolve_to_claude_form`
/// a Text card binds on open) for every path the guard accepts, so the caller
/// can normalize its stored paths and dedupe them against open cards' canonical
/// paths. Pure over the filesystem, synchronous — the handler runs it under
/// `spawn_blocking`.
///
/// Existence and canonical form are separate answers. A path that does not
/// exist yet still has one — `resolve_to_claude_form` rewrites a symlinked or
/// synthetic prefix without needing the leaf to be there — and the frontend
/// needs it, because [L29] binds the path it is about to **persist**, not only
/// the ones it can stat. The default project directory is exactly that case:
/// it is settable before it exists and created on first use. Only a path the
/// guard refuses (relative, traversing, secret-denylisted) has no entry here,
/// so `canonical` present still means "this is a path Tug will touch".
fn stat_paths(paths: &[String], kind: StatKind) -> Value {
    let mut exists = Map::new();
    let mut canonical = Map::new();
    let mut is_dir = Map::new();
    let mut identity = Map::new();
    for raw in paths.iter().take(MAX_STAT_PATHS) {
        let reachable = match guard_absolute_path(raw) {
            Ok(resolved) => {
                canonical.insert(
                    raw.clone(),
                    Value::String(resolved.to_string_lossy().into_owned()),
                );
                // `metadata` follows symlinks, so a link to a real target
                // reports the target's kind — which is the right reading for
                // "can I point at this?".
                std::fs::metadata(&resolved)
                    .map(|md| {
                        let matched = match kind {
                            StatKind::File => md.is_file(),
                            StatKind::Dir => md.is_dir(),
                            StatKind::Any => true,
                        };
                        if matched && md.is_dir() {
                            is_dir.insert(raw.clone(), Value::Bool(true));
                        }
                        if matched {
                            let mut entry = json!({});
                            crate::fs_read::insert_identity(&mut entry, &md);
                            if entry.as_object().is_some_and(|o| !o.is_empty()) {
                                identity.insert(raw.clone(), entry);
                            }
                        }
                        matched
                    })
                    .unwrap_or(false)
            }
            Err(_) => false,
        };
        exists.insert(raw.clone(), Value::Bool(reachable));
    }
    // `is_dir` carries only the reachable directories: a caller asking the
    // loose question needs to know which of its hits are folders, because
    // opening one is a different gesture from opening a file.
    //
    // `identity` carries `(dev, ino)` for the reachable paths only — an
    // unreachable path has no file to identify. It is what lets a caller
    // recognize one of its own files under a new name.
    json!({
        "exists": exists,
        "canonical": canonical,
        "isDir": is_dir,
        "identity": identity,
    })
}

/// Handle `POST /api/fs/stat`. Restricted to loopback.
pub(crate) async fn post_fs_stat(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    axum::Json(request): axum::Json<StatRequest>,
) -> Response {
    if !addr.ip().is_loopback() {
        warn!("post_fs_stat: rejected non-loopback connection from {addr}");
        return (
            StatusCode::FORBIDDEN,
            axum::Json(json!({ "error": "denied" })),
        )
            .into_response();
    }
    let result =
        tokio::task::spawn_blocking(move || stat_paths(&request.paths, request.kind)).await;
    match result {
        Ok(body) => (StatusCode::OK, axum::Json(body)).into_response(),
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

    #[cfg(unix)]
    #[test]
    fn stat_identifies_reachable_paths_and_omits_unreachable_ones() {
        use std::os::unix::fs::MetadataExt;

        let dir = tempfile::tempdir().unwrap();
        let present = dir.path().join("here.txt");
        std::fs::write(&present, "x").unwrap();
        let missing = dir.path().join("gone.txt");
        let present_key = present.to_string_lossy().into_owned();
        let missing_key = missing.to_string_lossy().into_owned();

        let body = stat_paths(&[present_key.clone(), missing_key.clone()], StatKind::File);

        let metadata = std::fs::metadata(&present).unwrap();
        assert_eq!(
            body["identity"][&present_key]["dev"].as_u64().unwrap(),
            metadata.dev()
        );
        assert_eq!(
            body["identity"][&present_key]["ino"].as_u64().unwrap(),
            metadata.ino()
        );
        // Nothing to identify where there is no file.
        assert!(body["identity"].get(&missing_key).is_none());
    }

    #[test]
    fn stat_reports_existing_file_true_and_missing_false() {
        let dir = tempfile::tempdir().unwrap();
        let present = dir.path().join("here.txt");
        std::fs::write(&present, "x").unwrap();
        let missing = dir.path().join("gone.txt");

        let body = stat_paths(
            &[
                present.to_string_lossy().into_owned(),
                missing.to_string_lossy().into_owned(),
            ],
            StatKind::File,
        );
        assert_eq!(body["exists"][present.to_string_lossy().as_ref()], true);
        assert_eq!(body["exists"][missing.to_string_lossy().as_ref()], false);
        // Both carry a resolved canonical form: existence and canonical form
        // are separate answers, and a caller persisting a not-yet-created path
        // still has to route it through the gateway ([L29]).
        assert!(body["canonical"][present.to_string_lossy().as_ref()].is_string());
        assert!(body["canonical"][missing.to_string_lossy().as_ref()].is_string());
    }

    #[test]
    fn stat_canonicalizes_a_path_that_does_not_exist_yet() {
        // The default project directory is settable before it exists and
        // created on first use, so the frontend must be able to canonicalize
        // it at the moment it persists it.
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("not-created-yet");
        let raw = missing.to_string_lossy().into_owned();

        let body = stat_paths(std::slice::from_ref(&raw), StatKind::Dir);
        assert_eq!(body["exists"][&raw], false);
        assert!(body["canonical"][&raw].is_string());

        // A path the guard refuses has no canonical form at all — "canonical
        // present" still means "a path Tug will touch".
        let refused = stat_paths(&["relative/path".to_string()], StatKind::Dir);
        assert!(refused["canonical"].get("relative/path").is_none());
    }

    #[test]
    fn stat_reports_directory_false() {
        let dir = tempfile::tempdir().unwrap();
        let body = stat_paths(&[dir.path().to_string_lossy().into_owned()], StatKind::File);
        assert_eq!(body["exists"][dir.path().to_string_lossy().as_ref()], false);
    }

    #[test]
    fn stat_dir_kind_reports_directory_true_and_file_false() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("here.txt");
        std::fs::write(&file, "x").unwrap();
        let missing = dir.path().join("gone");

        let body = stat_paths(
            &[
                dir.path().to_string_lossy().into_owned(),
                file.to_string_lossy().into_owned(),
                missing.to_string_lossy().into_owned(),
            ],
            StatKind::Dir,
        );
        assert_eq!(body["exists"][dir.path().to_string_lossy().as_ref()], true);
        assert_eq!(body["exists"][file.to_string_lossy().as_ref()], false);
        assert_eq!(body["exists"][missing.to_string_lossy().as_ref()], false);
        // A reachable directory carries its resolved canonical form.
        assert!(body["canonical"][dir.path().to_string_lossy().as_ref()].is_string());
    }

    #[test]
    fn stat_any_kind_accepts_whatever_is_there() {
        // The annotator's question is "is there something here?", so a
        // directory and a symlink both count — and the answer says which
        // hits are directories, since opening one is a different gesture.
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("here.txt");
        std::fs::write(&file, "x").unwrap();
        let link = dir.path().join("link.txt");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        let missing = dir.path().join("gone");

        let body = stat_paths(
            &[
                dir.path().to_string_lossy().into_owned(),
                file.to_string_lossy().into_owned(),
                link.to_string_lossy().into_owned(),
                missing.to_string_lossy().into_owned(),
            ],
            StatKind::Any,
        );
        assert_eq!(body["exists"][dir.path().to_string_lossy().as_ref()], true);
        assert_eq!(body["exists"][file.to_string_lossy().as_ref()], true);
        assert_eq!(body["exists"][link.to_string_lossy().as_ref()], true);
        assert_eq!(body["exists"][missing.to_string_lossy().as_ref()], false);

        assert_eq!(body["isDir"][dir.path().to_string_lossy().as_ref()], true);
        assert!(body["isDir"].get(file.to_string_lossy().as_ref()).is_none());
        // A symlink to a file is a file: `metadata` follows the link.
        assert!(body["isDir"].get(link.to_string_lossy().as_ref()).is_none());
    }

    #[test]
    fn stat_any_kind_still_refuses_what_the_guard_refuses() {
        let body = stat_paths(
            &[
                "relative/path.txt".to_string(),
                "/tmp/../etc/passwd".to_string(),
            ],
            StatKind::Any,
        );
        assert_eq!(body["exists"]["relative/path.txt"], false);
        assert_eq!(body["exists"]["/tmp/../etc/passwd"], false);
    }

    #[test]
    fn stat_reports_relative_and_traversing_paths_false() {
        let body = stat_paths(
            &[
                "relative/path.txt".to_string(),
                "/tmp/../etc/passwd".to_string(),
            ],
            StatKind::File,
        );
        assert_eq!(body["exists"]["relative/path.txt"], false);
        assert_eq!(body["exists"]["/tmp/../etc/passwd"], false);
    }

    #[test]
    fn stat_caps_the_batch() {
        let paths: Vec<String> = (0..MAX_STAT_PATHS + 8)
            .map(|i| format!("/nonexistent/{i}"))
            .collect();
        let body = stat_paths(&paths, StatKind::File);
        assert_eq!(body["exists"].as_object().unwrap().len(), MAX_STAT_PATHS);
    }
}
