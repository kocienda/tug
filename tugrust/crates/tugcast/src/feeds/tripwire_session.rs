//! A tripwire's session — a real `claude`, on a real worktree, with no card.
//!
//! A tripwire that fires needs hands: a checkout it may work in, permission
//! to write there when the phase allows it, and the whole tool surface a
//! session carries. That is an ordinary Tug session in every respect except
//! who asked for it, which is what [`AgentSupervisor::spawn_headless_session`]
//! exists to open ([P11]). The diagnosis phase runs one in the landing's
//! inspection tree; the authoring phase runs one in the tripwire's own arc
//! worktree. Each phase's session says what it decided by running the
//! resolution verb, which writes the trip row — nothing here reads a
//! decision out of what the session said.
//!
//! The runner is a trait for the same reason the agent spawner is: the engine
//! must be testable without a `claude` on the machine, and a test that scripts
//! what the session says exercises the settle path — the half where the
//! decisions are — against the same code the real one runs.
//!
//! **No clock ends a run while its session is alive.** The run ends when the
//! supervisor's own ledger entry says the session is finished — its turn over
//! and nothing it backgrounded still running, held for the project's idle
//! settle so the gap between a turn and its wake is not spent — or when the
//! entry says the session is gone. Those are the facts the arc runner reads
//! for every seated stage, read here for the same reason: the supervisor
//! already knows, and a scrape of the output stream can only guess.
//!
//! What the runner hands back besides how the session ended is the session's
//! transcript file, read off disk after the wait. The engine reads the
//! session's last words out of it for the next phase's prompt, and that is
//! the whole of what the transcript is for.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::time::Instant;
use tracing::{info, warn};
use tugcast_core::TugSessionId;
use tugtool_core::config::Config;

use crate::feeds::agent_supervisor::{AgentSupervisor, ControlError, SpawnState};
use crate::feeds::arc_runner::CHILD_GONE_GRACE;
use crate::session_ledger::{SessionLedger, claude_project_dir};

/// How often the wait re-reads the session's ledger entry.
///
/// The entry is in memory and the read is a lock and a handful of fields, so
/// this bounds the latency of noticing an end rather than any cost. The
/// turn-end edge itself goes to single-consumer channels the arc runner and
/// the wheel own, which is why the tripwire's wait reads the record instead of
/// listening for the edge.
pub(crate) const SESSION_READ_INTERVAL: Duration = Duration::from_secs(1);

/// What the engine asks a session to do.
pub struct TripwireSessionRequest {
    /// The tripwire that asked — the session's card id and the run's identity.
    pub tripwire: String,
    /// The arc worktree the session works in.
    pub worktree: PathBuf,
    /// The tripwire's permission mode, forwarded to `claude` at spawn [B09].
    pub permission_mode: String,
    /// The model the tripwire named, or the account default ([P06]).
    pub model: Option<String>,
    /// The whole prompt: brief, evidence, probe result, and the S04 contract.
    pub prompt: String,
}

/// How a session's run ended. There is no third way: a run is over when the
/// session finished or when it died, and nothing in the engine ends one
/// otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionEnd {
    /// The session ended its turn with no open jobs and stayed that way for
    /// the settle window.
    Finished,
    /// The session's child is gone, its entry errored or closed, or its entry
    /// is no longer in the ledger at all.
    Died,
}

/// What came back.
pub struct TripwireSessionOutcome {
    /// The session the run happened in, for the trip row and the post's ref.
    pub session_id: String,
    /// The session's transcript file, verbatim — claude's own JSONL under
    /// `~/.claude/projects/`. Read for its last assistant words and nothing
    /// else: what the session decided came off the trip row, written by the
    /// verb. Empty when the file could not be read, which the reader handles
    /// by finding nothing.
    pub transcript: String,
    /// How the run ended. A dead session still returns what it left on disk,
    /// but the engine settles it `failed` either way.
    pub end: SessionEnd,
}

/// Why a run did not happen.
///
/// Two kinds, because the trip log has to tell them apart. A `Fault` is
/// something wrong with this firing — a prompt the session refused, a spawn
/// that failed on its own terms — and it settles the trip `failed` next to the
/// other real failures. `HostFull` is not wrong with anything: the host's
/// spawn budget had no room at that instant, which is a busy condition that
/// will not be true in a minute. A trip that meets one goes back in the queue
/// the engine already drains, and nothing in the log calls it a failure.
///
/// The engine asks `admits_spawn` before it commits to a run, so `HostFull`
/// here is the race between that answer and the spawn rather than the
/// ordinary path.
#[derive(Debug, Clone)]
pub enum RunRefusal {
    /// The host's spawn budget refused this session.
    HostFull(String),
    /// Anything else that stopped the run.
    Fault(String),
}

impl RunRefusal {
    /// What to say about it, whichever kind it is.
    pub fn message(&self) -> &str {
        match self {
            RunRefusal::HostFull(m) | RunRefusal::Fault(m) => m,
        }
    }
}

#[async_trait::async_trait]
pub trait TripwireSessionRunner: Send + Sync {
    async fn run(
        &self,
        request: TripwireSessionRequest,
    ) -> Result<TripwireSessionOutcome, RunRefusal>;

    /// Whether a session would be admitted right now, asked without spawning
    /// one.
    ///
    /// The engine consults this beside its own ceiling, so a firing that the
    /// host has no room for is deferred rather than run into a refusal. The
    /// default is the honest answer for a runner with no budget to spend: a
    /// fake in a test admits, and so does a tugcast with nothing to ask.
    fn admits_spawn(&self) -> bool {
        true
    }
}

/// The production runner: spawn cardless, rotate the prompt in, wait for the
/// supervisor to say the session is finished or gone, read the transcript,
/// close.
pub struct SupervisorTripwireSessions {
    supervisor: Arc<AgentSupervisor>,
    /// Where the transcript file is found: the ledger knows claude's projects
    /// root, and the worktree encodes to the directory under it.
    ledger: Arc<SessionLedger>,
}

impl SupervisorTripwireSessions {
    pub fn new(supervisor: Arc<AgentSupervisor>, ledger: Arc<SessionLedger>) -> Self {
        SupervisorTripwireSessions { supervisor, ledger }
    }

    /// The session's transcript file, or empty when there is none to read.
    ///
    /// Read before the close, because the close removes the entry that
    /// carries the claude session id the file is named by.
    async fn transcript_of(&self, session: &TugSessionId, worktree: &Path) -> String {
        let claude_session_id = {
            let entry_arc = self.supervisor.ledger.lock().await.get(session).cloned();
            match entry_arc {
                Some(entry_arc) => entry_arc.lock().await.claude_session_id.clone(),
                None => None,
            }
        };
        let Some(claude_session_id) = claude_session_id else {
            return String::new();
        };
        let (dir, _canonical) = claude_project_dir(
            self.ledger.claude_projects_root(),
            &worktree.to_string_lossy(),
        );
        let path = dir.join(format!("{claude_session_id}.jsonl"));
        match tokio::fs::read_to_string(&path).await {
            Ok(text) => text,
            Err(e) => {
                warn!(session = %session, path = %path.display(), error = %e, "tripwire session transcript could not be read");
                String::new()
            }
        }
    }
}

#[async_trait::async_trait]
impl TripwireSessionRunner for SupervisorTripwireSessions {
    fn admits_spawn(&self) -> bool {
        self.supervisor.would_admit_spawn()
    }

    async fn run(
        &self,
        request: TripwireSessionRequest,
    ) -> Result<TripwireSessionOutcome, RunRefusal> {
        let session = self
            .supervisor
            .spawn_headless_session(
                &request.tripwire,
                &request.worktree,
                Some(request.permission_mode.clone()),
                Some("tripwire".to_string()),
            )
            .await
            .map_err(|e| {
                let message = format!("the tripwire's session could not be spawned: {e:?}");
                // The one spawn error that is about the host rather than about
                // this firing. The engine asked before it got here, so meeting
                // it means a card took the last slot in between — a race whose
                // answer is the queue, not the failure log.
                match e {
                    ControlError::CapExceeded { .. } => RunRefusal::HostFull(message),
                    _ => RunRefusal::Fault(message),
                }
            })?;

        // The rotation is the deck's own opening gesture: `model_change` first
        // so tugcode records the selector before it spawns claude ([P06]), then
        // the prompt through the dispatcher. Reused rather than re-derived,
        // because the `Spawning`-queue / `Live`-send matrix it carries is the
        // part that is easy to get subtly wrong.
        let rotation =
            crate::wheel::RotationRequest::new(session.clone(), &request.prompt, "tripwire")
                .model(request.model.clone());
        if let Err(refusal) = crate::wheel::rotate(&self.supervisor, &rotation).await {
            self.supervisor
                .close_headless_session(&request.tripwire, &session)
                .await;
            return Err(RunRefusal::Fault(format!(
                "the tripwire's prompt was refused: {refusal:?}"
            )));
        }

        // The same settle the arc runner holds an idle reading for, from the
        // same declaration, so a tripwire's session and a stage's are judged
        // finished by one rule.
        let settle = Config::load_from_project(&request.worktree)
            .unwrap_or_default()
            .tugtool
            .arc
            .idle_settle();
        let end = wait_for_session_end(&self.supervisor, &session, settle).await;
        let transcript = self.transcript_of(&session, &request.worktree).await;
        self.supervisor
            .close_headless_session(&request.tripwire, &session)
            .await;
        match end {
            SessionEnd::Finished => {
                info!(tripwire = %request.tripwire, session = %session, "tripwire session finished");
            }
            SessionEnd::Died => {
                warn!(tripwire = %request.tripwire, session = %session, "tripwire session died");
            }
        }
        Ok(TripwireSessionOutcome {
            session_id: session.as_str().to_string(),
            transcript,
            end,
        })
    }
}

/// One reading of the session's ledger entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionRead {
    /// Alive and working: a turn in flight, a job open, or the prompt's turn
    /// not yet begun.
    Busy,
    /// Alive, its turn over, nothing open. Carries how many turns it has
    /// ended, so a wake that opens and closes a turn inside the settle
    /// window reads as a different session and starts the window over.
    Quiet { turns_ended: u32 },
    /// Not coming back.
    Gone,
}

/// Read the entry the way the arc runner's `session_snapshot` does, so the two
/// agree about what a live session is.
async fn read_session(supervisor: &AgentSupervisor, session: &TugSessionId) -> SessionRead {
    let entry_arc = supervisor.ledger.lock().await.get(session).cloned();
    let Some(entry_arc) = entry_arc else {
        return SessionRead::Gone;
    };
    let entry = entry_arc.lock().await;
    let live = match entry.spawn_state {
        // An entry this process watched go `Live` and found back at `Idle`
        // has lost its child. One that never reached `Live` is still coming
        // up.
        SpawnState::Idle if entry.ever_live_here => false,
        SpawnState::Idle => true,
        // The bridge says `Live` through a respawn; a child gone past the
        // grace is the retry that never came back.
        SpawnState::Spawning | SpawnState::Live => entry
            .child_gone_at
            .is_none_or(|gone| gone.elapsed() < CHILD_GONE_GRACE),
        SpawnState::Errored | SpawnState::Closed => false,
    };
    if !live {
        return SessionRead::Gone;
    }
    // A session that has ended no turn has not yet started the one it was
    // asked for: quiet before the first turn is the spawn, not an answer.
    if entry.turns_ended > 0 && entry.is_quiet() {
        SessionRead::Quiet {
            turns_ended: entry.turns_ended,
        }
    } else {
        SessionRead::Busy
    }
}

/// Wait until the supervisor says the session is finished or gone.
///
/// A quiet reading is held for `settle` before it is spent, over the reading's
/// own facts rather than wall time alone: a turn ending inside the window
/// means the second reading is of a different session, and the window starts
/// again over it. `None` is the settle turned off, which spends the first
/// quiet reading.
///
/// There is no deadline here on purpose. A session that is alive is doing the
/// tripwire's work, and the user who can see the trip on the card is the one
/// who decides how long that may take.
pub(crate) async fn wait_for_session_end(
    supervisor: &AgentSupervisor,
    session: &TugSessionId,
    settle: Option<Duration>,
) -> SessionEnd {
    let mut ticker = tokio::time::interval(SESSION_READ_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut quiet: Option<(u32, Instant)> = None;
    loop {
        ticker.tick().await;
        match read_session(supervisor, session).await {
            SessionRead::Gone => return SessionEnd::Died,
            SessionRead::Busy => quiet = None,
            SessionRead::Quiet { turns_ended } => {
                let Some(settle) = settle else {
                    return SessionEnd::Finished;
                };
                match quiet {
                    Some((seen, since)) if seen == turns_ended => {
                        if since.elapsed() >= settle {
                            return SessionEnd::Finished;
                        }
                    }
                    _ => quiet = Some((turns_ended, Instant::now())),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feeds::agent_bridge::{CrashBudget, SessionMode};
    use crate::feeds::agent_supervisor::{LedgerEntry, test_minimal_supervisor};
    use crate::feeds::workspace_registry::WorkspaceKey;
    use tokio::sync::Mutex;

    /// A supervisor holding one live headless session, mid-turn.
    async fn live_session() -> (Arc<AgentSupervisor>, TugSessionId, Arc<Mutex<LedgerEntry>>) {
        let (supervisor, _register_rx) = test_minimal_supervisor();
        // Held for the supervisor's lifetime: dropping the receiver closes a
        // channel the supervisor still holds the sending end of.
        std::mem::forget(_register_rx);
        let id = TugSessionId::new("tripwire-sess".to_string());
        let mut entry = LedgerEntry::new(
            id.clone(),
            WorkspaceKey::from_test_str("ws-test"),
            PathBuf::from("/tmp"),
            SessionMode::New,
            CrashBudget::new(3, Duration::from_secs(60)),
        );
        entry.claude_session_id = Some("claude-tripwire".to_string());
        entry.spawn_state = SpawnState::Live;
        entry.ever_live_here = true;
        entry.turn_active = true;
        let entry = Arc::new(Mutex::new(entry));
        supervisor
            .ledger
            .lock()
            .await
            .insert(id.clone(), entry.clone());
        (supervisor, id, entry)
    }

    /// The old ceiling was twenty minutes. A session that works past an hour
    /// and then ends its turn is finished, and nothing in between failed it.
    #[tokio::test(start_paused = true)]
    async fn a_turn_that_ends_after_an_hour_is_finished() {
        let (supervisor, id, entry) = live_session().await;
        let mover = Arc::clone(&entry);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(61 * 60)).await;
            let mut e = mover.lock().await;
            e.turn_active = false;
            e.turns_ended = 1;
            e.prompt_turns_ended = 1;
        });
        let started = Instant::now();
        let end = wait_for_session_end(&supervisor, &id, Some(Duration::from_secs(5))).await;
        assert_eq!(end, SessionEnd::Finished);
        assert!(
            started.elapsed() >= Duration::from_secs(61 * 60 + 5),
            "the wait outlasted the turn and the settle: {:?}",
            started.elapsed()
        );
    }

    /// A child gone past the grace is a death, whatever the bridge says.
    #[tokio::test(start_paused = true)]
    async fn a_child_gone_past_the_grace_is_died() {
        let (supervisor, id, entry) = live_session().await;
        let mover = Arc::clone(&entry);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(10 * 60)).await;
            let mut e = mover.lock().await;
            e.child_pid = None;
            e.child_gone_at =
                Some(std::time::Instant::now() - CHILD_GONE_GRACE - Duration::from_secs(1));
        });
        let end = wait_for_session_end(&supervisor, &id, Some(Duration::from_secs(5))).await;
        assert_eq!(end, SessionEnd::Died);
    }

    /// An entry that went `Live` here and is found `Idle` again has lost its
    /// child, and an entry removed from the ledger is gone outright.
    #[tokio::test(start_paused = true)]
    async fn an_entry_back_at_idle_or_removed_is_died() {
        let (supervisor, id, entry) = live_session().await;
        {
            let mut e = entry.lock().await;
            e.spawn_state = SpawnState::Idle;
        }
        assert_eq!(
            wait_for_session_end(&supervisor, &id, None).await,
            SessionEnd::Died
        );

        supervisor.ledger.lock().await.remove(&id);
        assert_eq!(
            wait_for_session_end(&supervisor, &id, None).await,
            SessionEnd::Died
        );
    }

    /// Quiet before the first turn is the spawn, not an answer: the entry is
    /// not `turn_active` until the prompt lands, and the wait must not read
    /// that instant as finished.
    #[tokio::test(start_paused = true)]
    async fn quiet_before_the_first_turn_is_not_finished() {
        let (supervisor, id, entry) = live_session().await;
        {
            let mut e = entry.lock().await;
            e.turn_active = false;
        }
        let mover = Arc::clone(&entry);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(30)).await;
            let mut e = mover.lock().await;
            e.turn_active = true;
            drop(e);
            tokio::time::sleep(Duration::from_secs(30)).await;
            let mut e = mover.lock().await;
            e.turn_active = false;
            e.turns_ended = 1;
        });
        let started = Instant::now();
        let end = wait_for_session_end(&supervisor, &id, None).await;
        assert_eq!(end, SessionEnd::Finished);
        assert!(
            started.elapsed() >= Duration::from_secs(60),
            "spent before the prompt's turn ended: {:?}",
            started.elapsed()
        );
    }

    /// A quiet reading is held for the settle, and a turn ending inside the
    /// window starts it over: the wake that follows a turn is the gap the
    /// settle exists for.
    #[tokio::test(start_paused = true)]
    async fn a_turn_inside_the_settle_window_starts_it_over() {
        let (supervisor, id, entry) = live_session().await;
        {
            let mut e = entry.lock().await;
            e.turn_active = false;
            e.turns_ended = 1;
        }
        let mover = Arc::clone(&entry);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(2)).await;
            mover.lock().await.turn_active = true;
            tokio::time::sleep(Duration::from_secs(1)).await;
            let mut e = mover.lock().await;
            e.turn_active = false;
            e.turns_ended = 2;
        });
        let started = Instant::now();
        let end = wait_for_session_end(&supervisor, &id, Some(Duration::from_secs(5))).await;
        assert_eq!(end, SessionEnd::Finished);
        assert!(
            started.elapsed() >= Duration::from_secs(8),
            "the second turn's end should have restarted the window: {:?}",
            started.elapsed()
        );
    }

    /// An open background job holds the session busy past its turn's end.
    #[tokio::test(start_paused = true)]
    async fn an_open_job_holds_the_session_busy() {
        let (supervisor, id, entry) = live_session().await;
        {
            let mut e = entry.lock().await;
            e.turn_active = false;
            e.turns_ended = 1;
            e.open_jobs
                .insert("task-1".to_string(), std::time::Instant::now());
        }
        let mover = Arc::clone(&entry);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(15 * 60)).await;
            mover.lock().await.open_jobs.clear();
        });
        let started = Instant::now();
        let end = wait_for_session_end(&supervisor, &id, None).await;
        assert_eq!(end, SessionEnd::Finished);
        assert!(started.elapsed() >= Duration::from_secs(15 * 60));
    }
}
