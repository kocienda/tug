//! Attachment storage: `POST /api/attachments` and `POST /api/fs/attach`.
//!
//! Attachments are ordinary files. There is no blob table, no app-scheme
//! link, no localhost URL — a link that only Tug can resolve is a link that
//! is dead the moment the document leaves the app, and tugcast's port is
//! reallocated per launch anyway. Both routes therefore answer the same
//! question in two ways: *where do these bytes go, and what string does the
//! calling surface hold afterwards.*
//!
//! - `POST /api/attachments` — the composer's draft tier. The server picks
//!   the location: `data_dir()/draft-attachments/<uuid>.<ext>`, one directory
//!   over from the Overview's `overview-attachments`. The caller names only a
//!   media type; the response is the absolute path. Files here are transient
//!   by nature and are reclaimed by the startup sweep in `draft_gc`.
//! - `POST /api/fs/attach` — the document tier. The caller names the markdown
//!   document being edited and the filename it wants; the bytes land in a
//!   sibling `assets/` folder and the response carries both the absolute path
//!   and the document-relative one that goes into the markdown link.
//!
//! A document that has never been saved has no directory to be a sibling of,
//! so the document tier answers to a *draft id* as well as to a path:
//! `draft=<id>` writes into `data_dir()/draft-docs/<id>/assets/`, and the link
//! that goes into the buffer is the same relative `assets/<name>` it will be
//! after the document is saved. `GET /api/fs/attach-base` reports that home so
//! the deck — which cannot compute `data_dir()` — can resolve the same links,
//! and `draft_gc` reclaims a home whose draft is gone.
//!
//! Both take raw file bytes as the request body rather than base64 inside
//! JSON: base64 costs 1.33× before JSON escaping, which is what forced
//! `fs_write`'s 6× body ceiling.
//!
//! The extension is never guessed. `attachment_extension` maps a media type
//! to an extension that `fs_blob::mime_for_extension` can serve back, and
//! returns `None` otherwise — storing bytes under an extension the blob route
//! refuses would produce a write-only file that consumes disk and can never
//! rehydrate.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use axum::body::Bytes;
use axum::extract::{ConnectInfo, Query};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use tracing::warn;

use crate::fs_read::{fs_error, guard_absolute_path};

/// Max request body for either upload route. Raw bytes, so this is the
/// file size itself rather than an inflated envelope. Loopback-only keeps
/// the ceiling off the DoS surface.
pub(crate) const MAX_ATTACHMENT_BODY_BYTES: usize = 64 * 1024 * 1024;

/// The filename extension to store a media type under, or `None` when the
/// type is outside the set `fs_blob` can serve back.
///
/// This is the reverse of `fs_blob::mime_for_extension`, and the two are
/// pinned to agree by a unit test below: every extension this returns must
/// have an arm there, or the stored file would be unreadable through
/// `GET /api/fs/blob` and the attachment could never rehydrate.
///
/// Parameters are ignored — `image/png; charset=binary` is `image/png`.
pub(crate) fn attachment_extension(media_type: &str) -> Option<&'static str> {
    let base = media_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match base.as_str() {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/heic" => Some("heic"),
        "image/heif" => Some("heif"),
        "image/avif" => Some("avif"),
        "image/tiff" => Some("tiff"),
        "image/bmp" => Some("bmp"),
        "image/vnd.microsoft.icon" | "image/x-icon" => Some("ico"),
        "application/pdf" => Some("pdf"),
        _ => None,
    }
}

/// Process-wide counter making every temp filename unique, so two concurrent
/// uploads into one directory can never share — and corrupt — a temp file.
fn next_temp_seq() -> u64 {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// Write `bytes` to `target` atomically: hidden temp file in the target's
/// own directory (same filesystem), fsync, rename. A reader — including the
/// blob route serving the file back — never observes a partial attachment.
pub(crate) fn write_attachment_atomic(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let parent = target.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "target has no parent")
    })?;
    let file_name = target.file_name().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "target has no file name")
    })?;
    let temp_path = parent.join(format!(
        ".{}.tug-tmp-{}-{}",
        file_name.to_string_lossy(),
        std::process::id(),
        next_temp_seq(),
    ));
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&temp_path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp_path, target)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    result
}

/// The directory the composer's draft attachments rest in. Per-instance:
/// `tugbank.db` is per-instance too, so a draft and its bytes always live in
/// the same instance directory and are removed together by an instance prune.
pub(crate) fn draft_attachments_dir() -> PathBuf {
    tugcore::instance::data_dir().join("draft-attachments")
}

/// Query string for `POST /api/attachments`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentsQuery {
    media_type: String,
}

/// Store draft-tier bytes and report where they landed. Synchronous so it can
/// be unit-tested directly; the handler runs it under `spawn_blocking`.
fn store_draft_attachment(dir: &Path, media_type: &str, bytes: &[u8]) -> (StatusCode, Value) {
    let Some(ext) = attachment_extension(media_type) else {
        return fs_error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type");
    };
    if let Err(err) = std::fs::create_dir_all(dir) {
        warn!(error = %err, "attachments: draft dir unavailable");
        return fs_error(StatusCode::INTERNAL_SERVER_ERROR, "internal");
    }
    let path = dir.join(format!("{}.{}", uuid::Uuid::new_v4(), ext));
    if let Err(err) = write_attachment_atomic(&path, bytes) {
        warn!(error = %err, "attachments: draft write failed");
        return fs_error(StatusCode::INTERNAL_SERVER_ERROR, "internal");
    }
    (StatusCode::OK, json!({ "path": path.to_string_lossy() }))
}

/// Handle `POST /api/attachments`. Restricted to loopback.
///
/// No path is accepted from the caller, so there is nothing to guard and
/// nothing to canonicalize: the response path is built from `data_dir()` and
/// is canonical by construction.
pub(crate) async fn post_attachments(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(query): Query<AttachmentsQuery>,
    body: Bytes,
) -> Response {
    if !addr.ip().is_loopback() {
        warn!("post_attachments: rejected non-loopback connection from {addr}");
        return (
            StatusCode::FORBIDDEN,
            axum::Json(json!({ "error": "denied" })),
        )
            .into_response();
    }
    let dir = draft_attachments_dir();
    let result =
        tokio::task::spawn_blocking(move || store_draft_attachment(&dir, &query.media_type, &body))
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

/// The directory holding every not-yet-saved document's asset home, one
/// subdirectory per draft id. Per-instance for the same reason
/// `draft_attachments_dir` is: the draft's own state lives in this instance's
/// tugbank, so the bytes and the reference are pruned together.
pub(crate) fn draft_docs_dir() -> PathBuf {
    tugcore::instance::data_dir().join("draft-docs")
}

/// The home directory a draft's relative links resolve against, inside `root`.
///
/// `draft_id` passes `validate_asset_name`, so it is exactly one ordinary path
/// component and can never name anything outside `root`.
pub(crate) fn draft_doc_home(root: &Path, draft_id: &str) -> Result<PathBuf, &'static str> {
    validate_asset_name(draft_id)?;
    Ok(root.join(draft_id))
}

/// Where a draft's assets land: the `assets/` child of its home, so a link
/// written now (`assets/photo.png`) is the link the saved document keeps.
pub(crate) fn draft_doc_assets_dir(root: &Path, draft_id: &str) -> Result<PathBuf, &'static str> {
    Ok(draft_doc_home(root, draft_id)?.join("assets"))
}

/// The name a pasted image is stored under when the caller supplies none:
/// `pasted-YYYY-MM-DD-HHMMSS.<ext>` in local time, or `None` when the media
/// type is one `attachment_extension` refuses.
///
/// Local time rather than UTC because this string is read in the document, in
/// the folder, and in `git status` — it should say when the file arrived where
/// the user was sitting. `now` is a parameter so the test is deterministic.
pub(crate) fn mint_pasted_name(media_type: &str, now: SystemTime) -> Option<String> {
    let ext = attachment_extension(media_type)?;
    let stamp = chrono::DateTime::<chrono::Local>::from(now).format("%Y-%m-%d-%H%M%S");
    Some(format!("pasted-{stamp}.{ext}"))
}

/// Query string for `POST /api/fs/attach`: which document the asset belongs to
/// — either a saved one by `doc` path or an unsaved one by `draft` id — and the
/// filename the caller wants the asset to keep.
///
/// `name` is optional: a paste has no filename, so the server mints one from
/// the request's `Content-Type` rather than making the deck invent a spelling
/// of the same timestamp.
#[derive(Debug, Deserialize)]
pub(crate) struct AttachQuery {
    doc: Option<String>,
    draft: Option<String>,
    name: Option<String>,
}

/// Query string for `GET /api/fs/attach-base`.
#[derive(Debug, Deserialize)]
pub(crate) struct AttachBaseQuery {
    draft: String,
}

/// Accept `name` as an asset filename, or say why not.
///
/// The name becomes a single child of the document's `assets/` directory, so
/// it must not be able to name anything else: no separators, no `..`, no
/// empty name, and no leading dot (a dotfile asset would be invisible in the
/// folder the link points at, and the temp files this module writes are
/// themselves dot-prefixed).
pub(crate) fn validate_asset_name(name: &str) -> Result<(), &'static str> {
    if name.is_empty() {
        return Err("bad_name");
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err("bad_name");
    }
    // A leading dot covers `.`, `..`, and dotfiles in one rule.
    if name.starts_with('.') {
        return Err("bad_name");
    }
    // Belt and braces: whatever the platform considers a separator, the name
    // has to be exactly one ordinary component.
    let mut components = Path::new(name).components();
    match (components.next(), components.next()) {
        (Some(std::path::Component::Normal(part)), None) if part == name => Ok(()),
        _ => Err("bad_name"),
    }
}

/// The filename `name` should take inside `dir`, appending `-2`, `-3`, … before
/// the extension until nothing is in the way.
///
/// The original name is kept when it is free: these links are meant to be read
/// in the markdown source, so a content hash would make the document opaque.
pub(crate) fn resolve_collision_name(dir: &Path, name: &str) -> String {
    if !dir.join(name).exists() {
        return name.to_string();
    }
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string());
    let ext = path.extension().map(|s| s.to_string_lossy().into_owned());
    let mut n = 2u32;
    loop {
        let candidate = match &ext {
            Some(ext) => format!("{stem}-{n}.{ext}"),
            None => format!("{stem}-{n}"),
        };
        if !dir.join(&candidate).exists() {
            return candidate;
        }
        n += 1;
    }
}

/// Write `bytes` into `assets` under `name`, collision-resolved, and report
/// both spellings the caller needs. The directory is created if absent — every
/// caller has already established that it is entitled to create it.
fn store_attachment_in(assets: &Path, name: &str, bytes: &[u8]) -> (StatusCode, Value) {
    if let Err(error) = validate_asset_name(name) {
        return fs_error(StatusCode::BAD_REQUEST, error);
    }
    if let Err(err) = std::fs::create_dir_all(assets) {
        warn!(error = %err, "attachments: assets dir unavailable");
        return fs_error(StatusCode::INTERNAL_SERVER_ERROR, "internal");
    }
    let final_name = resolve_collision_name(assets, name);
    let path = assets.join(&final_name);
    if let Err(err) = write_attachment_atomic(&path, bytes) {
        warn!(error = %err, "attachments: asset write failed");
        return fs_error(StatusCode::INTERNAL_SERVER_ERROR, "internal");
    }
    (
        StatusCode::OK,
        json!({
            "path": path.to_string_lossy(),
            "relativePath": format!("assets/{final_name}"),
        }),
    )
}

/// Write `bytes` into `doc`'s sibling `assets/` folder. Synchronous so it can
/// be unit-tested directly; the handler runs it under `spawn_blocking`.
///
/// `doc` must already have passed `guard_absolute_path` — it arrives canonical.
fn store_doc_attachment(doc: &Path, name: &str, bytes: &[u8]) -> (StatusCode, Value) {
    if let Err(error) = validate_asset_name(name) {
        return fs_error(StatusCode::BAD_REQUEST, error);
    }
    // The document must be an existing regular file. This is what bounds the
    // directory-creation relaxation below: the route can only ever create a
    // single `assets/` child of a directory that already holds a real file,
    // never `mkdir -p` into an arbitrary nonexistent tree.
    match std::fs::metadata(doc) {
        Ok(md) if md.is_file() => {}
        Ok(_) => return fs_error(StatusCode::NOT_FOUND, "not_found"),
        Err(_) => return fs_error(StatusCode::NOT_FOUND, "not_found"),
    }
    let Some(parent) = doc.parent() else {
        return fs_error(StatusCode::BAD_REQUEST, "bad_path");
    };
    let assets = parent.join("assets");
    let result = store_attachment_in(&assets, name, bytes);
    if result.0 == StatusCode::OK {
        // Only the document tier: a draft home lives inside `data_dir()` and is
        // never in a working tree.
        crate::git_exclude::ensure_assets_excluded(&assets);
    }
    result
}

/// Write `bytes` into a draft document's asset home under `root`.
///
/// No existing-file precondition, and none is needed: the whole tree is inside
/// `data_dir()`, and `draft_doc_assets_dir` bounds `draft_id` to one ordinary
/// component. A document that does not exist yet is exactly the case this arm
/// is for.
fn store_draft_doc_attachment(
    root: &Path,
    draft_id: &str,
    name: &str,
    bytes: &[u8],
) -> (StatusCode, Value) {
    let assets = match draft_doc_assets_dir(root, draft_id) {
        Ok(dir) => dir,
        Err(error) => return fs_error(StatusCode::BAD_REQUEST, error),
    };
    store_attachment_in(&assets, name, bytes)
}

/// Create and report a draft's asset base — the directory its relative links
/// resolve against, which is the home itself and not its `assets/` child.
fn attach_base(root: &Path, draft_id: &str) -> (StatusCode, Value) {
    let home = match draft_doc_home(root, draft_id) {
        Ok(dir) => dir,
        Err(error) => return fs_error(StatusCode::BAD_REQUEST, error),
    };
    // Created on demand so the answer is always a directory that exists — the
    // deck resolves links against it before anything has been attached.
    if let Err(err) = std::fs::create_dir_all(&home) {
        warn!(error = %err, "attachments: draft home unavailable");
        return fs_error(StatusCode::INTERNAL_SERVER_ERROR, "internal");
    }
    (StatusCode::OK, json!({ "base": home.to_string_lossy() }))
}

/// Query string for `POST /api/fs/attach/migrate`.
#[derive(Debug, Deserialize)]
pub(crate) struct AttachMigrateQuery {
    draft: String,
    doc: String,
}

/// The sha-256 of a file's bytes, for the copy's verification step.
fn file_digest(path: &Path) -> std::io::Result<Vec<u8>> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(hasher.finalize().to_vec())
}

/// Move a draft document's assets into the directory it was just saved into.
///
/// Copy → verify → remove, per file. The ordering is the whole safety story: a
/// failure at any point leaves the source file present, so an asset can exist
/// in both places but never in neither. Collisions resolve at the destination
/// with the same `resolve_collision_name` the attach route uses, because a
/// `photo.png` already sitting beside the destination document belongs to that
/// document and is not ours to overwrite.
///
/// Returns the renames the document must apply — empty in the common case,
/// which is what makes the untitled story seamless rather than a rewrite.
fn migrate_draft_assets(root: &Path, draft_id: &str, doc: &Path) -> (StatusCode, Value) {
    let home = match draft_doc_home(root, draft_id) {
        Ok(dir) => dir,
        Err(error) => return fs_error(StatusCode::BAD_REQUEST, error),
    };
    // The same existing-regular-file precondition the attach route carries,
    // and for the same reason: it bounds where this can create a directory.
    match std::fs::metadata(doc) {
        Ok(md) if md.is_file() => {}
        _ => return fs_error(StatusCode::NOT_FOUND, "not_found"),
    }
    let Some(parent) = doc.parent() else {
        return fs_error(StatusCode::BAD_REQUEST, "bad_path");
    };
    let source = home.join("assets");
    let Ok(entries) = std::fs::read_dir(&source) else {
        // Nothing was ever attached. A no-op success, not an error — the deck
        // calls this on every Save As of a draft-backed buffer.
        let _ = std::fs::remove_dir_all(&home);
        return (StatusCode::OK, json!({ "renames": [] }));
    };
    let mut files: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        match entry.file_type() {
            Ok(ft) if ft.is_file() => files.push(entry.path()),
            _ => {}
        }
    }
    if files.is_empty() {
        let _ = std::fs::remove_dir_all(&home);
        return (StatusCode::OK, json!({ "renames": [] }));
    }

    let destination = parent.join("assets");
    if let Err(err) = std::fs::create_dir_all(&destination) {
        warn!(error = %err, "attachments: migration destination unavailable");
        let (status, mut body) = fs_error(StatusCode::INTERNAL_SERVER_ERROR, "internal");
        body["renames"] = json!([]);
        return (status, body);
    }

    let mut renames: Vec<Value> = Vec::new();
    for file in files {
        let Some(name) = file.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let final_name = resolve_collision_name(&destination, name);
        let target = destination.join(&final_name);
        let moved = (|| -> std::io::Result<()> {
            let bytes = std::fs::read(&file)?;
            write_attachment_atomic(&target, &bytes)?;
            // Verify before the source is gone: length first (cheap and
            // catches a truncated write), then the digest.
            let written = std::fs::metadata(&target)?.len();
            if written != bytes.len() as u64 {
                return Err(std::io::Error::other("size mismatch after copy"));
            }
            if file_digest(&target)? != file_digest(&file)? {
                return Err(std::io::Error::other("digest mismatch after copy"));
            }
            std::fs::remove_file(&file)
        })();
        if let Err(err) = moved {
            warn!(error = %err, path = %file.display(), "attachments: migration failed");
            // Stop here. Everything already moved is reported so the caller can
            // still reconcile the document; the source keeps whatever is left.
            let (status, mut body) = fs_error(StatusCode::INTERNAL_SERVER_ERROR, "internal");
            body["renames"] = json!(renames);
            return (status, body);
        }
        if final_name != name {
            renames.push(json!({
                "from": format!("assets/{name}"),
                "to": format!("assets/{final_name}"),
            }));
        }
    }

    // The assets have a repository now — the draft home never did, since it
    // lives inside `data_dir()`, which is why there is no stale rule to sweep
    // on the source side.
    crate::git_exclude::ensure_assets_excluded(&destination);

    // Everything moved, so the draft home has nothing left to hold.
    if let Err(err) = std::fs::remove_dir_all(&home) {
        warn!(error = %err, path = %home.display(), "attachments: draft home not reclaimed");
    }
    (StatusCode::OK, json!({ "renames": renames }))
}

/// Handle `POST /api/fs/attach/migrate`. Restricted to loopback.
pub(crate) async fn post_attach_migrate(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(query): Query<AttachMigrateQuery>,
) -> Response {
    if !addr.ip().is_loopback() {
        warn!("post_attach_migrate: rejected non-loopback connection from {addr}");
        return (
            StatusCode::FORBIDDEN,
            axum::Json(json!({ "error": "denied" })),
        )
            .into_response();
    }
    let doc = match guard_absolute_path(&query.doc) {
        Ok(canonical) => canonical,
        Err((status, body)) => return (status, axum::Json(body)).into_response(),
    };
    let result = tokio::task::spawn_blocking(move || {
        migrate_draft_assets(&draft_docs_dir(), &query.draft, &doc)
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

/// Handle `POST /api/fs/attach`. Restricted to loopback.
///
/// `guard_absolute_path` is the canonicalization gateway for `doc`; every path
/// this route returns is derived from its output and is canonical in turn.
///
/// Unlike `fs_write`, this route creates a missing directory anywhere on disk.
/// That is the gesture: creating `assets/` next to the document is what a drop
/// on a Text card *means*, and confining it to the Tug-owned roots would defeat
/// the portability the sibling-folder layout exists for. The relaxation is
/// bounded by loopback-only, `guard_absolute_path`, and the existing-regular-file
/// requirement on `doc`.
pub(crate) async fn post_fs_attach(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(query): Query<AttachQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !addr.ip().is_loopback() {
        warn!("post_fs_attach: rejected non-loopback connection from {addr}");
        return (
            StatusCode::FORBIDDEN,
            axum::Json(json!({ "error": "denied" })),
        )
            .into_response();
    }
    // A name the caller did not supply is minted from the body's media type,
    // so the timestamp and the write are one step — the same reason collision
    // resolution happens here rather than in the deck.
    let name = match query.name {
        Some(name) => name,
        None => {
            let media_type = headers
                .get(axum::http::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            match mint_pasted_name(media_type, SystemTime::now()) {
                Some(name) => name,
                None => {
                    let (status, body) =
                        fs_error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type");
                    return (status, axum::Json(body)).into_response();
                }
            }
        }
    };
    let result = match (query.doc, query.draft) {
        (Some(doc), None) => {
            let doc = match guard_absolute_path(&doc) {
                Ok(canonical) => canonical,
                Err((status, body)) => return (status, axum::Json(body)).into_response(),
            };
            tokio::task::spawn_blocking(move || store_doc_attachment(&doc, &name, &body)).await
        }
        (None, Some(draft)) => {
            tokio::task::spawn_blocking(move || {
                store_draft_doc_attachment(&draft_docs_dir(), &draft, &name, &body)
            })
            .await
        }
        // Neither or both: there is no defensible default for "which document
        // is this," so it is a request error rather than a guess.
        _ => {
            let (status, body) = fs_error(StatusCode::BAD_REQUEST, "bad_request");
            return (status, axum::Json(body)).into_response();
        }
    };
    match result {
        Ok((status, body)) => (status, axum::Json(body)).into_response(),
        Err(_join_err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "error": "internal" })),
        )
            .into_response(),
    }
}

/// Handle `GET /api/fs/attach-base`. Restricted to loopback.
///
/// The deck cannot compute `data_dir()` — it is per-instance and host-side — so
/// it asks for the directory a draft's relative links resolve against.
pub(crate) async fn get_attach_base(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(query): Query<AttachBaseQuery>,
) -> Response {
    if !addr.ip().is_loopback() {
        warn!("get_attach_base: rejected non-loopback connection from {addr}");
        return (
            StatusCode::FORBIDDEN,
            axum::Json(json!({ "error": "denied" })),
        )
            .into_response();
    }
    let result =
        tokio::task::spawn_blocking(move || attach_base(&draft_docs_dir(), &query.draft)).await;
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

    /// The invariant the whole "no `.img` fallback" position rests on: every
    /// extension we are willing to store under is one the blob route will
    /// serve back. A mapping that fails this produces write-only files.
    #[test]
    fn every_mapped_extension_is_servable() {
        for media_type in [
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
            "image/heic",
            "image/heif",
            "image/avif",
            "image/tiff",
            "image/bmp",
            "image/vnd.microsoft.icon",
            "image/x-icon",
            "application/pdf",
        ] {
            let ext = attachment_extension(media_type)
                .unwrap_or_else(|| panic!("{media_type} should map to an extension"));
            assert!(
                crate::fs_blob::mime_for_extension(ext).is_some(),
                "{media_type} maps to .{ext}, which /api/fs/blob cannot serve",
            );
        }
    }

    #[test]
    fn unmapped_media_types_yield_none() {
        // SVG is the live case: the drop gate admits it, `fs_blob`
        // deliberately does not serve it, so it is declined rather than
        // stored somewhere it could never be read back from.
        assert_eq!(attachment_extension("image/svg+xml"), None);
        assert_eq!(attachment_extension("text/plain"), None);
        assert_eq!(attachment_extension("application/zip"), None);
        assert_eq!(attachment_extension(""), None);
    }

    #[test]
    fn media_type_parameters_and_case_are_ignored() {
        assert_eq!(attachment_extension("IMAGE/PNG"), Some("png"));
        assert_eq!(
            attachment_extension("image/png; charset=binary"),
            Some("png")
        );
        assert_eq!(attachment_extension("  image/jpeg  "), Some("jpg"));
    }

    #[test]
    fn atomic_write_produces_exact_bytes_and_leaves_no_temp() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("photo.png");
        let bytes: Vec<u8> = (0u8..=255).cycle().take(5000).collect();
        write_attachment_atomic(&target, &bytes).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec!["photo.png".to_string()]);
    }

    #[test]
    fn draft_attachment_lands_in_the_dir_with_a_uuid_name() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("draft-attachments");
        let (status, body) = store_draft_attachment(&root, "image/png", b"PNGBYTES");
        assert_eq!(status, StatusCode::OK);
        let path = PathBuf::from(body["path"].as_str().unwrap());
        assert!(path.is_absolute());
        assert_eq!(path.parent().unwrap(), root);
        assert_eq!(path.extension().unwrap(), "png");
        assert!(
            uuid::Uuid::parse_str(path.file_stem().unwrap().to_str().unwrap()).is_ok(),
            "stem should be a uuid: {path:?}",
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"PNGBYTES");
    }

    #[test]
    fn draft_attachment_refuses_an_unmapped_media_type() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("draft-attachments");
        let (status, body) = store_draft_attachment(&root, "image/svg+xml", b"<svg/>");
        assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert_eq!(body["error"], "unsupported_media_type");
        // Nothing was created — not even the directory.
        assert!(!root.exists());
    }

    #[test]
    fn asset_names_that_could_escape_the_folder_are_refused() {
        assert!(validate_asset_name("photo.png").is_ok());
        assert!(validate_asset_name("my photo (2).png").is_ok());
        assert!(validate_asset_name("README").is_ok());
        assert!(validate_asset_name("").is_err());
        assert!(validate_asset_name("..").is_err());
        assert!(validate_asset_name(".hidden").is_err());
        assert!(validate_asset_name("../photo.png").is_err());
        assert!(validate_asset_name("sub/photo.png").is_err());
        assert!(validate_asset_name("sub\\photo.png").is_err());
        assert!(validate_asset_name("/etc/passwd").is_err());
    }

    #[test]
    fn collisions_suffix_before_the_extension() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(resolve_collision_name(dir.path(), "photo.png"), "photo.png");
        std::fs::write(dir.path().join("photo.png"), b"a").unwrap();
        assert_eq!(
            resolve_collision_name(dir.path(), "photo.png"),
            "photo-2.png"
        );
        std::fs::write(dir.path().join("photo-2.png"), b"a").unwrap();
        assert_eq!(
            resolve_collision_name(dir.path(), "photo.png"),
            "photo-3.png"
        );
    }

    #[test]
    fn collisions_on_an_extensionless_name_suffix_at_the_end() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("NOTES"), b"a").unwrap();
        assert_eq!(resolve_collision_name(dir.path(), "NOTES"), "NOTES-2");
    }

    #[test]
    fn collisions_keep_a_multi_dot_name_intact() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("archive.tar.gz"), b"a").unwrap();
        assert_eq!(
            resolve_collision_name(dir.path(), "archive.tar.gz"),
            "archive.tar-2.gz",
        );
    }

    #[test]
    fn doc_attachment_lands_in_a_sibling_assets_folder() {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("foo.md");
        std::fs::write(&doc, b"# hi").unwrap();

        let (status, body) = store_doc_attachment(&doc, "photo.png", b"PNGBYTES");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["relativePath"], "assets/photo.png");
        let path = PathBuf::from(body["path"].as_str().unwrap());
        assert_eq!(path, dir.path().join("assets").join("photo.png"));
        assert_eq!(std::fs::read(&path).unwrap(), b"PNGBYTES");

        // A second drop of the same name suffixes rather than clobbering.
        let (status, body) = store_doc_attachment(&doc, "photo.png", b"OTHER");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["relativePath"], "assets/photo-2.png");
        assert_eq!(std::fs::read(&path).unwrap(), b"PNGBYTES");
    }

    #[test]
    fn doc_attachment_refuses_a_bad_name_before_creating_anything() {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("foo.md");
        std::fs::write(&doc, b"# hi").unwrap();

        let (status, body) = store_doc_attachment(&doc, "../escape.png", b"x");
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "bad_name");
        assert!(!dir.path().join("assets").exists());
    }

    /// The bound on this route's directory-creation relaxation: a `doc` that
    /// is not an existing regular file is refused *before* any directory is
    /// created, so the route can never `mkdir -p` into an arbitrary tree.
    #[test]
    fn doc_attachment_refuses_a_nonexistent_or_directory_doc() {
        let dir = tempfile::tempdir().unwrap();

        let missing = dir.path().join("nowhere").join("foo.md");
        let (status, body) = store_doc_attachment(&missing, "photo.png", b"x");
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "not_found");
        assert!(!dir.path().join("nowhere").exists());

        let subdir = dir.path().join("adir");
        std::fs::create_dir(&subdir).unwrap();
        let (status, _) = store_doc_attachment(&subdir, "photo.png", b"x");
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(!dir.path().join("assets").exists());
    }

    #[test]
    fn draft_attach_creates_the_home_and_lands_in_assets() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("draft-docs");

        let (status, body) = store_draft_doc_attachment(&root, "card-7", "photo.png", b"PNGBYTES");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["relativePath"], "assets/photo.png");
        let path = PathBuf::from(body["path"].as_str().unwrap());
        assert_eq!(path, root.join("card-7").join("assets").join("photo.png"));
        assert_eq!(std::fs::read(&path).unwrap(), b"PNGBYTES");

        // Collision resolution is the shared behavior, not a doc-tier one.
        let (_, body) = store_draft_doc_attachment(&root, "card-7", "photo.png", b"OTHER");
        assert_eq!(body["relativePath"], "assets/photo-2.png");
        assert_eq!(std::fs::read(&path).unwrap(), b"PNGBYTES");
    }

    /// The draft id names a directory inside `data_dir()`, so it gets the same
    /// one-ordinary-component rule an asset name does. Anything else could
    /// write outside the tree this route is entitled to create in.
    #[test]
    fn draft_id_cannot_escape_the_draft_docs_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("draft-docs");

        for bad in ["..", "../elsewhere", "a/b", "", ".hidden", "/etc"] {
            let (status, body) = store_draft_doc_attachment(&root, bad, "photo.png", b"x");
            assert_eq!(
                status,
                StatusCode::BAD_REQUEST,
                "id {bad:?} should be refused"
            );
            assert_eq!(body["error"], "bad_name");
        }
        assert!(!root.exists(), "nothing should have been created");
    }

    #[test]
    fn attach_base_creates_and_reports_the_draft_home() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("draft-docs");

        let (status, body) = attach_base(&root, "card-7");
        assert_eq!(status, StatusCode::OK);
        let base = PathBuf::from(body["base"].as_str().unwrap());
        // The home itself, not its `assets/` child: the base is what a
        // relative `assets/photo.png` link resolves against.
        assert_eq!(base, root.join("card-7"));
        assert!(base.is_dir());

        let (status, body) = attach_base(&root, "../escape");
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "bad_name");
    }

    #[test]
    fn minted_paste_name_is_timestamped_and_servable() {
        // A fixed instant, so the assertion is on the shape rather than on
        // whatever second the test happened to run in.
        let at = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_770_000_000);
        let name = mint_pasted_name("image/png", at).unwrap();
        assert!(name.starts_with("pasted-"), "{name}");
        assert!(name.ends_with(".png"), "{name}");
        let stamp = name
            .trim_start_matches("pasted-")
            .trim_end_matches(".png")
            .to_string();
        assert_eq!(stamp.len(), "YYYY-MM-DD-HHMMSS".len(), "{name}");
        assert!(validate_asset_name(&name).is_ok(), "{name}");

        // Reformatting the same instant the same way agrees — the name is a
        // function of the clock the caller passed, not of the wall clock.
        assert_eq!(mint_pasted_name("image/png", at).unwrap(), name);
        assert!(
            mint_pasted_name("image/jpeg", at)
                .unwrap()
                .ends_with(".jpg")
        );
        // An unmapped type has no name to mint; the caller answers 415.
        assert_eq!(mint_pasted_name("application/zip", at), None);
        assert_eq!(mint_pasted_name("", at), None);
    }

    // ── Save-As migration ───────────────────────────────────────────────────

    /// A draft home holding `names`, and a saved document to migrate it into.
    /// Returns `(draft-docs root, doc path)`.
    fn migration_fixture(
        dir: &Path,
        draft_id: &str,
        names: &[(&str, &[u8])],
    ) -> (PathBuf, PathBuf) {
        let root = dir.join("draft-docs");
        let assets = draft_doc_assets_dir(&root, draft_id).unwrap();
        std::fs::create_dir_all(&assets).unwrap();
        for (name, bytes) in names {
            std::fs::write(assets.join(name), bytes).unwrap();
        }
        let doc_dir = dir.join("saved");
        std::fs::create_dir_all(&doc_dir).unwrap();
        let doc = doc_dir.join("notes.md");
        std::fs::write(&doc, b"# notes").unwrap();
        (root, doc)
    }

    #[test]
    fn migration_moves_every_asset_and_reports_no_renames() {
        let dir = tempfile::tempdir().unwrap();
        let (root, doc) = migration_fixture(
            dir.path(),
            "card-1",
            &[("a.png", b"AAA"), ("b.png", b"BBB"), ("c.pdf", b"CCC")],
        );

        let (status, body) = migrate_draft_assets(&root, "card-1", &doc);
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["renames"], json!([]));

        let dest = doc.parent().unwrap().join("assets");
        assert_eq!(std::fs::read(dest.join("a.png")).unwrap(), b"AAA");
        assert_eq!(std::fs::read(dest.join("b.png")).unwrap(), b"BBB");
        assert_eq!(std::fs::read(dest.join("c.pdf")).unwrap(), b"CCC");
        // The home is gone, so nothing is left for the sweep to reclaim.
        assert!(!root.join("card-1").exists());
    }

    #[test]
    fn migration_resolves_collisions_and_reports_them() {
        let dir = tempfile::tempdir().unwrap();
        let (root, doc) = migration_fixture(dir.path(), "card-1", &[("photo.png", b"MINE")]);
        let dest = doc.parent().unwrap().join("assets");
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(dest.join("photo.png"), b"THEIRS").unwrap();

        let (status, body) = migrate_draft_assets(&root, "card-1", &doc);
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body["renames"],
            json!([{ "from": "assets/photo.png", "to": "assets/photo-2.png" }]),
        );
        // The document that was already there keeps its own asset untouched.
        assert_eq!(std::fs::read(dest.join("photo.png")).unwrap(), b"THEIRS");
        assert_eq!(std::fs::read(dest.join("photo-2.png")).unwrap(), b"MINE");
    }

    /// Copy-then-verify-then-remove means a failure can leave a file in both
    /// places, never in neither. An unwritable destination is the cheapest way
    /// to make the failure happen at the first step.
    #[test]
    fn migration_leaves_the_source_intact_when_the_destination_is_unwritable() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let (root, doc) = migration_fixture(dir.path(), "card-1", &[("a.png", b"AAA")]);
        let doc_dir = doc.parent().unwrap().to_path_buf();
        let mut perms = std::fs::metadata(&doc_dir).unwrap().permissions();
        perms.set_mode(0o500);
        std::fs::set_permissions(&doc_dir, perms).unwrap();

        let (status, body) = migrate_draft_assets(&root, "card-1", &doc);

        // Restore before asserting, so a failed assertion cannot leave an
        // undeletable temp dir behind.
        let mut perms = std::fs::metadata(&doc_dir).unwrap().permissions();
        perms.set_mode(0o700);
        std::fs::set_permissions(&doc_dir, perms).unwrap();

        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body["renames"], json!([]));
        let source = draft_doc_assets_dir(&root, "card-1").unwrap();
        assert_eq!(std::fs::read(source.join("a.png")).unwrap(), b"AAA");
    }

    #[test]
    fn migration_of_an_empty_or_absent_draft_home_is_a_no_op_success() {
        let dir = tempfile::tempdir().unwrap();
        let (root, doc) = migration_fixture(dir.path(), "card-1", &[]);

        // Empty `assets/`.
        let (status, body) = migrate_draft_assets(&root, "card-1", &doc);
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["renames"], json!([]));

        // And a home that never existed at all — the ordinary case for a
        // buffer saved without ever attaching anything.
        let (status, body) = migrate_draft_assets(&root, "card-never", &doc);
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["renames"], json!([]));
        // Nothing was created beside the document for a no-op.
        assert!(!doc.parent().unwrap().join("assets").exists());
    }

    #[test]
    fn migration_refuses_a_bad_draft_id_or_a_missing_document() {
        let dir = tempfile::tempdir().unwrap();
        let (root, doc) = migration_fixture(dir.path(), "card-1", &[("a.png", b"AAA")]);

        let (status, body) = migrate_draft_assets(&root, "../escape", &doc);
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "bad_name");

        let (status, _) =
            migrate_draft_assets(&root, "card-1", &dir.path().join("nowhere").join("x.md"));
        assert_eq!(status, StatusCode::NOT_FOUND);
        // The source survives a refusal.
        let source = draft_doc_assets_dir(&root, "card-1").unwrap();
        assert_eq!(std::fs::read(source.join("a.png")).unwrap(), b"AAA");
    }
}
