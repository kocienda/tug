//! HTTP handlers for the `/api/permissions` endpoints.
//!
//! Read and mutate Claude Code's tool-permission **rules** — the
//! `permissions: { allow, ask, deny, additionalDirectories }` object — across
//! the three writable settings scopes:
//!
//! | Scope     | File                                |
//! |-----------|-------------------------------------|
//! | `user`    | `$HOME/.claude/settings.json`       |
//! | `project` | `<cwd>/.claude/settings.json`       |
//! | `local`   | `<cwd>/.claude/settings.local.json` |
//!
//! `GET /api/permissions?cwd=<abs>` returns each scope's four rule buckets so
//! the session-card editor can present the merged, scope-labeled union.
//! `POST /api/permissions/rule` adds or removes a single rule string in one
//! scope's bucket, preserving every other key in the file. Claude Code watches
//! these files and reloads `permissions` live, so a write takes effect without
//! a respawn (captured in `arc/transport-exploration.md`).
//!
//! Like the other `/api` handlers these are restricted to loopback
//! connections. `cwd` is supplied by the caller — the session card reads it from
//! the trusted session metadata — and must be absolute; handlers only ever
//! touch `.claude/settings*.json` beneath `cwd` (or `$HOME`).

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use axum::body::Bytes;
use axum::extract::{ConnectInfo, Query};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tracing::warn;

/// The four rule buckets in a `permissions` object, in display order. The
/// first three are tool-matcher rule lists; `additionalDirectories` is the
/// `Workspace` tab's extra read/edit roots.
const BUCKET_KEYS: [&str; 4] = ["allow", "ask", "deny", "additionalDirectories"];

/// Reject a rule longer than this many bytes — a guard against a runaway or
/// malformed payload bloating a settings file. Real matcher patterns are far
/// shorter (the longest in practice is a fully-qualified `Bash(/abs/path:*)`).
const MAX_RULE_LEN: usize = 4096;

/// A writable settings scope. Deserialized from the lowercase tab/scope name
/// the session card sends.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Scope {
    User,
    Project,
    Local,
}

/// A rule bucket within the `permissions` object. Deserialized from the
/// camelCase JSON key so the wire value is the literal settings.json key.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Bucket {
    Allow,
    Ask,
    Deny,
    AdditionalDirectories,
}

impl Bucket {
    /// The literal `permissions` object key this bucket writes to.
    fn key(self) -> &'static str {
        match self {
            Bucket::Allow => "allow",
            Bucket::Ask => "ask",
            Bucket::Deny => "deny",
            Bucket::AdditionalDirectories => "additionalDirectories",
        }
    }
}

/// Whether a mutation adds or removes the rule.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Op {
    Add,
    Remove,
}

// ── Path resolution ─────────────────────────────────────────────────────────

/// Resolve the settings file for `scope`. User scope is always under `$HOME`;
/// project and local scopes are under the session's `cwd`.
fn scope_path(scope: Scope, cwd: &Path, home: &Path) -> PathBuf {
    let claude = match scope {
        Scope::User => home.join(".claude"),
        Scope::Project | Scope::Local => cwd.join(".claude"),
    };
    match scope {
        Scope::User | Scope::Project => claude.join("settings.json"),
        Scope::Local => claude.join("settings.local.json"),
    }
}

/// Resolve `$HOME`, mirroring `main.rs`'s `dirs::home_dir()`-with-`$HOME`
/// fallback.
fn home_dir() -> Option<PathBuf> {
    dirs::home_dir().or_else(|| std::env::var_os("HOME").map(PathBuf::from))
}

// ── Read ─────────────────────────────────────────────────────────────────────

/// Read the four rule buckets from one settings file, returning an object with
/// every bucket key present (empty array when absent). A missing or unparsable
/// file yields all-empty buckets — the read is best-effort and never fails the
/// request, matching how a fresh project simply has no rules.
fn read_buckets(path: &Path) -> Value {
    let permissions = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|root| root.get("permissions").cloned())
        .unwrap_or(Value::Null);

    let mut out = Map::new();
    for key in BUCKET_KEYS {
        let entries = permissions
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        out.insert(key.to_owned(), Value::Array(entries));
    }
    Value::Object(out)
}

// ── Write ──────────────────────────────────────────────────────────────────

/// Add or remove `rule` in `bucket` of the `permissions` object in the file at
/// `path`, preserving every other key. A missing file (or empty file) starts
/// from `{}`; the parent directory is created if needed. Add is idempotent
/// (deduplicated); remove drops every matching entry and is a no-op when
/// absent. The file is rewritten pretty-printed with a trailing newline.
fn apply_mutation(path: &Path, bucket: &str, op: Op, rule: &str) -> std::io::Result<()> {
    let mut root: Value = match std::fs::read_to_string(path) {
        Ok(text) if !text.trim().is_empty() => serde_json::from_str(&text)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?,
        _ => Value::Object(Map::new()),
    };

    let obj = root.as_object_mut().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "settings root is not a JSON object",
        )
    })?;

    let permissions = obj
        .entry("permissions")
        .or_insert_with(|| Value::Object(Map::new()));
    if !permissions.is_object() {
        *permissions = Value::Object(Map::new());
    }
    let permissions = permissions
        .as_object_mut()
        .expect("permissions normalized to an object above");

    let list = permissions
        .entry(bucket)
        .or_insert_with(|| Value::Array(Vec::new()));
    if !list.is_array() {
        *list = Value::Array(Vec::new());
    }
    let list = list
        .as_array_mut()
        .expect("bucket normalized to an array above");

    match op {
        Op::Add => {
            if !list.iter().any(|v| v.as_str() == Some(rule)) {
                list.push(Value::String(rule.to_owned()));
            }
        }
        Op::Remove => {
            list.retain(|v| v.as_str() != Some(rule));
        }
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut serialized = serde_json::to_string_pretty(&root)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    serialized.push('\n');
    std::fs::write(path, serialized)
}

// ── Shared response helpers ──────────────────────────────────────────────────

/// Return a 403 for non-loopback connections, mirroring the other `/api`
/// handlers' guard. `Some(resp)` means reject; `None` means proceed.
fn check_loopback(handler: &str, addr: SocketAddr) -> Option<Response> {
    if addr.ip().is_loopback() {
        return None;
    }
    warn!("{handler}: rejected non-loopback connection from {addr}");
    Some(
        (
            StatusCode::FORBIDDEN,
            axum::Json(json!({"status": "error", "message": "forbidden"})),
        )
            .into_response(),
    )
}

fn bad_request(message: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        axum::Json(json!({"status": "error", "message": message})),
    )
        .into_response()
}

fn internal_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        axum::Json(json!({"status": "error", "message": "internal error"})),
    )
        .into_response()
}

// ── HTTP handlers ────────────────────────────────────────────────────────────

/// Query string for `GET /api/permissions` — the session's working directory.
#[derive(Debug, Deserialize)]
pub(crate) struct PermissionsQuery {
    cwd: String,
}

/// Handle `GET /api/permissions?cwd=<abs>`.
///
/// Returns `{ "cwd": <str>, "scopes": { "user": <buckets>, "project":
/// <buckets>, "local": <buckets> } }`, where each `<buckets>` is an object with
/// `allow` / `ask` / `deny` / `additionalDirectories` arrays. Restricted to
/// loopback. 400 when `cwd` is not absolute.
pub(crate) async fn get_permissions(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(query): Query<PermissionsQuery>,
) -> Response {
    if let Some(resp) = check_loopback("get_permissions", addr) {
        return resp;
    }
    let cwd = PathBuf::from(&query.cwd);
    if !cwd.is_absolute() {
        return bad_request("cwd must be an absolute path");
    }
    let home = match home_dir() {
        Some(home) => home,
        None => return internal_error(),
    };

    let cwd_string = query.cwd;
    let result = tokio::task::spawn_blocking(move || {
        json!({
            "cwd": cwd_string,
            "scopes": {
                "user": read_buckets(&scope_path(Scope::User, &cwd, &home)),
                "project": read_buckets(&scope_path(Scope::Project, &cwd, &home)),
                "local": read_buckets(&scope_path(Scope::Local, &cwd, &home)),
            }
        })
    })
    .await;

    match result {
        Ok(body) => (StatusCode::OK, axum::Json(body)).into_response(),
        Err(_join_err) => internal_error(),
    }
}

/// Request body for `POST /api/permissions/rule`.
#[derive(Debug, Deserialize)]
pub(crate) struct RuleMutation {
    cwd: String,
    scope: Scope,
    bucket: Bucket,
    op: Op,
    rule: String,
}

/// Handle `POST /api/permissions/rule`.
///
/// Adds or removes a single rule string in one scope's bucket, preserving the
/// rest of the file. Returns `{"status":"ok"}` on success. Restricted to
/// loopback. 400 on malformed body, non-absolute `cwd`, or an empty/oversized
/// rule.
pub(crate) async fn post_rule(ConnectInfo(addr): ConnectInfo<SocketAddr>, body: Bytes) -> Response {
    if let Some(resp) = check_loopback("post_rule", addr) {
        return resp;
    }
    let req: RuleMutation = match serde_json::from_slice(&body) {
        Ok(req) => req,
        Err(_) => return bad_request("invalid JSON"),
    };
    let cwd = PathBuf::from(&req.cwd);
    if !cwd.is_absolute() {
        return bad_request("cwd must be an absolute path");
    }
    let rule = req.rule.trim().to_owned();
    if rule.is_empty() {
        return bad_request("rule must not be empty");
    }
    if rule.len() > MAX_RULE_LEN {
        return bad_request("rule too long");
    }
    let home = match home_dir() {
        Some(home) => home,
        None => return internal_error(),
    };

    let path = scope_path(req.scope, &cwd, &home);
    let bucket = req.bucket.key();
    let op = req.op;
    let result =
        tokio::task::spawn_blocking(move || apply_mutation(&path, bucket, op, &rule)).await;

    match result {
        Ok(Ok(())) => (StatusCode::OK, axum::Json(json!({"status": "ok"}))).into_response(),
        Ok(Err(_io_err)) => internal_error(),
        Err(_join_err) => internal_error(),
    }
}

// ── Unit tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn read_root(path: &Path) -> Value {
        let text = std::fs::read_to_string(path).expect("read settings file");
        serde_json::from_str(&text).expect("parse settings file")
    }

    #[test]
    fn scope_path_resolves_each_scope() {
        let cwd = Path::new("/project");
        let home = Path::new("/home/user");
        assert_eq!(
            scope_path(Scope::User, cwd, home),
            PathBuf::from("/home/user/.claude/settings.json")
        );
        assert_eq!(
            scope_path(Scope::Project, cwd, home),
            PathBuf::from("/project/.claude/settings.json")
        );
        assert_eq!(
            scope_path(Scope::Local, cwd, home),
            PathBuf::from("/project/.claude/settings.local.json")
        );
    }

    #[test]
    fn read_buckets_missing_file_is_all_empty() {
        let buckets = read_buckets(Path::new("/no/such/settings.json"));
        for key in BUCKET_KEYS {
            assert_eq!(buckets.get(key).unwrap(), &json!([]), "{key} should be []");
        }
    }

    #[test]
    fn read_buckets_extracts_present_arrays() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.local.json");
        std::fs::write(
            &path,
            r#"{ "permissions": { "allow": ["Bash(ls:*)", "WebSearch"], "deny": ["Read(./.env)"] }, "spinnerTipsEnabled": false }"#,
        )
        .unwrap();
        let buckets = read_buckets(&path);
        assert_eq!(
            buckets.get("allow").unwrap(),
            &json!(["Bash(ls:*)", "WebSearch"])
        );
        assert_eq!(buckets.get("deny").unwrap(), &json!(["Read(./.env)"]));
        assert_eq!(buckets.get("ask").unwrap(), &json!([]));
        assert_eq!(buckets.get("additionalDirectories").unwrap(), &json!([]));
    }

    #[test]
    fn apply_mutation_adds_to_missing_file_and_creates_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude").join("settings.local.json");
        apply_mutation(&path, "allow", Op::Add, "Bash(ls:*)").unwrap();
        let root = read_root(&path);
        assert_eq!(root["permissions"]["allow"], json!(["Bash(ls:*)"]));
    }

    #[test]
    fn apply_mutation_add_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        apply_mutation(&path, "allow", Op::Add, "Bash(ls:*)").unwrap();
        apply_mutation(&path, "allow", Op::Add, "Bash(ls:*)").unwrap();
        let root = read_root(&path);
        assert_eq!(root["permissions"]["allow"], json!(["Bash(ls:*)"]));
    }

    #[test]
    fn apply_mutation_preserves_other_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(
            &path,
            r#"{ "theme": "dark", "permissions": { "allow": ["WebSearch"], "defaultMode": "default" } }"#,
        )
        .unwrap();
        apply_mutation(&path, "deny", Op::Add, "Bash(curl:*)").unwrap();
        let root = read_root(&path);
        // Untouched keys survive.
        assert_eq!(root["theme"], json!("dark"));
        assert_eq!(root["permissions"]["defaultMode"], json!("default"));
        assert_eq!(root["permissions"]["allow"], json!(["WebSearch"]));
        // New rule landed in its bucket.
        assert_eq!(root["permissions"]["deny"], json!(["Bash(curl:*)"]));
    }

    #[test]
    fn apply_mutation_remove_drops_match_and_is_noop_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        apply_mutation(&path, "allow", Op::Add, "Bash(ls:*)").unwrap();
        apply_mutation(&path, "allow", Op::Add, "WebSearch").unwrap();
        apply_mutation(&path, "allow", Op::Remove, "Bash(ls:*)").unwrap();
        // Removing again is a no-op, not an error.
        apply_mutation(&path, "allow", Op::Remove, "Bash(ls:*)").unwrap();
        let root = read_root(&path);
        assert_eq!(root["permissions"]["allow"], json!(["WebSearch"]));
    }

    #[test]
    fn apply_mutation_normalizes_non_array_bucket() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(
            &path,
            r#"{ "permissions": { "allow": "oops-not-an-array" } }"#,
        )
        .unwrap();
        apply_mutation(&path, "allow", Op::Add, "WebSearch").unwrap();
        let root = read_root(&path);
        assert_eq!(root["permissions"]["allow"], json!(["WebSearch"]));
    }

    #[test]
    fn apply_mutation_written_file_ends_with_newline() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        apply_mutation(&path, "allow", Op::Add, "WebSearch").unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.ends_with("}\n"), "expected trailing newline: {text:?}");
    }

    #[test]
    fn bucket_key_round_trips() {
        assert_eq!(Bucket::Allow.key(), "allow");
        assert_eq!(Bucket::Ask.key(), "ask");
        assert_eq!(Bucket::Deny.key(), "deny");
        assert_eq!(Bucket::AdditionalDirectories.key(), "additionalDirectories");
    }
}
