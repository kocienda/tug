//! HTTP server for tugcast
//!
//! Implements the axum server with routes for auth, WebSocket upgrade,
//! and API commands. In production mode, tugcast serves the pre-built
//! frontend from `tugdeck/dist/` via `tower-http::ServeDir` as a fallback
//! route. In dev mode, the Vite dev server on port 55155 handles the
//! frontend; tugcast handles only the API routes.

use axum::Extension;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::time::timeout;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use tracing::{info, warn};
use tugbank_core::TugbankClient;
use tugcast_core::{FeedId, Frame};

use crate::dev::SharedDevState;
use crate::router::FeedRouter;

/// Request payload for /api/tell endpoint
// Allow dead_code: struct is used only for testing/documentation
#[allow(dead_code)]
#[derive(Deserialize)]
struct TellRequest {
    action: String,
}

/// Response payload for /api/tell endpoint
#[derive(Serialize)]
struct TellResponse {
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    /// The handler's own reply body, when the action produced one (the
    /// `changeset_claim_ok` / `_err` frame a WebSocket client would have
    /// received). What lets the CLI report the actual outcome.
    #[serde(skip_serializing_if = "Option::is_none")]
    reply: Option<serde_json::Value>,
}

/// Handle POST /api/tell requests for triggering actions
async fn tell_handler(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(router): State<FeedRouter>,
    body: Bytes,
) -> Response {
    // Reject non-loopback connections
    if !addr.ip().is_loopback() {
        warn!(
            "tell_handler: rejected non-loopback connection from {}",
            addr
        );
        return (
            StatusCode::FORBIDDEN,
            axum::Json(TellResponse {
                status: "error".to_string(),
                message: Some("forbidden".to_string()),
                reply: None,
            }),
        )
            .into_response();
    }

    // Parse JSON payload manually (not using axum Json extractor) for custom error messages
    let payload: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(TellResponse {
                    status: "error".to_string(),
                    message: Some("invalid JSON".to_string()),
                    reply: None,
                }),
            )
                .into_response();
        }
    };

    // Extract action field
    let action = match payload.get("action").and_then(|a| a.as_str()) {
        Some(a) => a,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(TellResponse {
                    status: "error".to_string(),
                    message: Some("missing action field".to_string()),
                    reply: None,
                }),
            )
                .into_response();
        }
    };

    // Bridge: `changeset_*` CONTROL actions (e.g. `changeset_claim`) live in
    // the supervisor's `handle_control` — the single source of truth shared
    // with the WebSocket ingress — so the CLI (`tugtool claim`) and the deck
    // hit the same handler. Gated to the `changeset_` prefix: those verbs act
    // on a project + ledger, never on per-client state, so a tell (which has
    // no client connection) can drive them with a synthetic client id;
    // client-scoped verbs (`spawn_session`, …) stay off the HTTP surface.
    // Everything else falls through to the host-action `dispatch_action` below.
    if action.starts_with("changeset_")
        && let Some(sup) = router.supervisor.as_ref()
    {
        use crate::feeds::agent_supervisor::ControlOutcome;
        match sup
            .handle_control(action, &body, TELL_SYNTHETIC_CLIENT_ID)
            .await
        {
            ControlOutcome::Handled => {
                return (
                    StatusCode::OK,
                    axum::Json(TellResponse {
                        status: "ok".to_string(),
                        message: None,
                        reply: None,
                    }),
                )
                    .into_response();
            }
            ControlOutcome::HandledWith(reply) => {
                // The handler's own reply frame (e.g. `changeset_claim_ok`
                // with its count and warning) — returned verbatim so the CLI
                // reports what actually happened instead of inferring
                // success from a bare 200.
                return (
                    StatusCode::OK,
                    axum::Json(TellResponse {
                        status: "ok".to_string(),
                        message: None,
                        reply: Some(reply),
                    }),
                )
                    .into_response();
            }
            ControlOutcome::Error(err) => {
                return (
                    StatusCode::BAD_REQUEST,
                    axum::Json(TellResponse {
                        status: "error".to_string(),
                        message: Some(format!("{err:?}")),
                        reply: None,
                    }),
                )
                    .into_response();
            }
            // Not a supervisor-owned action after all — fall through.
            ControlOutcome::PassThrough => {}
        }
    }

    // Dispatch action
    crate::actions::dispatch_action(action, &body, &router.action_context()).await;

    (
        StatusCode::OK,
        axum::Json(TellResponse {
            status: "ok".to_string(),
            message: None,
            reply: None,
        }),
    )
        .into_response()
}

/// Synthetic client id for HTTP-`tell`-originated CONTROL actions: a tell has
/// no WebSocket connection, so `changeset_*` verbs (which never touch
/// per-client state) run under this sentinel. Well above any real client id
/// (those count up from 0), so it can never collide with a live client.
const TELL_SYNTHETIC_CLIENT_ID: u64 = u64::MAX;

/// Handle GET /api/changesets — an observability dump of the live changeset
/// aggregate. Composes fresh over the current registry + ledger (the same call
/// the CHANGESET_ALL feed makes on a bump) and returns it as JSON. Loopback
/// only; read-only. This is ground truth for "what does compose produce right
/// now" — the CLI (`tugtool host changesets`) reads it to diagnose a stale or
/// empty Changes view against the actual working-tree scan.
async fn changesets_handler(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(router): State<FeedRouter>,
) -> Response {
    if !addr.ip().is_loopback() {
        return (
            StatusCode::FORBIDDEN,
            axum::Json(serde_json::json!({ "status": "error", "message": "forbidden" })),
        )
            .into_response();
    }
    match router.supervisor.as_ref() {
        Some(sup) => {
            let snapshot = sup.compose_changeset_aggregate().await;
            (StatusCode::OK, axum::Json(snapshot)).into_response()
        }
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(serde_json::json!({ "status": "error", "message": "no supervisor" })),
        )
            .into_response(),
    }
}

/// Handle GET /api/ink-census — what the shell ledger holds per session.
///
/// The instrument that was missing when a `/commit` receipt went absent from
/// a transcript three separate times. "Is the row durable?" and "did the deck
/// get it?" are different questions, and until this route there was no way to
/// answer the first one without copying a live sqlite file by hand. Answers
/// `{sessions: [{tug_session_id, rows, max_seq, first_settled_at_ms,
/// last_settled_at_ms}]}`, newest activity first; `?session=<id>` narrows it.
///
/// Loopback only, read-only, no eval gate — a census is not a capability.
async fn ink_census_handler(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(params): Query<std::collections::HashMap<String, String>>,
    State(router): State<FeedRouter>,
) -> Response {
    if !addr.ip().is_loopback() {
        return (
            StatusCode::FORBIDDEN,
            axum::Json(serde_json::json!({ "status": "error", "message": "forbidden" })),
        )
            .into_response();
    }
    let Some(ledger) = router
        .supervisor
        .as_ref()
        .and_then(|sup| sup.shell_ledger.as_ref())
    else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(serde_json::json!({ "status": "error", "message": "no shell ledger" })),
        )
            .into_response();
    };
    let only = params.get("session").map(String::as_str);
    match ledger.ink_census(only) {
        Ok(sessions) => (
            StatusCode::OK,
            axum::Json(serde_json::json!({ "status": "ok", "sessions": sessions })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(serde_json::json!({ "status": "error", "message": err.to_string() })),
        )
            .into_response(),
    }
}

/// Request payload for POST /api/draft — the CLI's landing-draft write
/// path (`tugtool draft set|clear`). Routing these writes through the
/// server keeps short-lived CLI processes out of the shared changes
/// ledger entirely: one writer surface, one journal, one pragma set.
#[derive(serde::Deserialize)]
struct DraftApiRequest {
    /// `set` | `clear`.
    op: String,
    owner_kind: String,
    owner_id: String,
    /// The key the same owner's rows were written under before arcs had
    /// creation ids ([P01]) — the exact mirror of `raw_project_dir` on the
    /// owner-key axis: read as a fallback, superseded on set, swept on clear
    /// ([P03]). Without it the name→id migration would exist only on the
    /// CLI's test-isolated direct path and never in production.
    #[serde(default)]
    legacy_owner_id: Option<String>,
    /// Further keys the same owner's rows may sit under — for a **session**
    /// owner, the other segments of its line ([P01]). `$TUG_SESSION_ID` is
    /// frozen at spawn and the Wheel rotates a card's session on purpose, so
    /// a draft authored before a rotation sits under an id the card no longer
    /// wears; without this the write would key forward and orphan it. Read as
    /// fallbacks, superseded on set, swept on clear — exactly as the singular
    /// `legacy_owner_id` is.
    #[serde(default)]
    legacy_owner_ids: Vec<String>,
    /// Project path as the caller spelled it. The server is the
    /// canonicalization gateway ([L29]): this is resolved through
    /// `resolve_to_claude_form` and the *resolved* spelling is the row
    /// key written — a CLI must never canonicalize on its own (bare
    /// `fs::canonicalize` mints the firmlink-expanded spelling Claude
    /// never writes).
    project_dir: String,
    /// Additional legacy spelling of the same directory (e.g. the old
    /// CLI's `fs::canonicalize` form); a differing row under it is
    /// superseded on set and swept on clear.
    #[serde(default)]
    raw_project_dir: Option<String>,
    /// Directories a caller is *migrating off* — not other spellings of
    /// `project_dir` but a different directory entirely, whose rows this write
    /// retires. An arc draft written from inside the arc worktree sends the
    /// worktree here while keying on the base repository root, which is where
    /// the join reads. `project_dir` and `raw_project_dir` are both spoken for
    /// by the base root, so a third slot is what the sweep needs to reach the
    /// old rows at all.
    #[serde(default)]
    superseded_project_dirs: Vec<String>,
    /// New message; on set, `None` keeps the existing draft's message.
    #[serde(default)]
    message: Option<String>,
    /// New selection JSON string; `None` keeps the existing selection.
    #[serde(default)]
    selection: Option<String>,
}

/// Handle POST /api/draft — ledger-backed draft set/clear with the CLI's
/// read-merge semantics (Spec S02/S05): a set preserves the existing
/// fingerprint and selection unless replaced, always writes `edited=1`
/// (a skill-authored draft is an authored draft), and supersedes a
/// raw-spelling sibling row. Loopback only.
async fn draft_handler(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(router): State<FeedRouter>,
    body: Bytes,
) -> Response {
    fn err(status: StatusCode, message: &str) -> Response {
        (
            status,
            axum::Json(serde_json::json!({ "status": "error", "message": message })),
        )
            .into_response()
    }
    if !addr.ip().is_loopback() {
        return err(StatusCode::FORBIDDEN, "forbidden");
    }
    let Some(supervisor) = router.supervisor.as_ref() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "no supervisor");
    };
    let Some(ledger) = supervisor.session_ledger.clone() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "no session ledger");
    };
    let registry = supervisor.registry.clone();
    let req: DraftApiRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => return err(StatusCode::BAD_REQUEST, &format!("invalid JSON: {e}")),
    };
    // Blocking work (path resolution syscalls, ledger mutex, SQLite)
    // stays off the async workers.
    let response =
        match tokio::task::spawn_blocking(move || apply_draft_request(&ledger, &req)).await {
            Ok(response) => response,
            Err(e) => {
                return err(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &format!("draft task failed: {e}"),
                );
            }
        };
    // A draft the changesets feed derives from just moved, so the feed
    // recomputes — the same bump the arc bind handler fires. Without it a
    // standing join prompt keeps composing its "lands as" from the draft that
    // existed when it was raised, and announces "no draft was written" while
    // the join it offers would land with one. Unconditional on owner kind: a
    // commit draft refreshing the feed is harmless, and a condition here is a
    // branch nobody would maintain.
    if response.status().is_success() {
        registry.changeset_all_bump().notify_one();
    }
    response
}

/// The ledger half of [`draft_handler`], run on the blocking pool.
fn apply_draft_request(
    ledger: &crate::session_ledger::SessionLedger,
    req: &DraftApiRequest,
) -> Response {
    fn err(status: StatusCode, message: &str) -> Response {
        (
            status,
            axum::Json(serde_json::json!({ "status": "error", "message": message })),
        )
            .into_response()
    }
    // The gateway ([L29]): the persisted row key is the Claude-form
    // spelling, whatever the caller sent. Every differing spelling the
    // caller knows about — its own as-sent path, a legacy realpath form —
    // is a stale sibling to read as fallback, supersede on set, and
    // sweep on clear.
    let canonical =
        crate::path_resolver::resolve_to_claude_form(std::path::Path::new(&req.project_dir))
            .to_string_lossy()
            .into_owned();
    let alternates: Vec<String> = [Some(req.project_dir.clone()), req.raw_project_dir.clone()]
        .into_iter()
        .flatten()
        .chain(req.superseded_project_dirs.iter().cloned())
        .filter(|s| *s != canonical)
        .collect();
    // The owner key migrates on its own axis ([P03]), so the sibling set is
    // the product of both: every legacy key × every legacy spelling. Ordered
    // owner-key-major so a read prefers the current key's row.
    let siblings: Vec<(&str, &str)> = std::iter::once(req.owner_id.as_str())
        .chain(
            req.legacy_owner_id
                .as_deref()
                .filter(|legacy| *legacy != req.owner_id),
        )
        .chain(
            req.legacy_owner_ids
                .iter()
                .map(String::as_str)
                .filter(|id| *id != req.owner_id),
        )
        .flat_map(|id| {
            std::iter::once((id, canonical.as_str()))
                .chain(alternates.iter().map(move |alt| (id, alt.as_str())))
        })
        .filter(|(id, project)| !(*id == req.owner_id && *project == canonical))
        .collect();
    let read_existing = || {
        ledger
            .changeset_draft(&req.owner_kind, &req.owner_id, &canonical)
            .ok()
            .flatten()
            .or_else(|| {
                siblings.iter().find_map(|(id, project)| {
                    ledger
                        .changeset_draft(&req.owner_kind, id, project)
                        .ok()
                        .flatten()
                })
            })
    };
    match req.op.as_str() {
        "set" => {
            let existing = read_existing();
            let message = match req
                .message
                .clone()
                .or_else(|| existing.as_ref().map(|e| e.message.clone()))
            {
                Some(m) if !m.trim().is_empty() => m,
                _ => {
                    return err(
                        StatusCode::BAD_REQUEST,
                        "nothing to set: no message given and no draft on file",
                    );
                }
            };
            let row = crate::session_ledger::ChangesetDraftRow {
                owner_kind: req.owner_kind.clone(),
                owner_id: req.owner_id.clone(),
                project_dir: canonical.clone(),
                fingerprint: existing
                    .as_ref()
                    .map(|e| e.fingerprint.clone())
                    .unwrap_or_default(),
                message,
                updated_at: crate::session_ledger::now_millis(),
                edited: true,
                selection: req
                    .selection
                    .clone()
                    .or_else(|| existing.as_ref().and_then(|e| e.selection.clone())),
            };
            if let Err(e) = ledger.upsert_changeset_draft(&row) {
                return err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
            }
            for (id, project) in &siblings {
                let _ = ledger.delete_changeset_draft(&req.owner_kind, id, project);
            }
            (
                StatusCode::OK,
                axum::Json(serde_json::json!({ "status": "ok", "row": row })),
            )
                .into_response()
        }
        "clear" => {
            let existed = read_existing().is_some();
            if let Err(e) =
                ledger.delete_changeset_draft(&req.owner_kind, &req.owner_id, &canonical)
            {
                return err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
            }
            for (id, project) in &siblings {
                let _ = ledger.delete_changeset_draft(&req.owner_kind, id, project);
            }
            (
                StatusCode::OK,
                axum::Json(serde_json::json!({ "status": "ok", "deleted": existed })),
            )
                .into_response()
        }
        other => err(StatusCode::BAD_REQUEST, &format!("unknown op '{other}'")),
    }
}

/// Request payload for POST /api/arc — the CLI's session↔arc binding
/// write path (`tugtool arc bind|unbind`, and the `arc_gone` broadcast a
/// terminal join fires). Spec S04, [P04].
///
/// `arc_run` also reaches this shape from the deck's transport control, which
/// is the one caller that can arrive with documents and no record. It names
/// no kind: the opening reads that off the documents it finds.
#[derive(serde::Deserialize)]
struct ArcApiRequest {
    /// `bind` | `arc_run` | `arc_resume` | `unbind` | `arc_stop` | `arc_ask` |
    /// `arc_gone`.
    op: String,
    #[serde(default)]
    tug_session_id: Option<String>,
    /// Project path as the caller spelled it — resolved through the [L29]
    /// gateway here, exactly as `apply_draft_request` does. Absent for
    /// `unbind`, which names only a session.
    #[serde(default)]
    project_dir: Option<String>,
    /// The arc name, for `bind`.
    #[serde(default)]
    arc: Option<String>,
    /// For `arc_gone`: the owner key captured **before** the teardown that
    /// deleted the arc's branch ([P05]).
    #[serde(default)]
    arc_id: Option<String>,
    /// For `arc_gone`: which gesture ended the arc — `"discarded"` or
    /// `"joined"`. Absent reads as a discard, which is what every caller
    /// before this field existed was, so an older `tugtool` still works.
    #[serde(default)]
    reason: Option<String>,
    /// For `arc_ask`: the decision the stage stopped over, in the stage's own
    /// words. It becomes the arc's last `arc-note` and the tail of the
    /// receipt, so it is the whole of what the user has to go on.
    #[serde(default)]
    question: Option<String>,
}

// (A review-start route is gone: a review is an ordinary turn the user starts,
// so there is no signal for a skill to fire and nothing for the server to relay.)

/// Handle POST /api/arc. Loopback only, like every tugcast API; the ledger
/// work runs on the blocking pool.
///
/// A successful binding write fires the process-global changeset bump, the
/// same one a landing fires, so the Changes card recomposes with the new
/// mating.
async fn arc_handler(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(router): State<FeedRouter>,
    body: Bytes,
) -> Response {
    fn err(status: StatusCode, message: &str) -> Response {
        (
            status,
            axum::Json(serde_json::json!({ "status": "error", "message": message })),
        )
            .into_response()
    }
    if !addr.ip().is_loopback() {
        return err(StatusCode::FORBIDDEN, "forbidden");
    }
    let Some(supervisor) = router.supervisor.as_ref() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "no supervisor");
    };
    let Some(ledger) = supervisor.session_ledger.clone() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "no session ledger");
    };
    let registry = supervisor.registry.clone();
    let control_tx = supervisor.control_tx.clone();
    let req: ArcApiRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => return err(StatusCode::BAD_REQUEST, &format!("invalid JSON: {e}")),
    };
    // Kept out of the moved request: the ending's receipt is worded from it
    // after the blocking half returns.
    let reason = req.reason.clone();
    let outcome = match tokio::task::spawn_blocking(move || apply_arc_request(&ledger, &req)).await
    {
        Ok(outcome) => outcome,
        Err(e) => {
            return err(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("arc task failed: {e}"),
            );
        }
    };
    match outcome {
        crate::arc_api::ArcApiOutcome::Bound {
            session_id,
            arc_id,
            arc_name,
        } => {
            registry.changeset_all_bump().notify_one();
            // The same announcement the `bind_arc` CONTROL verb makes: a bind
            // is one fact, and the card wearing the arc must not depend on
            // which door it came through.
            //
            // Named from the outcome, never from the request: the door
            // expands a frozen `$TUG_SESSION_ID` to its line's live segment,
            // and a broadcast still naming the id that was posted would
            // announce the mating to a card that closed two rotations ago.
            crate::feeds::agent_supervisor::broadcast_bind_arc_ok(
                &control_tx,
                &session_id,
                &arc_id,
                &arc_name,
                None,
                None,
            );
            (
                StatusCode::OK,
                axum::Json(
                    serde_json::json!({ "status": "ok", "arc_id": arc_id, "arc_name": arc_name }),
                ),
            )
                .into_response()
        }
        crate::arc_api::ArcApiOutcome::Unbound { session_id } => {
            registry.changeset_all_bump().notify_one();
            crate::feeds::agent_supervisor::broadcast_unbind_arc_ok(&control_tx, &session_id);
            (
                StatusCode::OK,
                axum::Json(serde_json::json!({ "status": "ok" })),
            )
                .into_response()
        }
        crate::arc_api::ArcApiOutcome::Cleared { cleared, seated } => {
            if cleared > 0 {
                registry.changeset_all_bump().notify_one();
            }
            // A card whose stage this arc's run was seated on is told the
            // arc ended, and gets its model back at that stage's turn end.
            //
            // The hand-back is **armed**, never sent: the stage may be
            // mid-turn, and nothing retires a claude mid-sentence. And no
            // `arc-stop` is written on this path at all — the ending's own
            // terminal arc log line has already closed the arc's generation,
            // so a line appended after it would become the first line of a
            // phantom next generation that an arc reusing the name would be
            // born carrying. The receipt on the card is the whole record,
            // which is the right outcome for an arc that no longer exists.
            let gesture = crate::arc_api::ArcGoneReason::parse(reason.as_deref());
            if let Some(wheel) = router.wheel.as_ref() {
                for stage in &seated {
                    info!(
                        arc = %stage.arc_name,
                        stage = stage.stage.as_str(),
                        gesture = gesture.as_str(),
                        "an ending retires a seated stage at its turn's end",
                    );
                    crate::feeds::arc_runner::stop_arc_for_session(
                        supervisor,
                        wheel,
                        &tugcast_core::protocol::TugSessionId::new(stage.session_id.clone()),
                        std::path::Path::new(&stage.project_dir),
                        &stage.arc_name,
                        stage.stage,
                        gesture.stop_reason(),
                        crate::feeds::arc_runner::StopDelivery {
                            hand_back: crate::feeds::arc_runner::HandBack::Arm,
                            record: false,
                        },
                    )
                    .await;
                }
            }
            (
                StatusCode::OK,
                axum::Json(serde_json::json!({ "status": "ok", "cleared": cleared })),
            )
                .into_response()
        }
        crate::arc_api::ArcApiOutcome::ArcStopped {
            arc,
            stage,
            session_id,
            project_dir,
            reason,
            question,
        } => {
            // The whole of the stop — the question's note, the interrupt, the
            // hand-back, the receipt, the record — is the supervisor's one
            // method, so this route and the CONTROL frame the transport
            // control sends take the same path ([P03]). **Only a user's stop
            // halts a running turn**: an `arc_ask` is a stage ending its own
            // turn over a question, and interrupting it would truncate the
            // sentence the receipt exists to carry.
            //
            // **The protocol runs as its own task, and this request only
            // listens.** The stop is no longer milliseconds: it marks the arc
            // `stopping`, tears the session's work down, and waits up to the
            // project's ceiling for it to go quiet. Axum drops a handler
            // future the instant the client's socket closes, and on this
            // route the client is routinely a casualty of the very teardown
            // it asked for — `tugtool arc ask` runs inside the stage's own
            // turn, so it is a child of the claude whose process group the
            // teardown sweeps. Awaiting the protocol inline would therefore
            // cancel it mid-wait in the common case, leaving the
            // `arc-stopping` mark standing with neither the `arc-stop` that
            // ends the protocol nor the abandon line that gives it up: an arc
            // the wheel stands down for, that both presses refuse by
            // sentence, and that no gesture clears ([P03]). A `^C` on the
            // CLI, or any dropped connection, is the same shape.
            let stopping = {
                let (done_tx, done_rx) = tokio::sync::oneshot::channel();
                let supervisor = Arc::clone(supervisor);
                let (session_id, project_dir, arc) =
                    (session_id.clone(), project_dir.clone(), arc.clone());
                let question = question.clone();
                let halt = reason == tugarc_core::arc::ArcStopReason::StoppedByUser;
                tokio::spawn(async move {
                    let outcome = supervisor
                        .stop_arc_now(
                            &session_id,
                            std::path::Path::new(&project_dir),
                            &arc,
                            crate::feeds::agent_supervisor::StopTerms {
                                stage,
                                reason,
                                question: question.as_deref(),
                                halt,
                            },
                        )
                        .await;
                    // Nobody left to tell is the cancelled-request case, and
                    // the protocol above has already finished either way.
                    let _ = done_tx.send(outcome);
                });
                done_rx.await
            };
            if let Err(reason) = stopping.unwrap_or(Err("stop task failed")) {
                return err(StatusCode::SERVICE_UNAVAILABLE, reason);
            }
            (
                StatusCode::OK,
                axum::Json(serde_json::json!({
                    "status": "ok",
                    "arc": arc,
                    "stage": stage.as_str(),
                    "reason": reason.as_str(),
                    "question": question,
                })),
            )
                .into_response()
        }
        // Distinguishable by design: the CLI's try-each-instance loop reads
        // this as "not mine" and moves on silently ([P04]).
        crate::arc_api::ArcApiOutcome::UnknownSession => {
            err(StatusCode::NOT_FOUND, "unknown_session")
        }
        crate::arc_api::ArcApiOutcome::Error(message) => {
            err(StatusCode::INTERNAL_SERVER_ERROR, &message)
        }
    }
}

/// The ledger half of [`arc_handler`], run on the blocking pool. Every
/// `project_dir` passes through the [L29] gateway before it opens a repo or
/// is compared against anything persisted.
fn apply_arc_request(
    ledger: &crate::session_ledger::SessionLedger,
    req: &ArcApiRequest,
) -> crate::arc_api::ArcApiOutcome {
    use crate::arc_api::ArcApiOutcome;
    let resolved_project = || {
        req.project_dir
            .as_deref()
            .map(|dir| crate::path_resolver::resolve_to_claude_form(std::path::Path::new(dir)))
    };
    match req.op.as_str() {
        "bind" => {
            let (Some(session), Some(project), Some(arc)) = (
                req.tug_session_id.as_deref(),
                resolved_project(),
                req.arc.as_deref(),
            ) else {
                return ArcApiOutcome::Error(
                    "bind needs tug_session_id, project_dir, and arc".to_string(),
                );
            };
            crate::arc_api::bind(ledger, &project, session, arc)
        }
        // The arc runs on the calling card, so arriving is a binding: the tick
        // resolves "which arc does this session own" through it, and a tugcast
        // restart resumes by walking the bindings rather than guessing which
        // projects have logs ([P01]). `ensure_arc_id` mints the owner key as
        // a git config entry and needs no branch, so a pre-branch arc binds
        // exactly as a created arc does — and `arc create` later finds the
        // same id.
        //
        // It binds and returns; it never rotates. The request arrives from
        // inside the conversation session's own turn — the model typing
        // `tugtool arc run` is mid-turn on the card the arc is about — so
        // rotating on receipt would kill claude in the middle of the turn that
        // asked for the arc. The first rotation is that session's own idle
        // transition ([P05]).
        //
        // It also *opens* the arc when there is no record and the request
        // has documents to open on ([P04]) — the deck's Start button is the
        // caller that arrives with documents and nothing else, and the open
        // derives the arc's kind from them. The CLI opens client-side and
        // arrives with a record, so the open is a no-op for it.
        "arc_run" => {
            let (Some(session), Some(project), Some(arc)) = (
                req.tug_session_id.as_deref(),
                resolved_project(),
                req.arc.as_deref(),
            ) else {
                return ArcApiOutcome::Error(
                    "arc_run needs tug_session_id, project_dir, and arc".to_string(),
                );
            };
            crate::arc_api::arc_run(ledger, &project, session, arc)
        }
        // Pick a stopped arc back up: clear the stop by naming the stage it
        // stopped in, then bind — `arc_run`'s pair of acts made reachable
        // from the Resume button in the stop's own receipt ([B07]). It binds
        // and returns for the same reason `arc_run` does: the rotation is the
        // card's own next idle ([P05]).
        "arc_resume" => {
            let (Some(session), Some(project), Some(arc)) = (
                req.tug_session_id.as_deref(),
                resolved_project(),
                req.arc.as_deref(),
            ) else {
                return ArcApiOutcome::Error(
                    "arc_resume needs tug_session_id, project_dir, and arc".to_string(),
                );
            };
            crate::arc_api::arc_resume(ledger, &project, session, arc)
        }
        "unbind" => {
            let Some(session) = req.tug_session_id.as_deref() else {
                return ArcApiOutcome::Error("unbind needs tug_session_id".to_string());
            };
            crate::arc_api::unbind(ledger, session)
        }
        // Stop the arc and keep the arc. The blocking half names the stage;
        // the async half below performs the stop, because it is the half that
        // holds the supervisor the hand-back and the receipt go through.
        "arc_stop" => {
            let (Some(session), Some(project), Some(arc)) = (
                req.tug_session_id.as_deref(),
                resolved_project(),
                req.arc.as_deref(),
            ) else {
                return ArcApiOutcome::Error(
                    "arc_stop needs tug_session_id, project_dir, and arc".to_string(),
                );
            };
            crate::arc_api::arc_stop(ledger, &project, session, arc)
        }
        // A stage saying it has met a decision that is not its to make. The
        // same act `arc_stop` performs, under the stage's own reason and
        // carrying the question — see `ArcStopReason::NeedsDecision` for why an
        // arc's stage stops rather than raising an `AskUserQuestion`.
        "arc_ask" => {
            let (Some(session), Some(project), Some(arc), Some(question)) = (
                req.tug_session_id.as_deref(),
                resolved_project(),
                req.arc.as_deref(),
                req.question.as_deref(),
            ) else {
                return ArcApiOutcome::Error(
                    "arc_ask needs tug_session_id, project_dir, arc, and question".to_string(),
                );
            };
            crate::arc_api::arc_ask(ledger, &project, session, arc, question)
        }
        "arc_gone" => {
            let (Some(project), Some(arc_id)) = (resolved_project(), req.arc_id.as_deref()) else {
                return ArcApiOutcome::Error("arc_gone needs project_dir and arc_id".to_string());
            };
            crate::arc_api::arc_gone(ledger, &project, arc_id)
        }
        other => ArcApiOutcome::Error(format!("unknown op '{other}'")),
    }
}

/// Request payload for POST /api/session — the wheel's door ([S03]).
///
/// A rotation names no arc, so it does not ride `ArcApiRequest`: putting
/// `model`, `prompt`, `stage`, and `effort` on a type whose name says it is
/// about arcs would spell the wheel's whole parameter set in the wrong
/// vocabulary ([P03]).
#[derive(serde::Deserialize)]
struct SessionApiRequest {
    /// `rotate` | `rotate_cancel` | `resolve` | `step_closed` | `turn_facts`.
    op: String,
    #[serde(default)]
    tug_session_id: Option<String>,
    /// Project path as the caller spelled it — resolved through the [L29]
    /// gateway here, exactly as `apply_arc_request` does.
    #[serde(default)]
    project_dir: Option<String>,
    /// The stage label the divider renders. Free text.
    #[serde(default)]
    stage: Option<String>,
    /// The stage's opening prompt.
    #[serde(default)]
    prompt: Option<String>,
    /// The model to seat the fresh session on. Absent is the account default.
    #[serde(default)]
    model: Option<String>,
    /// The reasoning effort to seat it at. Absent leaves the level as it is.
    #[serde(default)]
    effort: Option<String>,
    /// `step_closed`: the step the calling turn just closed.
    #[serde(default)]
    step: Option<u32>,
}

/// Why a `resolve` could not answer, in the vocabulary the CLI's
/// try-each-instance loop reads.
#[derive(Debug)]
enum IdentityRefusal {
    /// Not this instance's line — keep walking.
    Unknown,
    /// This instance owns the line and every segment of it has closed.
    LineClosed(String),
}

/// The identity chokepoint ([P01]): expand a posted `$TUG_SESSION_ID` to the
/// live segment of its line, and say what became of the id that was posted.
///
/// Every short-lived CLI process holds an id frozen at spawn, and the Wheel
/// rotates a card's session on purpose — so the id a verb was born with
/// routinely names a segment closed two rotations ago. `calling_segment` makes
/// this move for `/api/arc`'s own ops; this op is the same move offered to
/// any caller *before* it acts, so no verb has to solve staleness for itself
/// and no reader has to be trusted to re-expand what a writer left stale.
///
/// The answer carries the posted id's own `state` alongside the resolved one,
/// because a refusal that cannot say what became of the id it was handed sends
/// its reader looking in the wrong place.
fn resolve_session_identity(
    ledger: &crate::session_ledger::SessionLedger,
    posted: &str,
) -> Result<serde_json::Value, IdentityRefusal> {
    let Some(row) = ledger.get(posted).ok().flatten() else {
        return Err(IdentityRefusal::Unknown);
    };
    let live = match ledger.live_segment_of(posted) {
        Ok(Some(live)) => live,
        _ => {
            return Err(IdentityRefusal::LineClosed(format!(
                "session {posted} is {} and no segment of its line is live — \
                 the card it worked has gone",
                row.state.as_str()
            )));
        }
    };
    let line_id = ledger.line_of(posted);
    // Every segment the line has ever worn, newest-answering first — what a
    // reader keyed on session id (a draft owner, a pending ask) expands over
    // so a row written under an earlier segment still surfaces.
    let segments = line_id
        .as_deref()
        .and_then(|line| ledger.line_ownership(line).ok().flatten())
        .map(|own| own.segment_ids)
        .unwrap_or_else(|| vec![posted.to_string()]);
    let live_state = ledger
        .get(&live)
        .ok()
        .flatten()
        .map(|r| r.state.as_str())
        .unwrap_or("live");
    Ok(serde_json::json!({
        "status": "ok",
        "session_id": live,
        "posted": posted,
        "posted_state": row.state.as_str(),
        "state": live_state,
        "line_id": line_id,
        "segments": segments,
        "rotated": live != posted,
        // **Which checkout this session works.** A session may only bind an
        // arc in its own project (`arc_api::bind`), so a caller can tell
        // "the bind was refused" from "this session had no standing to make
        // it" — and skip the attempt rather than reporting a failure about a
        // claim that was never its to make. An instance that predates the
        // field simply omits it, and the caller falls back to what it did
        // before: attempt, and warn.
        "project_dir": row.project_dir,
    }))
}

/// Handle POST /api/session. Loopback only, like every tugcast API.
///
/// The request is **parked**, never performed: the caller is a model running
/// inside the very turn whose end the rotation is scheduled for, and rotating
/// on receipt would kill it mid-sentence ([P04]). What this handler does is
/// decide whether the promise can be made — the session must exist here, and
/// the card must not already be running a score ([P06]) — and record it.
async fn session_handler(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(router): State<FeedRouter>,
    body: Bytes,
) -> Response {
    fn err(status: StatusCode, message: &str) -> Response {
        (
            status,
            axum::Json(serde_json::json!({ "status": "error", "message": message })),
        )
            .into_response()
    }
    if !addr.ip().is_loopback() {
        return err(StatusCode::FORBIDDEN, "forbidden");
    }
    let Some(supervisor) = router.supervisor.as_ref() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "no supervisor");
    };
    let Some(ledger) = supervisor.session_ledger.clone() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "no session ledger");
    };
    let req: SessionApiRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => return err(StatusCode::BAD_REQUEST, &format!("invalid JSON: {e}")),
    };
    let Some(session_id) = req.tug_session_id.clone().filter(|s| !s.is_empty()) else {
        return err(
            StatusCode::BAD_REQUEST,
            "a rotation names the session it rotates",
        );
    };

    // `resolve` is the identity chokepoint's server half, and the one op here
    // that needs no wheel: it reads the ledger and answers. Handled before the
    // wheel guard so an instance without one still resolves.
    if req.op == "resolve" {
        let resolved = {
            let ledger = Arc::clone(&ledger);
            let posted = session_id.clone();
            tokio::task::spawn_blocking(move || resolve_session_identity(&ledger, &posted)).await
        };
        return match resolved {
            Ok(Ok(value)) => (StatusCode::OK, axum::Json(value)).into_response(),
            Ok(Err(IdentityRefusal::Unknown)) => err(StatusCode::NOT_FOUND, "unknown_session"),
            Ok(Err(IdentityRefusal::LineClosed(message))) => err(StatusCode::CONFLICT, &message),
            Err(e) => err(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("session task failed: {e}"),
            ),
        };
    }

    // ── The turn-boundary ops ─────────────────────────────────────────────
    //
    // Two ops that need no wheel either, handled beside `resolve` for the
    // same reason: they read and write facts a `tugtool` verb holds and the
    // server keeps. Each resolves the posted id at its own door, exactly as
    // `/api/arc` does, so a stale spawn-time id lands on the live segment
    // ([P01]).
    //
    // **The card's quiet lines are not here**, and the reason is the whole
    // shape of W8 Task 3: an announcement a caller *posts* is a second
    // fallible write and an act a caller can omit. They are derived from the
    // arc log instead, by `feeds/arc_notes.rs`, so the announcement is
    // skippable only by not writing the record.
    //
    // **Skew.** An instance older than W8 answers `unknown op '…'`, and every
    // caller of these degrades: the announcement is not drawn, the boundary is
    // not recorded, and the gate denies nothing. A gate that bricked editing
    // on a mixed install would be worse than the overrun it prevents.
    if matches!(req.op.as_str(), "step_closed" | "turn_facts") {
        let seated = {
            let ledger = Arc::clone(&ledger);
            let posted = session_id.clone();
            match tokio::task::spawn_blocking(move || {
                let live = ledger.live_segment_of(&posted).ok().flatten();
                let on_arc = live
                    .as_deref()
                    .is_some_and(|id| crate::wheel::arc_is_running(&ledger, id));
                (live, on_arc)
            })
            .await
            {
                Ok(seated) => seated,
                Err(e) => {
                    return err(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        &format!("session task failed: {e}"),
                    );
                }
            }
        };
        let (live, on_arc) = seated;
        // No live segment is not this instance's business to refuse over: the
        // walk should keep going, and a caller whose whole line has closed is
        // told so by `resolve`, which is the op that owes that sentence.
        let Some(live) = live else {
            return err(StatusCode::NOT_FOUND, "unknown_session");
        };
        return match req.op.as_str() {
            "step_closed" => {
                let Some(step) = req.step else {
                    return err(
                        StatusCode::BAD_REQUEST,
                        "step_closed names the step it closed",
                    );
                };
                let recorded = supervisor.mark_step_closed_this_turn(&live, step).await;
                (
                    StatusCode::OK,
                    axum::Json(serde_json::json!({
                        "status": "ok",
                        "session_id": live,
                        // `false` is a card this tugcast holds no entry for —
                        // rebound from tugbank, or already closed. The verb
                        // does nothing with it; it is here so a test can tell
                        // "recorded" from "there was nobody to record against".
                        "recorded": recorded,
                    })),
                )
                    .into_response()
            }
            // The gate's question, and the only op here it asks: is this
            // session an arc stage, and has the turn now in flight already
            // closed a step?
            _ => {
                let closed = supervisor.step_closed_this_turn(&live).await;
                (
                    StatusCode::OK,
                    axum::Json(serde_json::json!({
                        "status": "ok",
                        "session_id": live,
                        "on_arc": on_arc,
                        "step_closed_this_turn": closed,
                    })),
                )
                    .into_response()
            }
        };
    }
    let Some(wheel) = router.wheel.clone() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "no wheel");
    };

    match req.op.as_str() {
        "rotate" => {
            let Some(prompt) = req.prompt.clone().filter(|p| !p.is_empty()) else {
                return err(StatusCode::BAD_REQUEST, "rotate needs a prompt");
            };
            let stage = req
                .stage
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "rotate".to_string());
            // The ledger read and the arc-record read are both blocking work.
            // `unknown_session` stays a 404 whose body the CLI's port loop
            // reads as "not this instance" before trying the next one.
            let probe = {
                let ledger = Arc::clone(&ledger);
                let session_id = session_id.clone();
                tokio::task::spawn_blocking(move || {
                    let known = matches!(ledger.get(&session_id), Ok(Some(_)));
                    // The posted id is frozen at spawn, and the Wheel rotates
                    // a card's session on purpose — so a rotation asked for
                    // from inside a stage names the segment that stage began
                    // on, not the one seated now. Park against the live
                    // segment or the promise is made to a corpse and never
                    // fires ([D167]).
                    let seated = ledger.live_segment_of(&session_id).ok().flatten();
                    let on_arc = seated
                        .as_deref()
                        .is_some_and(|id| crate::wheel::arc_is_running(&ledger, id));
                    (known, seated, on_arc)
                })
                .await
            };
            let (known, seated, on_arc) = match probe {
                Ok(probe) => probe,
                Err(e) => {
                    return err(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        &format!("session task failed: {e}"),
                    );
                }
            };
            if !known {
                return err(StatusCode::NOT_FOUND, "unknown_session");
            }
            // Known here but with no live segment: this *is* the instance
            // that owns the line, so a 404 would send the CLI walking on to
            // report the wrong thing. The line has closed; say that.
            let Some(seated) = seated else {
                return err(
                    StatusCode::CONFLICT,
                    "no segment of that session's line is live — the card has closed",
                );
            };
            if on_arc {
                return err(
                    StatusCode::CONFLICT,
                    crate::wheel::Refusal::ArcRunning.reason(),
                );
            }
            // Resolved for the same reason every other project path is, even
            // though nothing here opens a repo: a spelling that reached the
            // gateway is the one the rest of the system compares against.
            if let Some(dir) = req.project_dir.as_deref() {
                let _ = crate::path_resolver::resolve_to_claude_form(std::path::Path::new(dir));
            }
            let request = crate::wheel::RotationRequest::new(
                tugcast_core::protocol::TugSessionId::new(seated),
                prompt,
                stage,
            )
            .model(req.model.clone().filter(|m| !m.is_empty()))
            .effort(req.effort.clone().filter(|e| !e.is_empty()));
            let replaced = wheel.park(request);
            (
                StatusCode::OK,
                axum::Json(
                    serde_json::json!({ "status": "ok", "pending": true, "replaced": replaced }),
                ),
            )
                .into_response()
        }
        "rotate_cancel" => {
            // Expanded the same way the rotate arm expands, so a rotated card
            // withdraws the promise it actually parked. A cancel writes
            // nothing, so an id this instance cannot place falls back to
            // itself: withdrawing a promise nobody made is already a no-op.
            let seated = {
                let ledger = Arc::clone(&ledger);
                let posted = session_id.clone();
                match tokio::task::spawn_blocking(move || {
                    ledger.live_segment_of(&posted).ok().flatten()
                })
                .await
                {
                    Ok(seated) => seated.unwrap_or(session_id),
                    Err(e) => {
                        return err(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            &format!("session task failed: {e}"),
                        );
                    }
                }
            };
            let cancelled = wheel.withdraw(&seated);
            (
                StatusCode::OK,
                axum::Json(serde_json::json!({ "status": "ok", "cancelled": cancelled })),
            )
                .into_response()
        }
        other => err(StatusCode::BAD_REQUEST, &format!("unknown op '{other}'")),
    }
}

/// Handle POST /api/changes-write — the owner side of the single-writer
/// contract ([LR8]). The body is one `changes_journal::Record`, sent by an
/// instance that lost the writer claim; the owner applies it through the
/// same funnel as its own writes (SQLite + journal) and answers with the
/// number of rows it touched, so the caller gets a durable ack. Loopback
/// only, like every tugcast API.
async fn changes_write_handler(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(router): State<FeedRouter>,
    body: Bytes,
) -> Response {
    if !addr.ip().is_loopback() {
        return changes_write_error(StatusCode::FORBIDDEN, "forbidden");
    }
    let Some(ledger) = router
        .supervisor
        .as_ref()
        .and_then(|s| s.session_ledger.clone())
    else {
        return changes_write_error(StatusCode::SERVICE_UNAVAILABLE, "no session ledger");
    };
    // Blocking work (ledger mutex, SQLite, journal fsync) stays off the
    // async workers — a busy ledger must not starve the runtime.
    match tokio::task::spawn_blocking(move || apply_changes_write(&ledger, &body)).await {
        Ok(response) => response,
        Err(e) => changes_write_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("write task failed: {e}"),
        ),
    }
}

/// The body-to-ledger half of [`changes_write_handler`], factored out so
/// the forwarding path can be exercised over a real loopback socket.
pub(crate) fn apply_changes_write(
    ledger: &crate::session_ledger::SessionLedger,
    body: &[u8],
) -> Response {
    let record: crate::changes_journal::Record = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(e) => {
            return changes_write_error(StatusCode::BAD_REQUEST, &format!("invalid record: {e}"));
        }
    };
    match ledger.apply_forwarded_change(record) {
        Ok(applied) => (
            StatusCode::OK,
            axum::Json(serde_json::json!({ "status": "ok", "applied": applied })),
        )
            .into_response(),
        Err(e) => changes_write_error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

fn changes_write_error(status: StatusCode, message: &str) -> Response {
    (
        status,
        axum::Json(serde_json::json!({ "status": "error", "message": message })),
    )
        .into_response()
}

/// Handle POST /api/eval requests for evaluating JavaScript in the browser.
///
/// Sends an eval request to the browser via CONTROL frame and waits for the
/// response. Returns the result as JSON. Timeout after 30 seconds.
async fn eval_handler(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(router): State<FeedRouter>,
    bank: Option<Extension<Arc<TugbankClient>>>,
    body: Bytes,
) -> Response {
    if !addr.ip().is_loopback() {
        return (
            StatusCode::FORBIDDEN,
            axum::Json(serde_json::json!({"status": "error", "message": "forbidden"})),
        )
            .into_response();
    }

    // Eval runs in dev mode, or on any instance whose operator has set
    // the diagnostics opt-in on this instance's bank:
    //
    //   PUT /api/defaults/diag/eval {"kind":"bool","value":true}
    //
    // (delete the key to revoke). Loopback-only either way — the
    // opt-in exists so a release deck can be inspected with the same
    // instruments as a dev one, without shipping an always-open door.
    let mut allowed = router.dev_state.load().is_some();
    if !allowed {
        if let Some(Extension(client)) = bank {
            let read = tokio::task::spawn_blocking(move || client.get("diag", "eval")).await;
            allowed = match read {
                Ok(Ok(Some(tugbank_core::Value::Bool(b)))) => b,
                Ok(Ok(Some(tugbank_core::Value::String(s)))) => s == "1" || s == "true",
                _ => false,
            };
        }
    }
    if !allowed {
        return (
            StatusCode::FORBIDDEN,
            axum::Json(
                serde_json::json!({"status": "error", "message": "eval requires dev mode or the diag/eval opt-in"}),
            ),
        )
            .into_response();
    }

    let payload: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"status": "error", "message": "invalid JSON"})),
            )
                .into_response();
        }
    };

    let code = match payload.get("code").and_then(|c| c.as_str()) {
        Some(c) => c,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"status": "error", "message": "missing code field"})),
            )
                .into_response();
        }
    };

    // Generate request ID and create oneshot channel
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();

    // Register pending eval
    {
        let mut pending = router.pending_evals.lock().unwrap();
        pending.insert(request_id.clone(), tx);
    }

    // Broadcast eval request to browser
    let eval_frame = serde_json::json!({
        "action": "eval",
        "requestId": request_id,
        "code": code,
    });
    if let Some((broadcast_tx, _)) = router.stream_outputs.get(&FeedId::CONTROL) {
        let frame = Frame::new(FeedId::CONTROL, serde_json::to_vec(&eval_frame).unwrap());
        let _ = broadcast_tx.send(frame);
    }

    // Await response with timeout
    match timeout(std::time::Duration::from_secs(30), rx).await {
        Ok(Ok(result)) => (
            StatusCode::OK,
            axum::Json(serde_json::json!({"status": "ok", "result": result})),
        )
            .into_response(),
        Ok(Err(_)) => {
            // Sender dropped (browser disconnected)
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(
                    serde_json::json!({"status": "error", "message": "browser disconnected"}),
                ),
            )
                .into_response()
        }
        Err(_) => {
            // Timeout — clean up pending entry
            let mut pending = router.pending_evals.lock().unwrap();
            pending.remove(&request_id);
            (
                StatusCode::GATEWAY_TIMEOUT,
                axum::Json(serde_json::json!({"status": "error", "message": "timeout waiting for browser response"})),
            )
                .into_response()
        }
    }
}

/// How long an ask waits for a human. Eval waits 30 seconds because a browser
/// either answers immediately or is gone; an ask waits on someone noticing a
/// dialog, so the ceiling is set where "still deciding" stops being plausible
/// and "nobody is there" becomes the honest reading.
const ASK_TIMEOUT_SECS: u64 = 600;

/// Extra time the server waits past a countdown before answering it itself.
///
/// A question carrying `unattendedChoice` is counted down by the deck, in view
/// of the developer, and the deck sends the answer. This wait is the backstop
/// for a deck that took the frame and then stopped ticking — a suspended page,
/// a card torn down mid-count. The grace exists so the ordinary case is decided
/// where the human could still see it, and this path never races the dialog.
const ASK_UNATTENDED_GRACE_SECS: u64 = 5;

/// The most questions that may be in flight at once.
///
/// A blocked ask holds a task and a map entry for as long as its timeout, and
/// nothing about the endpoint is rate-limited otherwise. The ceiling is far
/// above any real use — a human cannot be asked eight things at once — and its
/// job is only to keep a runaway script from accumulating waits without end.
const MAX_PENDING_ASKS: usize = 8;

/// Caps on caller-supplied text, in characters.
///
/// The deck renders this text. Nothing stops a caller from sending a megabyte,
/// and the dialog is card-modal for as long as it is up, so an unbounded string
/// is an unbounded defacement of the developer's Session card. These are set
/// where a real question comfortably fits and an attack does not.
const MAX_TITLE_CHARS: usize = 200;
const MAX_DESCRIPTION_CHARS: usize = 2000;
const MAX_OPTIONS: usize = 8;

/// Removes a pending ask from the map when it goes out of scope, however it
/// goes out of scope.
///
/// A `Drop` impl rather than cleanup on each return path, because one exit is
/// not a return path at all: when the caller disconnects — a `^C` on the
/// script that asked — axum aborts the handler task mid-`await`, and no
/// hand-written branch runs. Without this the entry would sit in the map for
/// good, and [`MAX_PENDING_ASKS`] interrupted runs would wedge the endpoint for
/// everyone after them.
struct PendingAskGuard {
    map: crate::router::PendingAsks,
    request_id: String,
}

impl Drop for PendingAskGuard {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.map.lock() {
            pending.remove(&self.request_id);
        }
    }
}

/// Truncate on a character boundary, appending an ellipsis when it bites.
fn clamp_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_owned();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Handle POST /api/ask requests — put a question to the human in the deck.
///
/// Sends the question to the deck via a CONTROL frame and blocks until someone
/// answers it, then returns the chosen option's opaque id.
///
/// A caller that names an `unattendedChoice` is asking for a chance to be
/// stopped rather than for permission: the deck counts `timeoutSecs` down in
/// the dialog and commits, and a count that never arrives here is answered with
/// that choice ([`ASK_UNATTENDED_GRACE_SECS`]) instead of timing out. Without
/// one, silence is still a 504 — some questions really do need a yes.
///
/// Deliberately NOT gated like `/api/eval`. Eval is gated because it executes
/// arbitrary code; ask displays text and returns one of the caller's own option
/// ids, and it has to work on a release instance — its whole purpose is to let a
/// command-line tool get consent before doing something disruptive. Loopback is
/// the trust boundary, and the deck confines caller-supplied text below fixed
/// chrome so a question cannot impersonate the app's own prompts.
///
/// Giving up the gate is exactly why the input is clamped here and the eval
/// path's is not. Eval can afford to trust its caller because only a dev build
/// answers it; this runs on the machine the developer actually uses, so size,
/// count, and duration all get ceilings ([`MAX_TITLE_CHARS`],
/// [`MAX_OPTIONS`], [`MAX_PENDING_ASKS`], [`ASK_TIMEOUT_SECS`]).
async fn ask_handler(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(router): State<FeedRouter>,
    body: Bytes,
) -> Response {
    if !addr.ip().is_loopback() {
        return (
            StatusCode::FORBIDDEN,
            axum::Json(serde_json::json!({"status": "error", "message": "forbidden"})),
        )
            .into_response();
    }

    let payload: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"status": "error", "message": "invalid JSON"})),
            )
                .into_response();
        }
    };

    let title = match payload.get("title").and_then(|t| t.as_str()) {
        Some(t) if !t.is_empty() => t,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(
                    serde_json::json!({"status": "error", "message": "missing title field"}),
                ),
            )
                .into_response();
        }
    };

    let title = clamp_chars(title, MAX_TITLE_CHARS);

    // At least one option, or there is nothing for the human to choose.
    let options = match payload.get("options").and_then(|o| o.as_array()) {
        Some(o) if !o.is_empty() && o.len() <= MAX_OPTIONS => o.clone(),
        Some(o) if o.len() > MAX_OPTIONS => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({
                    "status": "error",
                    "message": format!("at most {MAX_OPTIONS} options"),
                })),
            )
                .into_response();
        }
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(
                    serde_json::json!({"status": "error", "message": "missing or empty options field"}),
                ),
            )
                .into_response();
        }
    };

    let description = payload
        .get("description")
        .and_then(|d| d.as_str())
        .map(|d| clamp_chars(d, MAX_DESCRIPTION_CHARS))
        .map(serde_json::Value::String)
        .unwrap_or(serde_json::Value::Null);

    // The caller may shorten the wait but not extend it past the ceiling.
    let secs = payload
        .get("timeoutSecs")
        .and_then(|t| t.as_u64())
        .unwrap_or(ASK_TIMEOUT_SECS)
        .min(ASK_TIMEOUT_SECS);

    // The answer silence means, if the caller named one. It has to be one of
    // the caller's own option values — anything else would count a dialog down
    // to a choice the caller cannot interpret.
    let unattended = match payload.get("unattendedChoice") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(value))
            if options
                .iter()
                .any(|o| o.get("value").and_then(|v| v.as_str()) == Some(value.as_str())) =>
        {
            Some(value.clone())
        }
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({
                    "status": "error",
                    "message": "unattendedChoice must be one of the option values",
                })),
            )
                .into_response();
        }
    };

    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let mut pending = router.pending_asks.lock().unwrap();
        if pending.len() >= MAX_PENDING_ASKS {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                axum::Json(serde_json::json!({
                    "status": "error",
                    "message": "too many questions already waiting",
                })),
            )
                .into_response();
        }
        pending.insert(request_id.clone(), tx);
    }
    // From here on the entry is owned by the guard: every exit below — answer,
    // timeout, undeliverable, or an abort that runs no code at all — clears it.
    let _guard = PendingAskGuard {
        map: router.pending_asks.clone(),
        request_id: request_id.clone(),
    };

    let ask_frame = serde_json::json!({
        "action": "ask",
        "requestId": request_id,
        "sessionId": payload.get("sessionId").cloned().unwrap_or(serde_json::Value::Null),
        "title": title,
        "description": description,
        "options": options,
        // Present together or not at all: the deck counts down only when it has
        // both a duration and an answer to commit at the end of it.
        "unattendedChoice": unattended,
        "countdownSecs": unattended.as_ref().map(|_| secs),
    });

    // Nobody listening is a distinct answer from nobody deciding. `send` reports
    // zero receivers, and a caller that would otherwise sit out the full timeout
    // in front of a deck that was never there deserves to hear so immediately —
    // the CLI reads this as "no route" and proceeds rather than treating it as a
    // refusal. Answering every blocked caller on every path is the invariant the
    // deck-side store keeps too; this is its other end.
    let delivered = match router.stream_outputs.get(&FeedId::CONTROL) {
        Some((broadcast_tx, _)) => {
            let frame = Frame::new(FeedId::CONTROL, serde_json::to_vec(&ask_frame).unwrap());
            broadcast_tx.send(frame).is_ok()
        }
        None => false,
    };
    if !delivered {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(serde_json::json!({"status": "error", "message": "no deck is connected"})),
        )
            .into_response();
    }

    let wait = match unattended {
        Some(_) => secs + ASK_UNATTENDED_GRACE_SECS,
        None => secs,
    };

    match timeout(std::time::Duration::from_secs(wait), rx).await {
        Ok(Ok(choice)) => (
            StatusCode::OK,
            axum::Json(serde_json::json!({"status": "ok", "choice": choice})),
        )
            .into_response(),
        Ok(Err(_)) => {
            // Sender dropped — the deck went away mid-question.
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({"status": "error", "message": "deck disconnected"})),
            )
                .into_response()
        }
        // Nobody answered. With an `unattendedChoice` that is itself the
        // answer — the caller said so — and reporting it as a timeout would
        // turn "nobody was at the keyboard" back into a refusal. Either way
        // the question is resolved HERE now, so the deck is told to take its
        // dialog down — a question that expires silently leaves the dialog
        // standing and the session reading Awaiting forever, with every press
        // on it answering a caller that already left.
        Err(_) => {
            broadcast_ask_rescind(&router, &request_id);
            match unattended {
                Some(choice) => (
                    StatusCode::OK,
                    axum::Json(serde_json::json!({"status": "ok", "choice": choice})),
                )
                    .into_response(),
                None => (
                    StatusCode::GATEWAY_TIMEOUT,
                    axum::Json(serde_json::json!({
                        "status": "error",
                        "message": "timeout waiting for answer",
                    })),
                )
                    .into_response(),
            }
        }
    }
}

/// Tell the deck a question no longer waits for an answer — its caller has
/// been answered (or told) by the server, so the dialog must come down.
/// Best-effort: a deck that is gone has no dialog to take down.
fn broadcast_ask_rescind(router: &FeedRouter, request_id: &str) {
    if let Some((broadcast_tx, _)) = router.stream_outputs.get(&FeedId::CONTROL) {
        let frame = serde_json::json!({"action": "ask-rescind", "requestId": request_id});
        let _ = broadcast_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&frame).unwrap(),
        ));
    }
}

/// Build the axum application router
///
/// Constructs the Router with auth, WebSocket, and API routes.
/// Separated from `run_server` to enable testing without TCP binding.
///
/// Static-file serving: tugcast always checks for a built frontend at
/// `resources::source_tree().join("tugdeck/dist")`. In a bundled Tug.app
/// this resolves to `Contents/Resources/tugdeck/dist/` (via `TUGCAST_RESOURCE_ROOT`
/// set by `ProcessManager.swift`). In a dev `cargo run` without the env var,
/// it falls back to `<repo>/tugdeck/dist/`. If the dist directory does not
/// exist, a warning is logged and unmatched routes return axum's default
/// 404 (API routes remain fully functional).
///
/// When `bank_store` is `Some(client)`, registers the four `/api/defaults`
/// routes with the client as an `Extension`. When `None`, the defaults routes
/// are not registered — this avoids a missing-Extension panic since no
/// defaults routes are reachable in callers (e.g., tests) that do not supply
/// a client. The client is created externally (in `main.rs`) so that migration
/// can share the same connection before the server starts accepting connections.
///
/// What the prompt-history routes need, in one value because it is two
/// databases with different lifetimes and the pairing is the load-bearing part.
///
/// `ledger` is machine-global and never trims; `sessions` is per-instance and
/// evicts. The corpus is keyed by a session id that rotates on every relaunch,
/// so a read has to resolve the id through the session ledger's fork and resume
/// edges — and record what it resolved, because the evicting half is the only
/// one that can still learn. Handing the routes the ledger alone is what made a
/// relaunched card come back with no history at all.
pub(crate) struct PromptHistoryDeps {
    pub ledger: Arc<crate::prompt_ledger::PromptLedger>,
    /// `None` when the session ledger did not open: reads fall back to the
    /// lineage already recorded in the corpus, which is degraded, not blank.
    pub sessions: Option<Arc<crate::session_ledger::SessionLedger>>,
}

/// `prompt_history` follows the same pattern: `None` leaves the prompt-history
/// routes unregistered rather than registering handlers that would panic on a
/// missing `Extension`. A composer talking to a build whose ledger failed to
/// open therefore gets a 404 it can report, not a hang.
pub(crate) fn build_app(
    router: FeedRouter,
    _dev_state: SharedDevState,
    bank_store: Option<Arc<TugbankClient>>,
    jots_state: Option<Arc<crate::jots::JotsState>>,
    prompt_history: Option<PromptHistoryDeps>,
) -> Router {
    // Allow any origin on localhost — tugcast only binds to loopback.
    // This prevents WKWebView CORS errors during page teardown (keepalive
    // fetches during beforeunload) and for cross-port requests when the
    // page is served by Vite dev server on a different port.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let mut base = Router::new()
        .route("/auth", get(crate::auth::handle_auth))
        .route("/ws", get(crate::router::ws_handler))
        .route("/api/tell", post(tell_handler))
        .route("/api/eval", post(eval_handler))
        .route("/api/ask", post(ask_handler))
        .route("/api/host", get(crate::host::get_host))
        .route("/api/changesets", get(changesets_handler))
        .route("/api/ink-census", get(ink_census_handler))
        .route("/api/draft", post(draft_handler))
        .route("/api/arc", post(arc_handler))
        .route("/api/session", post(session_handler))
        .route("/api/changes-write", post(changes_write_handler))
        // A frontend fault outlives the page it happened on: the user's
        // next act is Reload, which destroys every in-memory record of it.
        .route(
            "/api/client-fault",
            post(crate::client_fault::post_client_fault),
        )
        .route(
            "/api/workspace/acquire",
            post(crate::workspace_api::post_workspace_acquire),
        )
        .route(
            "/api/workspace/release",
            post(crate::workspace_api::post_workspace_release),
        )
        .route("/api/permissions", get(crate::permissions::get_permissions))
        .route("/api/permissions/rule", post(crate::permissions::post_rule))
        .route("/api/fs/complete", get(crate::fs_complete::get_fs_complete))
        .route("/api/fs/read", get(crate::fs_read::get_fs_read))
        .route("/api/fs/blob", get(crate::fs_blob::get_fs_blob))
        .route("/api/fs/bytes", get(crate::fs_blob::get_fs_bytes))
        .route("/api/fs/mkdir", post(crate::fs_mkdir::post_fs_mkdir))
        .route("/api/fs/stat", post(crate::fs_stat::post_fs_stat))
        .route(
            "/api/attachments",
            // Raw file bytes, so the limit is the file size itself.
            post(crate::attachments::post_attachments).layer(DefaultBodyLimit::max(
                crate::attachments::MAX_ATTACHMENT_BODY_BYTES,
            )),
        )
        .route(
            "/api/fs/attach",
            post(crate::attachments::post_fs_attach).layer(DefaultBodyLimit::max(
                crate::attachments::MAX_ATTACHMENT_BODY_BYTES,
            )),
        )
        .route(
            "/api/fs/attach-base",
            get(crate::attachments::get_attach_base),
        )
        .route(
            "/api/fs/attach/migrate",
            post(crate::attachments::post_attach_migrate),
        )
        .route(
            "/api/fs/write",
            // Per-route body limit above axum's 2 MB default so an 8 MiB
            // file (the read cap) still saves through the JSON envelope.
            post(crate::fs_write::post_fs_write)
                .layer(DefaultBodyLimit::max(crate::fs_write::MAX_WRITE_BODY_BYTES)),
        )
        .with_state(router)
        .layer(cors);

    // Wire defaults routes when an already-opened store is provided.
    if let Some(store) = bank_store {
        base = base
            .route("/api/defaults/{domain}", get(crate::defaults::get_domain))
            .route(
                "/api/defaults/{domain}/{key}",
                get(crate::defaults::get_key)
                    .put(crate::defaults::put_key)
                    .delete(crate::defaults::delete_key),
            )
            .layer(Extension(store));
    }

    // Wire the jots routes when a state (resolved file path) is provided.
    if let Some(state) = jots_state {
        base = base
            .route(
                "/api/jots",
                get(crate::jots::get_jots).put(crate::jots::put_jots),
            )
            .layer(Extension(state));
    }

    // Wire the prompt-history routes when the ledger opened.
    if let Some(deps) = prompt_history {
        base = base
            .route(
                "/api/prompt-history",
                get(crate::prompt_history_api::get_prompt_history)
                    .post(crate::prompt_history_api::post_prompt_history),
            )
            .route(
                "/api/prompt-history/atom-path",
                post(crate::prompt_history_api::post_prompt_history_atom_path),
            )
            .layer(Extension(deps.ledger))
            .layer(Extension(crate::prompt_lineage::LineageSource::new(
                deps.sessions,
            )));
    }

    let dist_path = crate::resources::source_tree().join("tugdeck").join("dist");
    if dist_path.is_dir() {
        let index_html = dist_path.join("index.html");
        return base.fallback_service(
            ServeDir::new(&dist_path).not_found_service(ServeFile::new(index_html)),
        );
    } else {
        warn!(
            "dist directory not found at {}, static file serving disabled",
            dist_path.display()
        );
    }

    base
}

/// Run the HTTP server
///
/// Serves the axum application on the provided `TcpListener`.
/// The `bank_store` is forwarded to `build_app` to enable the defaults
/// endpoints backed by the tugbank SQLite database. The client is created
/// in `main.rs` before startup so migration can share the same connection.
pub async fn run_server(
    listener: TcpListener,
    router: FeedRouter,
    dev_state: SharedDevState,
    bank_store: Option<Arc<TugbankClient>>,
    jots_state: Option<Arc<crate::jots::JotsState>>,
    prompt_history: Option<PromptHistoryDeps>,
) -> Result<(), std::io::Error> {
    let app = build_app(router, dev_state, bank_store, jots_state, prompt_history);

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── /api/session `resolve` — the identity chokepoint ──────────────────

    /// The Wheel's shape: a line whose stages have each rotated a fresh id,
    /// only the newest live. `$TUG_SESSION_ID` inside that card still names
    /// the first.
    fn rotated_ledger() -> crate::session_ledger::SessionLedger {
        let l = crate::session_ledger::SessionLedger::open_in_memory().expect("ledger");
        l.record_spawn("seg-old", "ws", "/proj", "card-1", 1_000, "line-1", None)
            .unwrap();
        l.demote_live_to_closed().unwrap();
        l.record_spawn("seg-new", "ws", "/proj", "card-1", 2_000, "line-1", None)
            .unwrap();
        l
    }

    #[test]
    fn resolve_expands_a_stale_id_to_the_seated_segment() {
        let l = rotated_ledger();
        let answer = resolve_session_identity(&l, "seg-old").expect("resolves");
        assert_eq!(answer["session_id"], "seg-new");
        assert_eq!(answer["posted"], "seg-old");
        assert_eq!(answer["posted_state"], "closed");
        assert_eq!(answer["state"], "live");
        assert_eq!(answer["rotated"], true);
        let segments: Vec<String> = serde_json::from_value(answer["segments"].clone()).unwrap();
        assert!(segments.contains(&"seg-old".to_string()));
        assert!(segments.contains(&"seg-new".to_string()));
    }

    #[test]
    fn resolve_answers_for_itself_when_nothing_has_rotated() {
        let l = rotated_ledger();
        let answer = resolve_session_identity(&l, "seg-new").expect("resolves");
        assert_eq!(answer["session_id"], "seg-new");
        assert_eq!(answer["rotated"], false);
    }

    /// The two refusals are different sentences on purpose: one sends the
    /// CLI walking to the next instance, the other says the card has gone.
    #[test]
    fn resolve_refuses_an_unknown_id_and_a_closed_line_differently() {
        let l = rotated_ledger();
        assert!(matches!(
            resolve_session_identity(&l, "never-seen"),
            Err(IdentityRefusal::Unknown)
        ));
        l.demote_live_to_closed().unwrap();
        match resolve_session_identity(&l, "seg-old") {
            Err(IdentityRefusal::LineClosed(message)) => {
                assert!(message.contains("seg-old"), "names the id it was handed");
                assert!(message.contains("closed"), "and its state: {message}");
            }
            other => panic!("expected a closed-line refusal, got {other:?}"),
        }
    }

    #[test]
    fn test_tell_request_deserialization() {
        let json = r#"{"action":"test-ping"}"#;
        let req: TellRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.action, "test-ping");
    }

    #[test]
    fn test_tell_request_missing_action() {
        let json = r#"{"foo":"bar"}"#;
        let result: Result<TellRequest, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    #[test]
    fn test_action_classification() {
        // All actions are now client-only (broadcast to Control feed).
        // restart, reset, and relaunch have been removed.
        assert_ne!("reload", "restart");
        assert_ne!("reload", "reset");
        assert_ne!("show-card", "restart");
        assert_ne!("show-card", "reset");
    }

    // --- /api/draft: the owner-key migration axis ([P03], Spec S02) --------

    const ID_KEY: &str = "tugarc/demo#1723500000000-a1b2c3";
    const LEGACY_KEY: &str = "tugarc/demo";

    /// The row key the handler will write for `project_dir` — the [L29]
    /// gateway's answer, computed the same way the handler computes it.
    fn draft_project_key(project_dir: &str) -> String {
        crate::path_resolver::resolve_to_claude_form(std::path::Path::new(project_dir))
            .to_string_lossy()
            .into_owned()
    }

    fn draft_request(op: &str, message: Option<&str>) -> DraftApiRequest {
        DraftApiRequest {
            op: op.to_string(),
            owner_kind: "arc".to_string(),
            owner_id: ID_KEY.to_string(),
            legacy_owner_id: Some(LEGACY_KEY.to_string()),
            legacy_owner_ids: Vec::new(),
            project_dir: "/proj".to_string(),
            raw_project_dir: None,
            superseded_project_dirs: Vec::new(),
            message: message.map(str::to_owned),
            selection: None,
        }
    }

    fn seed_legacy_draft(
        ledger: &crate::session_ledger::SessionLedger,
        project_key: &str,
        message: &str,
    ) {
        ledger
            .upsert_changeset_draft(&crate::session_ledger::ChangesetDraftRow {
                owner_kind: "arc".to_string(),
                owner_id: LEGACY_KEY.to_string(),
                project_dir: project_key.to_string(),
                fingerprint: "fp".to_string(),
                message: message.to_string(),
                updated_at: 1,
                edited: true,
                selection: None,
            })
            .unwrap();
    }

    /// A `set` under the id key supersedes the legacy-keyed row — in
    /// production, not only on the CLI's test-isolated direct path.
    #[test]
    fn draft_set_supersedes_the_legacy_owner_key_row() {
        let ledger = crate::session_ledger::SessionLedger::open_in_memory().unwrap();
        let project = draft_project_key("/proj");
        seed_legacy_draft(&ledger, &project, "Old message");

        let _ = apply_draft_request(&ledger, &draft_request("set", Some("New message")));

        assert_eq!(
            ledger
                .changeset_draft("arc", ID_KEY, &project)
                .unwrap()
                .map(|r| r.message),
            Some("New message".to_string())
        );
        assert!(
            ledger
                .changeset_draft("arc", LEGACY_KEY, &project)
                .unwrap()
                .is_none(),
            "the legacy-keyed row is superseded by the write"
        );
    }

    /// An arc draft written from inside the arc worktree keys on the base
    /// repository root and names the worktree as superseded. Both request
    /// spelling slots are spoken for by the base root, so without the third
    /// slot the sweep could not reach the worktree row at all — and it is the
    /// worktree rows that made every planned run's authored draft invisible to
    /// its join.
    #[test]
    fn draft_set_supersedes_a_row_under_a_superseded_directory() {
        let ledger = crate::session_ledger::SessionLedger::open_in_memory().unwrap();
        let base = draft_project_key("/proj");
        let worktree = draft_project_key("/proj/.tug/worktrees/demo");
        ledger
            .upsert_changeset_draft(&crate::session_ledger::ChangesetDraftRow {
                owner_kind: "arc".to_string(),
                owner_id: ID_KEY.to_string(),
                project_dir: worktree.clone(),
                fingerprint: "fp".to_string(),
                message: "The invisible draft".to_string(),
                updated_at: 1,
                edited: true,
                selection: None,
            })
            .unwrap();

        let mut req = draft_request("set", None);
        req.superseded_project_dirs = vec![worktree.clone()];
        let response = apply_draft_request(&ledger, &req);
        assert_eq!(response.status(), StatusCode::OK);

        // The worktree row was read through as the fallback, so its message
        // survives — under the base root, where the join looks.
        assert_eq!(
            ledger
                .changeset_draft("arc", ID_KEY, &base)
                .unwrap()
                .map(|r| r.message),
            Some("The invisible draft".to_string())
        );
        assert!(
            ledger
                .changeset_draft("arc", ID_KEY, &worktree)
                .unwrap()
                .is_none(),
            "the worktree-keyed row is superseded by the write"
        );
    }

    /// A `set` that carries no message reads the legacy-keyed row through the
    /// fallback instead of failing "nothing to set" — the failure mode the
    /// owner-key axis exists to prevent.
    #[test]
    fn draft_set_without_a_message_reads_through_the_legacy_owner_key() {
        let ledger = crate::session_ledger::SessionLedger::open_in_memory().unwrap();
        let project = draft_project_key("/proj");
        seed_legacy_draft(&ledger, &project, "Carried forward");

        let response = apply_draft_request(&ledger, &draft_request("set", None));
        assert_eq!(response.status(), StatusCode::OK);

        assert_eq!(
            ledger
                .changeset_draft("arc", ID_KEY, &project)
                .unwrap()
                .map(|r| r.message),
            Some("Carried forward".to_string())
        );
    }

    /// A `clear` sweeps both keys, so a reused arc name inherits nothing.
    #[test]
    fn draft_clear_sweeps_both_owner_keys() {
        let ledger = crate::session_ledger::SessionLedger::open_in_memory().unwrap();
        let project = draft_project_key("/proj");
        seed_legacy_draft(&ledger, &project, "Old message");
        let _ = apply_draft_request(&ledger, &draft_request("set", Some("New message")));
        seed_legacy_draft(&ledger, &project, "Resurrected");

        let response = apply_draft_request(&ledger, &draft_request("clear", None));
        assert_eq!(response.status(), StatusCode::OK);

        for key in [ID_KEY, LEGACY_KEY] {
            assert!(
                ledger
                    .changeset_draft("arc", key, &project)
                    .unwrap()
                    .is_none(),
                "row under {key} survived the clear"
            );
        }
    }

    // --- /api/ask ---------------------------------------------------------
    //
    // These run the real axum app over a real loopback socket, so what is under
    // test is the route as it is actually served — including the loopback guard
    // and the CONTROL broadcast the deck subscribes to.

    /// A live app on an ephemeral loopback port, plus a CONTROL receiver
    /// standing in for the deck's subscription and the router's ask map.
    struct AskFixture {
        base_url: String,
        control_rx: tokio::sync::broadcast::Receiver<Frame>,
        pending_asks: crate::router::PendingAsks,
    }

    /// POST a JSON body and read back `(status, parsed body)`. Spelled out
    /// rather than using reqwest's `json` helpers, which this crate's feature
    /// set does not enable.
    async fn post_json(url: &str, body: &serde_json::Value) -> (u16, serde_json::Value) {
        let response = reqwest::Client::new()
            .post(url)
            .header("content-type", "application/json")
            .body(serde_json::to_string(body).unwrap())
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        let text = response.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap())
    }

    async fn serve_ask_fixture() -> AskFixture {
        let (shutdown_tx, _shutdown_rx) = tokio::sync::mpsc::channel(1);
        let dev_state = crate::dev::new_shared_dev_state();
        let mut router = FeedRouter::new(
            "test-session".to_owned(),
            crate::auth::new_shared_auth_state_no_auth(0),
            shutdown_tx,
            dev_state.clone(),
        );
        let (control_tx, control_rx) = tokio::sync::broadcast::channel(16);
        router.register_stream(FeedId::CONTROL, control_tx, crate::router::LagPolicy::Warn);
        let pending_asks = router.pending_asks.clone();

        let app = build_app(router, dev_state, None, None, None);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });

        AskFixture {
            base_url: format!("http://127.0.0.1:{port}"),
            control_rx,
            pending_asks,
        }
    }

    fn ask_body(timeout_secs: u64) -> serde_json::Value {
        serde_json::json!({
            "title": "3 of 12 app-tests will take the screen",
            "description": "at0145, at0165, at0014",
            "timeoutSecs": timeout_secs,
            "options": [
                {"value": "run-all", "label": "Run all"},
                {"value": "cancel", "label": "Cancel"},
            ],
        })
    }

    /// The whole round trip: the question reaches the deck, the answer comes
    /// back on the HTTP response.
    #[tokio::test]
    async fn test_ask_round_trip_returns_the_choice() {
        let mut fx = serve_ask_fixture().await;
        let url = format!("{}/api/ask", fx.base_url);

        let request = tokio::spawn(async move { post_json(&url, &ask_body(30)).await });

        // Stand in for the deck: read the broadcast question, answer it.
        let frame = fx.control_rx.recv().await.unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(payload["action"], "ask");
        assert_eq!(payload["title"], "3 of 12 app-tests will take the screen");
        assert_eq!(payload["options"][0]["value"], "run-all");
        let request_id = payload["requestId"].as_str().unwrap().to_owned();

        let tx = fx.pending_asks.lock().unwrap().remove(&request_id).unwrap();
        tx.send("run-all".to_owned()).unwrap();

        let (status, body) = request.await.unwrap();
        assert_eq!(status, 200);
        assert_eq!(body["status"], "ok");
        assert_eq!(body["choice"], "run-all");
    }

    /// Nobody answers — the caller learns that rather than blocking forever.
    #[tokio::test]
    async fn test_ask_times_out_and_clears_the_pending_entry() {
        let fx = serve_ask_fixture().await;
        let (status, body) = post_json(&format!("{}/api/ask", fx.base_url), &ask_body(1)).await;

        assert_eq!(status, 504);
        assert_eq!(body["message"], "timeout waiting for answer");
        assert!(fx.pending_asks.lock().unwrap().is_empty());
    }

    /// A countdown question carries its answer and its duration to the deck,
    /// which is what lets the dialog show the count and commit at zero.
    #[tokio::test]
    async fn test_ask_forwards_the_unattended_answer_to_the_deck() {
        let mut fx = serve_ask_fixture().await;
        let url = format!("{}/api/ask", fx.base_url);
        let mut body = ask_body(30);
        body["unattendedChoice"] = serde_json::json!("run-all");

        let request = tokio::spawn(async move { post_json(&url, &body).await });

        let frame = fx.control_rx.recv().await.unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(payload["unattendedChoice"], "run-all");
        assert_eq!(payload["countdownSecs"], 30);

        let request_id = payload["requestId"].as_str().unwrap().to_owned();
        let tx = fx.pending_asks.lock().unwrap().remove(&request_id).unwrap();
        tx.send("cancel".to_owned()).unwrap();
        let (status, body) = request.await.unwrap();
        assert_eq!(status, 200);
        // Intervention wins: the countdown is a default, not a verdict.
        assert_eq!(body["choice"], "cancel");
    }

    /// A deck that never answers a countdown question — suspended, torn down —
    /// must not turn the caller's own default back into a refusal.
    #[tokio::test]
    async fn test_ask_answers_an_unanswered_countdown_with_the_default() {
        let fx = serve_ask_fixture().await;
        let mut body = ask_body(0);
        body["unattendedChoice"] = serde_json::json!("run-all");

        let (status, body) = post_json(&format!("{}/api/ask", fx.base_url), &body).await;

        assert_eq!(status, 200);
        assert_eq!(body["choice"], "run-all");
        assert!(fx.pending_asks.lock().unwrap().is_empty());
    }

    /// An unattended answer nobody offered would count down to a value the
    /// caller cannot interpret.
    #[tokio::test]
    async fn test_ask_rejects_an_unattended_choice_that_is_not_an_option() {
        let fx = serve_ask_fixture().await;
        let mut body = ask_body(30);
        body["unattendedChoice"] = serde_json::json!("run-them");

        let (status, body) = post_json(&format!("{}/api/ask", fx.base_url), &body).await;

        assert_eq!(status, 400);
        assert_eq!(
            body["message"],
            "unattendedChoice must be one of the option values"
        );
    }

    /// A question with no options has nothing to choose and is refused.
    #[tokio::test]
    async fn test_ask_rejects_empty_options() {
        let fx = serve_ask_fixture().await;
        let (status, _) = post_json(
            &format!("{}/api/ask", fx.base_url),
            &serde_json::json!({"title": "hi", "options": []}),
        )
        .await;
        assert_eq!(status, 400);
    }

    /// A question with no title would render as chrome with no question in it.
    #[tokio::test]
    async fn test_ask_rejects_missing_title() {
        let fx = serve_ask_fixture().await;
        let (status, _) = post_json(
            &format!("{}/api/ask", fx.base_url),
            &serde_json::json!({"options": [{"value": "a", "label": "A"}]}),
        )
        .await;
        assert_eq!(status, 400);
    }

    /// Nobody is listening — say so at once instead of holding the caller for
    /// the full timeout in front of a deck that was never there.
    #[tokio::test]
    async fn test_ask_with_no_deck_answers_immediately() {
        let fx = serve_ask_fixture().await;
        // Drop the stand-in deck's subscription: the broadcast now has zero
        // receivers, which is exactly the "app running, no browser" case.
        drop(fx.control_rx);

        let (status, body) = post_json(&format!("{}/api/ask", fx.base_url), &ask_body(600)).await;

        assert_eq!(status, 503);
        assert_eq!(body["message"], "no deck is connected");
        assert!(fx.pending_asks.lock().unwrap().is_empty());
    }

    /// More options than a person can weigh is a malformed question, not a long
    /// one — and the dialog would grow without bound rendering them.
    #[tokio::test]
    async fn test_ask_rejects_too_many_options() {
        let fx = serve_ask_fixture().await;
        let options: Vec<_> = (0..MAX_OPTIONS + 1)
            .map(|i| serde_json::json!({"value": format!("v{i}"), "label": "L"}))
            .collect();
        let (status, _) = post_json(
            &format!("{}/api/ask", fx.base_url),
            &serde_json::json!({"title": "hi", "options": options}),
        )
        .await;
        assert_eq!(status, 400);
    }

    /// Caller text is clamped before it reaches the deck: the dialog is
    /// card-modal while it is up, so an unbounded string is an unbounded
    /// defacement of the developer's card.
    #[tokio::test]
    async fn test_ask_clamps_caller_text() {
        let mut fx = serve_ask_fixture().await;
        let url = format!("{}/api/ask", fx.base_url);
        let body = serde_json::json!({
            "title": "T".repeat(MAX_TITLE_CHARS * 2),
            "description": "D".repeat(MAX_DESCRIPTION_CHARS * 2),
            "timeoutSecs": 1,
            "options": [{"value": "a", "label": "A"}],
        });
        let request = tokio::spawn(async move { post_json(&url, &body).await });

        let frame = fx.control_rx.recv().await.unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(
            payload["title"].as_str().unwrap().chars().count(),
            MAX_TITLE_CHARS
        );
        assert_eq!(
            payload["description"].as_str().unwrap().chars().count(),
            MAX_DESCRIPTION_CHARS
        );

        let _ = request.await.unwrap();
    }

    /// A runaway script cannot accumulate waits without end.
    #[tokio::test]
    async fn test_ask_caps_concurrent_questions() {
        let fx = serve_ask_fixture().await;
        let url = format!("{}/api/ask", fx.base_url);

        // Fill the map directly — the point under test is the admission check,
        // not the spawning of real waiters.
        {
            let mut pending = fx.pending_asks.lock().unwrap();
            for i in 0..MAX_PENDING_ASKS {
                let (tx, _rx) = tokio::sync::oneshot::channel();
                pending.insert(format!("filler-{i}"), tx);
            }
        }

        let (status, body) = post_json(&url, &ask_body(1)).await;
        assert_eq!(status, 429);
        assert_eq!(body["message"], "too many questions already waiting");
    }

    #[test]
    fn clamp_chars_leaves_short_text_alone() {
        assert_eq!(clamp_chars("hello", 10), "hello");
    }

    /// Counts characters, not bytes — a multi-byte title must not be sliced
    /// mid-codepoint.
    #[test]
    fn clamp_chars_counts_characters() {
        let s = "日本語のタイトル";
        assert_eq!(clamp_chars(s, 4).chars().count(), 4);
        assert!(clamp_chars(s, 4).ends_with('…'));
    }
}
