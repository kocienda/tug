//! base_motion — replay an arc onto its base the moment the base moves.
//!
//! The doctrine is that a landing problem should surface when it becomes true,
//! not when someone tries to land. So this watches for the base moving and, when
//! it is safe, moves the arc's rounds onto the new tip; the library half
//! (`tugarc_core::replay_onto`) does the moving and this decides *whether*.
//!
//! ## What wakes it
//!
//! Nothing new watches the filesystem. Each workspace already runs exactly one
//! `FileWatcher`, and `git_watch::run_git_workspace_watch` already broadcasts a
//! `GitHeadSignal` on the registry's shared GIT_HEAD channel whenever that
//! workspace's HEAD moves. This engine is one more subscriber to that channel.
//!
//! A signal is an *edge*, though: the git watch baselines `last_head` when its
//! task starts and speaks only on a move past it. An arc that was already behind
//! when tugcast started would therefore never be signalled about. So the engine
//! also **sweeps** — at startup, and whenever the registry opens a workspace it
//! has not seen. A sweep is a wake with no signal attached and runs the same
//! path; behindness is read from refs either way, so the two cannot disagree.
//!
//! The third wake is a turn ending. The common shape of this whole problem is
//! "the base moved while an agent was mid-turn on the arc," and the gate below
//! refuses to act mid-turn — so the supervisor hands the engine each session id
//! as its turn closes, and an arc parked behind it replays seconds later instead
//! of waiting for an unrelated commit.
//!
//! The fourth is a session binding to an arc. A done arc whose audit has gone
//! stale goes back to its audit stage on the Wheel, and that stage needs a
//! card: an arc nobody holds waits, and the bind that gives it one is the
//! moment to seat the re-audit.
//!
//! ## The decision is separate from the wiring
//!
//! [`decide_for_arc`] is pure — the gate and the choice of action expressed
//! over plain inputs, with no channels, no git, and no clock — following
//! `observer_wake.rs`. Every case in the gate is then a table test rather than a
//! server that has to be stood up and driven into the right state.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime};
use tugcore::instance::Paths;

use tokio::sync::{Notify, broadcast, mpsc};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use tugcast_core::protocol::{FeedId, Frame, TugSessionId};
use tugcast_core::types::GitHeadSignal;

use super::agent_supervisor::Ledger;
use super::session_scoped::SessionScopedFeed;
use super::workspace_registry::WorkspaceRegistry;
use crate::session_ledger::SessionLedger;

// MARK: - The decision

/// One live session bound to an arc, as the decision sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundSession {
    pub id: String,
    /// Whether the session is still working: mid-turn, or holding a background
    /// job it launched that has not reported. The engine reads
    /// `LedgerEntry::is_quiet` from the supervisor's in-memory ledger, which is
    /// the only place either fact lives.
    ///
    /// Not the turn flag alone. A turn ends the moment the model stops
    /// speaking, and a test sweep it backgrounded goes on reading the worktree
    /// this engine is about to rewrite.
    pub busy: bool,
}

/// Everything [`decide_for_arc`] needs about one arc, and nothing else.
#[derive(Debug, Clone)]
pub struct ArcInputs {
    /// Whether automatic motion is enabled for this repository
    /// (`git config tugarc.autoreplay`, default true).
    pub autoreplay: bool,
    /// Whether this *arc* has opted out
    /// (`git config branch.tugarc/<name>.tugautoreplay false`, default in).
    ///
    /// Every tugcast process watching a repository runs an engine, and each one
    /// treats every arc it can see as its own to keep current — which is how a
    /// release instance came to replay an app-test's fixture arc mid-test. A
    /// arc that nobody else should touch says so on its own branch config.
    pub arc_autoreplay: bool,
    /// Commits the base has gained past this arc's merge-base.
    pub base_ahead: u32,
    pub worktree_dirty: bool,
    /// A landing is in flight for this arc.
    pub join_journal: bool,
    /// The arc is part-way through a plan run, so an agent's context describes
    /// a tree a replay would move under it.
    pub mid_plan: bool,
    /// The live session bound to this arc — one arc, one card.
    pub session: Option<BoundSession>,
    /// A replay for this arc is already running — an ordinary one, or a
    /// quiet re-stamp the board publishes as `restamping`.
    pub in_flight: bool,
    /// The last replay attempt at the current base tip stopped on a conflict.
    pub conflicted: bool,
    /// The arc's audit has gone stale — the head or the base the `audited`
    /// mark was made against has moved since — and the record is one the
    /// re-audit door admits: done, or stopped at its audit for a reason the
    /// door may answer ([`tugarc_core::arc::reaudit_admits`]).
    pub audit_stale_done: bool,
    /// The stale audit went stale on the base alone: the head it was made
    /// against still stands, so no round landed after it.
    pub audit_base_only: bool,
    /// The quiet path already ran at the current base tip and could not
    /// re-stamp — the replay stopped or the fit was red.
    pub quiet_failed: bool,
}

/// What to do about one arc on one wake.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Do nothing, and say why. The reason is a stable slug for the log.
    Skip(&'static str),
    /// Replay the rounds. Nobody needs telling.
    Replay,
    /// Replay, then tell this session its context moved — the arc is mid-plan,
    /// so an agent is holding file contents the replay is about to rewrite.
    ReplayThenNotify(String),
    /// Record the state for the lane marks; nothing is safe to do. A conflict
    /// is never made into a turn here: resolving one is the audit stage's
    /// work, on the Wheel.
    MarkOnly,
    /// The arc's audit has gone stale: reopen it at the audit stage, on this
    /// idle bound session. The stage replays and resolves in the transcript,
    /// so the engine moves no refs for it.
    SeatAudit(String),
    /// The arc's audit went stale on the base alone: replay it, verify the
    /// fit, and re-stamp the audit with no turn spent. Anything short of a
    /// clean replay and a green fit seats the audit instead, on this idle
    /// bound session when there is one.
    Restamp(Option<String>),
}

/// The gate ([P02]) and the choice of action, with no IO.
///
/// Order is meaning, not convenience: the flag comes first because a repository
/// that has opted out gets no further thought; `Current` comes before the safety
/// checks because an arc with nothing to do is not "deferred over dirt"; and the
/// mid-turn check comes before any motion so a busy session is parked rather
/// than moved under, to be retried when its turn ends.
///
/// Worktree cleanliness and a join in flight are re-checked inside
/// `replay_onto`, which is the single source of truth for them — they appear
/// here so an arc that cannot be acted on is skipped without paying for a
/// blocking hop.
pub fn decide_for_arc(inputs: &ArcInputs) -> Decision {
    if !inputs.autoreplay {
        return Decision::Skip("autoreplay-off");
    }
    if !inputs.arc_autoreplay {
        return Decision::Skip("autoreplay-off (arc)");
    }
    if inputs.in_flight {
        return Decision::Skip("in-flight");
    }
    // Above `current`: an audit goes stale on a new round as well as on a
    // base move, and an arc whose head moved is not behind. Above the replay
    // gates too: a stale audit's replay is either the quiet path's own, or
    // the audit stage's, and never the ordinary one.
    if inputs.audit_stale_done {
        if inputs.join_journal {
            return Decision::Skip("join-journal");
        }
        let idle = match &inputs.session {
            Some(session) if session.busy => return Decision::Skip("session-busy"),
            Some(session) => Some(session.id.clone()),
            None => None,
        };
        // Only the base moved: the machine keeps that case, with or
        // without a card, so a join on the base costs no turn per arc. Not
        // over dirt, which `replay_onto` would only defer: the quiet path
        // waits for a clean tree as the ordinary one does, rather than
        // spending a turn on scratch bytes.
        if inputs.audit_base_only && !inputs.quiet_failed {
            if inputs.worktree_dirty {
                return Decision::Skip("dirty-worktree");
            }
            return Decision::Restamp(idle);
        }
        return match idle {
            Some(id) => Decision::SeatAudit(id),
            None => Decision::Skip("audit-stale, waiting for a card"),
        };
    }
    if inputs.base_ahead == 0 {
        return Decision::Skip("current");
    }
    if inputs.join_journal {
        return Decision::Skip("join-journal");
    }
    if inputs.worktree_dirty {
        return Decision::Skip("dirty-worktree");
    }
    if inputs.session.as_ref().is_some_and(|s| s.busy) {
        return Decision::Skip("session-busy");
    }

    if inputs.conflicted {
        return Decision::MarkOnly;
    }

    match (inputs.mid_plan, &inputs.session) {
        (true, Some(session)) => Decision::ReplayThenNotify(session.id.clone()),
        _ => Decision::Replay,
    }
}

/// How far the quiet path's replay got.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuietReplay {
    /// The arc stands on the moved base: replayed, recorded, or already current.
    Clean,
    /// The replay stopped on a conflict.
    Stopped,
    /// A gate inside `replay_onto` (dirt, a join in flight, a head that moved
    /// under it) deferred the replay. Transient: nothing is wrong with the
    /// arc, so a later wake tries again.
    Deferred,
    /// The replay could not run at all.
    Failed,
}

/// How the quiet path ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuietEnd {
    /// Write the fresh `audited` mark.
    Restamp,
    /// Hand the arc to its audit stage.
    Seat,
    /// Do nothing; a later wake tries again.
    Leave,
}

/// The quiet path's verdict, with no IO: a clean replay and a green fit
/// re-stamp; a conflict, or a fit that ran and was not green, seats the
/// audit; a deferral or a replay that could not run leaves the arc for the
/// next wake, because neither is anything a reader has to look at.
///
/// `verdict` is the verify report's word, `None` when the verify could not
/// run. Only `verified` and `nothing-in-range` are green here. A project
/// that declares no surfaces (`declares-none`) has nothing the machine can
/// run, and the audit verifies it with the plan's own checkpoints — so it is
/// seated, as a red or an unclaimed path is.
pub fn quiet_end(replay: QuietReplay, verdict: Option<&str>) -> QuietEnd {
    match replay {
        QuietReplay::Failed | QuietReplay::Deferred => QuietEnd::Leave,
        QuietReplay::Stopped => QuietEnd::Seat,
        QuietReplay::Clean => match verdict {
            Some("verified" | "nothing-in-range") => QuietEnd::Restamp,
            _ => QuietEnd::Seat,
        },
    }
}

// MARK: - Per-arc state

/// What the engine remembers about an arc between wakes.
#[derive(Debug, Default, Clone)]
struct ArcState {
    /// An ordinary replay is running. A quiet re-stamp's latch is not here:
    /// it is the board's published `restamping` fact, so the wire and a
    /// Re-audit press read the very thing the engine decides on.
    in_flight: bool,
    /// The paths the last conflicted attempt stopped on, and the base tip it
    /// stopped against. Cleared when the arc becomes current.
    conflict: Option<ConflictRecord>,
    /// The base tip the quiet path last failed at, so a wake at the same tip
    /// seats the audit rather than replaying and verifying again.
    quiet_failed_tip: Option<String>,
}

#[derive(Debug, Clone)]
struct ConflictRecord {
    base_head: String,
    round: String,
    round_subject: String,
    paths: Vec<String>,
    /// How many resolutions the rerere cache held when the replay began. A
    /// crossing settle that finishes after a sibling lands teaches the cache
    /// the very hunk this replay stopped on; a count that has moved since is
    /// the engine's cue that a retry may now recall it.
    cache_learned: usize,
}

/// One line saying what a replay stopped on — the round, the base it was
/// replayed against, and the paths that collided.
fn describe_conflict(record: &ConflictRecord) -> String {
    format!(
        "{} \"{}\" onto {}: {}",
        short(&record.round),
        record.round_subject,
        short(&record.base_head),
        record.paths.join(", "),
    )
}

// MARK: - The messages

/// The notice after a clean replay under a live plan run ([P11]).
///
/// The agent's context holds file contents from before the move, so its next
/// edit could silently revert base changes it never saw. This is context, not a
/// request — which it says, because an agent told about a change tends to
/// assume it is being asked to do something about it.
pub fn compose_replay_notice(
    arc: &str,
    base_branch: &str,
    base_head: &str,
    paths: &[String],
) -> String {
    let mut out = format!(
        "Arc \"{}\" was replayed onto {} at {} while you were between turns.\n\
         Your working tree moved under you. No action is required — but re-read any of these\n\
         files before editing them, because what you have in context predates the move:\n",
        arc,
        base_branch,
        short(base_head),
    );
    if paths.is_empty() {
        out.push_str("  (the base brought in no file changes)\n");
    } else {
        for path in paths {
            out.push_str(&format!("  {}\n", path));
        }
    }
    out
}

// MARK: - Injection

/// The payload of an injected submission — the shape `parse_tug_session_id` and
/// `InspectedPayload::from_slice` already read, so the dispatcher's existing
/// `user_message` intercept journals it exactly as it journals a client's.
/// It carries its own `submission_id`, as the deck's do, so the dispatcher
/// forwards it unchanged.
pub(crate) fn user_message_payload(session: &str, text: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "tug_session_id": session,
        "type": "user_message",
        "content": [{ "type": "text", "text": text }],
        "submission_id": uuid::Uuid::new_v4().to_string(),
    }))
    .expect("a json object of strings serializes")
}

/// Spec S05's opener — what makes an injected turn *visible*.
///
/// Journaling is not rendering: the dispatcher's intercept makes the turn real
/// to the server and to a later reload, but the transcript's live user row comes
/// from the composer echoing its own submission, and an injection has no
/// composer. Without this frame the agent would start working with no visible
/// cause.
///
/// `facts` are the outcome as data (Spec S06), for the deck to draw as a
/// receipt; the text says the same thing in words, and is still what the
/// agent reads and what a deck that knows no facts renders.
pub(crate) fn notice_payload(
    session: &str,
    origin: &str,
    text: &str,
    facts: Option<&NoticeFacts>,
) -> Vec<u8> {
    let mut body = serde_json::json!({
        "tug_session_id": session,
        "type": "tug_notice",
        "origin": origin,
        "text": text,
    });
    if let Some(facts) = facts {
        body["facts"] = serde_json::to_value(facts).expect("notice facts serialize");
    }
    serde_json::to_vec(&body).expect("a json object of strings serializes")
}

/// What a base-motion outcome was, as data (Spec S06): the replay and its
/// size. A stopped replay is no longer told to anyone — the audit stage
/// resolves it on the Wheel — though the deck still draws the receipts such
/// notices left in older transcripts.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(crate) enum NoticeFacts {
    Replayed {
        arc: String,
        base: String,
        /// The base head, full.
        sha: String,
        /// What the base brought in.
        paths: Vec<String>,
        rounds: usize,
    },
}

/// A notice with **no turn behind it** — Tug telling somebody something, rather
/// than the opener of work about to happen ([P08]).
///
/// The two are the same frame apart from `standalone`, and the flag is what
/// tells them apart on the deck. `notice_payload`'s notice precedes an injected
/// submission, so opening a turn is exactly right: the turn is coming. A
/// bulletin has nothing following it, and opening one there leaves a turn that
/// never ends — the session sits at `waking` over work nobody is doing, which
/// is what the holder of a folded file saw on 2026-09-03.
pub(crate) fn bulletin_payload(session: &str, origin: &str, text: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "tug_session_id": session,
        "type": "tug_notice",
        "origin": origin,
        "text": text,
        "standalone": true,
    }))
    .expect("a json object of strings serializes")
}

/// The origin label an injected notice is attributed to in the transcript.
const NOTICE_ORIGIN: &str = "base-motion";

/// The engine's conflict state, readable by the changeset composition.
///
/// `replay_conflict_paths` is the one snapshot field the library cannot derive:
/// whether an *attempt* conflicted is knowledge only the thing that attempted
/// has. Rather than thread a parameter through `compose_snapshot` and every
/// caller for a field that is empty in every configuration without an engine,
/// the running engine publishes itself here once. There is exactly one engine
/// per tugcast process, and when there is none the reader answers empty — which
/// is the truth in that case.
#[derive(Default)]
pub struct ConflictBoard {
    by_arc: Mutex<HashMap<String, Vec<String>>>,
    /// The quiet re-stamp, per arc: the job running now, if one is, and why
    /// the last one handed the arc to its audit stage.
    quiet: Mutex<HashMap<String, QuietFact>>,
    /// Mints each quiet job's generation, so a job a press released cannot
    /// end — or write for — the job that took the arc after it.
    generation: AtomicU64,
}

/// The re-audit's state on one arc, as the wire reads it: the run going now,
/// the one that last ended, and why the last one handed the arc to its audit
/// stage. Every face that shows the engine's re-audit reads this one fact.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QuietFact {
    /// The job running now.
    pub running: Option<RestampRun>,
    /// The re-audit that would run and is waiting on something first.
    pub waiting: Option<QuietWait>,
    /// Why the last quiet job could not re-stamp and handed the arc to its
    /// audit stage. Kept while the arc reads `audit-stale`.
    pub seated_why: Option<String>,
    /// The run that most recently ended here, as it ended — kept until the
    /// arc stops reading stale, so a card that binds after the ending can
    /// still be told it.
    pub last: Option<EndedRun>,
    /// The transcript row the current story is written to, once one is.
    /// Kept past the run's end, so a run that goes back to waiting keeps
    /// writing the same row.
    pub ink: Option<ReauditInk>,
}

/// One running quiet job: when it began, the horizon past which nothing it is
/// waiting on is worth waiting for, what moved the base under it, which phase
/// it is in, and one row per surface its verify planned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestampRun {
    pub since: SystemTime,
    pub deadline: SystemTime,
    generation: u64,
    /// The job has claimed its write ([`ConflictBoard::claim_write`]): from
    /// here to its end a press cannot release it, so the record is written by
    /// the job or by the press and never by both.
    committing: bool,
    /// The re-audit's identity, minted when it starts.
    pub run_id: String,
    pub phase: ReauditPhase,
    pub trigger: ReauditTrigger,
    /// One row per planned surface, in plan order; empty until the verify
    /// plans.
    pub surfaces: Vec<SurfaceRow>,
}

#[cfg(test)]
impl RestampRun {
    /// A run as a reader of the board meets one, for a test of that reader.
    pub(crate) fn for_test(
        since: SystemTime,
        run_id: &str,
        phase: ReauditPhase,
        trigger: ReauditTrigger,
        surfaces: Vec<SurfaceRow>,
    ) -> Self {
        RestampRun {
            since,
            deadline: since + Duration::from_secs(60),
            generation: 1,
            committing: false,
            run_id: run_id.to_string(),
            phase,
            trigger,
            surfaces,
        }
    }
}

/// A re-audit the quiet path would run and cannot yet: why, since when, and
/// what moved the base. Its run id is the one the run takes when it starts,
/// so the story is one transcript row from the wait to the verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuietWait {
    pub run_id: String,
    pub since: SystemTime,
    pub why: String,
    pub trigger: ReauditTrigger,
}

/// What a re-audit is waiting on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuietWaitReason {
    /// The bound session is mid-turn, or holds a job still running.
    SessionBusy,
    /// The arc's worktree has uncommitted changes.
    DirtyWorktree,
    /// A join is in flight for the arc.
    JoinJournal,
    /// The replay was deferred by one of its own gates; the detail says which.
    Deferred(String),
    /// The replay could not run at all.
    ReplayFailed,
}

/// Whether this wake's decision leaves a re-audit waiting, and on what. Only
/// the quiet path's waits are published: the audit went stale on the base
/// alone and the quiet path has not already failed at this tip, so the
/// re-audit is the engine's to run, and the decision skipped it for a reason
/// a later wake will clear.
pub fn quiet_wait(inputs: &ArcInputs, decision: &Decision) -> Option<QuietWaitReason> {
    if !(inputs.audit_stale_done && inputs.audit_base_only && !inputs.quiet_failed) {
        return None;
    }
    match decision {
        Decision::Skip("session-busy") => Some(QuietWaitReason::SessionBusy),
        Decision::Skip("dirty-worktree") => Some(QuietWaitReason::DirtyWorktree),
        Decision::Skip("join-journal") => Some(QuietWaitReason::JoinJournal),
        _ => None,
    }
}

/// The wait's sentence, as every face shows it. `callsign` names the bound
/// card when the ledger knows it.
pub fn wait_sentence(reason: &QuietWaitReason, callsign: Option<&str>) -> String {
    match reason {
        QuietWaitReason::SessionBusy => {
            format!(
                "waiting for {}'s turn to end",
                callsign.unwrap_or("its card")
            )
        }
        QuietWaitReason::DirtyWorktree => "waiting for the arc's worktree to be clean".to_string(),
        QuietWaitReason::JoinJournal => "waiting for a join in flight to finish".to_string(),
        QuietWaitReason::Deferred(detail) => format!("waiting to try again: {detail}"),
        QuietWaitReason::ReplayFailed => {
            "waiting to try again: the replay could not run".to_string()
        }
    }
}

/// Where a running re-audit is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReauditPhase {
    Replaying,
    Verifying,
    Marking,
    Seating,
}

impl ReauditPhase {
    /// The wire's word for the phase.
    pub fn as_str(self) -> &'static str {
        match self {
            ReauditPhase::Replaying => "replaying",
            ReauditPhase::Verifying => "verifying",
            ReauditPhase::Marking => "marking",
            ReauditPhase::Seating => "seating",
        }
    }
}

/// What moved the base: the new tip, its subject, and the arc it joined when
/// the tip is a join's squash.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReauditTrigger {
    pub sha: String,
    pub subject: String,
    pub arc: Option<String>,
}

/// One surface of a re-audit's verify, as it stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SurfaceRow {
    pub name: String,
    /// `pending`, `running`, `pass`, `fail` or `skipped`.
    pub status: &'static str,
    pub passed: Option<u64>,
    pub total: Option<u64>,
    /// The surface's wall time in whole milliseconds, once it lands.
    pub ms: Option<u64>,
    pub started: Option<SystemTime>,
    pub title: Option<String>,
    pub message: Option<String>,
}

impl SurfaceRow {
    fn pending(name: &str) -> Self {
        SurfaceRow {
            name: name.to_string(),
            status: "pending",
            passed: None,
            total: None,
            ms: None,
            started: None,
            title: None,
            message: None,
        }
    }
}

/// The sentence a surface carries when the horizon ended it.
const HORIZON_MESSAGE: &str = "stopped at the horizon";

/// A re-audit that has ended, as it ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndedRun {
    pub run_id: String,
    pub trigger: ReauditTrigger,
    pub surfaces: Vec<SurfaceRow>,
    pub since: SystemTime,
    pub ended: SystemTime,
    /// `verified`, `seated` or `released`.
    pub state: &'static str,
    pub why: Option<String>,
}

/// How a running re-audit ends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunEnding {
    /// The fit verified and the audit mark was written.
    Verified,
    /// The arc goes back to its audit stage, for this reason.
    Seated(String),
    /// The replay deferred or failed: a later wake tries again, and the run
    /// becomes a wait under its own run id, with this sentence.
    Wait(String),
}

/// The transcript row a re-audit's story is written to: which run, on whose
/// card, and the row's id and first-write clock the deck upserts it by.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReauditInk {
    pub run_id: String,
    pub session: String,
    pub receipt_id: i64,
    pub started_at_ms: i64,
}

/// One re-audit as its transcript row records it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReauditRecord {
    pub arc: String,
    pub run_id: String,
    pub base_branch: String,
    pub trigger: ReauditTrigger,
    /// `waiting`, `running`, `verified`, `seated`, `released` or `answered`.
    pub state: &'static str,
    pub why: Option<String>,
    pub started: SystemTime,
    pub ended: Option<SystemTime>,
    /// Recorded only at the terminal write; a live row reads the wire.
    pub surfaces: Vec<SurfaceRow>,
}

impl ReauditRecord {
    /// The row of a run that has ended.
    fn of_ended(arc: &str, base_branch: &str, run: &EndedRun) -> Self {
        ReauditRecord {
            arc: arc.to_string(),
            run_id: run.run_id.clone(),
            base_branch: base_branch.to_string(),
            trigger: run.trigger.clone(),
            state: run.state,
            why: run.why.clone(),
            started: run.since,
            ended: Some(run.ended),
            surfaces: run.surfaces.clone(),
        }
    }

    /// The row of a wait that ended with no run taking it.
    fn answered(arc: &str, base_branch: &str, wait: &QuietWait, ended: SystemTime) -> Self {
        ReauditRecord {
            arc: arc.to_string(),
            run_id: wait.run_id.clone(),
            base_branch: base_branch.to_string(),
            trigger: wait.trigger.clone(),
            state: "answered",
            why: Some(ANSWERED_WHY.to_string()),
            started: wait.since,
            ended: Some(ended),
            surfaces: Vec::new(),
        }
    }
}

/// The sentence a wait closes on when the audit was answered without it.
const ANSWERED_WHY: &str = "the audit was answered another way before the re-audit could start";

/// A field as one line of the row holds it: tabs and line breaks become
/// spaces, so neither can split a line or a surface's columns.
fn scrub(text: &str) -> String {
    text.chars()
        .map(|c| {
            if matches!(c, '\t' | '\n' | '\r') {
                ' '
            } else {
                c
            }
        })
        .collect()
}

/// The re-audit's transcript row: one `key: value` line per fact, then one
/// tab-separated `surface:` line per surface in plan order. The deck parses
/// it back; a field it has no value for is left empty.
pub(crate) fn format_reaudit_row(record: &ReauditRecord) -> String {
    use std::fmt::Write as _;
    let stamp = |at: SystemTime| chrono::DateTime::<chrono::Utc>::from(at).to_rfc3339();
    let num = |n: Option<u64>| n.map(|n| n.to_string()).unwrap_or_default();
    let text = |s: &Option<String>| s.as_deref().map(scrub).unwrap_or_default();
    let mut out = String::new();
    let _ = writeln!(out, "arc: {}", scrub(&record.arc));
    let _ = writeln!(out, "run: {}", scrub(&record.run_id));
    let _ = writeln!(
        out,
        "base: {} {}",
        scrub(&record.base_branch),
        scrub(&record.trigger.sha)
    );
    let _ = writeln!(out, "subject: {}", scrub(&record.trigger.subject));
    if let Some(arc) = record.trigger.arc.as_deref() {
        let _ = writeln!(out, "joined: {}", scrub(arc));
    }
    let _ = writeln!(out, "state: {}", record.state);
    if let Some(why) = record.why.as_deref() {
        let _ = writeln!(out, "why: {}", scrub(why));
    }
    let _ = writeln!(out, "started: {}", stamp(record.started));
    if let Some(ended) = record.ended {
        let _ = writeln!(out, "ended: {}", stamp(ended));
    }
    for row in &record.surfaces {
        let _ = writeln!(
            out,
            "surface: {}\t{}\t{}\t{}\t{}\t{}\t{}",
            scrub(&row.name),
            row.status,
            num(row.passed),
            num(row.total),
            num(row.ms),
            text(&row.title),
            text(&row.message),
        );
    }
    out
}

/// One landed surface as its row reads it: a check the horizon stopped (or
/// never let start) is `fail` with the horizon's sentence, ahead of an
/// ordinary red; a red names the first red check's child title or its
/// command, and the child's message or its exit; a surface with no checks is
/// claimed and unchecked; anything else passed. Counts are the children's
/// tests when they recorded, otherwise the checks.
fn landed_row(
    row: &mut SurfaceRow,
    result: &tugarc_core::surfaces::SurfaceResult,
    now: SystemTime,
) {
    let checks = result.commands.len() as u64;
    let checks_passed = result
        .commands
        .iter()
        .filter(|c| c.status == "already-run" || c.exit_code == Some(0))
        .count() as u64;
    let horizon = result
        .commands
        .iter()
        .any(|c| c.status == "timed-out" || c.status == "not-started")
        || (!result.red
            && !result.commands.is_empty()
            && result.commands.iter().all(|c| c.status == "not-reached"));
    let red = result
        .commands
        .iter()
        .find(|c| c.exit_code.is_some_and(|code| code != 0));
    row.ms = row
        .started
        .and_then(|at| now.duration_since(at).ok())
        .map(|d| d.as_millis() as u64);
    row.passed = Some(result.passed.unwrap_or(checks_passed));
    row.total = Some(result.total.unwrap_or(checks));
    (row.status, row.title, row.message) = if horizon {
        ("fail", None, Some(HORIZON_MESSAGE.to_string()))
    } else if let Some(c) = red {
        (
            "fail",
            Some(c.title.clone().unwrap_or_else(|| c.command.clone())),
            Some(
                c.message
                    .clone()
                    .unwrap_or_else(|| format!("exit {}", c.exit_code.unwrap_or(-1))),
            ),
        )
    } else if checks == 0 {
        ("skipped", None, Some("claimed, unchecked".to_string()))
    } else {
        ("pass", None, None)
    };
    if checks == 0 {
        row.passed = None;
        row.total = None;
    }
}

/// What a press on the Re-audit door finds about the quiet job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestampRelease {
    /// No quiet job holds the arc.
    NotRunning,
    /// A quiet job holds it and its horizon has not fallen: the press
    /// refuses, and this is what it says.
    Running {
        since: SystemTime,
        deadline: SystemTime,
    },
    /// The job is writing its answer to the record now: the press refuses
    /// for the moment that takes, rather than racing the write.
    Finishing,
    /// The job ran past its horizon, so the press took the arc back from it.
    Released,
}

impl ConflictBoard {
    fn set(&self, owner_key: &str, paths: Vec<String>) {
        let mut board = self.by_arc.lock();
        if paths.is_empty() {
            board.remove(owner_key);
        } else {
            board.insert(owner_key.to_string(), paths);
        }
    }

    /// Take the arc for a quiet job and publish it as running, answering the
    /// job's generation and its run id — or `None` when a quiet job already
    /// holds the arc. The run starts replaying, under `trigger`.
    fn begin_restamp(
        &self,
        owner_key: &str,
        horizon: Duration,
        trigger: ReauditTrigger,
    ) -> Option<(u64, String)> {
        let mut quiet = self.quiet.lock();
        let fact = quiet.entry(owner_key.to_string()).or_default();
        if fact.running.is_some() {
            return None;
        }
        let generation = self.generation.fetch_add(1, Ordering::Relaxed) + 1;
        let since = SystemTime::now();
        // A run that starts out of a wait is the wait's story going on: it
        // keeps the wait's run id, and its trigger when this wake read none.
        let (run_id, trigger) = match fact.waiting.take() {
            Some(wait) => {
                let trigger = if trigger.sha.is_empty() {
                    wait.trigger
                } else {
                    trigger
                };
                (wait.run_id, trigger)
            }
            None => (mint_run_id(), trigger),
        };
        fact.running = Some(RestampRun {
            since,
            deadline: since + horizon,
            generation,
            committing: false,
            run_id: run_id.clone(),
            phase: ReauditPhase::Replaying,
            trigger,
            surfaces: Vec::new(),
        });
        fact.seated_why = None;
        Some((generation, run_id))
    }

    /// Publish a re-audit as waiting, on `why`, under `trigger`, answering its
    /// run id and whether the published fact changed. A wait already standing
    /// keeps its run id and its start and takes the new sentence and trigger;
    /// otherwise a run id is minted. A running job takes precedence and the
    /// board is left alone.
    fn begin_wait(&self, owner_key: &str, why: String, trigger: ReauditTrigger) -> (String, bool) {
        let mut quiet = self.quiet.lock();
        let fact = quiet.entry(owner_key.to_string()).or_default();
        if let Some(run) = fact.running.as_ref() {
            return (run.run_id.clone(), false);
        }
        match fact.waiting.as_mut() {
            Some(wait) => {
                let changed = wait.why != why || wait.trigger != trigger;
                wait.why = why;
                wait.trigger = trigger;
                (wait.run_id.clone(), changed)
            }
            None => {
                let run_id = mint_run_id();
                fact.waiting = Some(QuietWait {
                    run_id: run_id.clone(),
                    since: SystemTime::now(),
                    why,
                    trigger,
                });
                (run_id, true)
            }
        }
    }

    /// Take down the arc's wait, answering it when one stood.
    fn clear_wait(&self, owner_key: &str) -> Option<QuietWait> {
        let mut quiet = self.quiet.lock();
        let fact = quiet.get_mut(owner_key)?;
        let wait = fact.waiting.take();
        if *fact == QuietFact::default() {
            quiet.remove(owner_key);
        }
        wait
    }

    /// The arc's wait stands.
    fn waiting(&self, owner_key: &str) -> bool {
        self.quiet
            .lock()
            .get(owner_key)
            .is_some_and(|fact| fact.waiting.is_some())
    }

    /// The running job `generation` started, when it still holds the arc.
    fn held_run<'a>(
        quiet: &'a mut HashMap<String, QuietFact>,
        owner_key: &str,
        generation: u64,
    ) -> Option<&'a mut RestampRun> {
        quiet
            .get_mut(owner_key)
            .and_then(|fact| fact.running.as_mut())
            .filter(|run| run.generation == generation)
    }

    /// Move the job `generation` started into `phase`.
    fn set_phase(&self, owner_key: &str, generation: u64, phase: ReauditPhase) {
        let mut quiet = self.quiet.lock();
        if let Some(run) = Self::held_run(&mut quiet, owner_key, generation) {
            run.phase = phase;
        }
    }

    /// Write one verify event onto the rows of the job `generation` started:
    /// the plan lays every surface out pending, a start runs one, a landing
    /// settles it.
    fn verify_event(
        &self,
        owner_key: &str,
        generation: u64,
        event: &tugarc_core::surfaces::VerifyEvent<'_>,
    ) {
        use tugarc_core::surfaces::VerifyEvent;
        let now = SystemTime::now();
        let mut quiet = self.quiet.lock();
        let Some(run) = Self::held_run(&mut quiet, owner_key, generation) else {
            return;
        };
        match event {
            VerifyEvent::Planned(planned) => {
                run.surfaces = planned
                    .iter()
                    .map(|(name, _)| SurfaceRow::pending(name))
                    .collect();
            }
            VerifyEvent::Started(name) => {
                if let Some(row) = run.surfaces.iter_mut().find(|r| r.name == *name) {
                    row.status = "running";
                    row.started = Some(now);
                }
            }
            VerifyEvent::Finished(result) => {
                if let Some(row) = run.surfaces.iter_mut().find(|r| r.name == result.name) {
                    landed_row(row, result, now);
                }
            }
        }
    }

    /// A quiet job holds the arc.
    fn restamping(&self, owner_key: &str) -> bool {
        self.quiet
            .lock()
            .get(owner_key)
            .is_some_and(|fact| fact.running.is_some())
    }

    /// The job `generation` started still holds the arc.
    fn holds(&self, owner_key: &str, generation: u64) -> bool {
        self.quiet
            .lock()
            .get(owner_key)
            .and_then(|fact| fact.running.as_ref())
            .is_some_and(|run| run.generation == generation)
    }

    /// Claim the write for the job `generation` started: answers true, and
    /// from then on [`Self::release_restamp`] answers `Finishing` rather than
    /// releasing, when that job still holds the arc. Answers false when a
    /// press already released it, and the job then writes nothing. The check
    /// and the claim are one critical section, which is what makes "a
    /// released job writes nothing" true by construction rather than by a
    /// check a press can land behind.
    fn claim_write(&self, owner_key: &str, generation: u64) -> bool {
        let mut quiet = self.quiet.lock();
        match quiet
            .get_mut(owner_key)
            .and_then(|fact| fact.running.as_mut())
        {
            Some(run) if run.generation == generation => {
                run.committing = true;
                true
            }
            _ => false,
        }
    }

    /// End the job `generation` started as `ending` says: a verified or
    /// seated run becomes the arc's `last`, and a seated one records why; a
    /// run that goes back to waiting becomes a wait under its own run id and
    /// trigger, in the same lock, so no wake can decide between the two.
    /// Answers false, and changes nothing, when a press already released that
    /// job.
    fn end_restamp(&self, owner_key: &str, generation: u64, ending: RunEnding) -> bool {
        let mut quiet = self.quiet.lock();
        let Some(fact) = quiet.get_mut(owner_key) else {
            return false;
        };
        if fact.running.as_ref().map(|run| run.generation) != Some(generation) {
            return false;
        }
        let Some(run) = fact.running.take() else {
            return false;
        };
        let (state, why) = match ending {
            RunEnding::Verified => ("verified", None),
            RunEnding::Seated(why) => ("seated", Some(why)),
            RunEnding::Wait(why) => {
                fact.seated_why = None;
                fact.waiting = Some(QuietWait {
                    run_id: run.run_id,
                    since: SystemTime::now(),
                    why,
                    trigger: run.trigger,
                });
                return true;
            }
        };
        fact.seated_why = why.clone();
        fact.last = Some(ended_run(run, state, why, SystemTime::now()));
        true
    }

    /// The Re-audit door's read: a job inside its horizon refuses the press,
    /// and one past it is released, so the next wake decides afresh.
    fn release_restamp(&self, owner_key: &str, now: SystemTime) -> RestampRelease {
        let mut quiet = self.quiet.lock();
        let Some(fact) = quiet.get_mut(owner_key) else {
            return RestampRelease::NotRunning;
        };
        match fact.running.as_ref() {
            None => RestampRelease::NotRunning,
            Some(run) if run.committing => RestampRelease::Finishing,
            Some(run) if now < run.deadline => RestampRelease::Running {
                since: run.since,
                deadline: run.deadline,
            },
            Some(_) => {
                let why = "the re-audit ran past its horizon and was released".to_string();
                if let Some(run) = fact.running.take() {
                    fact.last = Some(ended_run(run, "released", Some(why.clone()), now));
                }
                fact.seated_why = Some(why);
                RestampRelease::Released
            }
        }
    }

    /// Drop the seat reason and the ended run of an arc that no longer reads
    /// `audit-stale`, and the whole fact when nothing runs or waits on it.
    fn forget_seated(&self, owner_key: &str) {
        let mut quiet = self.quiet.lock();
        if let Some(fact) = quiet.get_mut(owner_key) {
            fact.seated_why = None;
            fact.last = None;
            if fact.running.is_none() && fact.waiting.is_none() {
                quiet.remove(owner_key);
            }
        }
    }

    /// The row already written for `run_id`, when there is one.
    fn ink_of(&self, owner_key: &str, run_id: &str) -> Option<ReauditInk> {
        self.quiet
            .lock()
            .get(owner_key)
            .and_then(|fact| fact.ink.clone())
            .filter(|ink| ink.run_id == run_id)
    }

    /// Remember the row the arc's story is written to.
    fn set_ink(&self, owner_key: &str, ink: ReauditInk) {
        self.quiet
            .lock()
            .entry(owner_key.to_string())
            .or_default()
            .ink = Some(ink);
    }

    /// Forget `run_id`'s row once its story has closed, and the whole fact
    /// when that leaves it empty.
    fn forget_ink(&self, owner_key: &str, run_id: &str) {
        let mut quiet = self.quiet.lock();
        if let Some(fact) = quiet.get_mut(owner_key) {
            if fact.ink.as_ref().is_some_and(|ink| ink.run_id == run_id) {
                fact.ink = None;
            }
            if *fact == QuietFact::default() {
                quiet.remove(owner_key);
            }
        }
    }

    /// The story going on now, as its row records it: the running job, or
    /// else the wait.
    fn live_record(&self, owner_key: &str, arc: &str, base_branch: &str) -> Option<ReauditRecord> {
        let quiet = self.quiet.lock();
        let fact = quiet.get(owner_key)?;
        let (run_id, trigger, state, why, started) = match (&fact.running, &fact.waiting) {
            (Some(run), _) => (&run.run_id, &run.trigger, "running", None, run.since),
            (None, Some(wait)) => (
                &wait.run_id,
                &wait.trigger,
                "waiting",
                Some(wait.why.clone()),
                wait.since,
            ),
            (None, None) => return None,
        };
        Some(ReauditRecord {
            arc: arc.to_string(),
            run_id: run_id.clone(),
            base_branch: base_branch.to_string(),
            trigger: trigger.clone(),
            state,
            why,
            started,
            ended: None,
            surfaces: Vec::new(),
        })
    }

    /// The job `generation` started as it is about to end, so its row can
    /// close before the board takes the run down.
    fn ending_record(
        &self,
        owner_key: &str,
        generation: u64,
        arc: &str,
        base_branch: &str,
        state: &'static str,
        why: Option<String>,
    ) -> Option<ReauditRecord> {
        let mut quiet = self.quiet.lock();
        let run = Self::held_run(&mut quiet, owner_key, generation)?.clone();
        let ended = ended_run(run, state, why, SystemTime::now());
        Some(ReauditRecord::of_ended(arc, base_branch, &ended))
    }

    /// The run that last ended here, as its row records it.
    fn last_record(&self, owner_key: &str, arc: &str, base_branch: &str) -> Option<ReauditRecord> {
        let quiet = self.quiet.lock();
        let last = quiet.get(owner_key)?.last.as_ref()?;
        Some(ReauditRecord::of_ended(arc, base_branch, last))
    }

    fn quiet_fact(&self, owner_key: &str) -> Option<QuietFact> {
        self.quiet.lock().get(owner_key).cloned()
    }
}

/// A fresh re-audit's identity.
fn mint_run_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// A run as it ended: its rows as they stood, any still pending or running
/// settled as the horizon's, since nothing more will land on them.
fn ended_run(
    run: RestampRun,
    state: &'static str,
    why: Option<String>,
    ended: SystemTime,
) -> EndedRun {
    let surfaces = run
        .surfaces
        .into_iter()
        .map(|mut row| {
            if row.status == "pending" || row.status == "running" {
                row.status = "fail";
                row.message = Some(HORIZON_MESSAGE.to_string());
            }
            row
        })
        .collect();
    EndedRun {
        run_id: run.run_id,
        trigger: run.trigger,
        surfaces,
        since: run.since,
        ended,
        state,
        why,
    }
}

/// Where one arc's re-audit row is written: the supervisor that owns the
/// ledgers and the frame, and the arc the row speaks for.
#[derive(Clone)]
struct InkWriter {
    supervisor: Option<Arc<super::agent_supervisor::AgentSupervisor>>,
    project_dir: PathBuf,
    arc: String,
    base_branch: String,
}

/// One row write as a test reads it: the card, the row, and whether the arc's
/// record already read its audit seated when the row was written.
#[cfg(test)]
#[derive(Debug, Clone)]
pub(crate) struct InkLogged {
    pub session: String,
    pub output: String,
    pub audit_seated: bool,
}

/// What would have been written, for an engine run with no supervisor.
#[cfg(test)]
static INK_LOG: Mutex<Vec<InkLogged>> = Mutex::new(Vec::new());

/// Row writes go one at a time, so a wake and a job that both mean to write
/// a story's first row write one row between them.
static INK_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Write the row `compose` reads off the board, on `session`'s card, or on
/// the card already holding the story's row when `session` is `None` — and
/// with neither, write nothing, since nobody holds the arc to be told. A
/// `fresh_only` write is skipped when the story already has its row. A row
/// already written is rewritten in place on the same card; a different card
/// gets a row of its own. Sameness is the card's, never the segment's: the
/// ink keeps the card id the supervisor resolved, and the supervisor resolves
/// the segment it is handed before it compares, so a card whose session
/// segment moved mid-story still rewrites its one row.
async fn write_ink(
    writer: &InkWriter,
    board: &ConflictBoard,
    owner_key: &str,
    session: Option<&str>,
    fresh_only: bool,
    compose: impl FnOnce(&ConflictBoard, &InkWriter) -> Option<ReauditRecord>,
) {
    let _gate = INK_GATE.lock().await;
    let Some(record) = compose(board, writer) else {
        return;
    };
    let prior = board.ink_of(owner_key, &record.run_id);
    if fresh_only && prior.is_some() {
        return;
    }
    let Some(session) = session
        .map(str::to_string)
        .or_else(|| prior.as_ref().map(|ink| ink.session.clone()))
    else {
        return;
    };
    let output = format_reaudit_row(&record);
    let Some(supervisor) = writer.supervisor.as_ref() else {
        #[cfg(test)]
        {
            let audit_seated =
                tugarc_core::read_arc(&Paths::from_env(), &writer.project_dir, &writer.arc)
                    .is_some_and(|run| run.resume == Some(tugarc_core::ArcStage::Audit));
            INK_LOG.lock().push(InkLogged {
                session: session.clone(),
                output,
                audit_seated,
            });
            // No supervisor resolves a card here, so the session is the card.
            let (receipt_id, started_at_ms) = prior
                .filter(|ink| ink.session == session)
                .map(|ink| (ink.receipt_id, ink.started_at_ms))
                .unwrap_or((0, 0));
            board.set_ink(
                owner_key,
                ReauditInk {
                    run_id: record.run_id,
                    session,
                    receipt_id,
                    started_at_ms,
                },
            );
        }
        return;
    };
    let written = supervisor
        .record_reaudit_ink(
            &session,
            &writer.arc,
            &writer.project_dir.to_string_lossy(),
            &output,
            prior.map(|ink| (ink.receipt_id, ink.started_at_ms, ink.session)),
        )
        .await;
    if let Some((receipt_id, started_at_ms, card)) = written {
        board.set_ink(
            owner_key,
            ReauditInk {
                run_id: record.run_id,
                session: card,
                receipt_id,
                started_at_ms,
            },
        );
    }
}

static BOARD: OnceLock<Arc<ConflictBoard>> = OnceLock::new();

/// The conflicting paths of the last replay attempt on this arc, empty when
/// the last attempt was clean or no engine is running.
pub fn conflict_paths_for(owner_key: &str) -> Vec<String> {
    BOARD
        .get()
        .and_then(|board| board.by_arc.lock().get(owner_key).cloned())
        .unwrap_or_default()
}

/// The quiet re-stamp's published fact for this arc: whether a job is
/// running and since when, and why the last one seated the audit. `None`
/// when there is nothing to say or no engine is running.
pub fn quiet_fact_for(owner_key: &str) -> Option<QuietFact> {
    BOARD.get().and_then(|board| board.quiet_fact(owner_key))
}

/// The Re-audit door's call on the engine. A quiet job inside its horizon
/// refuses the press; one past it is released and the engine woken, so the
/// arc is decided afresh instead of waiting behind a job that will not end.
pub fn release_restamp(owner_key: &str) -> RestampRelease {
    let Some(board) = BOARD.get() else {
        return RestampRelease::NotRunning;
    };
    let answer = board.release_restamp(owner_key, SystemTime::now());
    if answer == RestampRelease::Released {
        crossing_notices().wake.notify_one();
    }
    answer
}

/// Publish a quiet job on `owner_key` as running, for a test of a press that
/// must meet one; answers the generation [`end_restamp_for_test`] ends.
#[cfg(test)]
pub(crate) fn hold_restamp_for_test(owner_key: &str, horizon: Duration) -> u64 {
    BOARD
        .get_or_init(|| Arc::new(ConflictBoard::default()))
        .begin_restamp(owner_key, horizon, ReauditTrigger::default())
        .expect("no quiet job already holds the arc")
        .0
}

/// Publish a conflicted replay's paths on `owner_key` (empty clears them), for
/// a test of a reader that must meet one.
#[cfg(test)]
pub(crate) fn publish_conflicts_for_test(owner_key: &str, paths: Vec<String>) {
    BOARD
        .get_or_init(|| Arc::new(ConflictBoard::default()))
        .set(owner_key, paths);
}

/// End the job [`hold_restamp_for_test`] published.
#[cfg(test)]
pub(crate) fn end_restamp_for_test(owner_key: &str, generation: u64) {
    if let Some(board) = BOARD.get() {
        board.end_restamp(owner_key, generation, RunEnding::Verified);
        board.forget_seated(owner_key);
    }
}

// MARK: - Crossing notices

/// The origin a crossing notice is attributed to in the transcript.
const CROSSING_ORIGIN: &str = "crossing";

/// One notice waiting for its arc's session to be quiet enough to hear it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingNotice {
    repo: PathBuf,
    arc: String,
    text: String,
}

/// The crossing notices not yet spoken, and the wake that asks the engine to
/// speak them.
///
/// A crossing is found by the round probe, but its notice goes out through
/// this engine's injection, under the same gate a replay notice meets: a
/// session mid-turn is never interrupted, and is told when its turn ends —
/// the turn-end wake already brings the engine back to every open project.
#[derive(Default)]
struct CrossingNotices {
    pending: Mutex<Vec<PendingNotice>>,
    wake: Notify,
}

impl CrossingNotices {
    fn queue(&self, repo: &Path, arc: &str, text: &str) {
        self.pending.lock().push(PendingNotice {
            repo: repo.to_path_buf(),
            arc: arc.to_string(),
            text: text.to_string(),
        });
        self.wake.notify_one();
    }

    /// What to tell `arc`'s session now. A quiet session takes every notice
    /// waiting for it; a busy one leaves them waiting; an arc with no session
    /// bound has nobody to tell, and its notices are dropped rather than
    /// saved for a session that may never come.
    fn take_for(&self, repo: &Path, arc: &str, session: Option<&BoundSession>) -> Vec<String> {
        if session.is_some_and(|s| s.busy) {
            return Vec::new();
        }
        let mut pending = self.pending.lock();
        let (mine, rest): (Vec<_>, Vec<_>) = pending
            .drain(..)
            .partition(|notice| notice.repo == repo && notice.arc == arc);
        *pending = rest;
        match session {
            Some(_) => mine.into_iter().map(|notice| notice.text).collect(),
            None => Vec::new(),
        }
    }
}

/// Speak whatever crossing notices `arc`'s session can hear now, as one
/// turn however many are waiting: a second turn queued behind the first is
/// one more the agent never asked for.
async fn speak_crossings(
    notices: &CrossingNotices,
    inject: &InjectHandles,
    repo: &Path,
    arc: &str,
    session: Option<&BoundSession>,
) {
    let waiting = notices.take_for(repo, arc, session);
    let Some(target) = session.filter(|_| !waiting.is_empty()) else {
        return;
    };
    let text = waiting.join("\n");
    let submission = format!("[crossing] {text}");
    inject
        .send_as(&target.id, CROSSING_ORIGIN, &text, &submission, None)
        .await;
}

fn crossing_notices() -> &'static CrossingNotices {
    static NOTICES: OnceLock<CrossingNotices> = OnceLock::new();
    NOTICES.get_or_init(CrossingNotices::default)
}

/// The wake a bind sends. A `Notify` keeps one permit when the engine is busy,
/// so a bind landing mid-evaluation is answered by the next pass, not lost.
fn bind_wake() -> &'static Notify {
    static WAKE: OnceLock<Notify> = OnceLock::new();
    WAKE.get_or_init(Notify::new)
}

/// Tell the engine a session just bound to an arc.
pub fn wake_on_bind() {
    bind_wake().notify_one();
}

/// Tell the engine a crossing settle finished. What it taught the cache may
/// be exactly the hunk a replay already stopped on, and the conflict record
/// says so by its cache count; a wake is what gets that replay retried now
/// rather than on the next unrelated commit.
pub fn wake_on_settle() {
    crossing_notices().wake.notify_one();
}

/// Tell the engine a round landed on an arc. The head moved, so a finished
/// arc whose audit no longer describes it is owed a re-audit now.
pub fn wake_on_round() {
    crossing_notices().wake.notify_one();
}

/// Tell `arc`'s session about a crossing, as soon as it is quiet.
pub fn queue_crossing_notice(repo: &Path, arc: &str, text: &str) {
    crossing_notices().queue(repo, arc, text);
}

// MARK: - The engine

/// Why the engine woke. Both arms run the same evaluation; the difference is
/// only which workspaces it looks at.
enum Wake {
    /// A workspace's HEAD moved, or the registry just opened it.
    Workspace(String),
    /// A session's turn ended, so an arc parked behind it may now be actionable.
    /// Which arc that is depends on bindings that may have changed, so this
    /// re-evaluates every open workspace rather than guessing.
    TurnComplete,
    /// A session bound to an arc, so a stale audit that was waiting for a
    /// card may now have one. Every open workspace, as for a turn ending.
    Bind,
    /// Startup, a lagged event stream, a settled crossing, a round landing,
    /// or a released quiet re-stamp: every open workspace, because nothing
    /// says which arc moved.
    All,
}

/// Handles the engine needs from the rest of the process.
pub struct BaseMotionContext {
    pub registry: Arc<WorkspaceRegistry>,
    /// The supervisor's in-memory ledger — the only place session busyness lives.
    pub supervisor_ledger: Ledger,
    /// The persisted ledger, for the arc→sessions binding query.
    pub session_ledger: Option<Arc<SessionLedger>>,
    /// The aggregate recompute signal, fired after any completed motion so the
    /// marks refresh without waiting for a file event.
    pub bump: Arc<Notify>,
    /// The CODE_INPUT queue the router feeds. An injected turn goes down this
    /// same queue rather than calling the dispatcher directly, so injected and
    /// client submissions stay in one order and there is no second path into a
    /// session to keep in step.
    pub code_input_tx: Option<mpsc::Sender<Frame>>,
    /// The supervisor's CODE_OUTPUT feed, for the opener that makes an injected
    /// turn visible.
    pub code_output: Option<SessionScopedFeed>,
    /// The supervisor a re-audit's transcript row is written through; `None`
    /// in tests, which read what would have been written instead.
    pub supervisor: Option<Arc<super::agent_supervisor::AgentSupervisor>>,
    pub cancel: CancellationToken,
}

/// Run the engine until `cancel` fires.
///
/// `gh_rx` is a subscription to the registry's shared GIT_HEAD broadcast;
/// `workspace_open_rx` carries the key of each workspace the registry newly
/// opened; `turn_complete_rx` carries a session id each time a turn closes.
pub async fn run_base_motion_engine(
    ctx: BaseMotionContext,
    mut gh_rx: broadcast::Receiver<Frame>,
    mut workspace_open_rx: mpsc::Receiver<String>,
    mut turn_complete_rx: mpsc::Receiver<String>,
) {
    let board = Arc::clone(BOARD.get_or_init(|| Arc::new(ConflictBoard::default())));
    let state: Arc<Mutex<HashMap<String, ArcState>>> = Arc::new(Mutex::new(HashMap::new()));

    // The level read the edge cannot give us ([P01]): everything already open is
    // evaluated before the first signal can arrive.
    evaluate(&ctx, &board, &state, Wake::All).await;

    loop {
        let wake = tokio::select! {
            _ = ctx.cancel.cancelled() => {
                debug!("base-motion engine shutting down");
                return;
            }
            recv = gh_rx.recv() => match recv {
                Ok(frame) => match serde_json::from_slice::<GitHeadSignal>(&frame.payload) {
                    Ok(signal) => Wake::Workspace(signal.workspace_key),
                    Err(e) => {
                        warn!(error = %e, "base-motion: unreadable GIT_HEAD signal");
                        continue;
                    }
                },
                // A dropped signal means a HEAD move we did not see, so re-read
                // the level rather than wait for the next one.
                Err(broadcast::error::RecvError::Lagged(_)) => Wake::All,
                Err(broadcast::error::RecvError::Closed) => return,
            },
            opened = workspace_open_rx.recv() => match opened {
                Some(key) => Wake::Workspace(key),
                None => continue,
            },
            done = turn_complete_rx.recv() => match done {
                Some(_) => Wake::TurnComplete,
                None => continue,
            },
            _ = crossing_notices().wake.notified() => Wake::All,
            _ = bind_wake().notified() => Wake::Bind,
        };
        evaluate(&ctx, &board, &state, wake).await;
    }
}

/// The repo directories this wake covers.
fn wake_targets(registry: &WorkspaceRegistry, wake: &Wake) -> Vec<PathBuf> {
    let open = registry.project_dirs();
    match wake {
        Wake::Workspace(key) => open
            .into_iter()
            .filter(|(_, k)| k == key)
            .map(|(dir, _)| dir)
            .collect(),
        Wake::TurnComplete | Wake::Bind | Wake::All => {
            open.into_iter().map(|(dir, _)| dir).collect()
        }
    }
}

async fn evaluate(
    ctx: &BaseMotionContext,
    board: &Arc<ConflictBoard>,
    state: &Arc<Mutex<HashMap<String, ArcState>>>,
    wake: Wake,
) {
    for repo_dir in wake_targets(&ctx.registry, &wake) {
        evaluate_workspace(ctx, board, state, repo_dir).await;
    }
}

async fn evaluate_workspace(
    ctx: &BaseMotionContext,
    board: &Arc<ConflictBoard>,
    state: &Arc<Mutex<HashMap<String, ArcState>>>,
    repo_dir: PathBuf,
) {
    let bound_by_arc = ctx
        .session_ledger
        .as_ref()
        .and_then(|l| l.bound_session_by_arc().ok())
        .unwrap_or_default();

    // The whole enumeration is synchronous git, so it goes to the blocking pool
    // in one hop — the same discipline `arc_entries` uses.
    let dir = repo_dir.clone();
    let Ok((autoreplay, cache_learned, arcs)) = tokio::task::spawn_blocking(move || {
        let autoreplay = read_autoreplay(&dir);
        let cache_learned = tugarc_core::resolve::rr_cache_learned(&dir);
        let arcs: Vec<ArcReading> = tugarc_core::arc_detail_entries_in(&Paths::from_env(), &dir)
            .into_iter()
            .map(|detail| ArcReading {
                base_tip: rev_parse(&dir, &detail.base),
                join_journal: tugarc_core::join_in_flight(&Paths::from_env(), &dir, &detail.name),
                arc_autoreplay: read_arc_autoreplay(&dir, &detail.name),
                audit_base_only: tugarc_core::log::audit_stale_on_base_only(
                    &tugarc_core::read_declarations(&Paths::from_env(), &dir, &detail.name),
                    &tugarc_core::ops::live_tips(&dir, &detail.name),
                ),
                detail,
            })
            .collect();
        (autoreplay, cache_learned, arcs)
    })
    .await
    else {
        return;
    };

    for reading in arcs {
        let detail = &reading.detail;
        let owner_key = detail.owner_key.clone();
        let session = bound_session(&ctx.supervisor_ledger, &bound_by_arc, &owner_key).await;

        let inject = InjectHandles {
            code_input_tx: ctx.code_input_tx.clone(),
            code_output: ctx.code_output.clone(),
        };
        speak_crossings(
            crossing_notices(),
            &inject,
            &repo_dir,
            &detail.name,
            session.as_ref(),
        )
        .await;

        let (in_flight, conflicted, quiet_failed) = {
            let map = state.lock();
            match map.get(&owner_key) {
                Some(st) => (
                    st.in_flight || board.restamping(&owner_key),
                    // A conflict stands only while the cache knows what it
                    // knew when the replay stopped; anything it has learned
                    // since is a reason to try again.
                    st.conflict
                        .as_ref()
                        .is_some_and(|c| c.cache_learned == cache_learned),
                    // The latch is keyed on the tip, not on a bare flag: a base
                    // that moves again is a new chance for the quiet path.
                    st.quiet_failed_tip.as_deref() == Some(reading.base_tip.as_str()),
                ),
                None => (board.restamping(&owner_key), false, false),
            }
        };
        // A seat reason speaks for a stale audit; once a mark answers it, it
        // says nothing true.
        if detail.stage_word != tugarc_core::ops::ArcStageWord::AuditStale {
            board.forget_seated(&owner_key);
        }

        let inputs = ArcInputs {
            autoreplay,
            arc_autoreplay: reading.arc_autoreplay,
            base_ahead: detail.base_ahead,
            worktree_dirty: detail.worktree_dirty,
            join_journal: reading.join_journal,
            mid_plan: detail.stage_word == tugarc_core::ops::ArcStageWord::Implementing,
            session,
            in_flight,
            conflicted,
            audit_stale_done: detail.stage_word == tugarc_core::ops::ArcStageWord::AuditStale
                && detail.arc.as_ref().is_some_and(|run| {
                    tugarc_core::arc::reaudit_admits(
                        run.done,
                        run.stopped_stage
                            .as_deref()
                            .and_then(tugarc_core::arc::ArcStage::parse)
                            .zip(run.stopped.as_deref()),
                    )
                }),
            // A stopped record has only the one door back: its audit seated
            // again. A re-stamp would write a current mark over a stop, and
            // the arc would read audited while nothing ran it.
            audit_base_only: reading.audit_base_only
                && detail.arc.as_ref().is_some_and(|run| run.done),
            quiet_failed,
        };

        let decision = decide_for_arc(&inputs);
        let ink = InkWriter {
            supervisor: ctx.supervisor.clone(),
            project_dir: repo_dir.clone(),
            arc: detail.name.clone(),
            base_branch: detail.base.clone(),
        };
        let mut wait_changed = false;
        // A stale audit's re-audit is never silent: one the quiet path would
        // run and cannot yet is published as a wait, from the wake that finds
        // it, and the run that ends the wait takes its run id.
        match quiet_wait(&inputs, &decision) {
            Some(reason) => {
                let callsign = inputs.session.as_ref().and_then(|session| {
                    ctx.session_ledger
                        .as_ref()?
                        .get(&session.id)
                        .ok()
                        .flatten()?
                        .tag
                });
                let why = wait_sentence(&reason, callsign.as_deref());
                let (dir, tip) = (repo_dir.clone(), reading.base_tip.clone());
                let trigger = tokio::task::spawn_blocking(move || read_trigger(&dir, &tip))
                    .await
                    .unwrap_or_default();
                if board.begin_wait(&owner_key, why, trigger).1 {
                    wait_changed = true;
                    ctx.bump.notify_one();
                }
            }
            // Not on the wake that ends the wait — a `Restamp` whose job has
            // not adopted it yet — and not while a job holds the arc: either
            // way the wait is about to become the run.
            None if !matches!(decision, Decision::Restamp(_) | Decision::Skip("in-flight"))
                && board.waiting(&owner_key) =>
            {
                // A wait that ends with no run taking it closes its row.
                if let Some(wait) = board.clear_wait(&owner_key) {
                    let ended = SystemTime::now();
                    write_ink(&ink, board, &owner_key, None, false, |_, w| {
                        Some(ReauditRecord::answered(
                            &w.arc,
                            &w.base_branch,
                            &wait,
                            ended,
                        ))
                    })
                    .await;
                    board.forget_ink(&owner_key, &wait.run_id);
                }
                ctx.bump.notify_one();
            }
            None => {}
        }
        // The card holding the arc carries the story from the moment it holds
        // it: a wait's first row, a wait whose sentence or trigger moved, and
        // a card that bound while a run or a wait was already under way.
        if (board.restamping(&owner_key) || board.waiting(&owner_key))
            && (wait_changed || inputs.session.is_some())
        {
            write_ink(
                &ink,
                board,
                &owner_key,
                inputs.session.as_ref().map(|s| s.id.as_str()),
                !wait_changed,
                |b, w| b.live_record(&owner_key, &w.arc, &w.base_branch),
            )
            .await;
        }
        match &decision {
            Decision::SeatAudit(session) => {
                // A card that bound after a red fit no card held is told it,
                // before the audit stage it is handed to opens.
                if inputs.quiet_failed {
                    write_ink(&ink, board, &owner_key, Some(session), true, |b, w| {
                        b.last_record(&owner_key, &w.arc, &w.base_branch)
                            .filter(|record| record.state == "seated")
                    })
                    .await;
                }
                let (dir, name) = (repo_dir.clone(), detail.name.clone());
                let reopened = tokio::task::spawn_blocking(move || {
                    tugarc_core::ops::reopen_stale_audit(&Paths::from_env(), &dir, &name)
                })
                .await;
                match reopened {
                    Ok(Ok(true)) => {
                        info!(
                            arc = %detail.name,
                            session = %session,
                            "base-motion: audit stale, re-audit seated",
                        );
                        ctx.bump.notify_one();
                    }
                    // Another wake got there first: the arc is no longer done.
                    Ok(Ok(false)) => {}
                    Ok(Err(e)) => {
                        warn!(arc = %detail.name, error = %e, "base-motion: re-audit refused")
                    }
                    Err(e) => {
                        warn!(arc = %detail.name, error = %e, "base-motion: re-audit task failed")
                    }
                }
            }
            Decision::Skip(reason) => {
                // An arc that has caught up owes nobody a conflict mark.
                if inputs.base_ahead == 0 {
                    clear_arc(board, state, &owner_key);
                }
                debug!(arc = %detail.name, reason, "base-motion: no action");
            }
            Decision::MarkOnly => {
                // Nobody to tell, so the log is the only surface this has.
                let conflict = {
                    let map = state.lock();
                    map.get(&owner_key)
                        .and_then(|st| st.conflict.as_ref().map(describe_conflict))
                };
                debug!(
                    arc = %detail.name,
                    conflict = conflict.unwrap_or_default(),
                    "base-motion: conflicted, marked only",
                );
            }
            Decision::Replay | Decision::ReplayThenNotify(_) | Decision::Restamp(_) => {
                let trigger = match &decision {
                    Decision::Restamp(_) => {
                        let (dir, tip) = (repo_dir.clone(), reading.base_tip.clone());
                        tokio::task::spawn_blocking(move || read_trigger(&dir, &tip))
                            .await
                            .unwrap_or_default()
                    }
                    _ => ReauditTrigger::default(),
                };
                let (notify, quiet) = match &decision {
                    Decision::ReplayThenNotify(id) => (Some(id.clone()), None),
                    Decision::Restamp(seat) => (
                        None,
                        Some(QuietJob {
                            seat: seat.clone(),
                            base_tip: reading.base_tip.clone(),
                            trigger,
                            horizon: tugtool_core::config::Config::load_from_project(&repo_dir)
                                .map(|config| config.tugtool.arc.restamp_horizon())
                                .unwrap_or(QUIET_HORIZON),
                        }),
                    ),
                    _ => (None, None),
                };
                spawn_replay(
                    ctx,
                    board,
                    state,
                    ReplayJob {
                        repo_dir: repo_dir.clone(),
                        name: detail.name.clone(),
                        owner_key,
                        base_branch: detail.base.clone(),
                        notify,
                        quiet,
                    },
                );
            }
        }
    }
}

/// One arc as a wake reads it: the shared composition, plus the facts the
/// decision needs that it does not carry.
struct ArcReading {
    detail: tugarc_core::ArcDetail,
    base_tip: String,
    join_journal: bool,
    arc_autoreplay: bool,
    /// The audit went stale on the base alone (`audit_stale_on_base_only`).
    audit_base_only: bool,
}

/// Everything one replay needs, gathered on the async side so the spawned work
/// borrows nothing.
struct ReplayJob {
    repo_dir: PathBuf,
    name: String,
    owner_key: String,
    base_branch: String,
    /// The session a *clean* replay is told about ([P11]), when the arc is
    /// mid-plan and holds one.
    notify: Option<String>,
    /// Set when this replay is a stale audit's quiet path: verify and
    /// re-stamp after a clean replay, seat the audit after anything else.
    quiet: Option<QuietJob>,
}

/// The quiet path's half of a replay job.
struct QuietJob {
    /// The idle bound session the audit is seated on when the quiet path
    /// cannot re-stamp. With none, the arc waits for a card.
    seat: Option<String>,
    /// The base tip the wake read, which a failure is latched against.
    base_tip: String,
    /// What moved the base to that tip.
    trigger: ReauditTrigger,
    /// How long the job may run before its verify is killed and a Re-audit
    /// press may take the arc back from it.
    horizon: Duration,
}

/// How long a quiet re-stamp may run when the project declares nothing
/// readable — `restamp_horizon_secs` under `[tugtool.arc]` is the setting.
const QUIET_HORIZON: Duration =
    Duration::from_secs(tugtool_core::config::RESTAMP_HORIZON_SECS_DEFAULT);

/// Take the arc's lock and run one replay on the blocking pool.
///
/// The lock is per arc and is taken *before* the spawn, so a second signal
/// arriving while a replay runs finds it held and decides `Skip`. An
/// ordinary replay's lock is `in_flight`; a quiet-path job's is the board's
/// published `restamping` fact, held through its verify and its mark,
/// because until the mark lands the arc still reads stale and a second wake
/// would start the same work again. The quiet job's verify runs to its
/// horizon and no further.
fn spawn_replay(
    ctx: &BaseMotionContext,
    board: &Arc<ConflictBoard>,
    state: &Arc<Mutex<HashMap<String, ArcState>>>,
    job: ReplayJob,
) {
    {
        let mut map = state.lock();
        let entry = map.entry(job.owner_key.clone()).or_default();
        if entry.in_flight || board.restamping(&job.owner_key) {
            return;
        }
    }
    let quiet_run = match job.quiet.as_ref() {
        Some(quiet) => {
            match board.begin_restamp(&job.owner_key, quiet.horizon, quiet.trigger.clone()) {
                Some((generation, run_id)) => {
                    Some((generation, run_id, Instant::now() + quiet.horizon))
                }
                None => return,
            }
        }
        None => {
            state
                .lock()
                .entry(job.owner_key.clone())
                .or_default()
                .in_flight = true;
            None
        }
    };
    // The running fact is on the wire from the moment it is true.
    if quiet_run.is_some() {
        ctx.bump.notify_one();
    }

    let board = Arc::clone(board);
    let state = Arc::clone(state);
    let bump = Arc::clone(&ctx.bump);
    let ink = InkWriter {
        supervisor: ctx.supervisor.clone(),
        project_dir: job.repo_dir.clone(),
        arc: job.name.clone(),
        base_branch: job.base_branch.clone(),
    };
    let inject = InjectHandles {
        code_input_tx: ctx.code_input_tx.clone(),
        code_output: ctx.code_output.clone(),
    };

    tokio::spawn(async move {
        let arc = job.name.clone();
        // The card the run is seated on is told it has started — the same
        // row a wait it grew out of was already written to.
        if let (Some(seat), Some(_)) = (
            job.quiet.as_ref().and_then(|quiet| quiet.seat.as_deref()),
            quiet_run.as_ref(),
        ) {
            write_ink(&ink, &board, &job.owner_key, Some(seat), false, |b, w| {
                b.live_record(&job.owner_key, &w.arc, &w.base_branch)
            })
            .await;
        }
        let outcome = {
            let repo = job.repo_dir.clone();
            let name = job.name.clone();
            tokio::task::spawn_blocking(move || {
                // Read before the replay, so a settle that teaches the cache
                // while it runs leaves a count the next wake sees as moved.
                let learned = tugarc_core::resolve::rr_cache_learned(&repo);
                (
                    learned,
                    tugarc_core::replay_onto(&Paths::from_env(), &repo, &name),
                )
            })
            .await
        };
        let (cache_learned, outcome) = match outcome {
            Ok((learned, result)) => (learned, Ok(result)),
            Err(e) => (0, Err(e)),
        };

        // What to say, decided under the lock; saying it happens after, because
        // the channel send is async and the state mutex is not.
        let mut notice: Option<Notice> = None;
        // A deferral's detail, which a quiet job's wait sentence carries.
        let mut deferred: Option<String> = None;
        let (mut refresh, replay, stop_why) = {
            let mut map = state.lock();
            let entry = map.entry(job.owner_key.clone()).or_default();
            if job.quiet.is_none() {
                entry.in_flight = false;
            }

            match outcome {
                Ok(Ok(tugarc_core::ReplayOutcome::Replayed {
                    base_head, mapping, ..
                })) => {
                    info!(arc = %arc, base = %short(&base_head), "base-motion: replayed");
                    entry.conflict = None;
                    board.set(&job.owner_key, Vec::new());
                    if job.notify.is_some() {
                        notice = Some(Notice {
                            base_head,
                            rounds: mapping.len(),
                            // The oldest round, as it stood before the move. Its
                            // merge-base with the base branch is the base tip
                            // the arc used to sit on, which is what makes the
                            // delta below exactly what the base brought in.
                            oldest_round_before: mapping.first().map(|(old, _)| old.clone()),
                        });
                    }
                    (true, QuietReplay::Clean, None)
                }
                Ok(Ok(tugarc_core::ReplayOutcome::Recorded { .. })) => {
                    entry.conflict = None;
                    board.set(&job.owner_key, Vec::new());
                    (true, QuietReplay::Clean, None)
                }
                Ok(Ok(tugarc_core::ReplayOutcome::Conflicted {
                    base_head,
                    round,
                    round_subject,
                    paths,
                })) => {
                    info!(
                        arc = %arc,
                        round = %short(&round),
                        paths = paths.len(),
                        "base-motion: replay conflicts",
                    );
                    board.set(&job.owner_key, paths.clone());
                    let why = format!(
                        "the replay onto {} conflicts on {}",
                        short(&base_head),
                        paths.join(", ")
                    );
                    entry.conflict = Some(ConflictRecord {
                        base_head,
                        round,
                        round_subject,
                        paths,
                        cache_learned,
                    });
                    (true, QuietReplay::Stopped, Some(why))
                }
                Ok(Ok(tugarc_core::ReplayOutcome::Current)) => {
                    entry.conflict = None;
                    board.set(&job.owner_key, Vec::new());
                    (false, QuietReplay::Clean, None)
                }
                Ok(Ok(tugarc_core::ReplayOutcome::Deferred { reason, detail })) => {
                    debug!(arc = %arc, reason = %reason, detail = %detail, "base-motion: deferred");
                    deferred = Some(detail);
                    (false, QuietReplay::Deferred, None)
                }
                Ok(Err(err)) => {
                    warn!(arc = %arc, error = %err, "base-motion: replay failed");
                    (false, QuietReplay::Failed, None)
                }
                Err(err) => {
                    warn!(arc = %arc, error = %err, "base-motion: replay task died");
                    (false, QuietReplay::Failed, None)
                }
            }
        };

        if let (Some(notice), Some(session)) = (notice, job.notify.as_deref()) {
            let (text, facts) = compose_notice(&job, &notice);
            inject.send(session, &text, Some(&facts)).await;
        }

        if let (Some(quiet), Some((generation, run_id, deadline))) = (job.quiet.as_ref(), quiet_run)
        {
            let held = QuietHold {
                board: Arc::clone(&board),
                bump: Arc::clone(&bump),
                generation,
                run_id: run_id.clone(),
                deadline,
                ink: ink.clone(),
            };
            let (_, end, seated_why) = finish_quiet(&job, quiet, replay, stop_why, &held).await;
            let ending = match end {
                QuietEnd::Restamp => RunEnding::Verified,
                QuietEnd::Seat => RunEnding::Seated(seated_why.unwrap_or_default()),
                // A later wake tries again, so the run waits under its own
                // run id. A job a press released also comes back as `Leave`,
                // and `end_restamp` answers false for it below.
                QuietEnd::Leave => RunEnding::Wait(wait_sentence(
                    &match deferred.take() {
                        Some(detail) => QuietWaitReason::Deferred(detail),
                        None => QuietWaitReason::ReplayFailed,
                    },
                    None,
                )),
            };
            // A job a press released ends nothing: the arc is no longer its.
            let gone_back = matches!(ending, RunEnding::Wait(_));
            if board.end_restamp(&job.owner_key, generation, ending) {
                {
                    let mut map = state.lock();
                    let entry = map.entry(job.owner_key.clone()).or_default();
                    entry.quiet_failed_tip =
                        (end == QuietEnd::Seat).then(|| quiet.base_tip.clone());
                }
                // A run that goes back to waiting says so on the same row.
                if gone_back {
                    write_ink(&ink, &board, &job.owner_key, None, false, |b, w| {
                        b.live_record(&job.owner_key, &w.arc, &w.base_branch)
                    })
                    .await;
                }
            } else {
                // A press took the arc back: the row closes on the release.
                write_ink(&ink, &board, &job.owner_key, None, false, |b, w| {
                    b.last_record(&job.owner_key, &w.arc, &w.base_branch)
                        .filter(|record| record.run_id == run_id && record.state == "released")
                })
                .await;
            }
            // The running fact came down, so the wire moved whether or not
            // the record did.
            refresh = true;
        }

        if refresh {
            bump.notify_one();
        }
    });
}

/// The rest of a stale audit's quiet path, after its replay: verify a clean
/// one and re-stamp a green fit, or seat the audit. Returns whether the arc's
/// record moved, how the path ended, and — for a `Seat` — why, in a sentence
/// the wire carries. A `Seat` is latched by the caller against the base tip,
/// so a later wake (the bind that brings a card, most often) seats the audit
/// rather than replaying and verifying again.
///
/// The verify runs to the job's deadline and no further, and nothing is
/// written by a job a press released while it ran.
async fn finish_quiet(
    job: &ReplayJob,
    quiet: &QuietJob,
    replay: QuietReplay,
    stop_why: Option<String>,
    held: &QuietHold,
) -> (bool, QuietEnd, Option<String>) {
    let (repo, name) = (job.repo_dir.clone(), job.name.clone());
    let deadline = held.deadline;
    let (verdict, verify_why) = match replay {
        QuietReplay::Clean => {
            held.phase(&job.owner_key, ReauditPhase::Verifying);
            let (repo, name) = (repo.clone(), name.clone());
            let worktree = tugarc_core::ops::worktree_path(&repo, &name);
            let call_id = format!("reaudit_{}", held.run_id);
            let (board, bump, owner, generation) = (
                Arc::clone(&held.board),
                Arc::clone(&held.bump),
                job.owner_key.clone(),
                held.generation,
            );
            let report = tokio::task::spawn_blocking(move || {
                let wrap = engine_wrapper(&worktree, &call_id);
                let mut verdicts = tugtool_core::test_ledger::call_verdicts(Some(call_id));
                tugarc_core::surfaces::verify_by(
                    &Paths::from_env(),
                    &repo,
                    &name,
                    deadline,
                    tugarc_core::surfaces::VerifyHooks {
                        wrap: &wrap,
                        verdict: &mut |command| {
                            verdicts(command).map(|v| tugarc_core::surfaces::ChildVerdict {
                                passed: v.passed,
                                total: v.total,
                                title: v.title,
                                message: v.message,
                            })
                        },
                        watch: &mut |event| {
                            board.verify_event(&owner, generation, &event);
                            bump.notify_one();
                        },
                    },
                )
            })
            .await;
            match report {
                Ok(Ok(report)) => {
                    let why = report
                        .receipt
                        .strip_prefix("TUG-VERIFY-RECEIPT: ")
                        .unwrap_or(&report.receipt)
                        .to_string();
                    (
                        Some(report.verdict),
                        format!("the fit did not verify: {why}"),
                    )
                }
                Ok(Err(e)) => {
                    warn!(arc = %job.name, error = %e, "base-motion: verify refused");
                    (None, format!("the fit's verify could not run: {e}"))
                }
                Err(e) => {
                    warn!(arc = %job.name, error = %e, "base-motion: verify task died");
                    (None, format!("the fit's verify died: {e}"))
                }
            }
        }
        _ => (None, String::new()),
    };
    let end = quiet_end(replay, verdict.as_deref());
    let seated_why = (end == QuietEnd::Seat).then(|| stop_why.unwrap_or(verify_why));
    // Only an end that writes claims the write; `Leave`, and a seat with no
    // card to seat on, write nothing and need no claim.
    let writes = match end {
        QuietEnd::Leave => false,
        QuietEnd::Restamp => true,
        QuietEnd::Seat => quiet.seat.is_some(),
    };
    let still_held = if writes {
        held.board.claim_write(&job.owner_key, held.generation)
    } else {
        held.board.holds(&job.owner_key, held.generation)
    };
    if !still_held {
        info!(arc = %job.name, "base-motion: quiet job released mid-run, writing nothing");
        return (false, QuietEnd::Leave, None);
    }
    let wrote = match end {
        QuietEnd::Leave => return (false, end, None),
        QuietEnd::Restamp => {
            held.phase(&job.owner_key, ReauditPhase::Marking);
            let marked = tokio::task::spawn_blocking(move || {
                tugarc_core::ops::restamp_audit(&Paths::from_env(), &repo, &name)
            })
            .await;
            // The row closes before the board takes the run down, so a deck
            // that reads the wire first already finds the run ended.
            held.close_row(&job.owner_key, "verified", None).await;
            marked
        }
        QuietEnd::Seat => {
            // The card holding the story is told the run went back to its
            // audit stage before that stage opens; with no card, the bind
            // that brings one tells it.
            held.close_row(&job.owner_key, "seated", seated_why.clone())
                .await;
            if quiet.seat.is_none() {
                debug!(arc = %job.name, "base-motion: audit stale, waiting for a card");
                return (false, end, seated_why);
            }
            held.phase(&job.owner_key, ReauditPhase::Seating);
            tokio::task::spawn_blocking(move || {
                tugarc_core::ops::reopen_stale_audit(&Paths::from_env(), &repo, &name)
            })
            .await
        }
    };
    let moved = match wrote {
        Ok(Ok(wrote)) => {
            info!(
                arc = %job.name,
                verdict = verdict.as_deref().unwrap_or("-"),
                end = ?end,
                "base-motion: stale audit answered",
            );
            wrote
        }
        Ok(Err(e)) => {
            warn!(arc = %job.name, error = %e, "base-motion: stale audit refused");
            false
        }
        Err(e) => {
            warn!(arc = %job.name, error = %e, "base-motion: stale audit task died");
            false
        }
    };
    (moved, end, seated_why)
}

/// A quiet job's hold on its arc: the board that publishes it, the
/// generation and run id it was minted, the signal that puts each move on
/// the wire, and the deadline its verify runs to.
struct QuietHold {
    board: Arc<ConflictBoard>,
    bump: Arc<Notify>,
    generation: u64,
    run_id: String,
    deadline: Instant,
    /// Where the run's transcript row is written.
    ink: InkWriter,
}

impl QuietHold {
    /// Move the run into `phase` and put the move on the wire.
    fn phase(&self, owner_key: &str, phase: ReauditPhase) {
        self.board.set_phase(owner_key, self.generation, phase);
        self.bump.notify_one();
    }

    /// Write the run's row as it is about to end, on the card already
    /// holding it; with no row written, there is no card to tell.
    async fn close_row(&self, owner_key: &str, state: &'static str, why: Option<String>) {
        let generation = self.generation;
        write_ink(&self.ink, &self.board, owner_key, None, false, |b, w| {
            b.ending_record(owner_key, generation, &w.arc, &w.base_branch, state, why)
        })
        .await;
    }
}

/// A clean replay under a live plan run, as the notice tells it.
struct Notice {
    base_head: String,
    /// How many rounds the replay moved.
    rounds: usize,
    oldest_round_before: Option<String>,
}

/// Compose the notice a clean replay calls for, and the same outcome as facts.
fn compose_notice(job: &ReplayJob, notice: &Notice) -> (String, NoticeFacts) {
    let paths = base_delta_paths(
        &job.repo_dir,
        &job.base_branch,
        notice.oldest_round_before.as_deref(),
    );
    let text = compose_replay_notice(&job.name, &job.base_branch, &notice.base_head, &paths);
    let facts = NoticeFacts::Replayed {
        arc: job.name.clone(),
        base: job.base_branch.clone(),
        sha: notice.base_head.clone(),
        paths,
        rounds: notice.rounds,
    };
    (text, facts)
}

/// The files the base brought in — what an agent's context may be stale about.
///
/// The arc's rounds branched off the base tip the arc used to sit on, so the
/// merge-base of any pre-move round with the base branch *is* that old tip; the
/// diff from there to the base branch is the base's own delta and none of the
/// arc's work. Without a pre-move round to anchor on there is nothing to say,
/// and the notice says so rather than guessing.
fn base_delta_paths(
    repo: &Path,
    base_branch: &str,
    oldest_round_before: Option<&str>,
) -> Vec<String> {
    let Some(round) = oldest_round_before else {
        return Vec::new();
    };
    let old_base = merge_base(repo, round, base_branch);
    if old_base.is_empty() {
        return Vec::new();
    }
    tugchanges_core::read_paths(repo, &["diff", "--name-only", &old_base, base_branch])
        .unwrap_or_default()
}

/// `git merge-base <a> <b>`, empty when there is none.
fn merge_base(repo: &Path, a: &str, b: &str) -> String {
    let out = tugcore::git_command()
        .arg("-C")
        .arg(repo)
        .args(["merge-base", a, b])
        .output();
    match out {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        _ => String::new(),
    }
}

/// The send half of an injection, cloned out of the context so the spawned task
/// owns it. The session API's `say` op builds one too, so a lab's injected
/// turn takes exactly the path a conflict turn takes: the opener on
/// CODE_OUTPUT, the submission down the CODE_INPUT queue.
pub(crate) struct InjectHandles {
    pub(crate) code_input_tx: Option<mpsc::Sender<Frame>>,
    pub(crate) code_output: Option<SessionScopedFeed>,
}

impl InjectHandles {
    async fn send(&self, session: &str, text: &str, facts: Option<&NoticeFacts>) -> bool {
        self.send_as(session, NOTICE_ORIGIN, text, &submission_text(text), facts)
            .await
    }

    /// The row under `origin` saying `text`, then the turn the agent reads,
    /// which says `submission`.
    pub(crate) async fn send_as(
        &self,
        session: &str,
        origin: &str,
        text: &str,
        submission: &str,
        facts: Option<&NoticeFacts>,
    ) -> bool {
        let Some(input_tx) = self.code_input_tx.as_ref() else {
            return false;
        };
        if let Some(output) = self.code_output.as_ref() {
            output.publish_tagged(Frame::new(
                FeedId::CODE_OUTPUT,
                notice_payload(session, origin, text, facts),
            ));
        }
        input_tx
            .send(Frame::new(
                FeedId::CODE_INPUT,
                user_message_payload(session, submission),
            ))
            .await
            .is_ok()
    }
}

/// The same words, marked for the reader who gets no row.
///
/// One text serves two audiences: the transcript row, where the origin is the
/// line's own label and repeating it in the sentence would be the label said
/// twice; and the **submission**, which arrives at the agent as an ordinary
/// user message with no label anywhere. Unmarked there, base-motion's words
/// read as the user's own — so the marker is put back on that side only,
/// which is the one place it is carrying information rather than repeating a
/// glyph.
fn submission_text(text: &str) -> String {
    format!("[base-motion replay] {text}")
}

/// `git rev-parse <rev>`, empty when it does not resolve.
fn rev_parse(repo: &Path, rev: &str) -> String {
    let out = tugcore::git_command()
        .arg("-C")
        .arg(repo)
        .args(["rev-parse", rev])
        .output();
    match out {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        _ => String::new(),
    }
}

fn clear_arc(
    board: &Arc<ConflictBoard>,
    state: &Arc<Mutex<HashMap<String, ArcState>>>,
    owner_key: &str,
) {
    let mut map = state.lock();
    if let Some(entry) = map.get_mut(owner_key) {
        entry.conflict = None;
    }
    board.set(owner_key, Vec::new());
}

/// The live bound session of one arc, carrying whether it is mid-turn.
///
/// The binding comes from the persisted ledger, which names one holder per arc
/// and no more; busyness comes from the supervisor's in-memory ledger,
/// where a session the supervisor is not running simply has no entry and reads
/// as idle.
async fn bound_session(
    supervisor: &Ledger,
    bound_by_arc: &HashMap<String, String>,
    owner_key: &str,
) -> Option<BoundSession> {
    let id = bound_by_arc.get(owner_key)?;
    let entry = {
        let ledger = supervisor.lock().await;
        ledger.get(&TugSessionId::new(id.clone())).cloned()
    };
    let busy = match entry {
        Some(entry) => !entry.lock().await.is_quiet(),
        None => false,
    };
    Some(BoundSession {
        id: id.clone(),
        busy,
    })
}

/// `git config --bool branch.tugarc/<name>.tugautoreplay` for one arc,
/// defaulting to on. Read per arc inside the same blocking hop that assembles
/// the rest of its reading, beside the `branch.tugarc/<name>.{tugbase,tugplan}`
/// keys the arc already keeps there.
fn read_arc_autoreplay(repo_dir: &Path, name: &str) -> bool {
    let key = format!("branch.tugarc/{name}.tugautoreplay");
    let out = tugcore::git_command()
        .arg("-C")
        .arg(repo_dir)
        .args(["config", "--bool", &key])
        .output();
    match out {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim() != "false",
        _ => true,
    }
}

/// `git config --bool tugarc.autoreplay`, defaulting to on ([P08]).
fn read_autoreplay(repo_dir: &Path) -> bool {
    let out = tugcore::git_command()
        .arg("-C")
        .arg(repo_dir)
        .args(["config", "--bool", "tugarc.autoreplay"])
        .output();
    match out {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim() != "false",
        _ => true,
    }
}

/// What moved the base, from the tip's commit as git records it: `raw` is
/// `<subject>\x1f<Tug-Arc values, \x1e-separated>`. A join's squash names its
/// arc as `tugarc/<name> onto <base>`, and the trigger carries `<name>`.
pub fn parse_trigger(sha: &str, raw: &str) -> ReauditTrigger {
    let (subject, trailers) = raw.split_once('\x1f').unwrap_or((raw, ""));
    let arc = trailers
        .split('\x1e')
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(|value| {
            let branch = value.split(" onto ").next().unwrap_or(value).trim();
            branch.strip_prefix("tugarc/").unwrap_or(branch).to_string()
        })
        .filter(|name| !name.is_empty());
    ReauditTrigger {
        sha: sha.to_string(),
        subject: subject.trim().to_string(),
        arc,
    }
}

/// [`parse_trigger`] over the tip's commit, read from git. Any failure reads
/// as the sha alone, with no subject and no arc.
fn read_trigger(repo: &Path, tip: &str) -> ReauditTrigger {
    let output = tugcore::git_command()
        .current_dir(repo)
        .args([
            "log",
            "-1",
            "--format=%s%x1f%(trailers:key=Tug-Arc,valueonly,separator=%x1e)",
            tip,
        ])
        .output();
    match output {
        Ok(out) if out.status.success() => parse_trigger(
            tip,
            String::from_utf8_lossy(&out.stdout).trim_end_matches('\n'),
        ),
        _ => ReauditTrigger {
            sha: tip.to_string(),
            ..ReauditTrigger::default()
        },
    }
}

/// The wrap a re-audit's checks run through: the sibling `tugtool`'s
/// `report rewrite`, which is the hook's own rewrite over the worktree's
/// runner table, behind the engine's call mark. A missing or failing
/// `tugtool` leaves the call mark alone in front of the command, so a check
/// that reports for itself still records under the call.
fn engine_wrapper(worktree: &Path, call_id: &str) -> impl Fn(&str) -> String + use<> {
    let tugtool = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("tugtool")))
        .filter(|path| path.exists());
    let (worktree, call_id) = (worktree.to_path_buf(), call_id.to_string());
    move |command: &str| {
        let fallback = || format!("{}{command}", tugcore::call_id::call_mark(&call_id));
        let Some(tugtool) = tugtool.as_ref() else {
            return fallback();
        };
        let child = std::process::Command::new(tugtool)
            .args(["report", "rewrite", "--cwd"])
            .arg(&worktree)
            .args(["--call", &call_id])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn();
        let Ok(mut child) = child else {
            return fallback();
        };
        if let Some(mut stdin) = child.stdin.take() {
            use std::io::Write;
            let _ = stdin.write_all(command.as_bytes());
        }
        match child.wait_with_output() {
            Ok(out) if out.status.success() && !out.stdout.is_empty() => {
                String::from_utf8_lossy(&out.stdout).into_owned()
            }
            _ => fallback(),
        }
    }
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(9)]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idle(id: &str) -> BoundSession {
        BoundSession {
            id: id.to_string(),
            busy: false,
        }
    }

    fn busy(id: &str) -> BoundSession {
        BoundSession {
            id: id.to_string(),
            busy: true,
        }
    }

    fn behind() -> ArcInputs {
        ArcInputs {
            autoreplay: true,
            arc_autoreplay: true,
            base_ahead: 2,
            worktree_dirty: false,
            join_journal: false,
            mid_plan: false,
            session: None,
            in_flight: false,
            conflicted: false,
            audit_stale_done: false,
            audit_base_only: false,
            quiet_failed: false,
        }
    }

    /// **A done arc whose audit went stale on a round seats its audit** on an
    /// idle bound card, waits on a busy one, and waits for a card when nobody
    /// holds it. It is decided whether or not the base is ahead — a new round
    /// stales an audit as surely as a base move — and the engine never
    /// replays it, because the audit stage replays the arc itself.
    #[test]
    fn a_stale_done_audit_seats_the_audit_stage() {
        let stale = |session: Option<BoundSession>, base_ahead: u32| ArcInputs {
            audit_stale_done: true,
            base_ahead,
            session,
            ..behind()
        };
        assert_eq!(
            decide_for_arc(&stale(Some(idle("s1")), 2)),
            Decision::SeatAudit("s1".to_string())
        );
        assert_eq!(
            decide_for_arc(&stale(Some(idle("s1")), 0)),
            Decision::SeatAudit("s1".to_string()),
            "a head move is stale with the base not ahead"
        );
        assert_eq!(
            decide_for_arc(&stale(Some(busy("s1")), 2)),
            Decision::Skip("session-busy")
        );
        assert_eq!(
            decide_for_arc(&stale(None, 2)),
            Decision::Skip("audit-stale, waiting for a card")
        );
        assert_eq!(
            decide_for_arc(&ArcInputs {
                join_journal: true,
                ..stale(Some(idle("s1")), 2)
            }),
            Decision::Skip("join-journal")
        );
        assert_eq!(
            decide_for_arc(&ArcInputs {
                autoreplay: false,
                ..stale(Some(idle("s1")), 2)
            }),
            Decision::Skip("autoreplay-off"),
            "an arc whose repository opted out of motion is left alone"
        );
    }

    /// **The machine keeps the quiet case.** An audit stale on the base alone
    /// is replayed, verified and re-stamped with no turn — bound or not, since
    /// the re-stamp needs no card. Once the quiet path has failed at this base
    /// tip, the same arc seats its audit (or waits for a card) instead of
    /// replaying and verifying again.
    #[test]
    fn a_base_only_stale_audit_is_restamped_quietly() {
        let base_only = |session: Option<BoundSession>| ArcInputs {
            audit_stale_done: true,
            audit_base_only: true,
            session,
            ..behind()
        };
        assert_eq!(
            decide_for_arc(&base_only(Some(idle("s1")))),
            Decision::Restamp(Some("s1".to_string()))
        );
        assert_eq!(decide_for_arc(&base_only(None)), Decision::Restamp(None));
        assert_eq!(
            decide_for_arc(&base_only(Some(busy("s1")))),
            Decision::Skip("session-busy"),
            "a working session is never moved under"
        );
        let failed = |session| ArcInputs {
            quiet_failed: true,
            ..base_only(session)
        };
        assert_eq!(
            decide_for_arc(&failed(Some(idle("s1")))),
            Decision::SeatAudit("s1".to_string())
        );
        assert_eq!(
            decide_for_arc(&failed(None)),
            Decision::Skip("audit-stale, waiting for a card")
        );
    }

    /// **The Re-audit door's release.** A press past the horizon takes the
    /// arc back from a job that will not end: the running fact comes down
    /// with a reason, the released job can neither end nor write for the arc,
    /// and the next job takes it afresh.
    #[test]
    fn a_press_past_the_horizon_releases_the_quiet_job() {
        let board = ConflictBoard::default();
        assert_eq!(
            board.release_restamp("a", SystemTime::now()),
            RestampRelease::NotRunning
        );
        let first = begin(&board, "a");
        assert_eq!(
            board.begin_restamp("a", Duration::from_secs(60), ReauditTrigger::default()),
            None,
            "one quiet job per arc"
        );
        let later = SystemTime::now() + Duration::from_secs(61);
        assert_eq!(board.release_restamp("a", later), RestampRelease::Released);
        assert!(!board.restamping("a") && !board.holds("a", first));
        assert!(
            board
                .quiet_fact("a")
                .and_then(|fact| fact.seated_why)
                .is_some_and(|why| why.contains("ran past its horizon"))
        );
        let last = board
            .quiet_fact("a")
            .and_then(|fact| fact.last)
            .expect("the released run is kept as it ended");
        assert_eq!(last.state, "released");
        assert!(
            last.why
                .is_some_and(|why| why.contains("ran past its horizon"))
        );

        let second = begin(&board, "a");
        assert!(
            !board.end_restamp("a", first, RunEnding::Seated("stale".to_string())),
            "the released job ends nothing"
        );
        assert!(board.holds("a", second));
        assert!(board.end_restamp("a", second, RunEnding::Verified));
        assert!(!board.restamping("a"));
    }

    /// Take the arc for a quiet job with no trigger, answering its generation.
    fn begin(board: &ConflictBoard, owner: &str) -> u64 {
        board
            .begin_restamp(owner, Duration::from_secs(60), ReauditTrigger::default())
            .expect("the arc is free")
            .0
    }

    /// A job that has claimed its write cannot be released, however late it
    /// runs, and a released job cannot claim one: the record is written by
    /// the job or by the press, never by both.
    #[test]
    fn a_claimed_write_cannot_be_released_and_a_released_job_cannot_claim() {
        let board = ConflictBoard::default();
        let late = SystemTime::now() + Duration::from_secs(61);

        let first = begin(&board, "a");
        assert!(board.claim_write("a", first), "the holding job claims");
        assert_eq!(
            board.release_restamp("a", late),
            RestampRelease::Finishing,
            "past the horizon, a claimed write still finishes"
        );
        assert!(board.end_restamp("a", first, RunEnding::Verified));

        let second = begin(&board, "a");
        assert_eq!(board.release_restamp("a", late), RestampRelease::Released);
        assert!(
            !board.claim_write("a", second),
            "a released job writes nothing"
        );
    }

    fn command(status: &str, exit_code: Option<i32>) -> tugarc_core::surfaces::CommandResult {
        tugarc_core::surfaces::CommandResult {
            command: "just check".to_string(),
            declared_by: "s".to_string(),
            status: status.to_string(),
            exit_code,
            already_run_for: None,
            passed: None,
            total: None,
            title: None,
            message: None,
        }
    }

    fn landed(
        name: &str,
        red: bool,
        commands: Vec<tugarc_core::surfaces::CommandResult>,
    ) -> tugarc_core::surfaces::SurfaceResult {
        tugarc_core::surfaces::SurfaceResult {
            name: name.to_string(),
            paths: Vec::new(),
            commands,
            borrowed_from: Vec::new(),
            red,
            passed: None,
            total: None,
            title: None,
            message: None,
        }
    }

    fn rows(board: &ConflictBoard) -> Vec<SurfaceRow> {
        board
            .quiet_fact("a")
            .and_then(|fact| fact.running)
            .map(|run| run.surfaces)
            .unwrap_or_default()
    }

    /// **The verify's rows on the board.** The plan lays every surface out
    /// pending, a start runs one, and a landing settles it: a red names its
    /// command and exit, a check the horizon stopped says so ahead of its
    /// exit, a surface with no checks is claimed and unchecked, and a green
    /// one passes with its checks counted. A stale generation writes nothing.
    #[test]
    fn the_verify_writes_one_row_per_surface_onto_the_board() {
        use tugarc_core::surfaces::VerifyEvent;
        let board = ConflictBoard::default();
        let generation = begin(&board, "a");
        let planned: Vec<(String, usize)> = ["red", "slow", "bare", "green"]
            .iter()
            .map(|n| (n.to_string(), 1))
            .collect();
        board.verify_event("a", generation, &VerifyEvent::Planned(&planned));
        assert!(rows(&board).iter().all(|r| r.status == "pending"));
        assert_eq!(rows(&board).len(), 4);

        board.verify_event("a", generation, &VerifyEvent::Started("red"));
        assert_eq!(rows(&board)[0].status, "running");
        assert!(rows(&board)[0].started.is_some());
        let red = landed("red", true, vec![command("ran", Some(2))]);
        board.verify_event("a", generation, &VerifyEvent::Finished(&red));
        let row = &rows(&board)[0];
        assert_eq!(row.status, "fail");
        assert_eq!(row.title.as_deref(), Some("just check"));
        assert_eq!(row.message.as_deref(), Some("exit 2"));
        assert_eq!((row.passed, row.total), (Some(0), Some(1)));
        assert!(row.ms.is_some());

        let slow = landed("slow", true, vec![command("timed-out", Some(-1))]);
        board.verify_event("a", generation, &VerifyEvent::Finished(&slow));
        assert_eq!(rows(&board)[1].status, "fail");
        assert_eq!(rows(&board)[1].message.as_deref(), Some(HORIZON_MESSAGE));

        let bare = landed("bare", false, Vec::new());
        board.verify_event("a", generation, &VerifyEvent::Finished(&bare));
        assert_eq!(rows(&board)[2].status, "skipped");
        assert_eq!(
            rows(&board)[2].message.as_deref(),
            Some("claimed, unchecked")
        );

        let green = landed("green", false, vec![command("ran", Some(0))]);
        board.verify_event("a", generation, &VerifyEvent::Finished(&green));
        assert_eq!(rows(&board)[3].status, "pass");
        assert_eq!(
            (rows(&board)[3].passed, rows(&board)[3].total),
            (Some(1), Some(1))
        );

        let before = rows(&board);
        board.verify_event("a", generation + 1, &VerifyEvent::Planned(&[]));
        board.set_phase("a", generation + 1, ReauditPhase::Marking);
        assert_eq!(rows(&board), before, "a stale generation changes nothing");
        assert_eq!(
            board
                .quiet_fact("a")
                .and_then(|f| f.running)
                .map(|r| r.phase),
            Some(ReauditPhase::Replaying)
        );
    }

    /// A run that ends with surfaces the horizon never let land keeps them as
    /// the horizon's, since nothing more will land on them.
    #[test]
    fn an_ended_run_settles_the_rows_nothing_landed_on() {
        use tugarc_core::surfaces::VerifyEvent;
        let board = ConflictBoard::default();
        let generation = begin(&board, "a");
        let planned = vec![("a".to_string(), 1), ("b".to_string(), 1)];
        board.verify_event("a", generation, &VerifyEvent::Planned(&planned));
        board.verify_event("a", generation, &VerifyEvent::Started("a"));
        assert!(board.end_restamp("a", generation, RunEnding::Seated("why".to_string())));
        let last = board.quiet_fact("a").and_then(|f| f.last).unwrap();
        assert_eq!(last.state, "seated");
        assert!(
            last.surfaces
                .iter()
                .all(|r| r.status == "fail" && r.message.as_deref() == Some(HORIZON_MESSAGE))
        );
    }

    /// The row's headline lines: a join's trigger names the arc it joined,
    /// and a plain commit's carries its subject alone.
    #[test]
    fn the_row_names_a_joined_arc_only_when_the_trigger_carries_one() {
        let joined = format_reaudit_row(&record_for_test(ReauditTrigger {
            sha: "9ac1e0f2aa".to_string(),
            subject: "Draw the lid".to_string(),
            arc: Some("lid".to_string()),
        }));
        assert_eq!(
            joined,
            "arc: demo\nrun: run-1\nbase: main 9ac1e0f2aa\nsubject: Draw the lid\n\
             joined: lid\nstate: running\nstarted: 2027-01-15T08:00:00+00:00\n"
        );
        let plain = format_reaudit_row(&record_for_test(ReauditTrigger {
            sha: "abc".to_string(),
            subject: "Fix a typo".to_string(),
            arc: None,
        }));
        assert!(!plain.contains("joined:"), "{plain}");
        assert!(plain.contains("subject: Fix a typo\n"), "{plain}");
    }

    #[test]
    fn a_terminal_row_writes_its_ending_and_its_surfaces_in_plan_order() {
        let mut record = record_for_test(ReauditTrigger {
            sha: "abc".to_string(),
            subject: "one\ttwo\nthree".to_string(),
            arc: None,
        });
        record.state = "seated";
        record.why = Some("the fit did not verify".to_string());
        record.ended = Some(record.started + Duration::from_secs(31));
        let mut docs = SurfaceRow::pending("docs");
        docs.status = "fail";
        docs.title = Some("just\tlint".to_string());
        docs.message = Some("exit 1".to_string());
        let mut rust = SurfaceRow::pending("rust");
        rust.status = "pass";
        (rust.passed, rust.total, rust.ms) = (Some(1307), Some(1307), Some(30782));
        record.surfaces = vec![rust, docs];
        let row = format_reaudit_row(&record);
        let lines: Vec<&str> = row.lines().collect();
        assert!(lines.contains(&"subject: one two three"), "{row}");
        assert!(lines.contains(&"state: seated"), "{row}");
        assert!(lines.contains(&"why: the fit did not verify"), "{row}");
        assert!(lines.contains(&"ended: 2027-01-15T08:00:31+00:00"), "{row}");
        let surfaces: Vec<&str> = lines
            .iter()
            .filter_map(|line| line.strip_prefix("surface: "))
            .collect();
        assert_eq!(
            surfaces,
            [
                "rust\tpass\t1307\t1307\t30782\t\t",
                "docs\tfail\t\t\t\tjust lint\texit 1",
            ]
        );
    }

    /// A running record on the fixture arc, under `trigger`.
    fn record_for_test(trigger: ReauditTrigger) -> ReauditRecord {
        let since = std::time::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        ReauditRecord {
            arc: "demo".to_string(),
            run_id: "run-1".to_string(),
            base_branch: "main".to_string(),
            trigger,
            state: "running",
            why: None,
            started: since,
            ended: None,
            surfaces: Vec::new(),
        }
    }

    /// The trigger is what moved the base: a join's squash names its arc,
    /// any other commit is its subject, and two trailer values take the
    /// first.
    #[test]
    fn the_trigger_names_the_joined_arc_or_the_subject() {
        let join = parse_trigger("abc", "Draw the lid\x1ftugarc/wsr onto main");
        assert_eq!(join.arc.as_deref(), Some("wsr"));
        assert_eq!(join.subject, "Draw the lid");
        assert_eq!(join.sha, "abc");

        let plain = parse_trigger("abc", "Fix a typo\x1f");
        assert_eq!(plain.arc, None);
        assert_eq!(plain.subject, "Fix a typo");
        assert_eq!(parse_trigger("abc", "Bare").subject, "Bare");

        let two = parse_trigger("abc", "s\x1ftugarc/one onto main\x1etugarc/two onto main");
        assert_eq!(two.arc.as_deref(), Some("one"));
    }

    /// The quiet path's verdict: a clean replay with a green fit re-stamps; a
    /// conflicted replay, a red fit, an unclaimed path, a project with no
    /// surfaces to run, or a verify that could not run seats the audit; a
    /// deferred replay, or one that could not run at all, leaves the arc for
    /// the next wake.
    #[test]
    fn the_quiet_path_restamps_only_a_clean_green_fit() {
        use QuietEnd::*;
        use QuietReplay::*;
        assert_eq!(quiet_end(Clean, Some("verified")), Restamp);
        assert_eq!(quiet_end(Clean, Some("nothing-in-range")), Restamp);
        assert_eq!(quiet_end(Clean, Some("red")), Seat);
        assert_eq!(quiet_end(Clean, Some("unclaimed")), Seat);
        assert_eq!(quiet_end(Clean, Some("declares-none")), Seat);
        assert_eq!(quiet_end(Clean, None), Seat);
        assert_eq!(quiet_end(Stopped, None), Seat);
        assert_eq!(quiet_end(Failed, None), Leave);
        assert_eq!(
            quiet_end(Deferred, None),
            Leave,
            "a deferral is transient: it seats nothing and latches nothing"
        );
    }

    /// **The quiet path waits for a clean tree.** A base-only stale audit over
    /// a dirty worktree is skipped, as an ordinary replay is, rather than
    /// replayed into a deferral; a stale head still seats, dirt or no dirt.
    #[test]
    fn a_dirty_base_only_stale_audit_waits_for_a_clean_tree() {
        let dirty = |audit_base_only| ArcInputs {
            audit_stale_done: true,
            audit_base_only,
            worktree_dirty: true,
            session: Some(idle("s1")),
            ..behind()
        };
        assert_eq!(
            decide_for_arc(&dirty(true)),
            Decision::Skip("dirty-worktree")
        );
        assert_eq!(
            decide_for_arc(&dirty(false)),
            Decision::SeatAudit("s1".to_string())
        );
    }

    /// **Which waits are published.** Only the quiet path's: a base-only
    /// stale audit the decision skipped for a busy card, a dirty tree or a
    /// join in flight. A head-moved stale audit is the audit stage's, a
    /// latched failure seats, and a decision to run is no wait at all.
    #[test]
    fn only_the_quiet_paths_skips_are_published_as_waits() {
        let stale = |audit_base_only| ArcInputs {
            audit_stale_done: true,
            audit_base_only,
            ..behind()
        };
        let held = ArcInputs {
            session: Some(busy("s1")),
            ..stale(true)
        };
        assert_eq!(
            quiet_wait(&held, &decide_for_arc(&held)),
            Some(QuietWaitReason::SessionBusy)
        );
        let dirty = ArcInputs {
            worktree_dirty: true,
            ..stale(true)
        };
        assert_eq!(
            quiet_wait(&dirty, &decide_for_arc(&dirty)),
            Some(QuietWaitReason::DirtyWorktree)
        );
        let journal = ArcInputs {
            join_journal: true,
            ..stale(true)
        };
        assert_eq!(
            quiet_wait(&journal, &decide_for_arc(&journal)),
            Some(QuietWaitReason::JoinJournal)
        );
        let head_moved = ArcInputs {
            session: Some(busy("s1")),
            ..stale(false)
        };
        assert_eq!(quiet_wait(&head_moved, &decide_for_arc(&head_moved)), None);
        let failed = ArcInputs {
            quiet_failed: true,
            ..held.clone()
        };
        assert_eq!(quiet_wait(&failed, &Decision::Skip("session-busy")), None);
        let clean = stale(true);
        assert_eq!(decide_for_arc(&clean), Decision::Restamp(None));
        assert_eq!(quiet_wait(&clean, &Decision::Restamp(None)), None);
    }

    /// The wait sentences, each naming what the re-audit waits on.
    #[test]
    fn the_wait_sentences_say_what_is_waited_on() {
        assert_eq!(
            wait_sentence(&QuietWaitReason::SessionBusy, Some("odd-kiln")),
            "waiting for odd-kiln's turn to end"
        );
        assert_eq!(
            wait_sentence(&QuietWaitReason::SessionBusy, None),
            "waiting for its card's turn to end"
        );
        assert!(wait_sentence(&QuietWaitReason::DirtyWorktree, None).contains("worktree"));
        assert!(wait_sentence(&QuietWaitReason::JoinJournal, None).contains("join"));
        assert_eq!(
            wait_sentence(
                &QuietWaitReason::Deferred("the head moved".to_string()),
                None
            ),
            "waiting to try again: the head moved"
        );
        assert!(wait_sentence(&QuietWaitReason::ReplayFailed, None).contains("could not run"));
    }

    /// **One story, one run id.** A wait the run starts out of keeps its run
    /// id; a second wait with a new trigger keeps the run id and takes the
    /// trigger; a run that goes back to waiting waits under its own run id;
    /// and a released job installs no wait.
    #[test]
    fn a_wait_and_the_run_it_becomes_share_a_run_id() {
        let board = ConflictBoard::default();
        let trigger = |sha: &str| ReauditTrigger {
            sha: sha.to_string(),
            ..ReauditTrigger::default()
        };
        let (id, changed) = board.begin_wait("a", "dirty".to_string(), trigger("t1"));
        assert!(changed);
        let (again, changed) = board.begin_wait("a", "dirty".to_string(), trigger("t2"));
        assert_eq!(again, id, "a standing wait keeps its run id");
        assert!(changed, "a new trigger is a change");
        assert_eq!(
            board
                .quiet_fact("a")
                .and_then(|f| f.waiting)
                .map(|w| w.trigger.sha),
            Some("t2".to_string())
        );
        assert!(!board.begin_wait("a", "dirty".to_string(), trigger("t2")).1);

        let (generation, run_id) = board
            .begin_restamp("a", Duration::from_secs(60), ReauditTrigger::default())
            .unwrap();
        assert_eq!(run_id, id, "the run takes the wait's run id");
        let fact = board.quiet_fact("a").unwrap();
        assert!(fact.waiting.is_none(), "the run takes the wait down");
        assert_eq!(fact.running.map(|r| r.trigger.sha), Some("t2".to_string()));

        assert!(board.end_restamp("a", generation, RunEnding::Wait("again".to_string())));
        let wait = board.quiet_fact("a").and_then(|f| f.waiting).unwrap();
        assert_eq!(
            wait.run_id, id,
            "a run that goes back to waiting keeps its id"
        );
        assert_eq!(wait.why, "again");
        board.forget_seated("a");
        assert!(
            board.waiting("a"),
            "a fact that still waits is not forgotten"
        );

        let (released, _) = board
            .begin_restamp("a", Duration::from_secs(60), ReauditTrigger::default())
            .unwrap();
        let late = SystemTime::now() + Duration::from_secs(61);
        assert_eq!(board.release_restamp("a", late), RestampRelease::Released);
        assert!(!board.end_restamp("a", released, RunEnding::Wait("w".to_string())));
        assert!(!board.waiting("a"), "a released job installs no wait");
        assert!(board.clear_wait("a").is_none());
    }

    /// The bind wake keeps its permit: a bind while the engine is busy is
    /// answered by the next pass rather than lost.
    #[tokio::test]
    async fn a_bind_wakes_the_engine() {
        wake_on_bind();
        // The permit is already stored, so this resolves at once; a lost
        // wake would hang here and nextest's own guard would name it.
        bind_wake().notified().await;
    }

    #[test]
    fn a_behind_clean_idle_arc_replays() {
        assert_eq!(decide_for_arc(&behind()), Decision::Replay);
    }

    #[test]
    fn a_mid_plan_arc_with_a_session_is_told_its_context_moved() {
        let inputs = ArcInputs {
            mid_plan: true,
            session: Some(idle("sess-1")),
            ..behind()
        };
        assert_eq!(
            decide_for_arc(&inputs),
            Decision::ReplayThenNotify("sess-1".to_string())
        );
    }

    #[test]
    fn a_mid_plan_arc_with_no_session_replays_quietly() {
        let inputs = ArcInputs {
            mid_plan: true,
            ..behind()
        };
        assert_eq!(decide_for_arc(&inputs), Decision::Replay);
    }

    #[test]
    fn a_arc_that_opted_out_is_left_alone_however_far_behind_it_is() {
        // Every condition below would otherwise argue for acting: the arc is
        // behind, clean, idle, and mid-plan with a session to tell.
        let inputs = ArcInputs {
            arc_autoreplay: false,
            base_ahead: 40,
            mid_plan: true,
            session: Some(idle("sess-1")),
            ..behind()
        };
        assert_eq!(
            decide_for_arc(&inputs),
            Decision::Skip("autoreplay-off (arc)")
        );
    }

    #[test]
    fn an_opted_out_conflicted_arc_is_not_even_marked() {
        let inputs = ArcInputs {
            arc_autoreplay: false,
            conflicted: true,
            session: Some(idle("sess-1")),
            ..behind()
        };
        assert_eq!(
            decide_for_arc(&inputs),
            Decision::Skip("autoreplay-off (arc)")
        );
    }

    #[test]
    fn a_dirty_worktree_is_never_moved_under() {
        let inputs = ArcInputs {
            worktree_dirty: true,
            ..behind()
        };
        assert_eq!(decide_for_arc(&inputs), Decision::Skip("dirty-worktree"));
    }

    #[test]
    fn a_session_still_working_parks_the_whole_arc() {
        let inputs = ArcInputs {
            session: Some(busy("b")),
            ..behind()
        };
        // "Working" is mid-turn *or* holding a background job: a test sweep
        // outlives the turn that launched it, and it reads the same worktree
        // the replay would rewrite.
        assert_eq!(decide_for_arc(&inputs), Decision::Skip("session-busy"));
    }

    #[test]
    fn a_landing_in_flight_defers() {
        let inputs = ArcInputs {
            join_journal: true,
            ..behind()
        };
        assert_eq!(decide_for_arc(&inputs), Decision::Skip("join-journal"));
    }

    #[test]
    fn a_conflicted_arc_with_no_session_only_marks() {
        let inputs = ArcInputs {
            conflicted: true,
            ..behind()
        };
        assert_eq!(decide_for_arc(&inputs), Decision::MarkOnly);
    }

    #[test]
    fn a_conflicted_arc_is_marked_and_never_made_a_turn() {
        let inputs = ArcInputs {
            conflicted: true,
            session: Some(idle("sess-1")),
            ..behind()
        };
        // Resolving a conflict is the audit stage's work, on the Wheel; the
        // engine only keeps the lane mark.
        assert_eq!(decide_for_arc(&inputs), Decision::MarkOnly);
    }

    #[test]
    fn a_current_arc_does_nothing() {
        let inputs = ArcInputs {
            base_ahead: 0,
            ..behind()
        };
        assert_eq!(decide_for_arc(&inputs), Decision::Skip("current"));
    }

    #[test]
    fn a_replay_already_running_does_not_start_a_second() {
        let inputs = ArcInputs {
            in_flight: true,
            ..behind()
        };
        assert_eq!(decide_for_arc(&inputs), Decision::Skip("in-flight"));
    }

    #[test]
    fn the_repo_escape_stops_everything() {
        let inputs = ArcInputs {
            autoreplay: false,
            conflicted: true,
            session: Some(idle("sess-1")),
            ..behind()
        };
        assert_eq!(decide_for_arc(&inputs), Decision::Skip("autoreplay-off"));
    }

    // MARK: - The messages

    #[test]
    fn the_replay_notice_names_the_base_delta_and_asks_for_nothing() {
        let text = compose_replay_notice(
            "demo",
            "main",
            "abcdef0123456789",
            &["src/moved.rs".to_string()],
        );
        assert!(text.contains("src/moved.rs"));
        assert!(text.contains("No action is required"));
        assert!(
            !text.starts_with("[base-motion replay]"),
            "the row's own origin label says which feed this is; the text does not say it twice"
        );
        assert!(
            !text.contains("rebase"),
            "a clean replay asks for no git work"
        );
    }

    #[test]
    fn a_replay_notice_with_no_delta_says_so_rather_than_listing_nothing() {
        let text = compose_replay_notice("demo", "main", "abcdef0123456789", &[]);
        assert!(text.contains("no file changes"));
    }

    /// The one field that separates a bulletin from a turn's opener.
    ///
    /// A frame that lost it would open a turn nothing ever finishes, so the
    /// flag is pinned here rather than trusted to the two builders staying in
    /// step by eye.
    #[test]
    fn bulletin_payload_marks_standalone() {
        let bulletin: serde_json::Value =
            serde_json::from_slice(&bulletin_payload("s1", "arc-resolve", "hello")).unwrap();
        assert_eq!(bulletin["type"], "tug_notice");
        assert_eq!(bulletin["origin"], "arc-resolve");
        assert_eq!(bulletin["text"], "hello");
        assert_eq!(bulletin["standalone"], true);

        let opener: serde_json::Value =
            serde_json::from_slice(&notice_payload("s1", "base-motion", "hello", None)).unwrap();
        assert!(
            opener.get("standalone").is_none(),
            "an opener carries no flag at all — a turn is coming behind it: {opener}"
        );
    }

    // MARK: - Injection

    /// A crossing notice waits out a busy session, is spoken once as one turn
    /// when the session is quiet, and is not spoken again; an arc with nobody
    /// bound drops its notice.
    #[tokio::test]
    async fn a_crossing_notice_is_spoken_once_when_its_session_is_quiet() {
        let feed =
            SessionScopedFeed::new(FeedId::CODE_OUTPUT, 16, tugcast_core::lag::LagPolicy::Warn);
        let mut out_rx = feed.subscribe();
        let (in_tx, mut in_rx) = mpsc::channel::<Frame>(8);
        let inject = InjectHandles {
            code_input_tx: Some(in_tx),
            code_output: Some(feed),
        };
        let notices = CrossingNotices::default();
        let repo = Path::new("/repo");
        notices.queue(repo, "a", "Arc \"b\" changed f.txt");
        notices.queue(repo, "b", "Arc \"a\" changed f.txt");

        speak_crossings(&notices, &inject, repo, "a", Some(&busy("sess-a"))).await;
        assert!(
            in_rx.try_recv().is_err(),
            "a busy session is not interrupted"
        );

        speak_crossings(&notices, &inject, repo, "a", Some(&idle("sess-a"))).await;
        let opener: serde_json::Value =
            serde_json::from_slice(&out_rx.try_recv().unwrap().payload).unwrap();
        assert_eq!(opener["origin"], CROSSING_ORIGIN);
        assert_eq!(opener["tug_session_id"], "sess-a");
        let body: serde_json::Value =
            serde_json::from_slice(&in_rx.try_recv().unwrap().payload).unwrap();
        assert_eq!(
            body["content"][0]["text"],
            "[crossing] Arc \"b\" changed f.txt"
        );

        speak_crossings(&notices, &inject, repo, "a", Some(&idle("sess-a"))).await;
        assert!(in_rx.try_recv().is_err(), "a notice is spoken once");

        speak_crossings(&notices, &inject, repo, "b", None).await;
        speak_crossings(&notices, &inject, repo, "b", Some(&idle("sess-b"))).await;
        assert!(
            in_rx.try_recv().is_err(),
            "an arc with nobody bound drops it"
        );
    }

    /// [P10]: no injected turn reaches a client unannounced. The opener and the
    /// submission carry the same body, and the opener goes first — it is the
    /// turn's head row, so it cannot arrive under the output it introduces.
    #[tokio::test]
    async fn every_injection_is_announced_by_exactly_one_notice() {
        let feed =
            SessionScopedFeed::new(FeedId::CODE_OUTPUT, 16, tugcast_core::lag::LagPolicy::Warn);
        let mut out_rx = feed.subscribe();
        let (in_tx, mut in_rx) = mpsc::channel::<Frame>(8);
        let handles = InjectHandles {
            code_input_tx: Some(in_tx),
            code_output: Some(feed),
        };

        let text = compose_replay_notice("demo", "main", "abcdef0123456789", &[]);
        assert!(handles.send("sess-1", &text, None).await);

        let opener = out_rx.try_recv().expect("an opener rode out");
        assert_eq!(opener.feed_id, FeedId::CODE_OUTPUT);
        let opener: serde_json::Value = serde_json::from_slice(&opener.payload).unwrap();
        assert_eq!(opener["type"], "tug_notice");
        assert_eq!(opener["origin"], NOTICE_ORIGIN);
        assert_eq!(opener["tug_session_id"], "sess-1");
        assert_eq!(opener["text"], text, "the opener carries the injected body");
        assert!(
            out_rx.try_recv().is_err(),
            "exactly one opener per injection, never two",
        );

        let submitted = in_rx.try_recv().expect("the submission rode out");
        assert_eq!(submitted.feed_id, FeedId::CODE_INPUT);
        let body: serde_json::Value = serde_json::from_slice(&submitted.payload).unwrap();
        assert_eq!(body["type"], "user_message");
        // The same words, marked: the submission arrives at the agent as an
        // ordinary user message with no row and no origin label, so unmarked
        // there base-motion's words would read as the user's own. The row has
        // the label and needs no prefix; this side has neither and does.
        assert_eq!(
            body["content"][0]["text"],
            format!("[base-motion replay] {text}")
        );
    }

    #[tokio::test]
    async fn an_injection_with_nowhere_to_send_reports_failure() {
        let handles = InjectHandles {
            code_input_tx: None,
            code_output: None,
        };
        assert!(!handles.send("sess-1", "anything", None).await);
    }

    // MARK: - The wiring, against real repositories
    //
    // These drive the engine over tempdir repos with real arcs and real
    // worktrees. No app, no supervisor: the wake arrives on the channel the
    // registry's git watch would have sent it on, and the assertion is that the
    // branch actually moved.

    use serial_test::serial;
    use std::time::Duration;
    use tempfile::TempDir;
    use tokio::sync::Mutex as AsyncMutex;

    struct Repo {
        _home: TempDir,
        dir: TempDir,
    }

    use tugcore::test_fixtures::git::{GitFixture, git};

    fn read(dir: &Path, args: &[&str]) -> String {
        let out = tugcore::test_fixtures::git::command()
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    impl Repo {
        fn path(&self) -> &Path {
            self.dir.path()
        }

        fn worktree(&self) -> PathBuf {
            self.path().join(".tug/worktrees/demo")
        }

        fn tip(&self, refname: &str) -> String {
            read(self.path(), &["rev-parse", refname])
        }

        /// A commit on the base branch, so the arc falls behind.
        fn advance_base(&self, content: &str) {
            std::fs::write(self.path().join("f.txt"), content).unwrap();
            git(self.path(), &["add", "f.txt"]);
            git(self.path(), &["commit", "-q", "-m", "the base moves"]);
        }
    }

    /// A repository holding one arc with one round, its worktree checked out.
    /// `TUG_DATA_DIR` is redirected so the replay's arc log lands in the
    /// tempdir rather than in the developer's real state directory.
    fn repo_with_a_arc() -> Repo {
        let home = tempfile::tempdir().unwrap();
        // SAFETY: every test that calls this is #[serial]; no other thread
        // reads the environment while this runs.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().to_path_buf();
        let repo = repo.as_path();
        GitFixture::init(repo);
        std::fs::write(repo.join("f.txt"), "A\n").unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-q", "-m", "base"]);
        git(repo, &["branch", "tugarc/demo"]);
        git(repo, &["config", "branch.tugarc/demo.tugbase", "main"]);
        let repo_owned = Repo { _home: home, dir };
        let wt = repo_owned.worktree();
        git(
            repo,
            &["worktree", "add", "-q", wt.to_str().unwrap(), "tugarc/demo"],
        );
        // The arc's own round, on a file the base never touches, so a replay
        // of it is clean.
        std::fs::write(wt.join("g.txt"), "arc\n").unwrap();
        git(&wt, &["add", "-A"]);
        git(&wt, &["commit", "-q", "-m", "add g"]);
        repo_owned
    }

    fn test_context(
        registry: &Arc<WorkspaceRegistry>,
        bump: &Arc<Notify>,
        cancel: &CancellationToken,
    ) -> BaseMotionContext {
        BaseMotionContext {
            registry: Arc::clone(registry),
            supervisor_ledger: Arc::new(AsyncMutex::new(HashMap::new())),
            session_ledger: None,
            bump: Arc::clone(bump),
            code_input_tx: None,
            code_output: None,
            supervisor: None,
            cancel: cancel.clone(),
        }
    }

    /// Poll `check` until it holds or the deadline passes. Git subprocesses on
    /// a blocking pool have no completion signal to await, so the assertion is
    /// "this becomes true", not "this is true now".
    async fn settles(mut check: impl FnMut() -> bool) -> bool {
        for _ in 0..200 {
            if check() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        check()
    }

    /// The fixture arc, finished and audited, and then its base moved under
    /// the audit. The arc declares one surface whose check is `check`, on the
    /// arc itself so the verify reads it from the worktree. A `conflicting`
    /// arc rewrites `f.txt` as the base move does, so its replay cannot
    /// merge.
    fn repo_with_a_stale_audit(check: &str, conflicting: bool) -> Repo {
        let repo = repo_with_a_arc();
        let wt = repo.worktree();
        std::fs::create_dir_all(wt.join(".tugtool")).unwrap();
        std::fs::write(
            wt.join(".tugtool/config.toml"),
            format!(
                "[[tugtool.arc.surface]]\nname = \"all\"\n\
                 paths = [\".tugtool/\", \"f.txt\", \"g.txt\"]\ncheck = [\"{check}\"]\n"
            ),
        )
        .unwrap();
        if conflicting {
            std::fs::write(wt.join("f.txt"), "arc rewrote this\n").unwrap();
        }
        git(&wt, &["add", "-A"]);
        git(&wt, &["commit", "-q", "-m", "declare the surface"]);

        let paths = Paths::from_env();
        let root = repo.path();
        tugarc_core::append_arc_start(&paths, root, "demo", ".tug/arcs/demo/plan.md").unwrap();
        tugarc_core::mark_in(&paths, root, "demo", tugarc_core::MarkStage::Audited, None).unwrap();
        tugarc_core::append_arc_done(&paths, root, "demo").unwrap();
        repo.advance_base("base rewrote this\n");
        repo
    }

    /// The fixture arc's quiet-path job, with a card to seat the audit on.
    fn quiet_job(repo: &Repo) -> ReplayJob {
        ReplayJob {
            quiet: Some(QuietJob {
                seat: Some("sess-1".to_string()),
                base_tip: repo.tip("main"),
                horizon: QUIET_HORIZON,
                trigger: ReauditTrigger::default(),
            }),
            ..demo_job(repo)
        }
    }

    /// Run one quiet-path job to its end, and read back the arc's record.
    async fn run_quiet(
        repo: &Repo,
    ) -> (
        Arc<Mutex<HashMap<String, ArcState>>>,
        ArcRecordView,
        Option<QuietFact>,
    ) {
        INK_LOG.lock().clear();
        let cancel = CancellationToken::new();
        let registry = Arc::new(WorkspaceRegistry::new_for_test());
        let bump = Arc::new(Notify::new());
        let ctx = test_context(&registry, &bump, &cancel);
        let board = Arc::new(ConflictBoard::default());
        let state: Arc<Mutex<HashMap<String, ArcState>>> = Arc::new(Mutex::new(HashMap::new()));
        spawn_replay(&ctx, &board, &state, quiet_job(repo));
        assert!(
            settles(|| !board.restamping("tugarc/demo")).await,
            "the quiet path runs to its end"
        );
        cancel.cancel();
        let paths = Paths::from_env();
        let record = tugarc_core::read_arc(&paths, repo.path(), "demo").expect("the arc record");
        let log = tugarc_core::read_declarations(&paths, repo.path(), "demo");
        let current = tugarc_core::log::audit_current(
            &log,
            &tugarc_core::ops::live_tips(repo.path(), "demo"),
        );
        (
            state,
            ArcRecordView {
                done: record.done,
                reaudit: record.resume == Some(tugarc_core::ArcStage::Audit),
                audit_current: current,
            },
            board.quiet_fact("tugarc/demo"),
        )
    }

    /// What the quiet-path tests read off the arc once the job ends.
    struct ArcRecordView {
        done: bool,
        reaudit: bool,
        audit_current: bool,
    }

    /// The rows the engine would have written, in order.
    fn ink_log() -> Vec<InkLogged> {
        INK_LOG.lock().clone()
    }

    /// One `key: value` line of a written row.
    fn row_line<'a>(output: &'a str, key: &str) -> Option<&'a str> {
        output
            .lines()
            .find_map(|line| line.strip_prefix(key)?.strip_prefix(": "))
    }

    /// `test_context`, with the fixture arc bound to `sess-1` in a session
    /// ledger, so a wake finds the card that holds it. With no supervisor
    /// entry for `sess-1`, the card reads idle.
    fn bound_context(
        registry: &Arc<WorkspaceRegistry>,
        bump: &Arc<Notify>,
        cancel: &CancellationToken,
        repo: &Repo,
    ) -> BaseMotionContext {
        let ledger = SessionLedger::open_in_memory().expect("an in-memory ledger");
        ledger
            .record_spawn(
                "sess-1",
                "ws",
                &repo.path().to_string_lossy(),
                "card-1",
                crate::session_ledger::now_millis(),
                "line-1",
                None,
            )
            .unwrap();
        assert!(
            ledger
                .set_arc_binding("sess-1", Some(("tugarc/demo", "demo")))
                .unwrap()
        );
        BaseMotionContext {
            session_ledger: Some(Arc::new(ledger)),
            ..test_context(registry, bump, cancel)
        }
    }

    /// The fixture arc's replay job, with nobody to tell about the outcome.
    fn demo_job(repo: &Repo) -> ReplayJob {
        ReplayJob {
            repo_dir: repo.path().to_path_buf(),
            name: "demo".to_string(),
            owner_key: "tugarc/demo".to_string(),
            base_branch: "main".to_string(),
            notify: None,
            quiet: None,
        }
    }

    /// The registry entry, plus the canonical key its git watch would stamp
    /// into a `GitHeadSignal`.
    fn register(registry: &WorkspaceRegistry, dir: &Path, cancel: &CancellationToken) -> String {
        registry
            .get_or_create(dir, cancel.clone())
            .expect("a tempdir is a valid workspace");
        registry
            .project_dirs()
            .into_iter()
            .map(|(_, key)| key)
            .next()
            .expect("the workspace we just registered")
    }

    /// [P01]'s level read: an arc that fell behind before tugcast started gets
    /// no signal, because the git watch baselines HEAD at task start. The sweep
    /// is what finds it — nothing is ever sent on the GIT_HEAD channel here.
    #[tokio::test]
    #[serial]
    async fn the_initial_sweep_replays_a_arc_that_was_already_behind() {
        let repo = repo_with_a_arc();
        repo.advance_base("B\n");
        let before = repo.tip("tugarc/demo");

        let cancel = CancellationToken::new();
        let registry = Arc::new(WorkspaceRegistry::new_for_test());
        register(&registry, repo.path(), &cancel);
        let (gh_tx, gh_rx) = broadcast::channel::<Frame>(16);
        let (_open_tx, open_rx) = mpsc::channel::<String>(4);
        let (_turn_tx, turn_rx) = mpsc::channel::<String>(4);
        let bump = Arc::new(Notify::new());
        tokio::spawn(run_base_motion_engine(
            test_context(&registry, &bump, &cancel),
            gh_rx,
            open_rx,
            turn_rx,
        ));

        assert!(
            settles(|| repo.tip("tugarc/demo") != before).await,
            "the sweep must replay an arc nothing will ever signal about"
        );
        assert_eq!(
            read(&repo.worktree(), &["status", "--porcelain"]),
            "",
            "the worktree is clean after the move"
        );
        assert_eq!(
            read(
                repo.path(),
                &["merge-base", "--is-ancestor", "main", "tugarc/demo"]
            ),
            "",
        );
        assert!(
            read(repo.path(), &["log", "--oneline", "tugarc/demo"]).contains("add g"),
            "the arc's round survived the move"
        );
        // Quiet, never silent: the motion left a record.
        // Resolved through the same root normalization the library applies, so
        // the test cannot read a different project slug than the code wrote.
        //
        // Settled, not read once: `log_replay` appends *after* the
        // compare-and-swap that moved the branch, so the tip this test waited
        // on is reached a moment before the line exists. Reading it straight
        // through is a race that only widens under a loaded workspace run.
        let root = tugtool_core::find_repo_root_from(repo.path()).unwrap();
        let log_path = tugtool_core::project_state_dir(&root).join(tugtool_core::paths::ARC_LOG);
        let names_the_replay = || {
            std::fs::read_to_string(&log_path)
                .unwrap_or_default()
                .contains("replayed")
        };
        assert!(
            settles(names_the_replay).await,
            "the arc log names the replay"
        );

        drop(gh_tx);
        cancel.cancel();
    }

    /// The edge path: a base that moves while the engine is running replays off
    /// the GIT_HEAD signal the workspace's git watch broadcasts.
    #[tokio::test]
    #[serial]
    async fn a_git_head_signal_replays_a_arc_that_just_fell_behind() {
        let repo = repo_with_a_arc();
        let cancel = CancellationToken::new();
        let registry = Arc::new(WorkspaceRegistry::new_for_test());
        let key = register(&registry, repo.path(), &cancel);
        let (gh_tx, gh_rx) = broadcast::channel::<Frame>(16);
        let (_open_tx, open_rx) = mpsc::channel::<String>(4);
        let (_turn_tx, turn_rx) = mpsc::channel::<String>(4);
        let bump = Arc::new(Notify::new());
        tokio::spawn(run_base_motion_engine(
            test_context(&registry, &bump, &cancel),
            gh_rx,
            open_rx,
            turn_rx,
        ));
        // Let the startup sweep find nothing to do before the base moves, so
        // the replay under test can only have come from the signal.
        tokio::time::sleep(Duration::from_millis(200)).await;
        let before = repo.tip("tugarc/demo");
        repo.advance_base("B\n");

        let signal = GitHeadSignal {
            workspace_key: key,
            head: repo.tip("main"),
        };
        gh_tx
            .send(Frame::new(
                tugcast_core::protocol::FeedId::GIT_HEAD,
                serde_json::to_vec(&signal).unwrap(),
            ))
            .unwrap();

        assert!(
            settles(|| repo.tip("tugarc/demo") != before).await,
            "the signal must drive the replay"
        );
        // The aggregate recompute was asked for, so the marks refresh without
        // waiting on a file event.
        assert!(
            tokio::time::timeout(Duration::from_secs(2), bump.notified())
                .await
                .is_ok()
                || repo.tip("tugarc/demo") != before,
            "a completed motion bumps the aggregate"
        );
        cancel.cancel();
    }

    /// A signal for a workspace this engine does not hold is a cheap no-op, not
    /// a sweep of everything.
    #[tokio::test]
    #[serial]
    async fn a_signal_for_an_unknown_workspace_moves_nothing() {
        let repo = repo_with_a_arc();
        repo.advance_base("B\n");
        let cancel = CancellationToken::new();
        let registry = Arc::new(WorkspaceRegistry::new_for_test());
        let (gh_tx, gh_rx) = broadcast::channel::<Frame>(16);
        let (_open_tx, open_rx) = mpsc::channel::<String>(4);
        let (_turn_tx, turn_rx) = mpsc::channel::<String>(4);
        let bump = Arc::new(Notify::new());
        // Deliberately unregistered: the engine knows of no workspaces at all.
        tokio::spawn(run_base_motion_engine(
            test_context(&registry, &bump, &cancel),
            gh_rx,
            open_rx,
            turn_rx,
        ));
        let before = repo.tip("tugarc/demo");
        gh_tx
            .send(Frame::new(
                tugcast_core::protocol::FeedId::GIT_HEAD,
                serde_json::to_vec(&GitHeadSignal {
                    workspace_key: "/nowhere".to_string(),
                    head: "deadbeef".to_string(),
                })
                .unwrap(),
            ))
            .unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(repo.tip("tugarc/demo"), before);
        cancel.cancel();
    }

    /// [P08]'s escape: `tugarc.autoreplay false` stops the motion in a
    /// repository, and the wake path still runs — it just declines.
    #[tokio::test]
    #[serial]
    async fn the_repo_escape_defers_every_replay() {
        let repo = repo_with_a_arc();
        git(repo.path(), &["config", "tugarc.autoreplay", "false"]);
        repo.advance_base("B\n");
        let before = repo.tip("tugarc/demo");

        let cancel = CancellationToken::new();
        let registry = Arc::new(WorkspaceRegistry::new_for_test());
        let key = register(&registry, repo.path(), &cancel);
        let (gh_tx, gh_rx) = broadcast::channel::<Frame>(16);
        let (_open_tx, open_rx) = mpsc::channel::<String>(4);
        let (_turn_tx, turn_rx) = mpsc::channel::<String>(4);
        let bump = Arc::new(Notify::new());
        tokio::spawn(run_base_motion_engine(
            test_context(&registry, &bump, &cancel),
            gh_rx,
            open_rx,
            turn_rx,
        ));
        gh_tx
            .send(Frame::new(
                tugcast_core::protocol::FeedId::GIT_HEAD,
                serde_json::to_vec(&GitHeadSignal {
                    workspace_key: key,
                    head: repo.tip("main"),
                })
                .unwrap(),
            ))
            .unwrap();
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(
            repo.tip("tugarc/demo"),
            before,
            "an opted-out repository is never moved"
        );
        cancel.cancel();
    }

    /// [P02]'s park-and-retry, from the wake side: the engine's gate refuses to
    /// act while a session is mid-turn, so the supervisor's turn-complete signal
    /// is what lets the arc catch up. No GIT_HEAD signal is ever sent here.
    #[tokio::test]
    #[serial]
    async fn a_turn_ending_wakes_a_arc_that_fell_behind_during_it() {
        let repo = repo_with_a_arc();
        let cancel = CancellationToken::new();
        let registry = Arc::new(WorkspaceRegistry::new_for_test());
        register(&registry, repo.path(), &cancel);
        let (gh_tx, gh_rx) = broadcast::channel::<Frame>(16);
        let (_open_tx, open_rx) = mpsc::channel::<String>(4);
        let (turn_tx, turn_rx) = mpsc::channel::<String>(4);
        let bump = Arc::new(Notify::new());
        tokio::spawn(run_base_motion_engine(
            test_context(&registry, &bump, &cancel),
            gh_rx,
            open_rx,
            turn_rx,
        ));
        // Let the startup sweep settle on an arc with nothing to do.
        tokio::time::sleep(Duration::from_millis(200)).await;
        let before = repo.tip("tugarc/demo");
        repo.advance_base("B\n");

        turn_tx.send("sess-1".to_string()).await.unwrap();
        assert!(
            settles(|| repo.tip("tugarc/demo") != before).await,
            "a turn ending is a wake",
        );
        drop(gh_tx);
        cancel.cancel();
    }

    /// [P11]'s clean-replay notice carries the replay as facts beside its
    /// words, and the words are exactly what they were before the facts
    /// existed — the agent reads the text, the deck draws the facts.
    #[tokio::test]
    #[serial]
    async fn a_clean_replay_notice_carries_the_replay_as_facts() {
        let repo = repo_with_a_arc();
        repo.advance_base("B\n");

        let cancel = CancellationToken::new();
        let registry = Arc::new(WorkspaceRegistry::new_for_test());
        let bump = Arc::new(Notify::new());
        let feed =
            SessionScopedFeed::new(FeedId::CODE_OUTPUT, 16, tugcast_core::lag::LagPolicy::Warn);
        let mut out_rx = feed.subscribe();
        let (in_tx, mut in_rx) = mpsc::channel::<Frame>(8);
        let mut ctx = test_context(&registry, &bump, &cancel);
        ctx.code_input_tx = Some(in_tx);
        ctx.code_output = Some(feed);
        let board = Arc::new(ConflictBoard::default());
        let state: Arc<Mutex<HashMap<String, ArcState>>> = Arc::new(Mutex::new(HashMap::new()));

        spawn_replay(
            &ctx,
            &board,
            &state,
            ReplayJob {
                notify: Some("sess-1".to_string()),
                ..demo_job(&repo)
            },
        );
        tokio::time::timeout(Duration::from_secs(5), in_rx.recv())
            .await
            .expect("an injection within the timeout")
            .expect("the channel is open");

        let opener = out_rx.try_recv().expect("an opener");
        let opener: serde_json::Value = serde_json::from_slice(&opener.payload).unwrap();
        let base = repo.tip("main");
        let facts = &opener["facts"];
        assert_eq!(facts["kind"], "replayed", "{opener}");
        assert_eq!(facts["arc"], "demo");
        assert_eq!(facts["base"], "main");
        assert_eq!(facts["sha"], base, "the base head, full");
        assert_eq!(facts["rounds"], 1);
        assert_eq!(facts["paths"], serde_json::json!(["f.txt"]));
        assert!(
            facts.get("worktree").is_none(),
            "a replay names no worktree"
        );
        assert_eq!(
            opener["text"],
            compose_replay_notice("demo", "main", &base, &["f.txt".to_string()]),
            "the words are unchanged by the facts"
        );
        cancel.cancel();
    }

    /// **A replay that stopped before a settle finished is retried once the
    /// cache learns.** A sibling that lands inside a crossing settle's window
    /// moves the base before the settle has taught the cache, so the first
    /// replay stops on the hunk. When the settle finishes it wakes the engine,
    /// and the conflict record's cache count no longer matches: the replay
    /// runs again and recalls what the settle taught, instead of leaving the
    /// arc behind until the base moves again.
    #[tokio::test]
    #[serial]
    async fn a_replay_that_stopped_before_the_settle_is_retried_when_the_cache_learns() {
        let repo = repo_with_a_arc();
        let wt = repo.worktree();
        std::fs::write(wt.join("f.txt"), "arc\n").unwrap();
        git(&wt, &["commit", "-qam", "arc rewrites f"]);

        let cancel = CancellationToken::new();
        let registry = Arc::new(WorkspaceRegistry::new_for_test());
        register(&registry, repo.path(), &cancel);
        let (gh_tx, gh_rx) = broadcast::channel::<Frame>(16);
        let (_open_tx, open_rx) = mpsc::channel::<String>(4);
        let (turn_tx, turn_rx) = mpsc::channel::<String>(4);
        let bump = Arc::new(Notify::new());
        tokio::spawn(run_base_motion_engine(
            test_context(&registry, &bump, &cancel),
            gh_rx,
            open_rx,
            turn_rx,
        ));
        tokio::time::sleep(Duration::from_millis(200)).await;
        let before = repo.tip("tugarc/demo");
        repo.advance_base("base\n");
        turn_tx.send("sess-1".to_string()).await.unwrap();
        let owner_key = tugarc_core::ops::arc_owner_key(repo.path(), "demo");
        assert!(
            settles(|| conflict_paths_for(&owner_key) == ["f.txt"]).await,
            "the first replay stops on the hunk nothing has taught"
        );
        assert_eq!(repo.tip("tugarc/demo"), before);

        // The settle finishes: it teaches the cache the pair's resolution, the
        // way a crossing settle does, and wakes the engine.
        let scratch = tempfile::tempdir().unwrap();
        let at = scratch.path().join("wt");
        git(
            repo.path(),
            &[
                "worktree",
                "add",
                "-q",
                "--detach",
                at.to_str().unwrap(),
                "main",
            ],
        );
        git(repo.path(), &["config", "rerere.enabled", "true"]);
        let _ = tugcore::git_command()
            .arg("-C")
            .arg(&at)
            .args(["merge", "--no-edit", "tugarc/demo"])
            .output();
        std::fs::write(at.join("f.txt"), "base\narc\n").unwrap();
        git(&at, &["add", "f.txt"]);
        git(&at, &["rerere"]);
        let _ = tugcore::git_command()
            .arg("-C")
            .arg(&at)
            .args(["merge", "--abort"])
            .output();
        git(
            repo.path(),
            &["worktree", "remove", "--force", at.to_str().unwrap()],
        );
        wake_on_settle();

        assert!(
            settles(|| repo.tip("tugarc/demo") != before).await,
            "the settle's wake retries the replay, which recalls the hunk"
        );
        assert_eq!(
            read(repo.path(), &["show", "tugarc/demo:f.txt"]),
            "base\narc"
        );
        assert!(
            settles(|| conflict_paths_for(&owner_key).is_empty()).await,
            "and the lane's conflict mark clears"
        );
        drop(gh_tx);
        cancel.cancel();
    }

    /// **The clean re-stamp.** The base moved under a finished, audited arc
    /// and nothing else did: the engine replays it, the fit verifies green,
    /// and a fresh mark stands on the live tips — the arc is still done, and
    /// no stage was seated.
    #[tokio::test]
    #[serial]
    async fn a_clean_green_base_move_restamps_the_audit() {
        let repo = repo_with_a_stale_audit("true", false);
        let before = repo.tip("tugarc/demo");
        let (state, arc, fact) = run_quiet(&repo).await;
        assert_ne!(repo.tip("tugarc/demo"), before, "the arc was replayed");
        assert!(arc.audit_current, "the re-stamp stands on the live tips");
        assert!(arc.done && !arc.reaudit, "no turn was spent");
        assert!(state.lock()["tugarc/demo"].quiet_failed_tip.is_none());
        // The board keeps the run as it ended: one surface, green.
        let last = fact.and_then(|f| f.last).expect("the ended run is kept");
        assert!(!last.run_id.is_empty());
        assert_eq!(last.state, "verified");
        assert_eq!(last.surfaces.len(), 1);
        assert_eq!(last.surfaces[0].name, "all");
        assert_eq!(last.surfaces[0].status, "pass");
        // The seated card's row: started, then verified, one run.
        let rows = ink_log();
        let states: Vec<_> = rows
            .iter()
            .map(|r| row_line(&r.output, "state").unwrap_or_default())
            .collect();
        assert_eq!(states, ["running", "verified"], "{rows:?}");
        assert!(rows.iter().all(|r| r.session == "sess-1"));
        assert!(
            rows.iter()
                .all(|r| row_line(&r.output, "run") == Some(last.run_id.as_str()))
        );
        assert!(
            rows[1].output.contains("surface: all\tpass\t"),
            "{}",
            rows[1].output
        );
    }

    /// **The conflicted re-seat.** A replay that cannot merge moves nothing
    /// and is never made into a turn of its own: the arc goes back to its
    /// audit stage on the Wheel, and the failure is latched at this base tip.
    #[tokio::test]
    #[serial]
    async fn a_conflicted_base_move_seats_the_audit() {
        let repo = repo_with_a_stale_audit("true", true);
        let before = repo.tip("tugarc/demo");
        let (state, arc, _) = run_quiet(&repo).await;
        assert_eq!(repo.tip("tugarc/demo"), before, "a conflict moves nothing");
        assert!(!arc.done && arc.reaudit, "the audit is seated");
        assert!(!arc.audit_current);
        let st = &state.lock()["tugarc/demo"];
        assert!(st.conflict.is_some(), "the lane keeps its conflict mark");
        assert_eq!(st.quiet_failed_tip, Some(repo.tip("main")));
    }

    /// **The red re-seat.** The replay was clean but the fit is red: the
    /// audit is not re-stamped over a red check, and the arc goes back to its
    /// audit stage to answer it.
    #[tokio::test]
    #[serial]
    async fn a_red_fit_after_a_clean_replay_seats_the_audit() {
        let repo = repo_with_a_stale_audit("false", false);
        let before = repo.tip("tugarc/demo");
        let (state, arc, fact) = run_quiet(&repo).await;
        assert_ne!(
            repo.tip("tugarc/demo"),
            before,
            "the replay itself was clean"
        );
        assert!(!arc.done && arc.reaudit, "the audit is seated");
        assert!(!arc.audit_current, "nothing re-stamped a red fit");
        assert_eq!(
            state.lock()["tugarc/demo"].quiet_failed_tip,
            Some(repo.tip("main"))
        );
        let fact = fact.expect("the board keeps the seat");
        let last = fact.last.expect("the ended run is kept");
        assert_eq!(last.state, "seated");
        // The row closed as seated before the audit stage was handed it.
        let rows = ink_log();
        let states: Vec<_> = rows
            .iter()
            .map(|r| row_line(&r.output, "state").unwrap_or_default())
            .collect();
        assert_eq!(states, ["running", "seated"], "{rows:?}");
        assert!(
            row_line(&rows[1].output, "why")
                .is_some_and(|w| w.starts_with("the fit did not verify")),
            "{}",
            rows[1].output
        );
        assert!(!rows[1].audit_seated, "the row is written before the seat");
        assert!(
            rows.iter()
                .all(|r| row_line(&r.output, "run") == Some(last.run_id.as_str()))
        );
        assert_eq!(last.why, fact.seated_why);
        assert_eq!(last.surfaces.len(), 1);
        assert_eq!(last.surfaces[0].name, "all");
        assert_eq!(last.surfaces[0].status, "fail");
        assert!(
            last.surfaces[0]
                .message
                .as_deref()
                .is_some_and(|m| m.contains("exit")),
            "{:?}",
            last.surfaces[0]
        );
    }

    /// **A wait turns into the run on the same run id.** The base moved
    /// under a finished arc whose worktree is dirty: the wake publishes a
    /// wait saying so, and once the tree is clean the next wake starts the
    /// re-audit under the wait's own run id — which only the run adopting
    /// the wait can give it, so the wake did not clear the wait first.
    #[tokio::test]
    #[serial]
    async fn a_dirty_tree_waits_and_the_clean_wake_runs_under_the_waits_id() {
        let repo = repo_with_a_stale_audit("true", false);
        INK_LOG.lock().clear();
        let scratch = repo.worktree().join("scratch.txt");
        std::fs::write(&scratch, "not committed\n").unwrap();
        let cancel = CancellationToken::new();
        let registry = Arc::new(WorkspaceRegistry::new_for_test());
        register(&registry, repo.path(), &cancel);
        let bump = Arc::new(Notify::new());
        let ctx = bound_context(&registry, &bump, &cancel, &repo);
        let board = Arc::new(ConflictBoard::default());
        let state: Arc<Mutex<HashMap<String, ArcState>>> = Arc::new(Mutex::new(HashMap::new()));

        evaluate_workspace(&ctx, &board, &state, repo.path().to_path_buf()).await;
        let wait = board
            .quiet_fact("tugarc/demo")
            .and_then(|fact| fact.waiting)
            .expect("the dirty tree is published as a wait");
        assert!(wait.why.contains("worktree"), "{}", wait.why);
        assert!(!board.restamping("tugarc/demo"), "nothing runs over dirt");
        let rows = ink_log();
        assert_eq!(rows.len(), 1, "the wait is written from the wake: {rows:?}");
        assert_eq!(row_line(&rows[0].output, "state"), Some("waiting"));
        assert_eq!(rows[0].session, "sess-1");

        std::fs::remove_file(&scratch).unwrap();
        evaluate_workspace(&ctx, &board, &state, repo.path().to_path_buf()).await;
        assert!(
            settles(|| board
                .quiet_fact("tugarc/demo")
                .and_then(|fact| fact.last)
                .is_some())
            .await,
            "the clean wake runs the re-audit to its end"
        );
        let fact = board.quiet_fact("tugarc/demo").unwrap();
        assert!(fact.waiting.is_none());
        let last = fact.last.unwrap();
        assert_eq!(last.run_id, wait.run_id, "the run took the wait's run id");
        assert_eq!(last.state, "verified");
        // One story on one row: it waited, it ran, it verified.
        let rows = ink_log();
        let states: Vec<_> = rows
            .iter()
            .map(|r| row_line(&r.output, "state").unwrap_or_default())
            .collect();
        assert_eq!(states, ["waiting", "running", "verified"], "{rows:?}");
        assert!(
            rows.iter()
                .all(|r| row_line(&r.output, "run") == Some(wait.run_id.as_str()))
        );
        cancel.cancel();
    }

    /// **A card that binds after a red fit is told it.** The quiet path ran
    /// with no card to seat on, so nothing was written; the wake that finds a
    /// card bound writes the ended run's row as seated — its run id and its
    /// surface — before the audit stage is handed to that card.
    #[tokio::test]
    #[serial]
    async fn a_red_fit_with_no_card_is_written_when_a_card_binds() {
        let repo = repo_with_a_stale_audit("false", false);
        INK_LOG.lock().clear();
        let cancel = CancellationToken::new();
        let registry = Arc::new(WorkspaceRegistry::new_for_test());
        register(&registry, repo.path(), &cancel);
        let bump = Arc::new(Notify::new());
        let board = Arc::new(ConflictBoard::default());
        let state: Arc<Mutex<HashMap<String, ArcState>>> = Arc::new(Mutex::new(HashMap::new()));

        let unbound = test_context(&registry, &bump, &cancel);
        let mut job = quiet_job(&repo);
        if let Some(quiet) = job.quiet.as_mut() {
            quiet.seat = None;
        }
        spawn_replay(&unbound, &board, &state, job);
        assert!(
            settles(|| !board.restamping("tugarc/demo")).await,
            "the quiet path runs to its end"
        );
        assert!(ink_log().is_empty(), "no card, no row: {:?}", ink_log());
        let last = board
            .quiet_fact("tugarc/demo")
            .and_then(|fact| fact.last)
            .expect("the ended run is kept");
        assert_eq!(last.state, "seated");

        let bound = bound_context(&registry, &bump, &cancel, &repo);
        evaluate_workspace(&bound, &board, &state, repo.path().to_path_buf()).await;
        let rows = ink_log();
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].session, "sess-1");
        assert_eq!(row_line(&rows[0].output, "state"), Some("seated"));
        assert_eq!(row_line(&rows[0].output, "run"), Some(last.run_id.as_str()));
        assert!(
            rows[0].output.contains("surface: all\tfail\t"),
            "{}",
            rows[0].output
        );
        assert!(!rows[0].audit_seated, "the row is written before the seat");
        let record = tugarc_core::read_arc(&Paths::from_env(), repo.path(), "demo").unwrap();
        assert_eq!(
            record.resume,
            Some(tugarc_core::ArcStage::Audit),
            "the bind seated it"
        );

        // A second wake finds the row written and writes no second one.
        evaluate_workspace(&bound, &board, &state, repo.path().to_path_buf()).await;
        assert_eq!(ink_log().len(), 1);
        cancel.cancel();
    }

    /// **A hung verify ends at its horizon.** The quiet path's check never
    /// exits. While it runs the board publishes the job — when it began and
    /// when its horizon falls — and a Re-audit press inside the horizon is
    /// refused with that fact; at the horizon the check is killed, the job
    /// ends as a seat, and the reason it seated is what the wire carries.
    #[tokio::test]
    #[serial]
    async fn a_hung_verify_ends_at_its_horizon_and_seats_with_its_reason() {
        let repo = repo_with_a_stale_audit("sleep 30 & wait", false);
        let cancel = CancellationToken::new();
        let registry = Arc::new(WorkspaceRegistry::new_for_test());
        let bump = Arc::new(Notify::new());
        let ctx = test_context(&registry, &bump, &cancel);
        let board = Arc::new(ConflictBoard::default());
        let state: Arc<Mutex<HashMap<String, ArcState>>> = Arc::new(Mutex::new(HashMap::new()));

        spawn_replay(
            &ctx,
            &board,
            &state,
            ReplayJob {
                quiet: Some(QuietJob {
                    seat: Some("sess-1".to_string()),
                    base_tip: repo.tip("main"),
                    horizon: Duration::from_millis(1500),
                    trigger: ReauditTrigger::default(),
                }),
                ..demo_job(&repo)
            },
        );
        let running = board
            .quiet_fact("tugarc/demo")
            .and_then(|fact| fact.running)
            .expect("the job is published while it runs");
        assert_eq!(
            board.release_restamp("tugarc/demo", SystemTime::now()),
            RestampRelease::Running {
                since: running.since,
                deadline: running.deadline,
            },
            "a press inside the horizon refuses with the running fact"
        );

        assert!(
            settles(|| !board.restamping("tugarc/demo")).await,
            "the horizon ends the job"
        );
        // The seat's reason is what says the deadline, not the check, ended
        // it: a check that ran to its own end would not read as timed out.
        let why = board
            .quiet_fact("tugarc/demo")
            .and_then(|fact| fact.seated_why)
            .expect("a seat carries its reason");
        assert!(
            why.contains("timed out") && why.contains("sleep 30 & wait"),
            "{why}"
        );
        assert_eq!(
            state.lock()["tugarc/demo"].quiet_failed_tip,
            Some(repo.tip("main")),
            "the seat is latched at this base tip"
        );
        let record = tugarc_core::read_arc(&Paths::from_env(), repo.path(), "demo").unwrap();
        assert_eq!(
            record.resume,
            Some(tugarc_core::ArcStage::Audit),
            "the audit is seated"
        );
        cancel.cancel();
    }

    /// The in-flight lock, at the seam a second wake actually hits: a replay
    /// already running owns the arc, and the next signal's `spawn_replay`
    /// returns without starting a second one.
    #[tokio::test]
    #[serial]
    async fn a_second_wake_mid_replay_does_not_start_a_second_replay() {
        let repo = repo_with_a_arc();
        repo.advance_base("B\n");
        let before = repo.tip("tugarc/demo");

        let cancel = CancellationToken::new();
        let registry = Arc::new(WorkspaceRegistry::new_for_test());
        let bump = Arc::new(Notify::new());
        let ctx = test_context(&registry, &bump, &cancel);
        let board = Arc::new(ConflictBoard::default());
        let state: Arc<Mutex<HashMap<String, ArcState>>> = Arc::new(Mutex::new(HashMap::new()));
        state.lock().insert(
            "tugarc/demo".to_string(),
            ArcState {
                in_flight: true,
                ..ArcState::default()
            },
        );

        spawn_replay(&ctx, &board, &state, demo_job(&repo));
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            repo.tip("tugarc/demo"),
            before,
            "the held lock refused the second replay"
        );

        // Release the lock and the very same call moves the branch, so the
        // refusal above was the lock and not a broken fixture.
        state.lock().get_mut("tugarc/demo").unwrap().in_flight = false;
        spawn_replay(&ctx, &board, &state, demo_job(&repo));
        assert!(settles(|| repo.tip("tugarc/demo") != before).await);
        cancel.cancel();
    }
}
