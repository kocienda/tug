//! Tripwires HTTP routes: the list, one tripwire's trip log, and the card's small
//! knobs (Spec S06).
//!
//! HTTP rather than a feed for the same reason the prompt-history corpus is:
//! the card asks a question and wants that question's answer, and a broadcast
//! would make every reader carry echo discipline for a surface only one card
//! looks at. The live half — a tripwire that just settled — arrives on OVERVIEW
//! already, and the card re-asks on it.
//!
//! Every handler opens its own connection to `tripwires.db` and closes it
//! again. That is not a shortcut around a pool: the ledger is machine-global
//! and multi-writer by design, with no writer lock and every write a single
//! statement, so a held connection would buy nothing and would outlive the
//! request it was opened for.
//!
//! Authoring stays on the CLI [B15]. What this surface writes is the three
//! things a reader of the card would reach for without leaving it — paused,
//! model, post policy — and nothing that could make a tripwire unrunnable.

use std::net::SocketAddr;
use std::path::PathBuf;

use axum::body::Bytes;
use axum::extract::{ConnectInfo, Path, Query};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{Value, json};
use tracing::warn;
use tugutil_core::tripwire_ledger::{
    self as ledger, PostPolicy, Trip, TripStatus, Tripwire, TripwireEdit, TripwireLedgerError,
};

/// Trips a tripwire's log returns when the caller names no limit.
const DEFAULT_TRIP_LIMIT: i64 = 50;
/// Ceiling on a caller-named limit. The log is a window, not the table.
const MAX_TRIP_LIMIT: i64 = 500;
/// How far back the list projection looks for a tripwire's live state. The card
/// shows "running now" and "has staged work", both of which are recent facts;
/// a tripwire whose last twenty trips are all settled is not running.
const PROJECTION_DEPTH: i64 = 20;

/// Where `tripwires.db` lives. Resolved per request rather than injected: the
/// resolution is an env read and a path join, and reading it here is what lets
/// `TUG_TRIPWIRES_DB` isolate a test instance without a second wiring path
/// that only tests take.
fn db_path() -> PathBuf {
    tugcore::instance::tripwires_db_path()
}

#[derive(Debug, Deserialize)]
pub(crate) struct TripsQuery {
    limit: Option<i64>,
}

/// The card's three knobs. Every field optional; a body naming none is a
/// no-op that still answers with the tripwire, so the control that sent it can
/// settle on what the ledger holds rather than on what it hoped.
#[derive(Debug, Deserialize)]
pub(crate) struct KnobsBody {
    paused: Option<bool>,
    /// `Some(None)` clears the model back to the account default; absent
    /// leaves it alone. The two are different requests and JSON can say so.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<Option<String>>,
    post: Option<String>,
}

/// One tripwire as the card reads it: the row, plus the three facts about it that
/// are not in the row at all.
fn project(conn: &Connection, tripwire: &Tripwire) -> Value {
    let trips = ledger::trips_for_tripwire(conn, tripwire.id, PROJECTION_DEPTH).unwrap_or_default();
    let running = trips
        .iter()
        .any(|t| t.status == TripStatus::Running.as_str());
    // Staged work is what the card exists to surface: a dash sitting on the
    // machine that somebody has to decide about. It counts only while the dash
    // is still there, because a dash that was joined or discarded is not work
    // waiting on anybody.
    let staged = trips
        .iter()
        .find(|t| t.outcome.as_deref() == Some("staged") && t.dash.is_some())
        .filter(|t| dash_present(tripwire, t));
    let last = trips.first();
    json!({
        "name": tripwire.name,
        "trigger": tripwire.trigger,
        "scope": tripwire.scope,
        "probe": tripwire.probe,
        "brief": tripwire.brief,
        "model": tripwire.model,
        "tier": tripwire.resolved_tier().as_str(),
        "permission_mode": tripwire.permission_mode,
        "post": tripwire.post,
        "paused": tripwire.paused,
        "cooldown_secs": tripwire.cooldown_secs,
        "running": running,
        "staged_dash": staged.and_then(|t| t.dash.clone()),
        "last_trip": last.map(|t| json!({
            "at_ms": t.at_ms,
            "status": t.status,
            "interest": t.interest,
            "outcome": t.outcome,
            "headline": t.headline,
        })),
    })
}

/// Whether the dash a settled trip staged is still on disk.
///
/// A tripwire with no scope never staged anything, so it never has one to look
/// for; an unreadable checkout answers "no dash" rather than failing the whole
/// list, because one missing repository must not blank the card.
fn dash_present(tripwire: &Tripwire, trip: &Trip) -> bool {
    let (Some(scope), Some(dash)) = (tripwire.scope.as_deref(), trip.dash.as_deref()) else {
        return false;
    };
    tugdash_core::ops::dash_exists_in(std::path::Path::new(scope), dash)
}

fn list_tripwires(db_path: &std::path::Path) -> (StatusCode, Value) {
    let conn = match ledger::open_ledger(db_path) {
        Ok(conn) => conn,
        Err(e) => return ledger_error("list", e),
    };
    match ledger::list(&conn) {
        Ok(tripwires) => {
            let projected: Vec<Value> = tripwires.iter().map(|w| project(&conn, w)).collect();
            (StatusCode::OK, json!({ "tripwires": projected }))
        }
        Err(e) => ledger_error("list", e),
    }
}

fn tripwire_trips(
    db_path: &std::path::Path,
    name: &str,
    limit: Option<i64>,
) -> (StatusCode, Value) {
    let conn = match ledger::open_ledger(db_path) {
        Ok(conn) => conn,
        Err(e) => return ledger_error("trips", e),
    };
    let tripwire = match ledger::get(&conn, name) {
        Ok(Some(tripwire)) => tripwire,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                json!({ "error": "no_such_tripwire" }),
            );
        }
        Err(e) => return ledger_error("trips", e),
    };
    let limit = limit.unwrap_or(DEFAULT_TRIP_LIMIT).clamp(1, MAX_TRIP_LIMIT);
    match ledger::trips_for_tripwire(&conn, tripwire.id, limit) {
        Ok(trips) => (
            StatusCode::OK,
            json!({ "name": tripwire.name, "trips": trips }),
        ),
        Err(e) => ledger_error("trips", e),
    }
}

fn set_knobs(db_path: &std::path::Path, name: &str, body: KnobsBody) -> (StatusCode, Value) {
    let conn = match ledger::open_ledger(db_path) {
        Ok(conn) => conn,
        Err(e) => return ledger_error("knobs", e),
    };
    if ledger::get(&conn, name).ok().flatten().is_none() {
        return (
            StatusCode::NOT_FOUND,
            json!({ "error": "no_such_tripwire" }),
        );
    }
    if let Some(paused) = body.paused
        && let Err(e) = ledger::set_paused(&conn, name, paused)
    {
        return ledger_error("knobs", e);
    }
    let post = match body.post.as_deref().map(PostPolicy::parse) {
        // A spelling this build does not know is a refusal rather than a
        // silent fallback to `auto`: writing a policy the caller did not ask
        // for is worse than telling them the word was wrong.
        Some(None) => return (StatusCode::BAD_REQUEST, json!({ "error": "bad_post" })),
        Some(Some(policy)) => Some(policy),
        None => None,
    };
    if body.model.is_some() || post.is_some() {
        let edit = TripwireEdit {
            model: body.model,
            post,
            ..Default::default()
        };
        if let Err(e) = ledger::update(&conn, name, &edit) {
            return ledger_error("knobs", e);
        }
    }
    match ledger::get(&conn, name) {
        Ok(Some(tripwire)) => (
            StatusCode::OK,
            json!({ "tripwire": project(&conn, &tripwire) }),
        ),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            json!({ "error": "no_such_tripwire" }),
        ),
        Err(e) => ledger_error("knobs", e),
    }
}

fn ledger_error(route: &str, err: TripwireLedgerError) -> (StatusCode, Value) {
    warn!(error = %err, "tripwires: {route} failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({ "error": "internal" }),
    )
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

/// `GET /api/tripwires`. Restricted to loopback.
pub(crate) async fn get_tripwires(ConnectInfo(addr): ConnectInfo<SocketAddr>) -> Response {
    if let Some(denied) = deny_non_loopback(&addr, "get_tripwires") {
        return denied;
    }
    finish(tokio::task::spawn_blocking(move || list_tripwires(&db_path())).await)
}

/// `GET /api/tripwires/{name}/trips`. Restricted to loopback.
pub(crate) async fn get_tripwire_trips(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(name): Path<String>,
    Query(query): Query<TripsQuery>,
) -> Response {
    if let Some(denied) = deny_non_loopback(&addr, "get_tripwire_trips") {
        return denied;
    }
    finish(
        tokio::task::spawn_blocking(move || tripwire_trips(&db_path(), &name, query.limit)).await,
    )
}

/// `POST /api/tripwires/{name}`. Restricted to loopback.
pub(crate) async fn post_tripwire(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(name): Path<String>,
    bytes: Bytes,
) -> Response {
    if let Some(denied) = deny_non_loopback(&addr, "post_tripwire") {
        return denied;
    }
    let body: KnobsBody = match serde_json::from_slice(&bytes) {
        Ok(body) => body,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(json!({ "error": "bad_request" })),
            )
                .into_response();
        }
    };
    finish(tokio::task::spawn_blocking(move || set_knobs(&db_path(), &name, body)).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tugutil_core::tripwire_ledger::NewTripwire;

    fn scratch() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tripwires.db");
        ledger::open_ledger(&path).unwrap();
        (dir, path)
    }

    fn lay(path: &std::path::Path, name: &str) {
        let conn = ledger::open_ledger(path).unwrap();
        ledger::lay(
            &conn,
            &NewTripwire::new(name, r#"{"commit":{}}"#, "report anything that looks wrong"),
            1,
        )
        .unwrap();
    }

    #[test]
    fn the_list_carries_the_row_and_the_facts_that_are_not_in_it() {
        let (_dir, path) = scratch();
        lay(&path, "ci");
        let (status, body) = list_tripwires(&path);
        assert_eq!(status, StatusCode::OK);
        let tripwire = &body["tripwires"][0];
        assert_eq!(tripwire["name"], "ci");
        assert_eq!(tripwire["tier"], "verdict");
        assert_eq!(tripwire["paused"], false);
        assert_eq!(tripwire["running"], false);
        assert!(tripwire["staged_dash"].is_null());
        assert!(
            tripwire["last_trip"].is_null(),
            "a tripwire that never fired has no last trip rather than an empty one"
        );
    }

    /// A running trip is what the card's live indicator reads, and it is a
    /// projection over the trip log rather than a column, so it cannot drift
    /// from the log the detail level shows.
    #[test]
    fn a_running_trip_shows_on_the_tripwire_it_is_running_for() {
        let (_dir, path) = scratch();
        lay(&path, "ci");
        lay(&path, "other");
        let conn = ledger::open_ledger(&path).unwrap();
        let tripwire = ledger::get(&conn, "ci").unwrap().unwrap();
        let ledger::Claim::Claimed { trip_id } =
            ledger::claim_trip(&conn, tripwire.id, "abc", 10, "inst", None).unwrap()
        else {
            panic!("the claim is uncontested");
        };
        ledger::record_run(&conn, trip_id, None, None).unwrap();

        let (_, body) = list_tripwires(&path);
        let tripwires = body["tripwires"].as_array().unwrap();
        assert_eq!(tripwires[0]["running"], true);
        assert_eq!(tripwires[0]["last_trip"]["status"], "running");
        assert_eq!(tripwires[1]["running"], false, "and only that tripwire");
    }

    #[test]
    fn the_trip_log_reads_newest_first_and_refuses_an_unknown_tripwire() {
        let (_dir, path) = scratch();
        lay(&path, "ci");
        let conn = ledger::open_ledger(&path).unwrap();
        let tripwire = ledger::get(&conn, "ci").unwrap().unwrap();
        for (i, key) in ["one", "two"].iter().enumerate() {
            ledger::claim_trip(&conn, tripwire.id, key, 10 + i as i64, "inst", None).unwrap();
        }

        let (status, body) = tripwire_trips(&path, "ci", None);
        assert_eq!(status, StatusCode::OK);
        let trips = body["trips"].as_array().unwrap();
        assert_eq!(trips.len(), 2);
        assert_eq!(trips[0]["event_key"], "two");

        let (status, body) = tripwire_trips(&path, "nobody", None);
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "no_such_tripwire");
    }

    /// The knobs answer with the tripwire as the ledger now holds it, which is
    /// what lets the control settle on a fact rather than on its own optimism.
    #[test]
    fn the_knobs_move_what_they_name_and_answer_with_the_row() {
        let (_dir, path) = scratch();
        lay(&path, "ci");

        let (status, body) = set_knobs(
            &path,
            "ci",
            KnobsBody {
                paused: Some(true),
                model: Some(Some("claude-opus-5".to_string())),
                post: Some("never".to_string()),
            },
        );
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["tripwire"]["paused"], true);
        assert_eq!(body["tripwire"]["model"], "claude-opus-5");
        assert_eq!(body["tripwire"]["post"], "never");

        // Absent fields move nothing — the same body twice must not be the
        // second one undoing the first.
        let (_, body) = set_knobs(
            &path,
            "ci",
            KnobsBody {
                paused: None,
                model: None,
                post: None,
            },
        );
        assert_eq!(body["tripwire"]["paused"], true);
        assert_eq!(body["tripwire"]["model"], "claude-opus-5");

        // And a clear is a different request from an absence.
        let (_, body) = set_knobs(
            &path,
            "ci",
            KnobsBody {
                paused: Some(false),
                model: Some(None),
                post: None,
            },
        );
        assert_eq!(body["tripwire"]["paused"], false);
        assert!(body["tripwire"]["model"].is_null());
    }

    #[test]
    fn a_post_policy_this_build_cannot_read_is_refused_rather_than_guessed() {
        let (_dir, path) = scratch();
        lay(&path, "ci");
        let (status, body) = set_knobs(
            &path,
            "ci",
            KnobsBody {
                paused: None,
                model: None,
                post: Some("sometimes".to_string()),
            },
        );
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "bad_post");

        let conn = ledger::open_ledger(&path).unwrap();
        assert_eq!(
            ledger::get(&conn, "ci").unwrap().unwrap().post,
            "auto",
            "a refused knob moves nothing"
        );
    }
}
