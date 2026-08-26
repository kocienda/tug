//! `POST /api/dash` — the session↔dash binding write surface for short-lived
//! CLI processes.
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
    /// What a `dash_gone` swept: how many binding rows, and which of them were
    /// carrying a live arc's stage.
    Cleared {
        cleared: usize,
        seated: Vec<SeatedArcStage>,
    },
    /// The live arc this card runs, and the stage it will be stopped in. The
    /// blocking half resolves it; the handler's async half performs the stop.
    ArcStopped {
        dash: String,
        stage: tugdash_core::arc::ArcStage,
        session_id: String,
        project_dir: String,
    },
    /// This instance's ledger has no such session — the CLI should try the
    /// next live instance rather than report a failure.
    UnknownSession,
    Error(String),
}

/// A card an ending found a live arc's stage seated on.
///
/// It carries the dash name and the project rather than leaving the caller to
/// re-derive them: `dash_gone` is handed a dash **id**, and by the time it runs
/// the teardown has already destroyed the branch config that would translate
/// one ([L23]). Both come off the bound session's own row, which is still
/// there when the sweep reads it.
pub(crate) struct SeatedArcStage {
    pub session_id: String,
    pub dash_name: String,
    pub project_dir: String,
    pub stage: tugdash_core::arc::ArcStage,
}

/// Which gesture ended the dash.
///
/// `dash_gone` is the teardown of *any* ending — `broadcast_dash_gone` is
/// called from the discard and from both join paths — so the card is told
/// which one happened rather than being told the discard's story about a join.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DashGoneReason {
    Discarded,
    Joined,
}

impl DashGoneReason {
    /// Read the op's optional field. An older `tugutil` sends none, and a
    /// discard is what every caller before the field existed was.
    pub(crate) fn parse(word: Option<&str>) -> DashGoneReason {
        match word {
            Some("joined") => DashGoneReason::Joined,
            _ => DashGoneReason::Discarded,
        }
    }

    /// The stop reason whose sentence the ending's receipt is worded from.
    pub(crate) fn stop_reason(&self) -> tugdash_core::arc::ArcStopReason {
        match self {
            DashGoneReason::Discarded => tugdash_core::arc::ArcStopReason::Discarded,
            DashGoneReason::Joined => tugdash_core::arc::ArcStopReason::Joined,
        }
    }

    /// The word the retirement receipt leads with.
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            DashGoneReason::Discarded => "discarded",
            DashGoneReason::Joined => "joined",
        }
    }
}

/// Bind a session to a dash.
///
/// `project_dir` must already be resolved through the [L29] gateway. Minting
/// is correct here: a bind is a write-path verb, so an id-less dash
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
    // **A card runs at most one score.** A bind that displaced a live one left
    // the first arc's record reading live forever with no stop and no receipt:
    // the sweep is live-bindings-only, so the displaced arc simply dropped out
    // of it. That interruption has no honest row in any table, so it is
    // refused rather than described.
    //
    // The check reads the session's *current* binding, which is exactly the
    // arc about to be displaced — the one this refusal protects. It cannot
    // fire on the arc's own binds: `score_is_running` is false with no
    // binding, no arc record, or a `done`/`stopped` one, and a bind naming the
    // dash already running is the resume path, which is a no-op here.
    if crate::wheel::score_is_running(ledger, tug_session_id)
        && row.dash_name.as_deref() != Some(dash)
    {
        let running = row.dash_name.as_deref().unwrap_or("a dash");
        return DashApiOutcome::Error(format!(
            "card runs {running} — stop it before binding {dash}"
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

/// Clear one session's binding.
pub(crate) fn unbind(ledger: &SessionLedger, tug_session_id: &str) -> DashApiOutcome {
    // The row, not `owns_session`: the ownership question is answered by
    // throwing away the `dash_name` and `project_dir` the stop below needs.
    // `UnknownSession` is kept for a missing row so the CLI's
    // try-each-instance loop still walks on.
    if ledger.get(tug_session_id).ok().flatten().is_none() {
        return DashApiOutcome::UnknownSession;
    }
    // Unbinding a scored card is the same act a close is, with the same
    // reason: the arc leaves the sweep either way, and an arc that left with
    // no record says `review` forever while nothing is running.
    stop_a_scored_cards_arc_as_closed(ledger, tug_session_id);
    match ledger.set_dash_binding(tug_session_id, None) {
        Ok(_) => DashApiOutcome::Unbound,
        Err(e) => DashApiOutcome::Error(e.to_string()),
    }
}

/// Write `arc-stop <stage> card closed` when the card `session_id` names is
/// seated by a live arc's stage. A no-op for every other card.
///
/// **No receipt and no hand-back.** There is no card left to paint one on: the
/// entry is going `Closed`, and `wheel::hand_back` refuses `Closed` by
/// design. That is not a silent failure — the record says it, `tugutil dash
/// arc` says it, and the Lens says it. The only surface missing is one that
/// does not exist.
///
/// Unlike an ending, this path *does* write the record: nothing terminal has
/// been appended to the dash-log, so the arc's generation is still open and
/// the stop lands inside it. `tugutil dash run <name>` from a fresh card then
/// resumes through the ordinary `arc-resume` path, which makes the previously
/// accidental resume the designed one.
///
/// Called **before** the binding is released, since the binding is what names
/// the dash.
pub(crate) fn stop_a_scored_cards_arc_as_closed(ledger: &SessionLedger, session_id: &str) {
    let Ok(Some(row)) = ledger.get(session_id) else {
        return;
    };
    let Some(dash) = row.dash_name.as_deref() else {
        return;
    };
    if ledger.stage_provenance(session_id).is_none() {
        return;
    }
    let project = std::path::Path::new(&row.project_dir);
    let Some(record) = tugdash_core::arc::read_arc(project, dash) else {
        return;
    };
    if record.done || record.stopped.is_some() {
        return;
    }
    let Some(stage) = record.current_stage() else {
        return;
    };
    if let Err(e) = tugdash_core::arc::append_arc_stop(
        project,
        dash,
        stage,
        tugdash_core::arc::ArcStopReason::CardClosed,
    ) {
        tracing::warn!(
            dash = %dash,
            error = %e,
            "could not record that a scored card closed",
        );
    }
}

/// Resolve the arc `tugutil dash stop` asks to stop, or say why there is none.
///
/// The blocking half only: it names the stage, and the handler's async half —
/// which holds the supervisor — performs the stop through the one path every
/// stopper uses.
///
/// Each refusal names the state it found rather than failing vaguely: a state
/// the verb reports is not a crash.
pub(crate) fn arc_stop(
    ledger: &SessionLedger,
    project_dir: &std::path::Path,
    tug_session_id: &str,
    dash: &str,
) -> DashApiOutcome {
    let Some(row) = ledger.get(tug_session_id).ok().flatten() else {
        return DashApiOutcome::UnknownSession;
    };
    match row.dash_name.as_deref() {
        Some(bound) if bound == dash => {}
        Some(bound) => {
            return DashApiOutcome::Error(format!(
                "card is bound to {bound}, not {dash} — stop it from the card running it"
            ));
        }
        None => {
            return DashApiOutcome::Error(format!("card is bound to no dash, so it cannot stop {dash}"));
        }
    }
    let Some(record) = tugdash_core::arc::read_arc(project_dir, dash) else {
        return DashApiOutcome::Error(format!("{dash} has no arc to stop"));
    };
    if record.done {
        return DashApiOutcome::Error(format!("{dash}'s arc is already done"));
    }
    if let Some((stage, reason)) = record.stopped.as_ref() {
        return DashApiOutcome::Error(format!(
            "{dash}'s arc is already stopped in {} — {reason}",
            stage.as_str()
        ));
    }
    // An arc that has opened but rotated nothing is still a live arc, and
    // stopping it is an ordinary thing to want. `Devise` is the stage it would
    // have rotated first, and it is the same default the predicate takes when
    // it has to name a stage for a record that has none.
    let stage = record.current_stage().unwrap_or(tugdash_core::arc::ArcStage::Devise);
    DashApiOutcome::ArcStopped {
        dash: dash.to_string(),
        stage,
        session_id: tug_session_id.to_string(),
        project_dir: project_dir.to_string_lossy().into_owned(),
    }
}

/// Sweep every binding to a dead dash, plus its authored draft row.
///
/// `dash_id` is the owner key the caller captured **before** the teardown that
/// deleted the dash's branch (Risk R02). This endpoint never re-derives
/// it: by the time the call is made, the branch config it would read is gone,
/// and the only key it could produce would be the legacy one — which names
/// none of the id-keyed rows it is here to remove ([L23]).
pub(crate) fn dash_gone(
    ledger: &SessionLedger,
    project_dir: &std::path::Path,
    dash_id: &str,
) -> DashApiOutcome {
    // Found **before** the bindings are cleared: the binding is how a seated
    // session is found at all, and clearing it first would leave nothing to
    // look through.
    let seated = seated_stages(ledger, dash_id);
    let cleared = match ledger.clear_dash_bindings_for_dash(dash_id) {
        Ok(n) => n,
        Err(e) => return DashApiOutcome::Error(e.to_string()),
    };
    crate::feeds::agent_supervisor::AgentSupervisor::clear_dash_draft(
        ledger,
        &project_dir.to_string_lossy(),
        dash_id,
    );
    DashApiOutcome::Cleared { cleared, seated }
}

/// Every live session bound to `dash_id` that a stage of a live arc is seated
/// on, with the stage it is in.
///
/// Two facts have to hold together: the session carries a `stage_label`, which
/// only a rotation writes, and the dash it is bound to has an arc that is
/// neither done nor stopped. A card merely bound to the dash is not one an
/// ending needs to tell anything about a stage.
fn seated_stages(ledger: &SessionLedger, dash_id: &str) -> Vec<SeatedArcStage> {
    let Ok(by_dash) = ledger.bound_sessions_by_dash() else {
        return Vec::new();
    };
    let Some(sessions) = by_dash.get(dash_id) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for session_id in sessions {
        let Ok(Some(row)) = ledger.get(session_id) else {
            continue;
        };
        let Some(dash_name) = row.dash_name.clone() else {
            continue;
        };
        // The sessions table is keyed by the same id `stage_provenance` reads,
        // which is the id `bound_sessions_by_dash` handed back.
        if ledger.stage_provenance(session_id).is_none() {
            continue;
        }
        let Some(record) =
            tugdash_core::arc::read_arc(std::path::Path::new(&row.project_dir), &dash_name)
        else {
            continue;
        };
        if record.done || record.stopped.is_some() {
            continue;
        }
        let Some(stage) = record.current_stage() else {
            continue;
        };
        out.push(SeatedArcStage {
            session_id: session_id.clone(),
            dash_name,
            project_dir: row.project_dir.clone(),
            stage,
        });
    }
    out
}

/// Whether a session working `session_project` may bind a dash in
/// `dash_project`.
///
/// Both sides go through the [L29] gateway before they are compared, so the
/// two spellings of one directory — the session's, recorded at spawn, and the
/// CLI's, taken from a cwd — cannot read as two projects. Each side is then
/// resolved a second time, through `linked_worktree_base`: a path inside a
/// linked git worktree compares as the checkout that worktree belongs to.
///
/// That second hop is what lets a dash bind from the one directory a dash run
/// actually works in. The worktree is not a foreign project — it is this
/// project's other working copy — and the guard exists to refuse foreign
/// projects, which it still does with the message unchanged. Both sides are
/// resolved because a session can itself have been spawned in a worktree.
///
/// The hop runs here, server-side and after the gateway, so the CLI still
/// canonicalizes nothing ([L29]).
fn same_project(session_project: &str, dash_project: &std::path::Path) -> bool {
    let through_base = |p: &std::path::Path| {
        let resolved = crate::path_resolver::resolve_to_claude_form(p);
        match tugcore::registry::linked_worktree_base(&resolved) {
            Some(base) => crate::path_resolver::resolve_to_claude_form(&base),
            None => resolved,
        }
    };
    through_base(std::path::Path::new(session_project)) == through_base(dash_project)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::same_project;
    use tempfile::tempdir;

    /// A real ledger with one session bound to a live arc on `alpha`, in a
    /// real project the arc record belongs to.
    fn scored_card(root: &std::path::Path) -> SessionLedger {
        // A real repo: `ensure_dash_id` mints through git config.
        for args in [
            &["init", "-q"][..],
            &["config", "user.email", "t@example.com"][..],
            &["config", "user.name", "T"][..],
        ] {
            let ok = std::process::Command::new("git")
                .arg("-C")
                .arg(root)
                .args(args)
                .output()
                .expect("git runs")
                .status
                .success();
            assert!(ok, "git {args:?} failed");
        }
        std::fs::create_dir_all(root.join(".tugtool")).unwrap();
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.dash]\ndocs = \"dash\"\n",
        )
        .unwrap();
        let ledger = SessionLedger::open_in_memory().unwrap();
        ledger
            .record_spawn(
                "claude-1",
                "ws-test",
                &root.to_string_lossy(),
                "card-1",
                1_000,
                None,
            )
            .unwrap();
        ledger
            .set_dash_binding("claude-1", Some(("tugdash/alpha#1", "alpha")))
            .unwrap();
        tugdash_core::arc::append_arc_start(root, "alpha", "dash/alpha-brief.md").unwrap();
        ledger
    }

    fn bound_dash(ledger: &SessionLedger) -> Option<String> {
        ledger.get("claude-1").ok().flatten().and_then(|r| r.dash_name)
    }

    #[test]
    #[serial_test::serial]
    fn a_card_running_a_score_refuses_a_bind_to_another_dash() {
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = scored_card(root);

        let outcome = bind(&ledger, root, "claude-1", "beta");
        match outcome {
            DashApiOutcome::Error(message) => {
                assert!(message.contains("alpha"), "{message}");
                assert!(message.contains("beta"), "{message}");
            }
            _ => panic!("a live score must refuse a bind naming another dash"),
        }
        assert_eq!(
            bound_dash(&ledger).as_deref(),
            Some("alpha"),
            "and the binding it protects is untouched",
        );
    }

    #[test]
    #[serial_test::serial]
    fn unbinding_a_scored_card_stops_the_arc_as_card_closed() {
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = scored_card(root);
        tugdash_core::arc::append_arc_stage(
            root,
            "alpha",
            tugdash_core::arc::ArcStage::Review,
            "claude-1",
            None,
        )
        .unwrap();
        ledger
            .set_stage_provenance("claude-1", "review", None)
            .unwrap();

        assert!(matches!(
            unbind(&ledger, "claude-1"),
            DashApiOutcome::Unbound
        ));
        assert_eq!(
            tugdash_core::arc::read_arc(root, "alpha").unwrap().stopped,
            Some((
                tugdash_core::arc::ArcStage::Review,
                "card closed".to_string()
            )),
            "the record says the card went, rather than reading `review` forever",
        );
        assert!(bound_dash(&ledger).is_none(), "and the binding is cleared");
    }

    #[test]
    #[serial_test::serial]
    fn unbinding_a_card_with_no_arc_writes_nothing() {
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = SessionLedger::open_in_memory().unwrap();
        ledger
            .record_spawn(
                "claude-1",
                "ws-test",
                &root.to_string_lossy(),
                "card-1",
                1_000,
                None,
            )
            .unwrap();
        ledger
            .set_dash_binding("claude-1", Some(("tugdash/plain#1", "plain")))
            .unwrap();

        assert!(matches!(
            unbind(&ledger, "claude-1"),
            DashApiOutcome::Unbound
        ));
        assert_eq!(tugdash_core::arc::read_arc(root, "plain"), None);
    }

    #[test]
    #[serial_test::serial]
    fn a_card_no_rotation_seated_writes_no_stop_when_it_unbinds() {
        // Bound is not seated: an ordinary card that happens to name the dash
        // is not the card the arc's stage runs on.
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = scored_card(root);

        assert!(matches!(
            unbind(&ledger, "claude-1"),
            DashApiOutcome::Unbound
        ));
        assert_eq!(
            tugdash_core::arc::read_arc(root, "alpha").unwrap().stopped,
            None,
        );
    }

    #[test]
    #[serial_test::serial]
    fn dash_gone_finds_the_sessions_a_stage_is_seated_on() {
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = scored_card(root);
        tugdash_core::arc::append_arc_stage(
            root,
            "alpha",
            tugdash_core::arc::ArcStage::Review,
            "claude-1",
            None,
        )
        .unwrap();
        ledger
            .set_stage_provenance("claude-1", "review", None)
            .unwrap();
        // A second card bound to the same dash that no rotation seated: bound
        // is not the same as carrying a stage.
        ledger
            .record_spawn(
                "claude-2",
                "ws-test",
                &root.to_string_lossy(),
                "card-2",
                1_000,
                None,
            )
            .unwrap();
        ledger
            .set_dash_binding("claude-2", Some(("tugdash/alpha#1", "alpha")))
            .unwrap();

        let DashApiOutcome::Cleared { cleared, seated } = dash_gone(&ledger, root, "tugdash/alpha#1")
        else {
            panic!("dash_gone reports what it swept");
        };
        assert_eq!(cleared, 2, "both bindings are cleared");
        assert_eq!(seated.len(), 1, "only the seated card is told");
        assert_eq!(seated[0].session_id, "claude-1");
        assert_eq!(seated[0].dash_name, "alpha");
        assert_eq!(seated[0].stage, tugdash_core::arc::ArcStage::Review);
        assert_eq!(seated[0].project_dir, root.to_string_lossy());
    }

    #[test]
    #[serial_test::serial]
    fn dash_gone_on_a_dash_with_no_arc_finds_nothing_seated() {
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = SessionLedger::open_in_memory().unwrap();
        ledger
            .record_spawn(
                "claude-1",
                "ws-test",
                &root.to_string_lossy(),
                "card-1",
                1_000,
                None,
            )
            .unwrap();
        ledger
            .set_dash_binding("claude-1", Some(("tugdash/plain#1", "plain")))
            .unwrap();

        let DashApiOutcome::Cleared { cleared, seated } = dash_gone(&ledger, root, "tugdash/plain#1")
        else {
            panic!("dash_gone reports what it swept");
        };
        assert_eq!(cleared, 1);
        assert!(seated.is_empty(), "a hand-made dash seats no stage");
    }

    #[test]
    #[serial_test::serial]
    fn an_ending_writes_no_arc_line_after_the_terminal_one() {
        // The phantom-generation guard. `read_arc` resets at the last terminal
        // line, so an `arc-stop` appended after one becomes the first line of
        // a next generation that a dash reusing this name would be born
        // carrying. This fails loudly if anybody puts the append back.
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = scored_card(root);
        tugdash_core::arc::append_arc_stage(
            root,
            "alpha",
            tugdash_core::arc::ArcStage::Review,
            "claude-1",
            None,
        )
        .unwrap();
        ledger
            .set_stage_provenance("claude-1", "review", None)
            .unwrap();
        // The ending's own terminal line, appended before the CLI broadcasts.
        tugdash_core::dash::append_dash_log(root, "alpha", "discarded", "").unwrap();

        let _ = dash_gone(&ledger, root, "tugdash/alpha#1");

        assert_eq!(
            tugdash_core::arc::read_arc(root, "alpha"),
            None,
            "the arc's generation stays closed",
        );
    }

    #[test]
    fn a_joined_dash_says_joined_and_a_discarded_one_says_discarded() {
        // The gesture rides the op, and a missing field reads as a discard —
        // which is what every caller before the field existed was.
        assert_eq!(
            DashGoneReason::parse(Some("joined")),
            DashGoneReason::Joined,
        );
        assert_eq!(DashGoneReason::parse(Some("joined")).as_str(), "joined");
        assert_eq!(
            DashGoneReason::parse(Some("discarded")),
            DashGoneReason::Discarded,
        );
        assert_eq!(DashGoneReason::parse(None), DashGoneReason::Discarded);
        assert_eq!(DashGoneReason::parse(None).as_str(), "discarded");
    }

    #[test]
    #[serial_test::serial]
    fn arc_stop_names_the_stage_it_will_stop() {
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = scored_card(root);
        tugdash_core::arc::append_arc_stage(
            root,
            "alpha",
            tugdash_core::arc::ArcStage::Review,
            "claude-1",
            None,
        )
        .unwrap();

        match arc_stop(&ledger, root, "claude-1", "alpha") {
            DashApiOutcome::ArcStopped { dash, stage, .. } => {
                assert_eq!(dash, "alpha");
                assert_eq!(stage, tugdash_core::arc::ArcStage::Review);
            }
            DashApiOutcome::Error(m) => panic!("refused: {m}"),
            _ => panic!("unexpected"),
        }
    }

    #[test]
    #[serial_test::serial]
    fn an_arc_that_has_rotated_nothing_yet_still_stops() {
        // An arc that opened on a document and has not seated its first stage
        // is live, and stopping it is an ordinary thing to want. It stops in
        // the stage it would have rotated first.
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = scored_card(root);

        match arc_stop(&ledger, root, "claude-1", "alpha") {
            DashApiOutcome::ArcStopped { stage, .. } => {
                assert_eq!(stage, tugdash_core::arc::ArcStage::Devise);
            }
            DashApiOutcome::Error(m) => panic!("refused: {m}"),
            _ => panic!("unexpected"),
        }
    }

    #[test]
    #[serial_test::serial]
    fn arc_stop_refuses_a_card_bound_to_another_dash() {
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = scored_card(root);

        match arc_stop(&ledger, root, "claude-1", "beta") {
            DashApiOutcome::Error(message) => {
                assert!(message.contains("alpha"), "{message}");
                assert!(message.contains("beta"), "{message}");
            }
            _ => panic!("a card bound elsewhere cannot stop this dash"),
        }
        // And a session this instance does not hold is the walk-on answer.
        assert!(matches!(
            arc_stop(&ledger, root, "claude-elsewhere", "alpha"),
            DashApiOutcome::UnknownSession
        ));
    }

    #[test]
    #[serial_test::serial]
    fn arc_stop_refuses_when_there_is_no_live_arc() {
        // Absent, done, and already stopped are three states the verb reports
        // by name rather than three ways of failing vaguely.
        for close in ["absent", "done", "stopped"] {
            let home = tempdir().unwrap();
            // SAFETY: `#[serial]`; no other thread reads the environment here.
            unsafe {
                std::env::set_var("TUG_DATA_DIR", home.path());
            }
            let dir = tempdir().unwrap();
            let root = dir.path();
            let ledger = SessionLedger::open_in_memory().unwrap();
            if close == "absent" {
                ledger
                    .record_spawn(
                        "claude-1",
                        "ws-test",
                        &root.to_string_lossy(),
                        "card-1",
                        1_000,
                        None,
                    )
                    .unwrap();
                ledger
                    .set_dash_binding("claude-1", Some(("tugdash/alpha#1", "alpha")))
                    .unwrap();
            } else {
                let ledger = scored_card(root);
                if close == "done" {
                    tugdash_core::arc::append_arc_done(root, "alpha").unwrap();
                } else {
                    tugdash_core::arc::append_arc_stop(
                        root,
                        "alpha",
                        tugdash_core::arc::ArcStage::Devise,
                        tugdash_core::arc::ArcStopReason::CardClosed,
                    )
                    .unwrap();
                }
                match arc_stop(&ledger, root, "claude-1", "alpha") {
                    DashApiOutcome::Error(message) => {
                        assert!(message.contains("alpha"), "{close}: {message}");
                    }
                    _ => panic!("{close}: there is no live arc to stop"),
                }
                continue;
            }
            match arc_stop(&ledger, root, "claude-1", "alpha") {
                DashApiOutcome::Error(message) => {
                    assert!(message.contains("no arc"), "{message}");
                }
                _ => panic!("a dash with no arc has none to stop"),
            }
        }
    }

    #[test]
    #[serial_test::serial]
    fn binding_the_same_dash_again_is_still_a_no_op() {
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = scored_card(root);

        // The resume path, and `claim_dash` on the dash the card already runs.
        match bind(&ledger, root, "claude-1", "alpha") {
            DashApiOutcome::Bound { .. } => {}
            DashApiOutcome::Error(m) => panic!("refused: {m}"),
            _ => panic!("unexpected"),
        }
        assert_eq!(bound_dash(&ledger).as_deref(), Some("alpha"));
    }

    #[test]
    #[serial_test::serial]
    fn a_stopped_or_done_arc_does_not_refuse_a_bind() {
        for close in ["stopped", "done"] {
            let home = tempdir().unwrap();
            // SAFETY: `#[serial]`; no other thread reads the environment here.
            unsafe {
                std::env::set_var("TUG_DATA_DIR", home.path());
            }
            let dir = tempdir().unwrap();
            let root = dir.path();
            let ledger = scored_card(root);
            if close == "stopped" {
                tugdash_core::arc::append_arc_stop(
                    root,
                    "alpha",
                    tugdash_core::arc::ArcStage::Devise,
                    tugdash_core::arc::ArcStopReason::StoppedByUser,
                )
                .unwrap();
            } else {
                tugdash_core::arc::append_arc_done(root, "alpha").unwrap();
            }

            assert!(
                matches!(
                    bind(&ledger, root, "claude-1", "beta"),
                    DashApiOutcome::Bound { .. }
                ),
                "a {close} arc is not a score running",
            );
            assert_eq!(bound_dash(&ledger).as_deref(), Some("beta"));
        }
    }

    /// Builds a real checkout with a real linked worktree and returns both
    /// paths. Real `git worktree add` output, not a hand-built `.git` file:
    /// the pointer/`commondir` layout is exactly what the translation reads.
    fn checkout_with_worktree(root: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
        let main = root.join("checkout");
        let worktree = root.join("dashes/join-arc");
        std::fs::create_dir_all(&main).unwrap();
        let git = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .arg("-C")
                .arg(&main)
                .args(args)
                .output()
                .expect("git runs")
                .status
                .success();
            assert!(ok, "git {args:?} failed");
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@example.com"]);
        git(&["config", "user.name", "T"]);
        std::fs::write(main.join("seed"), b"seed").unwrap();
        git(&["add", "seed"]);
        git(&["commit", "-qm", "seed"]);
        git(&[
            "worktree",
            "add",
            "-q",
            "-b",
            "tugdash/join-arc",
            worktree.to_str().unwrap(),
        ]);
        (main, worktree)
    }

    /// The bind a dash run actually makes: the session was spawned in the
    /// checkout, and `dash step start` runs from inside the worktree.
    #[test]
    fn a_dash_worktree_is_its_checkouts_project() {
        let dir = tempdir().unwrap();
        let (main, worktree) = checkout_with_worktree(dir.path());

        assert!(same_project(&main.to_string_lossy(), &worktree));
        // Symmetric: a session spawned in the worktree binds a dash named
        // from the checkout.
        assert!(same_project(&worktree.to_string_lossy(), &main));
        // And a worktree still equals itself.
        assert!(same_project(&worktree.to_string_lossy(), &worktree));
    }

    /// The guard's actual purpose survives: a different project refuses.
    #[test]
    fn an_unrelated_project_still_refuses() {
        let dir = tempdir().unwrap();
        let (_main, worktree) = checkout_with_worktree(dir.path());
        let stranger = dir.path().join("stranger");
        std::fs::create_dir_all(&stranger).unwrap();

        assert!(!same_project(&stranger.to_string_lossy(), &worktree));
    }
}
