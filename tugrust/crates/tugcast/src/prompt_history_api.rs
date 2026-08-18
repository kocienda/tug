//! Prompt-history HTTP routes: append, page, and atom-path completion.
//!
//! `POST /api/prompt-history` records one submitted prompt;
//! `GET /api/prompt-history` reads a session's corpus back a keyset page at a
//! time; `POST /api/prompt-history/atom-path` completes a row whose attachment
//! upload resolved after the prompt was already sent.
//!
//! HTTP rather than a CONTROL op because the CONTROL bus is an uncorrelated
//! broadcast: a page frame applied twice prepends the same rows twice, which
//! forces every reader to carry cursor-echo discipline. Request/response
//! correlates for free, and the composer needs the correlation anyway — an
//! append's answer is the ledger id.
//!
//! Loopback-gated like every other local-only route here. The handlers are thin
//! on purpose: each defers to a synchronous function over the ledger, which is
//! what the unit tests below drive, while `integration_tests` drives the same
//! functions through the real router to pin the status codes and JSON shapes.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Extension;
use axum::body::Bytes;
use axum::extract::{ConnectInfo, Query};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use tracing::warn;

use crate::fs_read::fs_error;
use crate::prompt_ledger::{NewPromptEntry, PromptLedger};

/// Rows per page when the caller names no limit — the composer's initial window.
pub(crate) const DEFAULT_PAGE_LIMIT: usize = 200;
/// Ceiling on a caller-named limit. A page is a window, not a corpus dump.
pub(crate) const MAX_PAGE_LIMIT: usize = 500;

/// Body of `POST /api/prompt-history`. Snake_case throughout, matching the row
/// shape the page read returns, so the deck holds one spelling of a prompt.
#[derive(Debug, Deserialize)]
pub(crate) struct AppendBody {
    session_id: String,
    route: String,
    text: String,
    /// The reference-only atom array. Never carries image bytes: a thumbnail is
    /// derived from the stored original, and persisting it here is what made the
    /// previous storage home unusable.
    atoms: Value,
    project_path: String,
    submitted_at_ms: i64,
    client_entry_id: String,
}

/// Query string of `GET /api/prompt-history`.
#[derive(Debug, Deserialize)]
pub(crate) struct PageQuery {
    session: String,
    before: Option<i64>,
    limit: Option<usize>,
}

/// Body of `POST /api/prompt-history/atom-path`.
#[derive(Debug, Deserialize)]
pub(crate) struct AtomPathBody {
    client_entry_id: String,
    atom_id: String,
    path: String,
}

/// A caller-named limit, or the default, brought inside the served range.
pub(crate) fn clamp_limit(limit: Option<usize>) -> usize {
    match limit {
        Some(n) => n.clamp(1, MAX_PAGE_LIMIT),
        None => DEFAULT_PAGE_LIMIT,
    }
}

/// Append one prompt and answer with its ledger id. Synchronous so the seam is
/// unit-testable; the handler runs it under `spawn_blocking`.
///
/// A duplicate `client_entry_id` is a success carrying the existing id, not a
/// conflict: the client retries an append it could not confirm, and the whole
/// point of the id is that the retry is harmless.
fn append_prompt(ledger: &PromptLedger, body: AppendBody) -> (StatusCode, Value) {
    if !body.atoms.is_array() {
        return fs_error(StatusCode::BAD_REQUEST, "bad_request");
    }
    let entry = NewPromptEntry {
        session_id: body.session_id,
        route: body.route,
        text: body.text,
        atoms_json: body.atoms.to_string(),
        project_path: body.project_path,
        submitted_at_ms: body.submitted_at_ms,
        client_entry_id: body.client_entry_id,
    };
    match ledger.append(&entry) {
        Ok(id) => (StatusCode::OK, json!({ "id": id })),
        Err(err) => {
            warn!(error = %err, "prompt-history: append failed");
            fs_error(StatusCode::INTERNAL_SERVER_ERROR, "internal")
        }
    }
}

/// One keyset page of a session's prompts, oldest-first, with `has_more` saying
/// whether older rows remain and `before` echoed back for the caller's cursor.
fn page_prompts(ledger: &PromptLedger, query: PageQuery) -> (StatusCode, Value) {
    let limit = clamp_limit(query.limit);
    match ledger.list_page(&query.session, query.before, limit) {
        Ok((entries, has_more)) => (
            StatusCode::OK,
            json!({
                "entries": entries,
                "has_more": has_more,
                "before": query.before,
            }),
        ),
        Err(err) => {
            warn!(error = %err, "prompt-history: page read failed");
            fs_error(StatusCode::INTERNAL_SERVER_ERROR, "internal")
        }
    }
}

/// Set the stored path on one atom of one already-recorded prompt.
///
/// An entry or atom that is not there answers `200 {"ok": false}` rather than
/// 404: the backfill races a card closing, and a lost race is a known bound of
/// the feature rather than a failed request the client should retry.
fn patch_atom_path(ledger: &PromptLedger, body: AtomPathBody) -> (StatusCode, Value) {
    match ledger.set_atom_path(&body.client_entry_id, &body.atom_id, &body.path) {
        Ok(patched) => (StatusCode::OK, json!({ "ok": patched })),
        Err(err) => {
            warn!(error = %err, "prompt-history: atom-path patch failed");
            fs_error(StatusCode::INTERNAL_SERVER_ERROR, "internal")
        }
    }
}

/// Refuse anything that did not arrive over loopback, in the shape every other
/// local-only route here refuses it.
fn deny_non_loopback(addr: &SocketAddr, route: &str) -> Option<Response> {
    if addr.ip().is_loopback() {
        return None;
    }
    warn!("{route}: rejected non-loopback connection from {addr}");
    Some(
        (
            StatusCode::FORBIDDEN,
            axum::Json(json!({ "error": "denied" })),
        )
            .into_response(),
    )
}

/// The body is parsed here rather than by a `Json<T>` extractor so a malformed
/// request is a plain 400 with this module's error shape.
///
/// The error is boxed because a `Response` is large enough that carrying it
/// inline makes every `Ok` of this function pay for the failure path
/// (`clippy::result_large_err`).
fn parse_body<T: for<'de> Deserialize<'de>>(bytes: &Bytes) -> Result<T, Box<Response>> {
    serde_json::from_slice(bytes).map_err(|_| {
        let (status, body) = fs_error(StatusCode::BAD_REQUEST, "bad_request");
        Box::new((status, axum::Json(body)).into_response())
    })
}

fn finish(result: Result<(StatusCode, Value), tokio::task::JoinError>) -> Response {
    match result {
        Ok((status, body)) => (status, axum::Json(body)).into_response(),
        Err(_join_err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "error": "internal" })),
        )
            .into_response(),
    }
}

/// Handle `POST /api/prompt-history`. Restricted to loopback.
pub(crate) async fn post_prompt_history(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Extension(ledger): Extension<Arc<PromptLedger>>,
    bytes: Bytes,
) -> Response {
    if let Some(denied) = deny_non_loopback(&addr, "post_prompt_history") {
        return denied;
    }
    let body: AppendBody = match parse_body(&bytes) {
        Ok(body) => body,
        Err(response) => return *response,
    };
    finish(tokio::task::spawn_blocking(move || append_prompt(&ledger, body)).await)
}

/// Handle `GET /api/prompt-history`. Restricted to loopback.
pub(crate) async fn get_prompt_history(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Extension(ledger): Extension<Arc<PromptLedger>>,
    Query(query): Query<PageQuery>,
) -> Response {
    if let Some(denied) = deny_non_loopback(&addr, "get_prompt_history") {
        return denied;
    }
    finish(tokio::task::spawn_blocking(move || page_prompts(&ledger, query)).await)
}

/// Handle `POST /api/prompt-history/atom-path`. Restricted to loopback.
pub(crate) async fn post_prompt_history_atom_path(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Extension(ledger): Extension<Arc<PromptLedger>>,
    bytes: Bytes,
) -> Response {
    if let Some(denied) = deny_non_loopback(&addr, "post_prompt_history_atom_path") {
        return denied;
    }
    let body: AtomPathBody = match parse_body(&bytes) {
        Ok(body) => body,
        Err(response) => return *response,
    };
    finish(tokio::task::spawn_blocking(move || patch_atom_path(&ledger, body)).await)
}

// ── Unit tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn ledger() -> PromptLedger {
        PromptLedger::open_in_memory().unwrap()
    }

    fn append_body(n: usize) -> AppendBody {
        serde_json::from_value(json!({
            "session_id": "s1",
            "route": "❯",
            "text": format!("prompt {n}"),
            "atoms": [],
            "project_path": "",
            "submitted_at_ms": 1_700_000_000_000i64 + n as i64,
            "client_entry_id": format!("s1-{n}"),
        }))
        .unwrap()
    }

    #[test]
    fn append_maps_the_body_onto_a_row_and_answers_with_its_id() {
        let ledger = ledger();
        let (status, body) = append_prompt(&ledger, append_body(1));
        assert_eq!(status, StatusCode::OK);
        let id = body["id"].as_i64().unwrap();

        let (rows, _) = ledger.list_page("s1", None, 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, id);
        assert_eq!(rows[0].text, "prompt 1");
        assert_eq!(rows[0].route, "❯");
        assert_eq!(rows[0].client_entry_id, "s1-1");
    }

    #[test]
    fn a_duplicate_append_echoes_the_original_id_rather_than_conflicting() {
        let ledger = ledger();
        let (_, first) = append_prompt(&ledger, append_body(1));
        let (status, second) = append_prompt(&ledger, append_body(1));
        assert_eq!(status, StatusCode::OK);
        assert_eq!(first["id"], second["id"]);
        let (rows, _) = ledger.list_page("s1", None, 10).unwrap();
        assert_eq!(rows.len(), 1, "the retry inserted nothing");
    }

    #[test]
    fn an_atoms_field_that_is_not_an_array_is_a_bad_request() {
        let ledger = ledger();
        let body: AppendBody = serde_json::from_value(json!({
            "session_id": "s1",
            "route": "❯",
            "text": "hi",
            "atoms": {"not": "an array"},
            "project_path": "",
            "submitted_at_ms": 1i64,
            "client_entry_id": "s1-1",
        }))
        .unwrap();
        let (status, err) = append_prompt(&ledger, body);
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(err["error"], "bad_request");
        let (rows, _) = ledger.list_page("s1", None, 10).unwrap();
        assert!(rows.is_empty());
    }

    #[test]
    fn a_malformed_body_is_rejected_before_the_ledger_is_touched() {
        assert!(parse_body::<AppendBody>(&Bytes::from_static(b"{not json")).is_err());
        // Valid JSON of the wrong shape is refused just as firmly — a prompt
        // with no session has nowhere to be recalled from.
        assert!(parse_body::<AppendBody>(&Bytes::from_static(b"{\"text\":\"hi\"}")).is_err());
    }

    #[test]
    fn a_page_read_maps_the_cursor_and_reports_more() {
        let ledger = ledger();
        for n in 1..=5 {
            append_prompt(&ledger, append_body(n));
        }

        let (status, body) = page_prompts(
            &ledger,
            serde_json::from_value(json!({"session": "s1", "limit": 2})).unwrap(),
        );
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["has_more"], true);
        assert!(body["before"].is_null(), "no cursor was named");
        let entries = body["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["text"], "prompt 4");
        assert_eq!(entries[1]["text"], "prompt 5");

        // Walking backward from the page's oldest row excludes it and echoes
        // the cursor the caller sent.
        let cursor = entries[0]["id"].as_i64().unwrap();
        let (_, older) = page_prompts(
            &ledger,
            serde_json::from_value(json!({"session": "s1", "before": cursor, "limit": 2})).unwrap(),
        );
        assert_eq!(older["before"], cursor);
        let entries = older["entries"].as_array().unwrap();
        assert_eq!(entries[0]["text"], "prompt 2");
        assert_eq!(entries[1]["text"], "prompt 3");
    }

    #[test]
    fn a_page_read_of_an_unknown_session_is_an_empty_page_not_an_error() {
        let ledger = ledger();
        let (status, body) = page_prompts(
            &ledger,
            serde_json::from_value(json!({"session": "never-was"})).unwrap(),
        );
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["entries"], json!([]));
        assert_eq!(body["has_more"], false);
    }

    #[test]
    fn limits_are_clamped_into_the_served_range() {
        assert_eq!(clamp_limit(None), DEFAULT_PAGE_LIMIT);
        assert_eq!(clamp_limit(Some(50)), 50);
        assert_eq!(clamp_limit(Some(0)), 1);
        assert_eq!(clamp_limit(Some(50_000)), MAX_PAGE_LIMIT);
    }

    #[test]
    fn an_out_of_range_limit_still_serves_a_page() {
        let ledger = ledger();
        for n in 1..=3 {
            append_prompt(&ledger, append_body(n));
        }
        let (status, body) = page_prompts(
            &ledger,
            serde_json::from_value(json!({"session": "s1", "limit": 0})).unwrap(),
        );
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["entries"].as_array().unwrap().len(), 1);
        assert_eq!(body["has_more"], true);
    }

    #[test]
    fn an_atom_path_patch_reports_whether_it_landed() {
        let ledger = ledger();
        let body: AppendBody = serde_json::from_value(json!({
            "session_id": "s1",
            "route": "❯",
            "text": "look at this",
            "atoms": [{"id": "atom-a", "position": 0, "type": "image"}],
            "project_path": "",
            "submitted_at_ms": 1i64,
            "client_entry_id": "s1-1",
        }))
        .unwrap();
        append_prompt(&ledger, body);

        let patch: AtomPathBody = serde_json::from_value(json!({
            "client_entry_id": "s1-1",
            "atom_id": "atom-a",
            "path": "/tmp/draft/uuid.png",
        }))
        .unwrap();
        let (status, answer) = patch_atom_path(&ledger, patch);
        assert_eq!(status, StatusCode::OK);
        assert_eq!(answer["ok"], true);

        let (rows, _) = ledger.list_page("s1", None, 10).unwrap();
        assert_eq!(rows[0].atoms[0]["path"], "/tmp/draft/uuid.png");

        // A patch for an atom that is not there is a settled `false`, not an
        // error the client should retry.
        let missing: AtomPathBody = serde_json::from_value(json!({
            "client_entry_id": "s1-1",
            "atom_id": "atom-z",
            "path": "/tmp/draft/other.png",
        }))
        .unwrap();
        let (status, answer) = patch_atom_path(&ledger, missing);
        assert_eq!(status, StatusCode::OK);
        assert_eq!(answer["ok"], false);
    }
}
