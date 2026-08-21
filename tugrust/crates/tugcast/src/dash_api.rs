//! `POST /api/dash` — the session↔dash binding write surface for short-lived
//! CLI processes (Spec S04, [P04]).
//!
//! Mirrors `server.rs::draft_handler`: loopback-only, blocking work on the
//! blocking pool, one ledger writer. It differs in one way that matters —
//! `sessions.db` is **per-instance**, so unlike `/api/draft` (whose target is
//! the machine-global changes ledger, making any instance a valid conduit) a
//! bind must land on the instance that owns the session. An instance that does
//! not answers `unknown_session`, and the CLI walks on to the next one.
//!
//! Every `project_dir` on this endpoint is resolved through
//! `path_resolver::resolve_to_claude_form` on arrival ([L29]). The CLI ships
//! its own spelling untouched; the gateway is here.

use crate::session_ledger::SessionLedger;

/// What a binding write did, in the vocabulary the CLI's try-each-instance
/// loop reads: `UnknownSession` means "not mine, keep looking", an error means
/// "mine, and it failed".
pub(crate) enum DashApiOutcome {
    Bound {
        dash_id: String,
        dash_name: String,
    },
    Unbound,
    /// How many binding rows a `dash_gone` swept.
    Cleared(usize),
    /// This instance's ledger has no such session — the CLI should try the
    /// next live instance rather than report a failure.
    UnknownSession,
    Error(String),
}

/// Bind a session to a dash ([P04], Spec S04).
///
/// `project_dir` must already be resolved through the [L29] gateway. Minting
/// is correct here: a bind is a write-path verb ([P02]), so an id-less dash
/// from an older build gains its creation id at the moment something first
/// keys by it.
pub(crate) fn bind(
    ledger: &SessionLedger,
    project_dir: &std::path::Path,
    tug_session_id: &str,
    dash: &str,
) -> DashApiOutcome {
    let Some(row) = ledger.get(tug_session_id).ok().flatten() else {
        return DashApiOutcome::UnknownSession;
    };
    // **A session may only bind a dash in its own project**, which is the rule
    // the Lens's Bind control already states to the user ("This dash belongs to
    // …") and the server was taking on trust. It is not a nicety: without it a
    // short-lived CLI process anywhere on the machine can rebind a live
    // session to a dash in a directory that session has never seen. That is
    // how an app-test's scratch dash came to own a developer's session, and
    // the face went blank because the dash it named no longer existed.
    if !same_project(&row.project_dir, project_dir) {
        return DashApiOutcome::Error(format!(
            "session {tug_session_id} works {} — it cannot bind a dash in {}",
            row.project_dir,
            project_dir.display()
        ));
    }
    let dash_id = match tugdash_core::ops::ensure_dash_id(project_dir, dash) {
        Ok(id) => id,
        Err(e) => return DashApiOutcome::Error(e),
    };
    match ledger.set_dash_binding(tug_session_id, Some((&dash_id, dash))) {
        Ok(_) => DashApiOutcome::Bound {
            dash_id,
            dash_name: dash.to_string(),
        },
        Err(e) => DashApiOutcome::Error(e.to_string()),
    }
}

/// Clear one session's binding ([P04], Spec S04).
pub(crate) fn unbind(ledger: &SessionLedger, tug_session_id: &str) -> DashApiOutcome {
    if !owns_session(ledger, tug_session_id) {
        return DashApiOutcome::UnknownSession;
    }
    match ledger.set_dash_binding(tug_session_id, None) {
        Ok(_) => DashApiOutcome::Unbound,
        Err(e) => DashApiOutcome::Error(e.to_string()),
    }
}

/// Sweep every binding to a dead dash, plus its authored draft row.
///
/// `dash_id` is the owner key the caller captured **before** the teardown that
/// deleted the dash's branch ([P05], Risk R02). This endpoint never re-derives
/// it: by the time the call is made, the branch config it would read is gone,
/// and the only key it could produce would be the legacy one — which names
/// none of the id-keyed rows it is here to remove ([L23]).
pub(crate) fn dash_gone(
    ledger: &SessionLedger,
    project_dir: &std::path::Path,
    dash_id: &str,
) -> DashApiOutcome {
    let cleared = match ledger.clear_dash_bindings_for_dash(dash_id) {
        Ok(n) => n,
        Err(e) => return DashApiOutcome::Error(e.to_string()),
    };
    crate::feeds::agent_supervisor::AgentSupervisor::clear_dash_draft(
        ledger,
        &project_dir.to_string_lossy(),
        dash_id,
    );
    DashApiOutcome::Cleared(cleared)
}

/// Whether this instance's ledger holds the session — the ownership check
/// that makes try-each-instance terminate on the right instance.
fn owns_session(ledger: &SessionLedger, tug_session_id: &str) -> bool {
    ledger.get(tug_session_id).ok().flatten().is_some()
}

/// Whether a session working `session_project` may bind a dash in
/// `dash_project`.
///
/// Both sides go through the [L29] gateway before they are compared, so the
/// two spellings of one directory — the session's, recorded at spawn, and the
/// CLI's, taken from a cwd — cannot read as two projects. A dash **worktree**
/// counts as its own project's path here rather than the main checkout's:
/// `dash create` from inside one already names the checkout, and reaching
/// through would be a second, quieter path resolution beside the gateway's.
fn same_project(session_project: &str, dash_project: &std::path::Path) -> bool {
    crate::path_resolver::resolve_to_claude_form(std::path::Path::new(session_project))
        == crate::path_resolver::resolve_to_claude_form(dash_project)
}
