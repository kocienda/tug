//! Tripwires HTTP routes: the list, one tripwire's trip log, and the card's small
//! knobs (Spec S06).
//!
//! Doctrine: `tuglaws/tripwires.md` (one projection, three callers).
//!
//! HTTP rather than a feed for the same reason the prompt-history corpus is:
//! the card asks a question and wants that question's answer, and a broadcast
//! would make every reader carry echo discipline for a surface only one card
//! looks at. That holds for the trip log, which is per-tripwire and up to five
//! hundred rows, and for every write below. It does **not** hold for the
//! roster: the roster is small, always shown, and written by processes this one
//! cannot hear, so it rides the `TRIPWIRES` snapshot feed and the card asks
//! nothing for it ([P01]). What this surface owes that feed is a nudge after
//! every ledger write here — latency rather than the mechanism, since the
//! feed's own `PRAGMA data_version` probe sees the same commit anyway.
//!
//! Every handler opens its own connection to `tripwires.db` and closes it
//! again. That is not a shortcut around a pool: the ledger is machine-global
//! and multi-writer by design, with no writer lock and every write a single
//! statement, so a held connection would buy nothing and would outlive the
//! request it was opened for.
//!
//! Authoring stays on the CLI [B15]. What this surface writes is the two knobs
//! a reader of the card would reach for without leaving it — paused and model
//! — plus the two verbs the product has a caller for: fire it by hand, and
//! dismiss what it is holding. Nothing here can make a tripwire unrunnable,
//! and `resolve` stays the CLI's because its one caller is a diagnosis session
//! with a shell ([B08]).

use std::net::SocketAddr;
use std::path::PathBuf;

use axum::body::Bytes;
use axum::extract::{ConnectInfo, Path, Query};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use tracing::warn;
use tugarc_core::tripwire_dismiss::DismissRefusal;
use tugarc_core::tripwire_remove::RemoveRefusal;
use tugtool_core::tripwire_ledger::{self as ledger, TripwireEdit, TripwireLedgerError};
use tugtool_core::tripwire_roster;

/// Trips a tripwire's log returns when the caller names no limit.
const DEFAULT_TRIP_LIMIT: i64 = 50;
/// Ceiling on a caller-named limit. The log is a window, not the table.
const MAX_TRIP_LIMIT: i64 = 500;
// The projection itself lives in `tugtool_core::tripwire_roster`, with three
// callers — this surface, the `TRIPWIRES` feed, and `tugtool tripwire list`.
// `MAX_TRIP_LIMIT` above stays here because it is the HTTP window rather than
// the projection's, and `tripwire_roster::REVISION_DEPTH` may never fall below
// it: the card re-asks a log whose revision moved, and the biggest log this
// surface hands out is `MAX_TRIP_LIMIT` rows.

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

/// The card's two knobs. Every field optional; a body naming none is a
/// no-op that still answers with the tripwire, so the control that sent it can
/// settle on what the ledger holds rather than on what it hoped.
#[derive(Debug, Deserialize)]
pub(crate) struct KnobsBody {
    paused: Option<bool>,
    /// `Some(None)` clears the model back to the account default; absent
    /// leaves it alone. The two are different requests and JSON can say so.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<Option<String>>,
}

fn list_tripwires(db_path: &std::path::Path) -> (StatusCode, Value) {
    let conn = match ledger::open_ledger(db_path) {
        Ok(conn) => conn,
        Err(e) => return ledger_error("list", e),
    };
    match ledger::list(&conn) {
        Ok(tripwires) => {
            let projected: Result<Vec<_>, _> = tripwires
                .iter()
                .map(|w| tripwire_roster::row_for(&conn, w))
                .collect();
            match projected {
                Ok(rows) => (StatusCode::OK, json!({ "tripwires": rows })),
                Err(e) => ledger_error("list", e),
            }
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
    if body.model.is_some() {
        let edit = TripwireEdit {
            model: body.model,
            ..Default::default()
        };
        if let Err(e) = ledger::update(&conn, name, &edit) {
            return ledger_error("knobs", e);
        }
    }
    // The ledger moved, so the roster feed recomposes now rather than on its
    // next probe. Latency only — the probe is the mechanism.
    crate::feeds::tripwires::bump();
    match ledger::get(&conn, name) {
        Ok(Some(tripwire)) => match tripwire_roster::row_for(&conn, &tripwire) {
            Ok(row) => (StatusCode::OK, json!({ "tripwire": row })),
            Err(e) => ledger_error("knobs", e),
        },
        Ok(None) => (
            StatusCode::NOT_FOUND,
            json!({ "error": "no_such_tripwire" }),
        ),
        Err(e) => ledger_error("knobs", e),
    }
}

/// The instance label a trip claimed from this surface carries. `api:` rather
/// than the CLI's `cli:`, so the trip log says which door a hand-firing came
/// through.
fn instance_label() -> String {
    match tugcore::instance::instance_id() {
        Some(id) if !id.is_empty() => format!("api:{id}"),
        _ => "api".to_string(),
    }
}

/// Spec S03. Queues a manual trip exactly as `tugtool tripwire trip` does —
/// the two share `queue_manual_trip` — then tells this process's engine.
fn trip_tripwire(db_path: &std::path::Path, name: &str) -> (StatusCode, Value) {
    let conn = match ledger::open_ledger(db_path) {
        Ok(conn) => conn,
        Err(e) => return ledger_error("trip", e),
    };
    let tripwire = match ledger::get(&conn, name) {
        Ok(Some(tripwire)) => tripwire,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                json!({ "error": "no_such_tripwire" }),
            );
        }
        Err(e) => return ledger_error("trip", e),
    };
    let now_ms = crate::session_ledger::now_millis();
    let (trip_id, event_key) =
        match ledger::queue_manual_trip(&conn, tripwire.id, now_ms, &instance_label()) {
            Ok(queued) => queued,
            Err(e) => return ledger_error("trip", e),
        };
    // The row is the firing and the kick is only a nudge that says not to wait
    // out the engine's tick, so `served` reports which of the two happened
    // rather than gating on it.
    let served = crate::feeds::tripwire::kick(&tripwire.name);
    crate::feeds::tripwires::bump();
    (
        StatusCode::OK,
        json!({
            "tripwire": tripwire.name,
            "trip_id": trip_id,
            "event_key": event_key,
            "status": "queued",
            "served": served,
        }),
    )
}

/// Spec S04. The shared dismiss of `tugarc_core::tripwire_dismiss`, which the
/// CLI verb runs too — the settle and the arc discard are one act, and two
/// spellings of it is how the two answers drift.
fn dismiss_tripwire(db_path: &std::path::Path, name: &str) -> (StatusCode, Value) {
    let conn = match ledger::open_ledger(db_path) {
        Ok(conn) => conn,
        Err(e) => return ledger_error("dismiss", e),
    };
    let tripwire = match ledger::get(&conn, name) {
        Ok(Some(tripwire)) => tripwire,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                json!({ "error": "no_such_tripwire" }),
            );
        }
        Err(e) => return ledger_error("dismiss", e),
    };
    let now_ms = crate::session_ledger::now_millis();
    match tugarc_core::tripwire_dismiss::dismiss(&conn, &tripwire, now_ms) {
        // A discard that failed is a 200 carrying its reason, never a 500: the
        // settle is written whatever happened next, and an arc left standing is
        // the leak the verb exists to close.
        Ok(dismissed) => {
            crate::feeds::tripwires::bump();
            (
                StatusCode::OK,
                json!({
                    "tripwire": tripwire.name,
                    "trip_id": dismissed.trip_id,
                    "arc": dismissed.arc,
                    "discarded": dismissed.discarded,
                    "discard_error": dismissed.discard_error,
                }),
            )
        }
        // `state` is what lets a caller tell a tripwire that already settled
        // from one that never fired — the same two cases the CLI's refusal
        // prose distinguishes.
        Err(DismissRefusal::NoLiveTrip { state }) => (
            StatusCode::CONFLICT,
            json!({ "error": "no_live_trip", "state": state }),
        ),
        Err(DismissRefusal::Ledger(e)) => ledger_error("dismiss", e),
    }
}

/// Spec S04. The shared removal of `tugarc_core::tripwire_remove`, which
/// `tugtool tripwire rm` runs too ([B07]).
///
/// One operation rather than a `DELETE` here and a `DELETE` there, because the
/// rule it carries is not a matter of taste: a tripwire whose trip is running
/// cannot be removed, and one holding a finished run's arc has that arc
/// discarded on the way out rather than orphaned by the cascade. Two spellings
/// of that is how the card and the terminal come to disagree about what
/// removing a tripwire means.
fn remove_tripwire(db_path: &std::path::Path, name: &str) -> (StatusCode, Value) {
    let conn = match ledger::open_ledger(db_path) {
        Ok(conn) => conn,
        Err(e) => return ledger_error("remove", e),
    };
    let tripwire = match ledger::get(&conn, name) {
        Ok(Some(tripwire)) => tripwire,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                json!({ "error": "no_such_tripwire" }),
            );
        }
        Err(e) => return ledger_error("remove", e),
    };
    let now_ms = crate::session_ledger::now_millis();
    match tugarc_core::tripwire_remove::remove(&conn, &tripwire, now_ms) {
        // A discard that failed is a 200 carrying its reason, for the same
        // reason a dismissal's is: the tripwire is gone whatever happened
        // next, and an arc left standing is a fact somebody has to be told.
        Ok(removed) => {
            crate::feeds::tripwires::bump();
            (
                StatusCode::OK,
                json!({
                    "tripwire": tripwire.name,
                    "removed": true,
                    "arc": removed.arc,
                    "discarded": removed.discarded,
                    "discard_error": removed.discard_error,
                }),
            )
        }
        // A conflict rather than a forbidden: the state refuses it, not the
        // caller, and the same request a moment later will succeed. The card
        // states this refusal in the menu item's own label so it is rarely
        // reached, but a race between two doors reaches it.
        Err(RemoveRefusal::TripRunning) => {
            (StatusCode::CONFLICT, json!({ "error": "trip_running" }))
        }
        Err(RemoveRefusal::Ledger(e)) => ledger_error("remove", e),
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

/// `POST /api/tripwires/{name}/trip`. Restricted to loopback. Empty body.
pub(crate) async fn post_tripwire_trip(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(name): Path<String>,
) -> Response {
    if let Some(denied) = deny_non_loopback(&addr, "post_tripwire_trip") {
        return denied;
    }
    finish(tokio::task::spawn_blocking(move || trip_tripwire(&db_path(), &name)).await)
}

/// `POST /api/tripwires/{name}/dismiss`. Restricted to loopback. Empty body.
pub(crate) async fn post_tripwire_dismiss(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(name): Path<String>,
) -> Response {
    if let Some(denied) = deny_non_loopback(&addr, "post_tripwire_dismiss") {
        return denied;
    }
    finish(tokio::task::spawn_blocking(move || dismiss_tripwire(&db_path(), &name)).await)
}

/// `DELETE /api/tripwires/{name}`. Restricted to loopback. Empty body.
pub(crate) async fn delete_tripwire(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(name): Path<String>,
) -> Response {
    if let Some(denied) = deny_non_loopback(&addr, "delete_tripwire") {
        return denied;
    }
    finish(tokio::task::spawn_blocking(move || remove_tripwire(&db_path(), &name)).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    // `TripStatus` is the tests' own now: the projection moved to
    // `tugtool_core::tripwire_roster` and this module no longer reads a trip's
    // status itself. The four tests below are unedited from before the move —
    // if one of them ever needs editing, the port changed the answer.
    use tugtool_core::tripwire_ledger::{NewTripwire, TripStatus};

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
            &NewTripwire::new(
                name,
                r#"{"fact":{"kind":"edit_failed"}}"#,
                "report anything that looks wrong",
                "main",
                "Reports anything that looks wrong on main",
            ),
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
        assert_eq!(tripwire["branch"], "main");
        assert_eq!(tripwire["paused"], false);
        assert_eq!(tripwire["running"], false);
        assert_eq!(tripwire["awaiting"], false);
        assert!(tripwire["running_session"].is_null());
        assert!(tripwire["awaiting_arc"].is_null());
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
        ledger::record_run(&conn, trip_id, Some("sess-1"), None).unwrap();

        let (_, body) = list_tripwires(&path);
        let tripwires = body["tripwires"].as_array().unwrap();
        assert_eq!(tripwires[0]["running"], true);
        assert_eq!(
            tripwires[0]["running_session"], "sess-1",
            "the live dot is keyed on the session, so the projection has to carry it"
        );
        assert_eq!(tripwires[0]["last_trip"]["status"], "running");
        assert_eq!(tripwires[1]["running"], false, "and only that tripwire");
    }

    /// The awaiting state and the arc it holds, which together are the whole
    /// of what the section's yellow dot and its detail row read ([P07], [P08]).
    #[test]
    fn an_awaiting_trip_shows_with_the_arc_it_is_holding() {
        let (_dir, path) = scratch();
        lay(&path, "ci");
        let conn = ledger::open_ledger(&path).unwrap();
        let tripwire = ledger::get(&conn, "ci").unwrap().unwrap();
        let ledger::Claim::Claimed { trip_id } =
            ledger::claim_trip(&conn, tripwire.id, "abc", 10, "inst", None).unwrap()
        else {
            panic!("the claim is uncontested");
        };
        ledger::record_run(&conn, trip_id, Some("sess-1"), Some("tripwire-ci-abcd1234")).unwrap();
        ledger::settle(
            &conn,
            trip_id,
            TripStatus::Awaiting,
            &ledger::Settlement {
                headline: Some("the migration drops a column nothing backfills".to_string()),
                ..ledger::Settlement::default()
            },
            20,
        )
        .unwrap();

        let (_, body) = list_tripwires(&path);
        let tripwire = &body["tripwires"][0];
        assert_eq!(tripwire["awaiting"], true);
        assert_eq!(tripwire["awaiting_arc"], "tripwire-ci-abcd1234");
        assert_eq!(
            tripwire["running"], false,
            "an awaiting run has finished — it holds the wire's slot, it is not working"
        );
        assert_eq!(
            tripwire["last_trip"]["headline"],
            "the migration drops a column nothing backfills"
        );
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

    /// Firing by hand through the API writes the same row the CLI's verb
    /// writes — the two share `queue_manual_trip`, and the `manual:` key is
    /// what lets a tripwire be fired twice on one commit.
    #[test]
    fn the_trip_endpoint_queues_a_manual_trip_and_refuses_an_unknown_tripwire() {
        let (_dir, path) = scratch();
        lay(&path, "ci");

        let (status, body) = trip_tripwire(&path, "ci");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["tripwire"], "ci");
        assert_eq!(body["status"], "queued");
        assert!(
            body["event_key"].as_str().unwrap().starts_with("manual:"),
            "a hand-fired trip carries a manual key: {}",
            body["event_key"]
        );

        let conn = ledger::open_ledger(&path).unwrap();
        let tripwire = ledger::get(&conn, "ci").unwrap().unwrap();
        let trips = ledger::trips_for_tripwire(&conn, tripwire.id, 10).unwrap();
        assert_eq!(trips.len(), 1);
        assert_eq!(trips[0].status, "queued");
        assert_eq!(trips[0].id, body["trip_id"].as_i64().unwrap());

        let (status, body) = trip_tripwire(&path, "nobody");
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "no_such_tripwire");
    }

    /// The dismiss endpoint's two answers: the awaiting trip it settles, and
    /// the `409` whose `state` tells an already-settled tripwire from one that
    /// never fired.
    #[test]
    fn the_dismiss_endpoint_settles_the_live_trip_and_says_which_refusal_it_is() {
        let (_dir, path) = scratch();
        lay(&path, "ci");

        let (status, body) = dismiss_tripwire(&path, "ci");
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "no_live_trip");
        assert!(
            body["state"].is_null(),
            "a tripwire that never fired has no state to name"
        );

        let conn = ledger::open_ledger(&path).unwrap();
        let tripwire = ledger::get(&conn, "ci").unwrap().unwrap();
        let ledger::Claim::Claimed { trip_id } =
            ledger::claim_trip(&conn, tripwire.id, "abc", 10, "inst", None).unwrap()
        else {
            panic!("the claim is uncontested");
        };
        ledger::record_run(&conn, trip_id, Some("sess-1"), None).unwrap();
        ledger::settle(
            &conn,
            trip_id,
            TripStatus::Awaiting,
            &ledger::Settlement {
                headline: Some("something to look at".to_string()),
                ..ledger::Settlement::default()
            },
            20,
        )
        .unwrap();

        let (status, body) = dismiss_tripwire(&path, "ci");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["trip_id"], trip_id);
        assert!(body["arc"].is_null());
        assert_eq!(body["discarded"], false);
        assert_eq!(
            ledger::trip(&conn, trip_id).unwrap().unwrap().status,
            "settled"
        );

        let (status, body) = dismiss_tripwire(&path, "ci");
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            body["state"], "settled",
            "a caller told only `refused` could not tell this from a tripwire that never fired"
        );

        let (status, _) = dismiss_tripwire(&path, "nobody");
        assert_eq!(status, StatusCode::NOT_FOUND);
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
            },
        );
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["tripwire"]["paused"], true);
        assert_eq!(body["tripwire"]["model"], "claude-opus-5");

        // Absent fields move nothing — the same body twice must not be the
        // second one undoing the first.
        let (_, body) = set_knobs(
            &path,
            "ci",
            KnobsBody {
                paused: None,
                model: None,
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
            },
        );
        assert_eq!(body["tripwire"]["paused"], false);
        assert!(body["tripwire"]["model"].is_null());
    }

    /// **The removal's three answers, and the one that is not a removal.**
    ///
    /// A quiet tripwire goes with its trip log; a running trip refuses with a
    /// conflict rather than a forbidden, because it is the state that says no
    /// and the same request a moment later succeeds; and a name nothing
    /// answers to is a 404 the card can tell from either.
    #[test]
    fn removing_a_tripwire_answers_for_each_state_it_can_be_in() {
        let (_dir, path) = scratch();
        lay(&path, "ci");
        lay(&path, "other");

        let trip_id = {
            let conn = ledger::open_ledger(&path).unwrap();
            let tripwire = ledger::get(&conn, "ci").unwrap().unwrap();
            let ledger::Claim::Claimed { trip_id } =
                ledger::claim_trip(&conn, tripwire.id, "abc", 10, "inst", None).unwrap()
            else {
                panic!("the claim is uncontested");
            };
            ledger::record_run(&conn, trip_id, Some("sess-1"), None).unwrap();
            trip_id
        };

        let (status, body) = remove_tripwire(&path, "ci");
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "trip_running");
        let conn = ledger::open_ledger(&path).unwrap();
        assert!(
            ledger::get(&conn, "ci").unwrap().is_some(),
            "a refused removal leaves the row standing"
        );
        drop(conn);

        let (status, body) = remove_tripwire(&path, "nothing");
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "no_such_tripwire");

        let (status, body) = remove_tripwire(&path, "other");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["removed"], true);
        assert!(body["arc"].is_null(), "nothing was held: {body}");
        let conn = ledger::open_ledger(&path).unwrap();
        assert!(ledger::get(&conn, "other").unwrap().is_none());
        assert_eq!(
            ledger::trip(&conn, trip_id).unwrap().unwrap().status,
            "running",
            "and the other tripwire's trip is untouched"
        );
    }

    /// **An arc that could not be discarded is a 200 carrying its reason.**
    ///
    /// The same rule a dismissal runs under: the tripwire is gone whatever
    /// happened next, so raising a 500 would take the successful removal away
    /// from the caller in order to report the arc. It is reported instead.
    #[test]
    fn an_arc_that_could_not_be_discarded_is_reported_rather_than_raised() {
        let (_dir, path) = scratch();
        lay(&path, "ci");
        {
            let conn = ledger::open_ledger(&path).unwrap();
            let tripwire = ledger::get(&conn, "ci").unwrap().unwrap();
            let ledger::Claim::Claimed { trip_id } =
                ledger::claim_trip(&conn, tripwire.id, "abc", 10, "inst", None).unwrap()
            else {
                panic!("the claim is uncontested");
            };
            ledger::record_run(&conn, trip_id, Some("sess-1"), Some("tripwire-ci-abcd1234"))
                .unwrap();
            ledger::settle(
                &conn,
                trip_id,
                TripStatus::Awaiting,
                &ledger::Settlement::default(),
                20,
            )
            .unwrap();
        }

        // The trip names no repository and the tripwire has no scope, so there
        // is no checkout the arc could be removed from.
        let (status, body) = remove_tripwire(&path, "ci");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["arc"], "tripwire-ci-abcd1234");
        assert_eq!(body["discarded"], false);
        assert!(
            body["discard_error"].is_string(),
            "a discard that failed says why: {body}"
        );
        let conn = ledger::open_ledger(&path).unwrap();
        assert!(
            ledger::get(&conn, "ci").unwrap().is_none(),
            "and the tripwire is removed regardless"
        );
    }

    /// The description rides the projection the card reads, beside the brief
    /// the card does not render ([B01], [B03]).
    #[test]
    fn the_list_carries_the_description_and_the_brief_both() {
        let (_dir, path) = scratch();
        lay(&path, "ci");
        let (_, body) = list_tripwires(&path);
        let tripwire = &body["tripwires"][0];
        assert_eq!(
            tripwire["description"],
            "Reports anything that looks wrong on main"
        );
        assert_eq!(tripwire["brief"], "report anything that looks wrong");
    }
}
