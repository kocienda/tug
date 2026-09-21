//! `POST /api/arc` — the session↔arc binding write surface for short-lived
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
pub(crate) enum ArcApiOutcome {
    Bound {
        /// The segment the binding was written onto — the live one, which is
        /// not always the id the caller posted. Every announcement names
        /// this: a broadcast naming the stale id reaches no card.
        session_id: String,
        arc_id: String,
        arc_name: String,
    },
    Unbound {
        /// As [`Self::Bound`]'s.
        session_id: String,
    },
    /// What a `arc_gone` swept: how many binding rows, and which of them were
    /// carrying a live arc's stage.
    Cleared {
        cleared: usize,
        seated: Vec<SeatedArcStage>,
    },
    /// The live arc this card runs, and the stage it will be stopped in. The
    /// blocking half resolves it; the handler's async half performs the stop.
    ArcStopped {
        arc: String,
        stage: tugarc_core::arc::ArcStage,
        session_id: String,
        project_dir: String,
        /// Why. `StoppedByUser` for `arc stop`; `NeedsDecision` for the
        /// `arc ask` a stage raises about itself.
        reason: tugarc_core::arc::ArcStopReason,
        /// The question a `arc ask` stopped over, written as an `arc-note`
        /// before the stop so the record and the receipt both carry it. The
        /// stop vocabulary is closed and cannot carry a payload, which is why
        /// the question travels beside the reason rather than inside it.
        question: Option<String>,
    },
    /// This instance's ledger has no such session — the CLI should try the
    /// next live instance rather than report a failure.
    UnknownSession,
    Error(String),
}

/// A card an ending found a live arc's stage seated on.
///
/// It carries the arc name and the project rather than leaving the caller to
/// re-derive them: `arc_gone` is handed an arc **id**, and by the time it runs
/// the teardown has already destroyed the branch config that would translate
/// one ([L23]). Both come off the bound session's own row, which is still
/// there when the sweep reads it.
pub(crate) struct SeatedArcStage {
    pub session_id: String,
    pub arc_name: String,
    pub project_dir: String,
    pub stage: tugarc_core::arc::ArcStage,
}

/// Which gesture ended the arc.
///
/// `arc_gone` is the teardown of *any* ending — `broadcast_arc_gone` is
/// called from the discard and from both join paths — so the card is told
/// which one happened rather than being told the discard's story about a join.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ArcGoneReason {
    Discarded,
    Joined,
}

impl ArcGoneReason {
    /// Read the op's optional field. An older `tugtool` sends none, and a
    /// discard is what every caller before the field existed was.
    pub(crate) fn parse(word: Option<&str>) -> ArcGoneReason {
        match word {
            Some("joined") => ArcGoneReason::Joined,
            _ => ArcGoneReason::Discarded,
        }
    }

    /// The stop reason whose sentence the ending's receipt is worded from.
    pub(crate) fn stop_reason(&self) -> tugarc_core::arc::ArcStopReason {
        match self {
            ArcGoneReason::Discarded => tugarc_core::arc::ArcStopReason::Discarded,
            ArcGoneReason::Joined => tugarc_core::arc::ArcStopReason::Joined,
        }
    }

    /// The word the retirement receipt leads with.
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            ArcGoneReason::Discarded => "discarded",
            ArcGoneReason::Joined => "joined",
        }
    }
}

/// The live segment of the calling card's line ([P01]) — the session a verb
/// addressed to `posted` is really about.
///
/// Every session-addressed op on this endpoint goes through here first.
/// `$TUG_SESSION_ID` is frozen at spawn and the Wheel rotates a card's session
/// on purpose — above `implement_compact_tokens`, on a threshold any long
/// implement stage crosses — so the id a `tugtool arc` verb posts from inside
/// a stage routinely names a segment closed and demoted two rotations earlier.
/// Read raw, a bind then moves a column on that corpse and returns
/// `affected > 0`: a truthful success about the wrong session, while the live
/// card shows no arc and the documented repair gesture reports success too
/// ([D167]).
///
/// The two neighbours that had already met this — `tugchanges_core`'s
/// `line_segments` and `tugarc_core`'s `session_citation_for` — each solved
/// it for themselves. Resolving at the door is the same answer made once, for
/// every op that arrives through it.
///
/// `Err(UnknownSession)` keeps the CLI's try-each-instance loop walking. A
/// line with no live segment is an error rather than a fall back to the
/// posted id: there is no card left to bind, stop, or unbind, and saying so
/// is the refusal that turns this from a silent haunting into a sentence.
fn calling_segment(ledger: &SessionLedger, posted: &str) -> Result<String, ArcApiOutcome> {
    if ledger.get(posted).ok().flatten().is_none() {
        return Err(ArcApiOutcome::UnknownSession);
    }
    match ledger.live_segment_of(posted) {
        Ok(Some(live)) => Ok(live),
        Ok(None) => Err(ArcApiOutcome::Error(format!(
            "session {posted} names a closed segment and no segment of its line is live — \
             the card it worked has gone"
        ))),
        Err(e) => Err(ArcApiOutcome::Error(e.to_string())),
    }
}

/// The *other* live card holding `arc_id`, named as the user would know it.
///
/// **One arc, one card.** Two cards on one arc is not a shape any surface can
/// draw honestly: the transport control on each row would read the other's
/// state, a stop from either would end work the other is doing, and the arc's
/// own record has one stage, not two. So a second holder is refused at the
/// door rather than described afterwards.
///
/// `this_session` is the caller's **live segment**, because that is what
/// [`SessionLedger::bound_session_by_arc`] is keyed by. A caller that passed
/// its posted id would be told its own callsign holds its own arc.
fn other_holder(ledger: &SessionLedger, arc_id: &str, this_session: &str) -> Option<String> {
    let holder = ledger.bound_session_by_arc().ok()?.get(arc_id)?.clone();
    if holder == this_session {
        return None;
    }
    let row = ledger.get(&holder).ok().flatten();
    Some(
        row.and_then(|row| row.name.clone().or_else(|| row.tag.clone()))
            .unwrap_or(holder),
    )
}

/// Bind a session to an arc.
///
/// `project_dir` must already be resolved through the [L29] gateway. Minting
/// is correct here: a bind is a write-path verb, so an id-less arc
/// from an older build gains its creation id at the moment something first
/// keys by it.
pub(crate) fn bind(
    ledger: &SessionLedger,
    project_dir: &std::path::Path,
    tug_session_id: &str,
    arc: &str,
) -> ArcApiOutcome {
    let tug_session_id = match calling_segment(ledger, tug_session_id) {
        Ok(live) => live,
        Err(outcome) => return outcome,
    };
    let tug_session_id = tug_session_id.as_str();
    let Some(row) = ledger.get(tug_session_id).ok().flatten() else {
        return ArcApiOutcome::UnknownSession;
    };
    // **A session may only bind an arc in its own project**, which is the rule
    // the Arcs card's Bind control already states to the user ("This arc belongs to
    // …") and the server was taking on trust. It is not a nicety: without it a
    // short-lived CLI process anywhere on the machine can rebind a live
    // session to an arc in a directory that session has never seen. That is
    // how an app-test's scratch arc came to own a developer's session, and
    // the face went blank because the arc it named no longer existed.
    if !same_project(&row.project_dir, project_dir) {
        return ArcApiOutcome::Error(format!(
            "session {tug_session_id} works {} — it cannot bind an arc in {}",
            row.project_dir,
            project_dir.display()
        ));
    }
    // **A card runs at most one arc.** A bind that displaced a live one left
    // the first arc's record reading live forever with no stop and no receipt:
    // the sweep is live-bindings-only, so the displaced arc simply dropped out
    // of it. That interruption has no honest row in any table, so it is
    // refused rather than described.
    //
    // The check reads the session's *current* binding, which is exactly the
    // arc about to be displaced — the one this refusal protects. It cannot
    // fire on the arc's own binds: `arc_is_running` is false with no
    // binding, no arc record, or a `done`/`stopped` one, and a bind naming the
    // arc already running is the resume path, which is a no-op here.
    if crate::wheel::arc_is_running(ledger, tug_session_id) && row.arc_name.as_deref() != Some(arc)
    {
        let running = row.arc_name.as_deref().unwrap_or("an arc");
        return ArcApiOutcome::Error(format!(
            "card runs {running} — stop it before binding {arc}"
        ));
    }
    let arc_id = match tugarc_core::ops::ensure_arc_id(project_dir, arc) {
        Ok(id) => id,
        Err(e) => return ArcApiOutcome::Error(e),
    };
    // One arc, one card: a second holder is refused by name, so the user is
    // told which card to go and stop rather than left with two rows arguing.
    if let Some(holder) = other_holder(ledger, &arc_id, tug_session_id) {
        return ArcApiOutcome::Error(format!("{holder} is running {arc}"));
    }
    match ledger.set_arc_binding(tug_session_id, Some((&arc_id, arc))) {
        Ok(true) => ArcApiOutcome::Bound {
            session_id: tug_session_id.to_string(),
            arc_id,
            arc_name: arc.to_string(),
        },
        // Unreachable through the resolution above, and kept because the day
        // it is reachable is the day something bound a corpse again — better
        // a refusal that names the session than a success that doesn't.
        Ok(false) => ArcApiOutcome::Error(format!(
            "session {tug_session_id} is not live, so it cannot be bound to {arc}"
        )),
        Err(e) => ArcApiOutcome::Error(e.to_string()),
    }
}

/// Start an arc on the calling card: open it if it has never run, then bind.
///
/// **The open happens only when there is no record** ([P04]). `tugtool arc
/// run` opens client-side and reaches the server with a record already
/// written, so this is a no-op for the CLI and the CLI is unchanged; the
/// button on the Arcs card is the caller that arrives with documents and
/// nothing else, and it is the one this open is for.
///
/// A record that already exists is bound and otherwise left exactly as it is —
/// **a stopped one stays stopped**, because clearing a stop is
/// [`arc_resume`]'s act and no other ([B04]). Two verbs, two facts: Start
/// opens, Resume picks back up.
///
/// **The opening derives the kind from the arc's documents** ([B04] of the
/// one-door brief), so the request names none: a task list beside the brief
/// opens a plain arc, a brief alone or a plan opens a planned one. An arc
/// with no documents at all has nothing to derive from, and `open_arc`
/// refuses it — naming the address to write to — before anything is written
/// or bound.
pub(crate) fn arc_run(
    ledger: &SessionLedger,
    project_dir: &std::path::Path,
    tug_session_id: &str,
    arc: &str,
) -> ArcApiOutcome {
    // The live segment, resolved before anything is written: an open that
    // landed and then failed to bind would leave the arc reading live with
    // nothing seated on it.
    let tug_session_id = match calling_segment(ledger, tug_session_id) {
        Ok(live) => live,
        Err(outcome) => return outcome,
    };
    if tugarc_core::arc::read_arc(project_dir, arc).is_none() {
        if let Err(e) = tugarc_core::ops::open_arc(project_dir, arc) {
            return ArcApiOutcome::Error(e);
        }
    }
    bind(ledger, project_dir, tug_session_id.as_str(), arc)
}

/// Pick a stopped arc back up on the calling card: the same two acts
/// `tugtool arc run` performs on a stopped arc, made reachable from a button
/// ([F02], [B07]). `append_arc_resume` names the stage the record stopped in,
/// which is what clears the stop and tells the runner where to pick up; the
/// bind is what seats the arc on this card, and the first rotation is that
/// card's own next idle ([P05]) — never this call.
///
/// **An arc carrying no stop is bound and otherwise left alone**, and that is
/// the whole of what makes the button safe to press twice ([B06]). The
/// receipt block cannot subscribe to live state to know whether its stop is
/// still standing ([F05]), so a second press — or a press on a row whose arc
/// something else already resumed — has to be a no-op here rather than a
/// refusal there. The two terminal reasons need no guard: `read_arc` resets
/// at a discard's or a join's own line, so a torn-down arc reaches this with
/// no record at all and is refused by the read below.
///
/// The session is resolved **before** the record is written. A resume that
/// appended its line and then failed to bind would leave the arc reading
/// live with nothing seated on it — the shape a stop exists to avoid.
pub(crate) fn arc_resume(
    ledger: &SessionLedger,
    project_dir: &std::path::Path,
    tug_session_id: &str,
    arc: &str,
) -> ArcApiOutcome {
    // The line's live segment, kept rather than thrown away: `other_holder`
    // compares against the ids `bound_session_by_arc` is keyed by, which are
    // live segments, and a card posting a frozen id (which the door does)
    // would otherwise be told its own callsign holds its own arc.
    let tug_session_id = match calling_segment(ledger, tug_session_id) {
        Ok(live) => live,
        Err(outcome) => return outcome,
    };
    let Some(record) = tugarc_core::arc::read_arc(project_dir, arc) else {
        return ArcApiOutcome::Error(format!("{arc} has no arc to resume"));
    };
    // Refused *before* the resume line is written: an arc another card holds
    // must not have its stop cleared by a card that will not be seated on it.
    let arc_id = match tugarc_core::ops::ensure_arc_id(project_dir, arc) {
        Ok(id) => id,
        Err(e) => return ArcApiOutcome::Error(e),
    };
    if let Some(holder) = other_holder(ledger, &arc_id, tug_session_id.as_str()) {
        return ArcApiOutcome::Error(format!("{holder} is running {arc}"));
    }
    // Refused while the stop is in flight: a resume that cleared a mark the
    // protocol is about to read would pick the arc up under a stop half done
    // ([B05]). Once the `arc-stop` lands the arc is stopped, and this verb
    // resumes it as any other.
    if record.stopping.is_some() {
        return ArcApiOutcome::Error(format!(
            "{arc}'s arc is stopping — wait for the stop to finish"
        ));
    }
    if let Some((stage, _)) = record.stopped {
        if let Err(e) = tugarc_core::arc::append_arc_resume(project_dir, arc, stage) {
            return ArcApiOutcome::Error(e.to_string());
        }
    }
    bind(ledger, project_dir, tug_session_id.as_str(), arc)
}

/// Clear one session's binding.
pub(crate) fn unbind(ledger: &SessionLedger, tug_session_id: &str) -> ArcApiOutcome {
    // The line's live segment, not the posted id — a rotated card unbinding
    // itself would otherwise clear a corpse's column and leave its own
    // binding standing.
    let tug_session_id = match calling_segment(ledger, tug_session_id) {
        Ok(live) => live,
        Err(outcome) => return outcome,
    };
    let tug_session_id = tug_session_id.as_str();
    // The row, not `owns_session`: the ownership question is answered by
    // throwing away the `arc_name` and `project_dir` the stop below needs.
    // `UnknownSession` is kept for a missing row so the CLI's
    // try-each-instance loop still walks on.
    if ledger.get(tug_session_id).ok().flatten().is_none() {
        return ArcApiOutcome::UnknownSession;
    }
    // Unbinding a card on an arc is the same act a close is, with the same
    // reason: the arc leaves the sweep either way, and an arc that left with
    // no record says `review` forever while nothing is running.
    stop_an_on_arc_cards_arc_as_closed(ledger, tug_session_id);
    match ledger.set_arc_binding(tug_session_id, None) {
        Ok(_) => ArcApiOutcome::Unbound {
            session_id: tug_session_id.to_string(),
        },
        Err(e) => ArcApiOutcome::Error(e.to_string()),
    }
}

/// Write `arc-stop <stage> card closed` when the card `session_id` names is
/// seated by a live arc's stage. A no-op for every other card.
///
/// **No receipt and no hand-back.** There is no card left to paint one on: the
/// entry is going `Closed`, and `wheel::hand_back` refuses `Closed` by
/// design. That is not a silent failure — the record says it, `tugtool arc
/// record` says it, and the Arcs card says it. The only surface missing is
/// one that does not exist.
///
/// Unlike an ending, this path *does* write the record: nothing terminal has
/// been appended to the arc log, so the arc's generation is still open and
/// the stop lands inside it. `tugtool arc run <name>` from a fresh card then
/// resumes through the ordinary `arc-resume` path, which makes the previously
/// accidental resume the designed one.
///
/// Called **before** the binding is released, since the binding is what names
/// the arc.
pub(crate) fn stop_an_on_arc_cards_arc_as_closed(ledger: &SessionLedger, session_id: &str) {
    let Ok(Some(row)) = ledger.get(session_id) else {
        return;
    };
    let Some(arc) = row.arc_name.as_deref() else {
        return;
    };
    if ledger.stage_provenance(session_id).is_none() {
        return;
    }
    let project = std::path::Path::new(&row.project_dir);
    let Some(record) = tugarc_core::arc::read_arc(project, arc) else {
        return;
    };
    if record.done || record.stopped.is_some() {
        return;
    }
    let Some(stage) = record.current_stage() else {
        return;
    };
    if let Err(e) = tugarc_core::arc::append_arc_stop(
        project,
        arc,
        stage,
        tugarc_core::arc::ArcStopReason::CardClosed,
    ) {
        tracing::warn!(
            arc = %arc,
            error = %e,
            "could not record that a card on an arc closed",
        );
    }
}

/// Resolve the arc `tugtool arc stop` asks to stop, or say why there is none.
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
    arc: &str,
) -> ArcApiOutcome {
    let tug_session_id = match calling_segment(ledger, tug_session_id) {
        Ok(live) => live,
        Err(outcome) => return outcome,
    };
    let tug_session_id = tug_session_id.as_str();
    let Some(row) = ledger.get(tug_session_id).ok().flatten() else {
        return ArcApiOutcome::UnknownSession;
    };
    match row.arc_name.as_deref() {
        Some(bound) if bound == arc => {}
        Some(bound) => {
            return ArcApiOutcome::Error(format!(
                "card is bound to {bound}, not {arc} — stop it from the card running it"
            ));
        }
        None => {
            return ArcApiOutcome::Error(format!(
                "card is bound to no arc, so it cannot stop {arc}"
            ));
        }
    }
    let Some(record) = tugarc_core::arc::read_arc(project_dir, arc) else {
        return ArcApiOutcome::Error(format!("{arc} has no arc to stop"));
    };
    if record.done {
        return ArcApiOutcome::Error(format!("{arc}'s arc is already done"));
    }
    if let Some((stage, reason)) = record.stopped.as_ref() {
        return ArcApiOutcome::Error(format!(
            "{arc}'s arc is already stopped in {} — {reason}",
            stage.as_str()
        ));
    }
    // A stop protocol in flight is the one state a second press must not run
    // over: two stoppers sharing no lock is the shape the mark exists to
    // close ([B05]). The press is answered by sentence; the protocol's own
    // end answers the first.
    if let Some(stage) = record.stopping {
        return ArcApiOutcome::Error(format!(
            "{arc}'s arc is already stopping in {}",
            stage.as_str()
        ));
    }
    // An arc that has opened but rotated nothing is still a live arc, and
    // stopping it is an ordinary thing to want. `Devise` is the stage it would
    // have rotated first, and it is the same default the predicate takes when
    // it has to name a stage for a record that has none.
    let stage = record
        .current_stage()
        .unwrap_or(tugarc_core::arc::ArcStage::Devise);
    ArcApiOutcome::ArcStopped {
        arc: arc.to_string(),
        stage,
        session_id: tug_session_id.to_string(),
        project_dir: project_dir.to_string_lossy().into_owned(),
        reason: tugarc_core::arc::ArcStopReason::StoppedByUser,
        question: None,
    }
}

/// Resolve the arc a stage's `tugtool arc ask` stops, and carry its question.
///
/// The same resolution [`arc_stop`] performs, and deliberately the same one: a
/// stage raising a question is stopping its own arc, and a second path to the
/// same act could refuse where the first succeeded. What differs is the reason
/// and the payload — `NeedsDecision`, and the question the async half writes as
/// an `arc-note` before the stop so the record carries it and the receipt can
/// read it back.
///
/// A blank question is refused rather than accepted as an empty note. "The
/// stage stopped and would not say what it was asking" is the one outcome this
/// verb exists to make impossible.
pub(crate) fn arc_ask(
    ledger: &SessionLedger,
    project_dir: &std::path::Path,
    tug_session_id: &str,
    arc: &str,
    question: &str,
) -> ArcApiOutcome {
    let question = question.trim();
    if question.is_empty() {
        return ArcApiOutcome::Error(
            "arc ask needs the question — a stop nobody can read is not a receipt".to_string(),
        );
    }
    match arc_stop(ledger, project_dir, tug_session_id, arc) {
        ArcApiOutcome::ArcStopped {
            arc,
            stage,
            session_id,
            project_dir,
            ..
        } => ArcApiOutcome::ArcStopped {
            arc,
            stage,
            session_id,
            project_dir,
            reason: tugarc_core::arc::ArcStopReason::NeedsDecision,
            question: Some(question.to_owned()),
        },
        other => other,
    }
}

/// Sweep every binding to a dead arc, plus its authored draft row.
///
/// `arc_id` is the owner key the caller captured **before** the teardown that
/// deleted the arc's branch (Risk R02). This endpoint never re-derives
/// it: by the time the call is made, the branch config it would read is gone,
/// and the only key it could produce would be the legacy one — which names
/// none of the id-keyed rows it is here to remove ([L23]).
pub(crate) fn arc_gone(
    ledger: &SessionLedger,
    project_dir: &std::path::Path,
    arc_id: &str,
) -> ArcApiOutcome {
    // Found **before** the bindings are cleared: the binding is how a seated
    // session is found at all, and clearing it first would leave nothing to
    // look through.
    let seated = seated_stages(ledger, arc_id);
    let cleared = match ledger.clear_arc_bindings_for_arc(arc_id) {
        Ok(n) => n,
        Err(e) => return ArcApiOutcome::Error(e.to_string()),
    };
    crate::feeds::agent_supervisor::AgentSupervisor::clear_arc_draft(
        ledger,
        &project_dir.to_string_lossy(),
        arc_id,
    );
    ArcApiOutcome::Cleared { cleared, seated }
}

/// Every live session bound to `arc_id` that a stage of a live arc is seated
/// on, with the stage it is in.
///
/// Two facts have to hold together: the session carries a `stage_label`, which
/// only a rotation writes, and the arc it is bound to has an arc that is
/// neither done nor stopped. A card merely bound to the arc is not one an
/// ending needs to tell anything about a stage.
fn seated_stages(ledger: &SessionLedger, arc_id: &str) -> Vec<SeatedArcStage> {
    let Ok(by_arc) = ledger.bound_session_by_arc() else {
        return Vec::new();
    };
    let Some(session_id) = by_arc.get(arc_id) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    {
        let Ok(Some(row)) = ledger.get(session_id) else {
            return out;
        };
        let Some(arc_name) = row.arc_name.clone() else {
            return out;
        };
        // The sessions table is keyed by the same id `stage_provenance` reads,
        // which is the id `bound_session_by_arc` handed back.
        if ledger.stage_provenance(session_id).is_none() {
            return out;
        }
        let Some(record) =
            tugarc_core::arc::read_arc(std::path::Path::new(&row.project_dir), &arc_name)
        else {
            return out;
        };
        if record.done || record.stopped.is_some() {
            return out;
        }
        let Some(stage) = record.current_stage() else {
            return out;
        };
        out.push(SeatedArcStage {
            session_id: session_id.clone(),
            arc_name,
            project_dir: row.project_dir.clone(),
            stage,
        });
    }
    out
}

/// Whether a session working `session_project` may bind an arc in
/// `arc_project`.
///
/// Both sides go through the [L29] gateway before they are compared, so the
/// two spellings of one directory — the session's, recorded at spawn, and the
/// CLI's, taken from a cwd — cannot read as two projects. Each side is then
/// resolved a second time, through `linked_worktree_base`: a path inside a
/// linked git worktree compares as the checkout that worktree belongs to.
///
/// That second hop is what lets an arc bind from the one directory an arc run
/// actually works in. The worktree is not a foreign project — it is this
/// project's other working copy — and the guard exists to refuse foreign
/// projects, which it still does with the message unchanged. Both sides are
/// resolved because a session can itself have been spawned in a worktree.
///
/// The hop runs here, server-side and after the gateway, so the CLI still
/// canonicalizes nothing ([L29]).
fn same_project(session_project: &str, arc_project: &std::path::Path) -> bool {
    let through_base = |p: &std::path::Path| {
        let resolved = crate::path_resolver::resolve_to_claude_form(p);
        match tugcore::registry::linked_worktree_base(&resolved) {
            Some(base) => crate::path_resolver::resolve_to_claude_form(&base),
            None => resolved,
        }
    };
    through_base(std::path::Path::new(session_project)) == through_base(arc_project)
}

#[cfg(test)]
mod tests {
    use super::same_project;
    use super::*;
    use tempfile::tempdir;

    /// A real ledger with one session bound to a live arc on `alpha`, in a
    /// real project the arc record belongs to.
    fn on_arc_card(root: &std::path::Path) -> SessionLedger {
        // A real repo: `ensure_arc_id` mints through git config.
        for args in [
            &["init", "-q"][..],
            &["config", "user.email", "t@example.com"][..],
            &["config", "user.name", "T"][..],
        ] {
            let ok = tugcore::git_command()
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
            "[tugtool.arc]\ndocs = \"arc\"\n",
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
                "claude-1",
                None,
            )
            .unwrap();
        ledger
            .set_arc_binding("claude-1", Some(("tugarc/alpha#1", "alpha")))
            .unwrap();
        tugarc_core::arc::append_arc_start(root, "alpha", "arc/alpha-brief.md").unwrap();
        ledger
    }

    fn bound_arc(ledger: &SessionLedger) -> Option<String> {
        ledger
            .get("claude-1")
            .ok()
            .flatten()
            .and_then(|r| r.arc_name)
    }

    /// The same real project and live card, with the binding cleared: the
    /// shape a Start press arrives on, where the card runs nothing yet.
    fn idle_card(root: &std::path::Path) -> SessionLedger {
        let ledger = on_arc_card(root);
        ledger
            .set_arc_binding("claude-1", None::<(&str, &str)>)
            .unwrap();
        ledger
    }

    /// Write an arc's brief at its own address, which is the whole of what an
    /// arc needs on disk before it can be opened.
    fn write_brief(root: &std::path::Path, arc: &str) {
        let dir = root.join(".tug").join("arcs").join(arc);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("brief.md"), "# Brief\n").unwrap();
    }

    /// The other document the `/arc` door writes. A task list with no plan
    /// beside it is what makes an arc plain.
    fn write_tasks(root: &std::path::Path, arc: &str) {
        let dir = root.join(".tug").join("arcs").join(arc);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("tasks.md"), "# Tasks\n").unwrap();
    }

    /// A temp `TUG_DATA_DIR` and a temp repo, in the order every arc test
    /// here needs them: the environment first, so the arc log lands under the
    /// fixture rather than the developer's own data dir.
    fn arc_run_fixture() -> (tempfile::TempDir, tempfile::TempDir) {
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        (home, tempdir().unwrap())
    }

    /// **Start opens.** An arc with a brief and no record is the shape the
    /// Arcs card's Start button acts on, and the opening reads the kind off
    /// those documents ([B04]) — a brief alone is planned, a task list beside
    /// it is plain. The press names neither.
    #[test]
    #[serial_test::serial]
    fn arc_run_opens_a_document_only_arc_with_the_kind_its_documents_name() {
        let (_home, dir) = arc_run_fixture();
        let root = dir.path();
        let ledger = idle_card(root);
        write_brief(root, "beta");

        assert!(matches!(
            arc_run(&ledger, root, "claude-1", "beta"),
            ArcApiOutcome::Bound { .. }
        ));
        let record = tugarc_core::arc::read_arc(root, "beta").expect("the arc was opened");
        assert_eq!(record.kind, Some(tugarc_core::ArcKind::Planned));
        assert_eq!(record.document.as_deref(), Some(".tug/arcs/beta/brief.md"));
        assert_eq!(bound_arc(&ledger).as_deref(), Some("beta"));

        let (_home, dir) = arc_run_fixture();
        let root = dir.path();
        let ledger = idle_card(root);
        write_brief(root, "gamma");
        write_tasks(root, "gamma");

        assert!(matches!(
            arc_run(&ledger, root, "claude-1", "gamma"),
            ArcApiOutcome::Bound { .. }
        ));
        let record = tugarc_core::arc::read_arc(root, "gamma").expect("the arc was opened");
        assert_eq!(record.kind, Some(tugarc_core::ArcKind::Plain));
        assert_eq!(record.document.as_deref(), Some(".tug/arcs/gamma/brief.md"));
    }

    /// **And an arc with no documents is refused before it writes.** There is
    /// nothing to derive a kind from and nothing for a stage to read, so the
    /// refusal names the address to write to — and a refusal that has already
    /// written half an arc is worse than the refusal alone.
    #[test]
    #[serial_test::serial]
    fn arc_run_with_no_record_and_no_documents_is_refused_before_it_writes() {
        let (_home, dir) = arc_run_fixture();
        let root = dir.path();
        let ledger = idle_card(root);

        match arc_run(&ledger, root, "claude-1", "beta") {
            ArcApiOutcome::Error(message) => {
                assert!(
                    message.contains("has no brief, plan, or task list"),
                    "{message}"
                );
            }
            other => panic!("expected a refusal, got {}", outcome_name(&other)),
        }
        assert!(
            tugarc_core::arc::read_arc(root, "beta").is_none(),
            "nothing was written",
        );
        assert!(bound_arc(&ledger).is_none(), "and nothing was bound");
    }

    /// **Start is not Resume.** An arc that already has a record is bound and
    /// otherwise left exactly as it is — a stopped one stays stopped, because
    /// clearing a stop is `arc_resume`'s act and no other ([B04]).
    #[test]
    #[serial_test::serial]
    fn arc_run_on_an_existing_record_binds_and_writes_nothing() {
        let (_home, dir) = arc_run_fixture();
        let root = dir.path();
        let ledger = idle_card(root);
        write_brief(root, "beta");
        tugarc_core::arc::append_arc_start(root, "beta", ".tug/arcs/beta/brief.md").unwrap();
        tugarc_core::arc::append_arc_stop(
            root,
            "beta",
            tugarc_core::ArcStage::Devise,
            tugarc_core::arc::ArcStopReason::StoppedByUser,
        )
        .unwrap();

        assert!(matches!(
            arc_run(&ledger, root, "claude-1", "beta"),
            ArcApiOutcome::Bound { .. }
        ));
        let record = tugarc_core::arc::read_arc(root, "beta").expect("the record stands");
        assert!(
            record.stopped.is_some(),
            "the stop is the resume's to clear, not the start's",
        );
        assert_eq!(record.kind, None, "and no kind line was written over it");
        assert_eq!(bound_arc(&ledger).as_deref(), Some("beta"));
    }

    /// Rotate `on_arc_card`'s card the way the Wheel does: a fresh segment
    /// on the same line, seated with the binding, and the old id closed and
    /// demoted. `claude-1` is what `$TUG_SESSION_ID` still says inside it.
    fn rotate_the_card(ledger: &SessionLedger, root: &std::path::Path) {
        ledger.demote_live_to_closed().unwrap();
        ledger
            .record_spawn(
                "claude-2",
                "ws-test",
                &root.to_string_lossy(),
                "card-1",
                2_000,
                "claude-1",
                None,
            )
            .unwrap();
        ledger.seat_line_bindings().unwrap();
    }

    #[test]
    #[serial_test::serial]
    fn a_bind_from_a_rotated_card_lands_on_the_seated_segment() {
        // The `lens-breakout` failure: the stage posts the id it was spawned
        // under, which two rotations later names a closed, demoted row. Bound
        // raw, the write moved a column on that corpse and reported success
        // while the live card showed no arc at all.
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = on_arc_card(root);
        rotate_the_card(&ledger, root);

        // A re-bind naming the arc already running is the resume path, which
        // is exactly the gesture the note reached for as a repair.
        assert!(matches!(
            bind(&ledger, root, "claude-1", "alpha"),
            ArcApiOutcome::Bound { .. }
        ));
        assert_eq!(
            ledger.get("claude-2").unwrap().unwrap().arc_name.as_deref(),
            Some("alpha"),
            "the binding is on the segment that is actually seated",
        );
        assert!(
            bound_arc(&ledger).is_none(),
            "and nothing was written onto the segment the stale id named",
        );
    }

    #[test]
    #[serial_test::serial]
    fn a_verb_from_a_card_whose_line_has_closed_is_refused() {
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = on_arc_card(root);
        ledger.demote_live_to_closed().unwrap();

        match bind(&ledger, root, "claude-1", "alpha") {
            ArcApiOutcome::Error(message) => {
                assert!(
                    message.contains("no segment of its line is live"),
                    "{message}"
                );
            }
            _ => panic!("a bind with no card left to bind must say so, not succeed"),
        }
        match unbind(&ledger, "claude-1") {
            ArcApiOutcome::Error(message) => {
                assert!(message.contains("has gone"), "{message}");
            }
            _ => panic!("and so must an unbind"),
        }
    }

    #[test]
    #[serial_test::serial]
    fn a_card_running_a_score_refuses_a_bind_to_another_arc() {
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = on_arc_card(root);

        let outcome = bind(&ledger, root, "claude-1", "beta");
        match outcome {
            ArcApiOutcome::Error(message) => {
                assert!(message.contains("alpha"), "{message}");
                assert!(message.contains("beta"), "{message}");
            }
            _ => panic!("a live arc must refuse a bind naming another arc"),
        }
        assert_eq!(
            bound_arc(&ledger).as_deref(),
            Some("alpha"),
            "and the binding it protects is untouched",
        );
    }

    #[test]
    #[serial_test::serial]
    fn unbinding_an_on_arc_card_stops_the_arc_as_card_closed() {
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = on_arc_card(root);
        tugarc_core::arc::append_arc_stage(
            root,
            "alpha",
            tugarc_core::arc::ArcStage::Review,
            "claude-1",
            None,
        )
        .unwrap();
        ledger
            .set_stage_provenance("claude-1", "review", None)
            .unwrap();

        assert!(matches!(
            unbind(&ledger, "claude-1"),
            ArcApiOutcome::Unbound { .. }
        ));
        assert_eq!(
            tugarc_core::arc::read_arc(root, "alpha").unwrap().stopped,
            Some((
                tugarc_core::arc::ArcStage::Review,
                "card closed".to_string()
            )),
            "the record says the card went, rather than reading `review` forever",
        );
        assert!(bound_arc(&ledger).is_none(), "and the binding is cleared");
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
                "claude-1",
                None,
            )
            .unwrap();
        ledger
            .set_arc_binding("claude-1", Some(("tugarc/plain#1", "plain")))
            .unwrap();

        assert!(matches!(
            unbind(&ledger, "claude-1"),
            ArcApiOutcome::Unbound { .. }
        ));
        assert_eq!(tugarc_core::arc::read_arc(root, "plain"), None);
    }

    #[test]
    #[serial_test::serial]
    fn a_card_no_rotation_seated_writes_no_stop_when_it_unbinds() {
        // Bound is not seated: an ordinary card that happens to name the arc
        // is not the card the arc's stage runs on.
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = on_arc_card(root);

        assert!(matches!(
            unbind(&ledger, "claude-1"),
            ArcApiOutcome::Unbound { .. }
        ));
        assert_eq!(
            tugarc_core::arc::read_arc(root, "alpha").unwrap().stopped,
            None,
        );
    }

    #[test]
    #[serial_test::serial]
    fn arc_gone_finds_the_sessions_a_stage_is_seated_on() {
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = on_arc_card(root);
        tugarc_core::arc::append_arc_stage(
            root,
            "alpha",
            tugarc_core::arc::ArcStage::Review,
            "claude-1",
            None,
        )
        .unwrap();
        ledger
            .set_stage_provenance("claude-1", "review", None)
            .unwrap();
        // A second card bound to the same arc that no rotation seated: bound
        // is not the same as carrying a stage.
        ledger
            .record_spawn(
                "claude-2",
                "ws-test",
                &root.to_string_lossy(),
                "card-2",
                1_000,
                "claude-2",
                None,
            )
            .unwrap();
        ledger
            .set_arc_binding("claude-2", Some(("tugarc/alpha#1", "alpha")))
            .unwrap();

        let ArcApiOutcome::Cleared { cleared, seated } = arc_gone(&ledger, root, "tugarc/alpha#1")
        else {
            panic!("arc_gone reports what it swept");
        };
        assert_eq!(cleared, 2, "both bindings are cleared");
        assert_eq!(seated.len(), 1, "only the seated card is told");
        assert_eq!(seated[0].session_id, "claude-1");
        assert_eq!(seated[0].arc_name, "alpha");
        assert_eq!(seated[0].stage, tugarc_core::arc::ArcStage::Review);
        assert_eq!(seated[0].project_dir, root.to_string_lossy());
    }

    #[test]
    #[serial_test::serial]
    fn arc_gone_on_a_arc_with_no_arc_finds_nothing_seated() {
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
                "claude-1",
                None,
            )
            .unwrap();
        ledger
            .set_arc_binding("claude-1", Some(("tugarc/plain#1", "plain")))
            .unwrap();

        let ArcApiOutcome::Cleared { cleared, seated } = arc_gone(&ledger, root, "tugarc/plain#1")
        else {
            panic!("arc_gone reports what it swept");
        };
        assert_eq!(cleared, 1);
        assert!(seated.is_empty(), "a hand-made arc seats no stage");
    }

    #[test]
    #[serial_test::serial]
    fn an_ending_writes_no_arc_line_after_the_terminal_one() {
        // The phantom-generation guard. `read_arc` resets at the last terminal
        // line, so an `arc-stop` appended after one becomes the first line of
        // a next generation that an arc reusing this name would be born
        // carrying. This fails loudly if anybody puts the append back.
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = on_arc_card(root);
        tugarc_core::arc::append_arc_stage(
            root,
            "alpha",
            tugarc_core::arc::ArcStage::Review,
            "claude-1",
            None,
        )
        .unwrap();
        ledger
            .set_stage_provenance("claude-1", "review", None)
            .unwrap();
        // The ending's own terminal line, appended before the CLI broadcasts.
        tugarc_core::log::append_arc_log(root, "alpha", "discarded", "").unwrap();

        let _ = arc_gone(&ledger, root, "tugarc/alpha#1");

        assert_eq!(
            tugarc_core::arc::read_arc(root, "alpha"),
            None,
            "the arc's generation stays closed",
        );
    }

    #[test]
    fn a_joined_arc_says_joined_and_a_discarded_one_says_discarded() {
        // The gesture rides the op, and a missing field reads as a discard —
        // which is what every caller before the field existed was.
        assert_eq!(ArcGoneReason::parse(Some("joined")), ArcGoneReason::Joined,);
        assert_eq!(ArcGoneReason::parse(Some("joined")).as_str(), "joined");
        assert_eq!(
            ArcGoneReason::parse(Some("discarded")),
            ArcGoneReason::Discarded,
        );
        assert_eq!(ArcGoneReason::parse(None), ArcGoneReason::Discarded);
        assert_eq!(ArcGoneReason::parse(None).as_str(), "discarded");
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
        let ledger = on_arc_card(root);
        tugarc_core::arc::append_arc_stage(
            root,
            "alpha",
            tugarc_core::arc::ArcStage::Review,
            "claude-1",
            None,
        )
        .unwrap();

        match arc_stop(&ledger, root, "claude-1", "alpha") {
            ArcApiOutcome::ArcStopped { arc, stage, .. } => {
                assert_eq!(arc, "alpha");
                assert_eq!(stage, tugarc_core::arc::ArcStage::Review);
            }
            ArcApiOutcome::Error(m) => panic!("refused: {m}"),
            _ => panic!("unexpected"),
        }
    }

    /// `arc ask` is `arc stop` under its own reason, carrying the question.
    ///
    /// The same resolution on purpose — a stage raising a question is stopping
    /// its own arc, and a second path to the same act could refuse where the
    /// first succeeded. What differs is the reason and the payload.
    #[test]
    #[serial_test::serial]
    fn arc_ask_stops_the_same_arc_under_its_own_reason() {
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = on_arc_card(root);
        tugarc_core::arc::append_arc_stage(
            root,
            "alpha",
            tugarc_core::arc::ArcStage::Review,
            "claude-1",
            None,
        )
        .unwrap();

        match arc_ask(
            &ledger,
            root,
            "claude-1",
            "alpha",
            "  per-host or per-request?  ",
        ) {
            ArcApiOutcome::ArcStopped {
                arc,
                stage,
                reason,
                question,
                ..
            } => {
                assert_eq!(arc, "alpha");
                assert_eq!(stage, tugarc_core::arc::ArcStage::Review);
                assert_eq!(reason, tugarc_core::arc::ArcStopReason::NeedsDecision);
                assert_eq!(question.as_deref(), Some("per-host or per-request?"));
            }
            ArcApiOutcome::Error(m) => panic!("refused: {m}"),
            _ => panic!("unexpected"),
        }
    }

    /// A blank question is refused rather than accepted as an empty note.
    ///
    /// "The stage stopped and would not say what it was asking" is the one
    /// outcome this verb exists to make impossible.
    #[test]
    #[serial_test::serial]
    fn arc_ask_refuses_a_question_that_says_nothing() {
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = on_arc_card(root);

        match arc_ask(&ledger, root, "claude-1", "alpha", "   ") {
            ArcApiOutcome::Error(message) => {
                assert!(message.contains("needs the question"), "{message}");
            }
            _ => panic!("a blank question must not stop an arc"),
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
        let ledger = on_arc_card(root);

        match arc_stop(&ledger, root, "claude-1", "alpha") {
            ArcApiOutcome::ArcStopped { stage, .. } => {
                assert_eq!(stage, tugarc_core::arc::ArcStage::Devise);
            }
            ArcApiOutcome::Error(m) => panic!("refused: {m}"),
            _ => panic!("unexpected"),
        }
    }

    #[test]
    #[serial_test::serial]
    fn arc_stop_refuses_a_card_bound_to_another_arc() {
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = on_arc_card(root);

        match arc_stop(&ledger, root, "claude-1", "beta") {
            ArcApiOutcome::Error(message) => {
                assert!(message.contains("alpha"), "{message}");
                assert!(message.contains("beta"), "{message}");
            }
            _ => panic!("a card bound elsewhere cannot stop this arc"),
        }
        // And a session this instance does not hold is the walk-on answer.
        assert!(matches!(
            arc_stop(&ledger, root, "claude-elsewhere", "alpha"),
            ArcApiOutcome::UnknownSession
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
                        "claude-1",
                        None,
                    )
                    .unwrap();
                ledger
                    .set_arc_binding("claude-1", Some(("tugarc/alpha#1", "alpha")))
                    .unwrap();
            } else {
                let ledger = on_arc_card(root);
                if close == "done" {
                    tugarc_core::arc::append_arc_done(root, "alpha").unwrap();
                } else {
                    tugarc_core::arc::append_arc_stop(
                        root,
                        "alpha",
                        tugarc_core::arc::ArcStage::Devise,
                        tugarc_core::arc::ArcStopReason::CardClosed,
                    )
                    .unwrap();
                }
                match arc_stop(&ledger, root, "claude-1", "alpha") {
                    ArcApiOutcome::Error(message) => {
                        assert!(message.contains("alpha"), "{close}: {message}");
                    }
                    _ => panic!("{close}: there is no live arc to stop"),
                }
                continue;
            }
            match arc_stop(&ledger, root, "claude-1", "alpha") {
                ArcApiOutcome::Error(message) => {
                    assert!(message.contains("no arc"), "{message}");
                }
                _ => panic!("an arc with no arc has none to stop"),
            }
        }
    }

    /// The variant an outcome is, for a panic message — `ArcApiOutcome` is a
    /// wire-shaped enum and carries no `Debug`.
    fn outcome_name(outcome: &ArcApiOutcome) -> String {
        match outcome {
            ArcApiOutcome::Bound { .. } => "Bound".to_string(),
            ArcApiOutcome::Error(message) => format!("Error({message})"),
            _ => "another outcome".to_string(),
        }
    }

    /// A second live card in the same project, on its own line.
    fn second_card(ledger: &SessionLedger, root: &std::path::Path) {
        ledger
            .record_spawn(
                "claude-2",
                "ws-test",
                &root.to_string_lossy(),
                "card-2",
                2_000,
                "claude-2",
                None,
            )
            .unwrap();
    }

    /// Seat `demo` on `claude-1` under the id every other reader keys by —
    /// the one `ensure_arc_id` mints — and give the arc a record to run.
    fn demo_on_the_first_card(ledger: &SessionLedger, root: &std::path::Path) -> String {
        let arc_id = tugarc_core::ops::ensure_arc_id(root, "demo").unwrap();
        ledger
            .set_arc_binding("claude-1", Some((&arc_id, "demo")))
            .unwrap();
        tugarc_core::arc::append_arc_start(root, "demo", "arc/demo-brief.md").unwrap();
        arc_id
    }

    /// One arc, one card: a bind naming an arc another live card holds is
    /// refused, and the refusal names the holder so the user knows which card
    /// to go and stop.
    #[test]
    #[serial_test::serial]
    fn a_bind_naming_an_arc_another_live_card_holds_is_refused_by_name() {
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = on_arc_card(root);
        demo_on_the_first_card(&ledger, root);
        ledger.rename("claude-1", Some("Wheelhouse")).unwrap();
        second_card(&ledger, root);

        match bind(&ledger, root, "claude-2", "demo") {
            ArcApiOutcome::Error(message) => {
                assert!(
                    message.contains("Wheelhouse") && message.contains("is running demo"),
                    "the refusal names the holder: {message}",
                );
            }
            other => panic!("a second holder is refused, not {}", outcome_name(&other)),
        }
        assert!(
            ledger.get("claude-2").unwrap().unwrap().arc_name.is_none(),
            "and the refused card is left holding nothing",
        );
    }

    /// The refusal comes *before* the resume line: an arc another card holds
    /// must not have its stop cleared by a card that will not be seated on it.
    #[test]
    #[serial_test::serial]
    fn a_resume_of_an_arc_another_card_holds_writes_no_line() {
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = on_arc_card(root);
        demo_on_the_first_card(&ledger, root);
        tugarc_core::arc::append_arc_stop(
            root,
            "demo",
            tugarc_core::arc::ArcStage::Implement,
            tugarc_core::arc::ArcStopReason::StoppedByUser,
        )
        .unwrap();
        second_card(&ledger, root);
        let before = resume_lines(root);

        match arc_resume(&ledger, root, "claude-2", "demo") {
            ArcApiOutcome::Error(message) => {
                assert!(message.contains("is running demo"), "{message}");
            }
            other => panic!("a second holder is refused, not {}", outcome_name(&other)),
        }
        assert_eq!(resume_lines(root), before, "and the stop still stands");
        assert!(
            tugarc_core::arc::read_arc(root, "demo")
                .unwrap()
                .stopped
                .is_some()
        );
    }

    /// The frozen-id case the holder check is keyed to survive: a card posts
    /// the id it was spawned under, which a rotation later names a closed
    /// segment. Compared raw, the live segment its own line was seated on
    /// would read as a foreign holder, and the card would be refused its own
    /// arc in a sentence naming its own callsign.
    #[test]
    #[serial_test::serial]
    fn a_resume_posted_under_a_frozen_id_is_not_refused_as_a_foreign_holder() {
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = on_arc_card(root);
        demo_on_the_first_card(&ledger, root);
        tugarc_core::arc::append_arc_stop(
            root,
            "demo",
            tugarc_core::arc::ArcStage::Implement,
            tugarc_core::arc::ArcStopReason::StoppedByUser,
        )
        .unwrap();
        // The Wheel rotates the card: the binding moves onto the fresh
        // segment, and `$TUG_SESSION_ID` still says `claude-1`.
        rotate_the_card(&ledger, root);

        assert!(
            matches!(
                arc_resume(&ledger, root, "claude-1", "demo"),
                ArcApiOutcome::Bound { .. }
            ),
            "a card's own line is never a foreign holder",
        );
        assert_eq!(
            ledger.get("claude-2").unwrap().unwrap().arc_name.as_deref(),
            Some("demo"),
        );
    }

    #[test]
    #[serial_test::serial]
    fn binding_the_same_arc_again_is_still_a_no_op() {
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = on_arc_card(root);

        // The resume path, and `claim_arc` on the arc the card already runs.
        match bind(&ledger, root, "claude-1", "alpha") {
            ArcApiOutcome::Bound { .. } => {}
            ArcApiOutcome::Error(m) => panic!("refused: {m}"),
            _ => panic!("unexpected"),
        }
        assert_eq!(bound_arc(&ledger).as_deref(), Some("alpha"));
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
            let ledger = on_arc_card(root);
            if close == "stopped" {
                tugarc_core::arc::append_arc_stop(
                    root,
                    "alpha",
                    tugarc_core::arc::ArcStage::Devise,
                    tugarc_core::arc::ArcStopReason::StoppedByUser,
                )
                .unwrap();
            } else {
                tugarc_core::arc::append_arc_done(root, "alpha").unwrap();
            }

            assert!(
                matches!(
                    bind(&ledger, root, "claude-1", "beta"),
                    ArcApiOutcome::Bound { .. }
                ),
                "a {close} arc is not one running",
            );
            assert_eq!(bound_arc(&ledger).as_deref(), Some("beta"));
        }
    }

    /// Every `arc-resume` line standing in the arc log, read raw. The record
    /// says only *whether* an arc is stopped, and the unstopped case below
    /// is about a line that must not have been written at all.
    fn resume_lines(root: &std::path::Path) -> usize {
        let path = tugtool_core::paths::arc_log_path(root);
        std::fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .filter(|line| line.contains("arc-resume"))
            .count()
    }

    /// A resume is the two acts `tugtool arc run` performs on a stopped arc
    /// ([F02]): the stop is cleared by naming the stage to rotate again, and
    /// the calling card is seated on the arc.
    #[test]
    #[serial_test::serial]
    fn a_resume_clears_the_stop_and_seats_the_card() {
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = on_arc_card(root);
        tugarc_core::arc::append_arc_stage(
            root,
            "alpha",
            tugarc_core::arc::ArcStage::Implement,
            "claude-1",
            None,
        )
        .unwrap();
        tugarc_core::arc::append_arc_stop(
            root,
            "alpha",
            tugarc_core::arc::ArcStage::Implement,
            tugarc_core::arc::ArcStopReason::StoppedByUser,
        )
        .unwrap();

        assert!(matches!(
            arc_resume(&ledger, root, "claude-1", "alpha"),
            ArcApiOutcome::Bound { .. }
        ));
        let record = tugarc_core::arc::read_arc(root, "alpha").expect("the arc is still there");
        assert!(
            record.stopped.is_none(),
            "the stop is cleared, which is what tells the runner to pick up",
        );
        assert_eq!(
            record.current_stage(),
            Some(tugarc_core::arc::ArcStage::Implement),
            "and it picks up in the stage it stopped in, not at the top",
        );
        assert_eq!(bound_arc(&ledger).as_deref(), Some("alpha"));
    }

    /// [B06]: pressing Resume on an arc that carries no stop binds and writes
    /// nothing. The receipt block may not read live state to know whether its
    /// stop is still standing ([F05]), so the second press has to be harmless
    /// here rather than refused there.
    #[test]
    #[serial_test::serial]
    fn a_resume_of_an_unstopped_arc_writes_no_line() {
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = on_arc_card(root);

        assert!(matches!(
            arc_resume(&ledger, root, "claude-1", "alpha"),
            ArcApiOutcome::Bound { .. }
        ));
        assert_eq!(
            resume_lines(root),
            0,
            "an arc with nothing to resume gains no resume line",
        );
        assert_eq!(bound_arc(&ledger).as_deref(), Some("alpha"));
    }

    /// A session this instance does not own keeps the CLI's
    /// try-each-instance loop walking ([P04]) — and, because the session is
    /// resolved before anything is written, leaves the record alone.
    #[test]
    #[serial_test::serial]
    fn a_resume_from_an_unknown_session_is_refused_before_it_writes() {
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = on_arc_card(root);
        tugarc_core::arc::append_arc_stop(
            root,
            "alpha",
            tugarc_core::arc::ArcStage::Devise,
            tugarc_core::arc::ArcStopReason::StoppedByUser,
        )
        .unwrap();

        assert!(matches!(
            arc_resume(&ledger, root, "nobody", "alpha"),
            ArcApiOutcome::UnknownSession
        ));
        assert_eq!(
            resume_lines(root),
            0,
            "a refused resume appends nothing — an arc reading live with no \
             card seated on it is the shape a stop exists to avoid",
        );
        assert!(
            tugarc_core::arc::read_arc(root, "alpha")
                .expect("the arc is still there")
                .stopped
                .is_some(),
            "and the arc is still stopped",
        );
    }

    /// An arc name with no record is named in the refusal rather than guessed
    /// at — the button is only ever drawn on a receipt that names one.
    #[test]
    #[serial_test::serial]
    fn a_resume_of_an_arc_with_no_record_is_refused() {
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = on_arc_card(root);

        let ArcApiOutcome::Error(message) = arc_resume(&ledger, root, "claude-1", "beta") else {
            panic!("an arc with no record is an error, not a binding");
        };
        assert!(message.contains("beta"), "the refusal names it: {message}");
        assert_eq!(
            bound_arc(&ledger).as_deref(),
            Some("alpha"),
            "and the card keeps the arc it had",
        );
    }

    /// Builds a real checkout with a real linked worktree and returns both
    /// paths. Real `git worktree add` output, not a hand-built `.git` file:
    /// the pointer/`commondir` layout is exactly what the translation reads.
    fn checkout_with_worktree(root: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
        let main = root.join("checkout");
        let worktree = root.join("arcs/join-arc");
        std::fs::create_dir_all(&main).unwrap();
        let git = |args: &[&str]| {
            let ok = tugcore::git_command()
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
            "tugarc/join-arc",
            worktree.to_str().unwrap(),
        ]);
        (main, worktree)
    }

    /// The bind an arc run actually makes: the session was spawned in the
    /// checkout, and `arc step start` runs from inside the worktree.
    #[test]
    fn a_arc_worktree_is_its_checkouts_project() {
        let dir = tempdir().unwrap();
        let (main, worktree) = checkout_with_worktree(dir.path());

        assert!(same_project(&main.to_string_lossy(), &worktree));
        // Symmetric: a session spawned in the worktree binds an arc named
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

    /// **A second Stop on a stopping arc is refused** ([B05]). The mark says a
    /// protocol is in flight, and the answer is the sentence rather than a
    /// second stopper racing the first.
    #[test]
    #[serial_test::serial]
    fn a_second_stop_on_a_stopping_arc_is_refused() {
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = on_arc_card(root);
        tugarc_core::arc::append_arc_stage(
            root,
            "alpha",
            tugarc_core::arc::ArcStage::Implement,
            "claude-1",
            None,
        )
        .unwrap();
        tugarc_core::arc::append_arc_stopping(root, "alpha", tugarc_core::arc::ArcStage::Implement)
            .unwrap();

        match arc_stop(&ledger, root, "claude-1", "alpha") {
            ArcApiOutcome::Error(message) => {
                assert_eq!(message, "alpha's arc is already stopping in implement");
            }
            other => panic!(
                "a stopping arc is not stopped again: {}",
                outcome_name(&other)
            ),
        }
    }

    /// **A Resume during the stop is refused** ([B05]), and refused before any
    /// `arc-resume` line is written — the record still carries the mark and
    /// no stop afterwards.
    #[test]
    #[serial_test::serial]
    fn a_resume_during_the_stop_is_refused() {
        let home = tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempdir().unwrap();
        let root = dir.path();
        let ledger = on_arc_card(root);
        tugarc_core::arc::append_arc_stage(
            root,
            "alpha",
            tugarc_core::arc::ArcStage::Implement,
            "claude-1",
            None,
        )
        .unwrap();
        tugarc_core::arc::append_arc_stopping(root, "alpha", tugarc_core::arc::ArcStage::Implement)
            .unwrap();

        match arc_resume(&ledger, root, "claude-1", "alpha") {
            ArcApiOutcome::Error(message) => {
                assert_eq!(
                    message,
                    "alpha's arc is stopping — wait for the stop to finish"
                );
            }
            other => panic!("a stopping arc is not resumed: {}", outcome_name(&other)),
        }
        let record = tugarc_core::arc::read_arc(root, "alpha").unwrap();
        assert_eq!(record.stopping, Some(tugarc_core::arc::ArcStage::Implement));
        assert_eq!(record.resume, None, "no `arc-resume` line was written");
    }
}
