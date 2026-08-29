//! The work tier's session — a real `claude`, on a real worktree, with no card.
//!
//! A verdict-tier tripwire asks a pooled worker a question. A work-tier tripwire needs
//! hands: a checkout it may write in, permission to write there, and the whole
//! tool surface a session carries. That is an ordinary Tug session in every
//! respect except who asked for it, which is what
//! [`AgentSupervisor::spawn_headless_session`] exists to open ([P11]).
//!
//! The runner is a trait for the same reason the agent spawner is: the engine
//! must be testable without a `claude` on the machine, and a test that scripts
//! what the session says exercises the settle path — the half where the
//! decisions are — against the same code the real one runs.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tracing::{info, warn};
use tugcast_core::{Frame, TugSessionId};

use crate::feeds::agent_supervisor::AgentSupervisor;
use crate::feeds::payload_inspector::InspectedPayload;

/// How long a work-tier run may take before the engine stops waiting on it.
///
/// A tripwire's session is unattended: nobody is watching for the turn that never
/// ends, so the engine has to be the one that notices. Twenty minutes is long
/// enough for a real fix on a real tree and short enough that a wedged session
/// does not hold a concurrency slot for the rest of the day.
pub const TRIPWIRE_RUN_TIMEOUT: Duration = Duration::from_secs(20 * 60);

/// What the engine asks a session to do.
pub struct TripwireSessionRequest {
    /// The tripwire that asked — the session's card id and the run's identity.
    pub tripwire: String,
    /// The dash worktree the session works in.
    pub worktree: PathBuf,
    /// The tripwire's permission mode, forwarded to `claude` at spawn [B09].
    pub permission_mode: String,
    /// The model the tripwire named, or the account default ([P06]).
    pub model: Option<String>,
    /// The whole prompt: brief, evidence, probe result, and the S04 contract.
    pub prompt: String,
}

/// What came back.
pub struct TripwireSessionOutcome {
    /// The session the run happened in, for the trip row and the post's ref.
    pub session_id: String,
    /// Every CODE_OUTPUT payload the session emitted, concatenated. Read as
    /// evidence rather than as structure: the envelope is found in it by the
    /// same span scan the Overview's wake uses, which is why nothing here has
    /// to know the shape of an assistant frame.
    pub transcript: String,
    /// Whether the turn ended on its own. A run that timed out still returns
    /// what it saw — a partial transcript sometimes carries the envelope — but
    /// the engine settles it `failed` either way.
    pub completed: bool,
}

#[async_trait::async_trait]
pub trait TripwireSessionRunner: Send + Sync {
    async fn run(&self, request: TripwireSessionRequest) -> Result<TripwireSessionOutcome, String>;
}

/// The production runner: spawn cardless, rotate the prompt in, watch the
/// output, close.
pub struct SupervisorTripwireSessions {
    supervisor: Arc<AgentSupervisor>,
}

impl SupervisorTripwireSessions {
    pub fn new(supervisor: Arc<AgentSupervisor>) -> Self {
        SupervisorTripwireSessions { supervisor }
    }
}

#[async_trait::async_trait]
impl TripwireSessionRunner for SupervisorTripwireSessions {
    async fn run(&self, request: TripwireSessionRequest) -> Result<TripwireSessionOutcome, String> {
        // Subscribe before the spawn. A session that answers fast would
        // otherwise have its opening frames broadcast into a feed nobody was
        // listening on yet, and the transcript would be missing its head.
        let code_rx = self.supervisor.code_output.subscribe();

        let session = self
            .supervisor
            .spawn_headless_session(
                &request.tripwire,
                &request.worktree,
                Some(request.permission_mode.clone()),
                Some("tripwire".to_string()),
            )
            .await
            .map_err(|e| format!("the tripwire's session could not be spawned: {e:?}"))?;

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
            return Err(format!("the tripwire's prompt was refused: {refusal:?}"));
        }

        let (transcript, completed) = watch_turn(code_rx, &session).await;
        self.supervisor
            .close_headless_session(&request.tripwire, &session)
            .await;
        if completed {
            info!(tripwire = %request.tripwire, session = %session, "tripwire session finished its turn");
        } else {
            warn!(tripwire = %request.tripwire, session = %session, "tripwire session timed out");
        }
        Ok(TripwireSessionOutcome {
            session_id: session.as_str().to_string(),
            transcript,
            completed,
        })
    }
}

/// Read this session's CODE_OUTPUT until the turn ends or the clock runs out.
///
/// Every payload is kept verbatim, including the tool frames: the envelope may
/// be written anywhere in the turn, and narrowing to assistant text here would
/// be this module deciding what counts as an answer — a decision the envelope
/// parser already makes, and better, by scanning for the newest readable
/// object in whatever it is given.
async fn watch_turn(
    mut code_rx: tokio::sync::broadcast::Receiver<Frame>,
    session: &TugSessionId,
) -> (String, bool) {
    let deadline = tokio::time::Instant::now() + TRIPWIRE_RUN_TIMEOUT;
    let mut transcript = String::new();
    loop {
        let frame = match tokio::time::timeout_at(deadline, code_rx.recv()).await {
            Ok(Ok(frame)) => frame,
            // Lagged: frames were dropped. The turn is still running and the
            // transcript is now incomplete, which the envelope scan will
            // notice on its own by finding nothing.
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(n))) => {
                warn!(session = %session, dropped = n, "tripwire session output lagged");
                continue;
            }
            Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => {
                return (transcript, false);
            }
            Err(_) => return (transcript, false),
        };
        let Some(inspected) = InspectedPayload::from_slice(&frame.payload) else {
            continue;
        };
        if inspected.tug_session_id.as_deref() != Some(session.as_str()) {
            continue;
        }
        transcript.push_str(&String::from_utf8_lossy(&frame.payload));
        transcript.push('\n');
        if matches!(
            inspected.msg_type.as_deref(),
            Some("turn_complete") | Some("turn_cancelled")
        ) {
            return (transcript, true);
        }
    }
}
