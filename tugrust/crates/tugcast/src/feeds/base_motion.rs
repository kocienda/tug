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
//! ## The decision is separate from the wiring
//!
//! [`decide_for_arc`] is pure — the gate and the choice of action expressed
//! over plain inputs, with no channels, no git, and no clock — following
//! `observer_wake.rs`. Every case in the gate is then a table test rather than a
//! server that has to be stood up and driven into the right state.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

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
    /// A replay for this arc is already running.
    pub in_flight: bool,
    /// The last replay attempt at the current base tip stopped on a conflict.
    pub conflicted: bool,
    /// A turn has already been injected for this arc at the current base tip.
    pub notified: bool,
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
    /// The replay conflicts and this session can be asked to resolve it.
    InjectConflict(String),
    /// Record the state for the lane marks; there is nobody to tell and nothing
    /// safe to do.
    MarkOnly,
}

/// The gate ([P02]) and the choice of action, with no IO.
///
/// Order is meaning, not convenience: the flag comes first because a repository
/// that has opted out gets no further thought; `Current` comes before the safety
/// checks because an arc with nothing to do is not "deferred over dirt"; and the
/// mid-turn check comes before the conflict branch so a busy session is parked
/// rather than interrupted, to be retried when its turn ends.
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
        if inputs.notified {
            return Decision::MarkOnly;
        }
        return match &inputs.session {
            Some(session) => Decision::InjectConflict(session.id.clone()),
            None => Decision::MarkOnly,
        };
    }

    match (inputs.mid_plan, &inputs.session) {
        (true, Some(session)) => Decision::ReplayThenNotify(session.id.clone()),
        _ => Decision::Replay,
    }
}

// MARK: - Per-arc state

/// What the engine remembers about an arc between wakes.
#[derive(Debug, Default, Clone)]
struct ArcState {
    in_flight: bool,
    /// The paths the last conflicted attempt stopped on, and the base tip it
    /// stopped against. Cleared when the arc becomes current.
    conflict: Option<ConflictRecord>,
    /// The base tip a turn has already been injected for.
    notified_tip: Option<String>,
}

#[derive(Debug, Clone)]
struct ConflictRecord {
    base_head: String,
    round: String,
    round_subject: String,
    paths: Vec<String>,
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

/// Everything the conflict message says, so composing it needs no IO.
pub struct ConflictMessage<'a> {
    pub arc: &'a str,
    pub base_branch: &'a str,
    pub base_head: &'a str,
    pub round: &'a str,
    pub round_subject: &'a str,
    pub paths: &'a [String],
    /// `tugarc_core::resolve_intent` — the arc's maintained draft and round
    /// subjects, so the agent knows what the work it is rescuing is for.
    pub intent: &'a str,
    pub worktree_abs: &'a str,
}

/// The turn a conflicted replay becomes.
///
/// It carries what moved, where the replay stopped, what this arc is trying to
/// do, and the exact sequence that finishes the job — including the
/// bookkeeping verb, without which the moved rounds go unrecorded, and the
/// verb that checks the fit of what the replay produced. It also
/// says what to do when the conflict is a real design collision rather than a
/// mechanical one, because "resolve this" is not always the right answer.
pub fn compose_conflict_message(m: &ConflictMessage<'_>) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "The base branch {} moved to {} under arc \"{}\",\n\
         and replaying its rounds stopped at {} \"{}\" with conflicts in:\n",
        m.base_branch,
        short(m.base_head),
        m.arc,
        short(m.round),
        m.round_subject,
    ));
    for path in m.paths {
        out.push_str(&format!("  {}\n", path));
    }
    if !m.intent.trim().is_empty() {
        out.push_str(&format!("\nThis arc's intent:\n{}\n", m.intent.trim()));
    }
    out.push_str(&format!(
        "\nResolve it on the arc's own worktree:\n  \
         git -C {} rebase {}\n\
         Fix each conflict with both sides in view, then `git rebase --continue`. When the\n\
         rebase is done, run `tugtool arc replay {} --json` to record the moved rounds.\n",
        m.worktree_abs, m.base_branch, m.arc,
    ));
    out.push_str(&format!(
        "After the replay records, verify the fit:\n  \
         tugtool arc verify {}\n\
         It resolves every path the arc would land to a declared surface and runs what\n\
         those surfaces declare. A refusal names paths no surface claims — declare one for\n\
         them in .tugtool/config.toml rather than working around it. Red is ordinary work:\n\
         fix it in the worktree and re-run.\n",
        m.arc,
    ));
    out.push_str(
        "If the conflict reveals a real design collision instead, `git rebase --abort` and say so.\n",
    );
    out
}

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
pub(crate) fn user_message_payload(session: &str, text: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "tug_session_id": session,
        "type": "user_message",
        "content": [{ "type": "text", "text": text }],
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
pub(crate) fn notice_payload(session: &str, origin: &str, text: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "tug_session_id": session,
        "type": "tug_notice",
        "origin": origin,
        "text": text,
    }))
    .expect("a json object of strings serializes")
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
}

impl ConflictBoard {
    fn set(&self, owner_key: &str, paths: Vec<String>) {
        let mut board = self.by_arc.lock().expect("conflict board mutex");
        if paths.is_empty() {
            board.remove(owner_key);
        } else {
            board.insert(owner_key.to_string(), paths);
        }
    }
}

static BOARD: OnceLock<Arc<ConflictBoard>> = OnceLock::new();

/// The conflicting paths of the last replay attempt on this arc, empty when
/// the last attempt was clean or no engine is running.
pub fn conflict_paths_for(owner_key: &str) -> Vec<String> {
    BOARD
        .get()
        .and_then(|board| {
            board
                .by_arc
                .lock()
                .expect("conflict board mutex")
                .get(owner_key)
                .cloned()
        })
        .unwrap_or_default()
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
    /// Startup, or a periodic level read.
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
        Wake::TurnComplete | Wake::All => open.into_iter().map(|(dir, _)| dir).collect(),
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
    let Ok((autoreplay, arcs)) = tokio::task::spawn_blocking(move || {
        let autoreplay = read_autoreplay(&dir);
        let arcs: Vec<ArcReading> = tugarc_core::arc_detail_entries_in(&dir)
            .into_iter()
            .map(|detail| ArcReading {
                base_tip: rev_parse(&dir, &detail.base),
                join_journal: tugarc_core::join_in_flight(&dir, &detail.name),
                arc_autoreplay: read_arc_autoreplay(&dir, &detail.name),
                detail,
            })
            .collect();
        (autoreplay, arcs)
    })
    .await
    else {
        return;
    };

    for reading in arcs {
        let detail = &reading.detail;
        let owner_key = detail.owner_key.clone();
        let session = bound_session(&ctx.supervisor_ledger, &bound_by_arc, &owner_key).await;

        let (in_flight, conflicted, notified) = {
            let map = state.lock().expect("base-motion state mutex");
            match map.get(&owner_key) {
                Some(st) => (
                    st.in_flight,
                    st.conflict.is_some(),
                    // The latch is keyed on the tip, not on a bare flag: a base
                    // that moves again is a new divergence event and deserves
                    // to be spoken about again.
                    st.notified_tip.as_deref() == Some(reading.base_tip.as_str()),
                ),
                None => (false, false, false),
            }
        };

        let inputs = ArcInputs {
            autoreplay,
            arc_autoreplay: reading.arc_autoreplay,
            base_ahead: detail.base_ahead,
            worktree_dirty: detail.worktree_dirty,
            join_journal: reading.join_journal,
            mid_plan: detail.stage == "implementing",
            session,
            in_flight,
            conflicted,
            notified,
        };

        let decision = decide_for_arc(&inputs);
        match &decision {
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
                    let map = state.lock().expect("base-motion state mutex");
                    map.get(&owner_key)
                        .and_then(|st| st.conflict.as_ref().map(describe_conflict))
                };
                debug!(
                    arc = %detail.name,
                    conflict = conflict.unwrap_or_default(),
                    "base-motion: conflicted, marked only",
                );
            }
            Decision::Replay | Decision::ReplayThenNotify(_) | Decision::InjectConflict(_) => {
                // A plain `Replay` still carries the session it *would* tell,
                // because a replay that turns out to conflict must become a
                // turn now — the alternative is silence until the next wake,
                // and the next wake may not come.
                let target = match &decision {
                    Decision::ReplayThenNotify(id) | Decision::InjectConflict(id) => {
                        Some(id.clone())
                    }
                    _ => inputs.session.as_ref().map(|s| s.id.clone()),
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
                        worktree_abs: detail.worktree_abs.clone(),
                        branch: detail.branch.clone(),
                        target,
                        notify_on_clean: matches!(decision, Decision::ReplayThenNotify(_)),
                    },
                );
            }
        }
    }
}

/// One arc as a wake reads it: the shared composition, plus the two facts the
/// decision needs that it does not carry.
struct ArcReading {
    detail: tugarc_core::ArcDetail,
    base_tip: String,
    join_journal: bool,
    arc_autoreplay: bool,
}

/// Everything one replay needs, gathered on the async side so the spawned work
/// borrows nothing.
struct ReplayJob {
    repo_dir: PathBuf,
    name: String,
    owner_key: String,
    base_branch: String,
    worktree_abs: String,
    branch: String,
    /// The session an outcome would be told about, when there is one.
    target: Option<String>,
    /// Whether a *clean* replay should tell it ([P11]). A conflict always tells
    /// it, whatever this says.
    notify_on_clean: bool,
}

/// Take the in-flight lock and run one replay on the blocking pool.
///
/// The lock is per arc and is taken *before* the spawn, so a second signal
/// arriving while a replay runs finds `in_flight` set and decides `Skip`.
fn spawn_replay(
    ctx: &BaseMotionContext,
    board: &Arc<ConflictBoard>,
    state: &Arc<Mutex<HashMap<String, ArcState>>>,
    job: ReplayJob,
) {
    {
        let mut map = state.lock().expect("base-motion state mutex");
        let entry = map.entry(job.owner_key.clone()).or_default();
        if entry.in_flight {
            return;
        }
        entry.in_flight = true;
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
            tokio::task::spawn_blocking(move || tugarc_core::replay_onto(&repo, &name)).await
        };

        // What to say, decided under the lock; saying it happens after, because
        // the channel send is async and the state mutex is not.
        let mut speak: Option<Speak> = None;
        let refresh = {
            let mut map = state.lock().expect("base-motion state mutex");
            let entry = map.entry(job.owner_key.clone()).or_default();
            entry.in_flight = false;

            match outcome {
                Ok(Ok(tugarc_core::ReplayOutcome::Replayed {
                    base_head, mapping, ..
                })) => {
                    info!(arc = %arc, base = %short(&base_head), "base-motion: replayed");
                    entry.conflict = None;
                    entry.notified_tip = None;
                    board.set(&job.owner_key, Vec::new());
                    if job.notify_on_clean && job.target.is_some() {
                        entry.notified_tip = Some(base_head.clone());
                        speak = Some(Speak::Notice {
                            base_head,
                            // The oldest round, as it stood before the move. Its
                            // merge-base with the base branch is the base tip
                            // the arc used to sit on, which is what makes the
                            // delta below exactly what the base brought in.
                            oldest_round_before: mapping.first().map(|(old, _)| old.clone()),
                        });
                    }
                    true
                }
                Ok(Ok(tugarc_core::ReplayOutcome::Recorded { .. })) => {
                    entry.conflict = None;
                    entry.notified_tip = None;
                    board.set(&job.owner_key, Vec::new());
                    true
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
                    // One injection per divergence event: a base tip already
                    // spoken about is not spoken about again.
                    let already = entry.notified_tip.as_deref() == Some(base_head.as_str());
                    if !already && job.target.is_some() {
                        entry.notified_tip = Some(base_head.clone());
                        speak = Some(Speak::Conflict);
                    }
                    entry.conflict = Some(ConflictRecord {
                        base_head,
                        round,
                        round_subject,
                        paths,
                    });
                    true
                }
                Ok(Ok(tugarc_core::ReplayOutcome::Current)) => {
                    entry.conflict = None;
                    entry.notified_tip = None;
                    board.set(&job.owner_key, Vec::new());
                    false
                }
                Ok(Ok(tugarc_core::ReplayOutcome::Deferred { reason, detail })) => {
                    debug!(arc = %arc, reason = %reason, detail = %detail, "base-motion: deferred");
                    false
                }
                Ok(Err(err)) => {
                    warn!(arc = %arc, error = %err, "base-motion: replay failed");
                    false
                }
                Err(err) => {
                    warn!(arc = %arc, error = %err, "base-motion: replay task died");
                    false
                }
            }
        };

        if let (Some(speak), Some(session)) = (speak, job.target.as_deref()) {
            let text = compose_for(&job, &speak, &state);
            if !inject.send(session, &text).await {
                // Nowhere to send after all — take the latch back off so a
                // later wake can try again rather than staying silent forever.
                let mut map = state.lock().expect("base-motion state mutex");
                if let Some(entry) = map.get_mut(&job.owner_key) {
                    entry.notified_tip = None;
                }
            }
        }

        if refresh {
            bump.notify_one();
        }
    });
}

/// Which message an outcome calls for.
enum Speak {
    /// The replay stopped on a conflict; the record holds where.
    Conflict,
    /// The replay was clean and a plan run is live, so its agent is told its
    /// working tree moved.
    Notice {
        base_head: String,
        oldest_round_before: Option<String>,
    },
}

/// Compose the message this outcome calls for.
fn compose_for(
    job: &ReplayJob,
    speak: &Speak,
    state: &Arc<Mutex<HashMap<String, ArcState>>>,
) -> String {
    match speak {
        Speak::Conflict => {
            let record = {
                let map = state.lock().expect("base-motion state mutex");
                map.get(&job.owner_key).and_then(|st| st.conflict.clone())
            };
            let Some(record) = record else {
                // Only reachable if the record were cleared between deciding to
                // speak and composing, which the lock ordering prevents.
                return String::new();
            };
            let intent = tugarc_core::resolve_intent(&job.repo_dir, &job.base_branch, &job.branch);
            compose_conflict_message(&ConflictMessage {
                arc: &job.name,
                base_branch: &job.base_branch,
                base_head: &record.base_head,
                round: &record.round,
                round_subject: &record.round_subject,
                paths: &record.paths,
                intent: &intent,
                worktree_abs: &job.worktree_abs,
            })
        }
        Speak::Notice {
            base_head,
            oldest_round_before,
        } => {
            let paths = base_delta_paths(
                &job.repo_dir,
                &job.base_branch,
                oldest_round_before.as_deref(),
            );
            compose_replay_notice(&job.name, &job.base_branch, base_head, &paths)
        }
    }
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
    let out = tugcore::git_command()
        .arg("-C")
        .arg(repo)
        .args(["diff", "--name-only", &old_base, base_branch])
        .output();
    match out {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
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
/// owns it.
struct InjectHandles {
    code_input_tx: Option<mpsc::Sender<Frame>>,
    code_output: Option<SessionScopedFeed>,
}

impl InjectHandles {
    async fn send(&self, session: &str, text: &str) -> bool {
        let Some(input_tx) = self.code_input_tx.as_ref() else {
            return false;
        };
        if let Some(output) = self.code_output.as_ref() {
            output.publish_tagged(Frame::new(
                FeedId::CODE_OUTPUT,
                notice_payload(session, NOTICE_ORIGIN, text),
            ));
        }
        input_tx
            .send(Frame::new(
                FeedId::CODE_INPUT,
                user_message_payload(session, &submission_text(text)),
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
    let mut map = state.lock().expect("base-motion state mutex");
    if let Some(entry) = map.get_mut(owner_key) {
        entry.conflict = None;
        entry.notified_tip = None;
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
            notified: false,
        }
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
    fn a_conflicted_arc_with_an_idle_session_becomes_a_turn() {
        let inputs = ArcInputs {
            conflicted: true,
            session: Some(idle("sess-1")),
            ..behind()
        };
        assert_eq!(
            decide_for_arc(&inputs),
            Decision::InjectConflict("sess-1".to_string())
        );
    }

    #[test]
    fn a_conflict_already_told_about_is_not_told_again() {
        let inputs = ArcInputs {
            conflicted: true,
            notified: true,
            session: Some(idle("sess-1")),
            ..behind()
        };
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

    fn conflict_text() -> String {
        compose_conflict_message(&ConflictMessage {
            arc: "demo",
            base_branch: "main",
            base_head: "abcdef0123456789",
            round: "0123456789abcdef",
            round_subject: "teach the lane to say what moved",
            paths: &["src/a.rs".to_string(), "src/b.rs".to_string()],
            intent: "Land the divergence marks.\n\nRound subjects:\nadd the marks",
            worktree_abs: "/repo/.tug/worktrees/demo",
        })
    }

    #[test]
    fn the_conflict_turn_says_where_it_stopped_and_how_to_finish() {
        let text = conflict_text();
        assert!(text.contains("teach the lane to say what moved"));
        assert!(text.contains("src/a.rs"), "every conflicting path is named");
        assert!(text.contains("src/b.rs"));
        assert!(
            text.contains("git -C /repo/.tug/worktrees/demo rebase main"),
            "the rebase is worktree-absolute, not relative to wherever the agent stands",
        );
        assert!(
            text.contains("tugtool arc replay demo"),
            "the bookkeeping verb finishes the contract",
        );
        assert!(
            text.contains("git rebase --abort"),
            "a real design collision is an outcome the turn allows for",
        );
        assert!(
            text.contains("Land the divergence marks."),
            "the intent rides along"
        );
        assert!(
            text.contains("tugtool arc verify demo"),
            "the turn names the verb, which knows what this project is made of",
        );
        assert!(
            !text.contains("{base}") && !text.contains("{head}"),
            "nothing is left for the agent to substitute by hand",
        );
        assert!(
            text.contains("no surface claims"),
            "a refusal is fixed by declaring a surface, and the turn says so",
        );
        assert!(
            text.contains("Red is ordinary work"),
            "a red verify is ordinary work, and the turn says so",
        );
        let replay_at = text.find("tugtool arc replay demo").expect("replay named");
        let verify_at = text.find("verify the fit").expect("verify named");
        assert!(
            replay_at < verify_at,
            "the fit is checked over what the replay recorded, so it comes after",
        );
    }

    /// The verb is named whatever the project declares, because the verb is
    /// what reads the declaration — a project with no surfaces gets the
    /// declared-none report from the verb itself rather than a turn that
    /// quietly said nothing about the fit at all.
    #[test]
    fn a_conflict_turn_names_the_verb_whatever_the_project_declares() {
        let text = compose_conflict_message(&ConflictMessage {
            arc: "demo",
            base_branch: "main",
            base_head: "abcdef0123456789",
            round: "0123456789abcdef",
            round_subject: "s",
            paths: &["f.txt".to_string()],
            intent: "   ",
            worktree_abs: "/repo/wt",
        });
        assert!(text.contains("tugtool arc verify demo"));
        assert!(
            text.contains("tugtool arc replay demo"),
            "the bookkeeping verb stands with or without a declaration",
        );
        assert!(text.contains("git rebase --abort"));
    }

    #[test]
    fn a_conflict_turn_without_an_intent_skips_the_section() {
        let text = compose_conflict_message(&ConflictMessage {
            arc: "demo",
            base_branch: "main",
            base_head: "abcdef0123456789",
            round: "0123456789abcdef",
            round_subject: "s",
            paths: &["f.txt".to_string()],
            intent: "   ",
            worktree_abs: "/repo/wt",
        });
        assert!(!text.contains("This arc's intent"));
        assert!(text.contains("tugtool arc replay demo"));
    }

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
            serde_json::from_slice(&notice_payload("s1", "base-motion", "hello")).unwrap();
        assert!(
            opener.get("standalone").is_none(),
            "an opener carries no flag at all — a turn is coming behind it: {opener}"
        );
    }

    // MARK: - Injection

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

        let text = conflict_text();
        assert!(handles.send("sess-1", &text).await);

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
        assert!(!handles.send("sess-1", "anything").await);
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

    fn git(dir: &Path, args: &[&str]) {
        let out = tugcore::git_command()
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn read(dir: &Path, args: &[&str]) -> String {
        let out = tugcore::git_command()
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
        git(repo, &["init", "-b", "main"]);
        git(repo, &["config", "user.name", "t"]);
        git(repo, &["config", "user.email", "t@t"]);
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

    /// The same repository, but with the arc's round and the base's commit
    /// both rewriting `f.txt` — so replaying the round onto the moved base
    /// cannot merge.
    fn repo_with_a_conflicting_arc() -> Repo {
        let repo = repo_with_a_arc();
        let wt = repo.worktree();
        std::fs::write(wt.join("f.txt"), "arc rewrote this\n").unwrap();
        git(&wt, &["add", "-A"]);
        git(&wt, &["commit", "-q", "-m", "rewrite f"]);
        repo.advance_base("base rewrote this\n");
        repo
    }

    /// The fixture arc's replay job, with nobody to tell about the outcome.
    fn demo_job(repo: &Repo) -> ReplayJob {
        ReplayJob {
            repo_dir: repo.path().to_path_buf(),
            name: "demo".to_string(),
            owner_key: "tugarc/demo".to_string(),
            base_branch: "main".to_string(),
            worktree_abs: repo.worktree().to_string_lossy().into_owned(),
            branch: "tugarc/demo".to_string(),
            target: None,
            notify_on_clean: false,
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
        let root = tugtool_core::find_repo_root_from(repo.path()).unwrap();
        let log = std::fs::read_to_string(
            tugtool_core::project_state_dir(&root).join(tugtool_core::paths::ARC_LOG),
        )
        .unwrap_or_default();
        assert!(log.contains("replayed"), "the arc log names the replay");

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

    /// [P05]: a replay that cannot merge becomes an ordinary turn in the arc's
    /// bound session — and exactly one, however many wakes arrive at the same
    /// base tip. The turn carries the round it stopped on and the paths.
    #[tokio::test]
    #[serial]
    async fn a_conflicted_replay_becomes_one_turn_per_divergence_event() {
        let repo = repo_with_a_conflicting_arc();
        let before = repo.tip("tugarc/demo");

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
        let job = || ReplayJob {
            target: Some("sess-1".to_string()),
            ..demo_job(&repo)
        };

        spawn_replay(&ctx, &board, &state, job());
        let first = tokio::time::timeout(Duration::from_secs(5), in_rx.recv())
            .await
            .expect("an injection within the timeout")
            .expect("the channel is open");
        assert_eq!(
            repo.tip("tugarc/demo"),
            before,
            "a conflicted replay moves nothing",
        );

        let body: serde_json::Value = serde_json::from_slice(&first.payload).unwrap();
        let text = body["content"][0]["text"].as_str().unwrap().to_string();
        assert!(
            text.contains("rewrite f"),
            "the turn names the stopping round"
        );
        assert!(
            text.contains("f.txt"),
            "the turn names the conflicting path"
        );
        assert!(text.contains("tugtool arc replay demo"));

        // The opener rode out with it — the turn is not invisible.
        let opener = out_rx.try_recv().expect("an opener");
        let opener: serde_json::Value = serde_json::from_slice(&opener.payload).unwrap();
        assert_eq!(opener["type"], "tug_notice");
        // The same words, and only the submission wears the origin marker:
        // the row has an origin label of its own, and the submission has
        // nowhere else to say where it came from.
        assert_eq!(
            format!("[base-motion replay] {}", opener["text"].as_str().unwrap()),
            text
        );

        // A second wake at the same base tip says nothing more.
        spawn_replay(&ctx, &board, &state, job());
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(
            in_rx.try_recv().is_err(),
            "one injection per divergence event, not one per wake",
        );

        // The base moving is a new divergence event, and reopens the question.
        repo.advance_base("base rewrote this again\n");
        spawn_replay(&ctx, &board, &state, job());
        assert!(
            tokio::time::timeout(Duration::from_secs(5), in_rx.recv())
                .await
                .is_ok(),
            "a base that moved again is spoken about again",
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
        state.lock().unwrap().insert(
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
        state
            .lock()
            .unwrap()
            .get_mut("tugarc/demo")
            .unwrap()
            .in_flight = false;
        spawn_replay(&ctx, &board, &state, demo_job(&repo));
        assert!(settles(|| repo.tip("tugarc/demo") != before).await);
        cancel.cancel();
    }
}
