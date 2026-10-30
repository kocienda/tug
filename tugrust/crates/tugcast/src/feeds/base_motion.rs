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

/// The quiet re-stamp's state on one arc, as the wire reads it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QuietFact {
    /// The job running now.
    pub running: Option<RestampRun>,
    /// Why the last quiet job could not re-stamp and handed the arc to its
    /// audit stage. Kept while the arc reads `audit-stale`.
    pub seated_why: Option<String>,
}

/// One running quiet job: when it began, and the horizon past which nothing
/// it is waiting on is worth waiting for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestampRun {
    pub since: SystemTime,
    pub deadline: SystemTime,
    generation: u64,
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
    /// job's generation — or `None` when a quiet job already holds the arc.
    fn begin_restamp(&self, owner_key: &str, horizon: Duration) -> Option<u64> {
        let mut quiet = self.quiet.lock();
        let fact = quiet.entry(owner_key.to_string()).or_default();
        if fact.running.is_some() {
            return None;
        }
        let generation = self.generation.fetch_add(1, Ordering::Relaxed) + 1;
        let since = SystemTime::now();
        fact.running = Some(RestampRun {
            since,
            deadline: since + horizon,
            generation,
        });
        fact.seated_why = None;
        Some(generation)
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

    /// End the job `generation` started, recording why it seated the audit
    /// when it did. Answers false, and changes nothing, when a press already
    /// released that job.
    fn end_restamp(&self, owner_key: &str, generation: u64, seated_why: Option<String>) -> bool {
        let mut quiet = self.quiet.lock();
        let Some(fact) = quiet.get_mut(owner_key) else {
            return false;
        };
        if fact.running.as_ref().map(|run| run.generation) != Some(generation) {
            return false;
        }
        fact.running = None;
        fact.seated_why = seated_why;
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
            Some(run) if now < run.deadline => RestampRelease::Running {
                since: run.since,
                deadline: run.deadline,
            },
            Some(_) => {
                fact.running = None;
                fact.seated_why =
                    Some("the quiet re-stamp ran past its deadline and was released".to_string());
                RestampRelease::Released
            }
        }
    }

    /// Drop the seat reason of an arc that no longer reads `audit-stale`.
    fn forget_seated(&self, owner_key: &str) {
        let mut quiet = self.quiet.lock();
        if let Some(fact) = quiet.get_mut(owner_key) {
            fact.seated_why = None;
            if fact.running.is_none() {
                quiet.remove(owner_key);
            }
        }
    }

    fn quiet_fact(&self, owner_key: &str) -> Option<QuietFact> {
        self.quiet.lock().get(owner_key).cloned()
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
        .begin_restamp(owner_key, horizon)
        .expect("no quiet job already holds the arc")
}

/// End the job [`hold_restamp_for_test`] published.
#[cfg(test)]
pub(crate) fn end_restamp_for_test(owner_key: &str, generation: u64) {
    if let Some(board) = BOARD.get() {
        board.end_restamp(owner_key, generation, None);
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
    /// Startup, a lagged event stream, or a settled crossing: every open
    /// workspace, because nothing says which arc moved.
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
        match &decision {
            Decision::SeatAudit(session) => {
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
                let (notify, quiet) = match &decision {
                    Decision::ReplayThenNotify(id) => (Some(id.clone()), None),
                    Decision::Restamp(seat) => (
                        None,
                        Some(QuietJob {
                            seat: seat.clone(),
                            base_tip: reading.base_tip.clone(),
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
        Some(quiet) => match board.begin_restamp(&job.owner_key, quiet.horizon) {
            Some(generation) => Some((generation, Instant::now() + quiet.horizon)),
            None => return,
        },
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
    let inject = InjectHandles {
        code_input_tx: ctx.code_input_tx.clone(),
        code_output: ctx.code_output.clone(),
    };

    tokio::spawn(async move {
        let arc = job.name.clone();
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

        if let (Some(quiet), Some((generation, deadline))) = (job.quiet.as_ref(), quiet_run) {
            let held = QuietHold {
                board: &board,
                generation,
                deadline,
            };
            let (_, end, seated_why) = finish_quiet(&job, quiet, replay, stop_why, &held).await;
            // A job a press released ends nothing: the arc is no longer its.
            if board.end_restamp(&job.owner_key, generation, seated_why) {
                let mut map = state.lock();
                let entry = map.entry(job.owner_key.clone()).or_default();
                entry.quiet_failed_tip = (end == QuietEnd::Seat).then(|| quiet.base_tip.clone());
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
    held: &QuietHold<'_>,
) -> (bool, QuietEnd, Option<String>) {
    let (repo, name) = (job.repo_dir.clone(), job.name.clone());
    let deadline = held.deadline;
    let (verdict, verify_why) = match replay {
        QuietReplay::Clean => {
            let (repo, name) = (repo.clone(), name.clone());
            let report = tokio::task::spawn_blocking(move || {
                tugarc_core::surfaces::verify_by(&Paths::from_env(), &repo, &name, deadline)
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
    if !held.board.holds(&job.owner_key, held.generation) {
        info!(arc = %job.name, "base-motion: quiet job released mid-run, writing nothing");
        return (false, QuietEnd::Leave, None);
    }
    let wrote = match end {
        QuietEnd::Leave => return (false, end, None),
        QuietEnd::Restamp => {
            tokio::task::spawn_blocking(move || {
                tugarc_core::ops::restamp_audit(&Paths::from_env(), &repo, &name)
            })
            .await
        }
        QuietEnd::Seat => {
            if quiet.seat.is_none() {
                debug!(arc = %job.name, "base-motion: audit stale, waiting for a card");
                return (false, end, seated_why);
            }
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
/// generation it was minted, and the deadline its verify runs to.
struct QuietHold<'a> {
    board: &'a ConflictBoard,
    generation: u64,
    deadline: Instant,
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
        let first = board
            .begin_restamp("a", Duration::from_secs(60))
            .expect("the arc is free");
        assert_eq!(
            board.begin_restamp("a", Duration::from_secs(60)),
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
                .is_some_and(|why| why.contains("deadline"))
        );

        let second = board
            .begin_restamp("a", Duration::from_secs(60))
            .expect("a released arc is free again");
        assert!(
            !board.end_restamp("a", first, Some("stale".to_string())),
            "the released job ends nothing"
        );
        assert!(board.holds("a", second));
        assert!(board.end_restamp("a", second, None));
        assert!(!board.restamping("a"));
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
            }),
            ..demo_job(repo)
        }
    }

    /// Run one quiet-path job to its end, and read back the arc's record.
    async fn run_quiet(repo: &Repo) -> (Arc<Mutex<HashMap<String, ArcState>>>, ArcRecordView) {
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
        )
    }

    /// What the quiet-path tests read off the arc once the job ends.
    struct ArcRecordView {
        done: bool,
        reaudit: bool,
        audit_current: bool,
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
        let (state, arc) = run_quiet(&repo).await;
        assert_ne!(repo.tip("tugarc/demo"), before, "the arc was replayed");
        assert!(arc.audit_current, "the re-stamp stands on the live tips");
        assert!(arc.done && !arc.reaudit, "no turn was spent");
        assert!(state.lock()["tugarc/demo"].quiet_failed_tip.is_none());
    }

    /// **The conflicted re-seat.** A replay that cannot merge moves nothing
    /// and is never made into a turn of its own: the arc goes back to its
    /// audit stage on the Wheel, and the failure is latched at this base tip.
    #[tokio::test]
    #[serial]
    async fn a_conflicted_base_move_seats_the_audit() {
        let repo = repo_with_a_stale_audit("true", true);
        let before = repo.tip("tugarc/demo");
        let (state, arc) = run_quiet(&repo).await;
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
        let (state, arc) = run_quiet(&repo).await;
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
