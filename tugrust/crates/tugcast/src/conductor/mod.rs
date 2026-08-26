//! The conductor — the layer that seats a claude session under a card.
//!
//! tugcast can retire the claude session seated under a card and seat a fresh
//! one — on a chosen model, with a chosen opening prompt — while the card, its
//! transcript, its callsign, and its durable ink all stay exactly where they
//! were. That act is a **rotation**, and this module is where it lives.
//!
//! The dash arc was its first and for a long time its only client, which is why
//! the act used to be a private function in the arc's runner. It is not the
//! arc's: the arc *decides* which stage runs next and this *performs* the
//! seating, and the two halves have different reasons to change.
//! `dash_arc.rs` keeps every decision it makes; the runner keeps its re-read
//! guard, its in-flight bookkeeping, and everything it records.
//!
//! The conductor borrows a [`AgentSupervisor`] rather than owning one: it needs
//! that supervisor's per-session ledger, its spawn queue, and its dispatcher,
//! and a conductor that owned them would be a second supervisor.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex as StdMutex};

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use tugcast_core::protocol::{Frame, TugSessionId};
use tugdash_core::arc::ArcStopReason;

use crate::feeds::agent_supervisor::{AgentSupervisor, QueuePush, SpawnState, code_input_frame};

pub mod prompt;

/// What a rotation carries — everything the frames are composed from, and
/// nothing a model wrote.
///
/// # The invariant floor
///
/// A rotation is defined as much by what it *cannot* change as by what it
/// carries, and the floor is written here as absence rather than as prose.
/// Three kinds of thing pass through a rotation:
///
/// - **Invariants** — the card, the tug session id, the transcript and its
///   durable ink, the lineage chain, and the user's own model to return to.
///   None of them is a field, so nothing a caller writes can address them. The
///   transcript, the ink, and the lineage follow from the identity transfer in
///   `agent_bridge.rs` (`inherit_fork_identity` + `set_fork_provenance(…,
///   None)`), which the conductor never calls and cannot parameterize; the
///   model to return to is `LedgerEntry::deck_model`, which only a WebSocket
///   client's own `model_change` ever writes.
/// - **Parameters** — the model, the effort, the prompt, the stage label, the
///   score, and the divider facts a score supplies. Those are the fields below.
/// - **Always dropped** — the retiring claude's context. A rotation is a fresh
///   claude session by definition; carrying context across one is `/compact`'s
///   job, not the conductor's.
///
/// `session` names *which card rotates*. It is never a parameter of what the
/// card rotates *into*.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RotationRequest {
    /// The card's tug session id — the session that rotates.
    session: TugSessionId,
    /// The stage's opening prompt. Composed from documents, never a caller's
    /// sentence, when the caller is a score.
    prompt: String,
    /// The stage label — free text. `devise` / `review` / `implement` are the
    /// arc's three, and the divider renders whatever it is given.
    stage: String,
    /// The model this stage runs on. `None` is the account default, which
    /// sends no `model_change` frame at all.
    model: Option<String>,
    /// The reasoning effort this stage runs at. `None` leaves it as it is.
    /// It rides the `session_command`, so tugcode applies it before the spawn
    /// rather than respawning behind one.
    effort: Option<String>,
    /// The score driving this rotation — today a dash name, reaching tugcode
    /// as `arc` and the child as `TUG_DASH_ARC`.
    score: Option<String>,
    /// The document the score opened on, repo-relative.
    document: Option<String>,
    /// The plan the stage drives, once one exists.
    plan: Option<String>,
    /// The inclusive step range a *continued* implement stage walks, `N-M`.
    /// `None` on every other stage, which is what tells the transcript's
    /// divider a continued stage from a first one.
    steps: Option<String>,
}

impl RotationRequest {
    /// A rotation of `session`, opening on `prompt`, labelled `stage`.
    ///
    /// Everything else is optional and set through the builders below. There
    /// is no constructor that takes more, because there is nothing more a
    /// rotation is allowed to name.
    pub fn new(session: TugSessionId, prompt: impl Into<String>, stage: impl Into<String>) -> Self {
        Self {
            session,
            prompt: prompt.into(),
            stage: stage.into(),
            model: None,
            effort: None,
            score: None,
            document: None,
            plan: None,
            steps: None,
        }
    }

    /// The model to seat the fresh session on. Unset is the account default.
    pub fn model(mut self, model: Option<String>) -> Self {
        self.model = model;
        self
    }

    /// The reasoning effort to seat the fresh session at.
    pub fn effort(mut self, effort: Option<String>) -> Self {
        self.effort = effort;
        self
    }

    /// The score this rotation belongs to — a dash name today.
    pub fn score(mut self, score: Option<String>) -> Self {
        self.score = score;
        self
    }

    /// The document the score opened on.
    pub fn document(mut self, document: Option<String>) -> Self {
        self.document = document;
        self
    }

    /// The plan the stage drives.
    pub fn plan(mut self, plan: Option<String>) -> Self {
        self.plan = plan;
        self
    }

    /// The step range a continued implement stage walks.
    pub fn steps(mut self, steps: Option<String>) -> Self {
        self.steps = steps;
        self
    }
}

/// How a rotation's frames reached the card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    /// Sent on a live tugcode's stdin.
    Sent,
    /// Queued behind a spawn in flight; the promotion drains them in order.
    Queued,
}

/// Why a rotation could not happen.
///
/// Returned rather than logged: a client stops with this as the recorded
/// reason, so a rotation that cannot happen is visible on the card instead of
/// leaving its caller waiting forever ([L31]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// No ledger entry for the session — the card is gone.
    UnknownSession,
    /// The session has no claude running to rotate.
    Idle,
    Errored,
    Closed,
    /// The spawn-window queue was already full of user input.
    QueueOverflow,
    /// `Live` with no stdin sender installed.
    NoInputTx,
    /// The stdin channel closed under the send.
    SendFailed,
    /// The card is already running a score, and a card runs at most one.
    /// Two schedulers driving one card can interleave, and refusing
    /// is the one behavior that cannot.
    ArcRunning,
}

impl Refusal {
    /// The word recorded in `arc-stop`'s note and shown on the card.
    pub fn reason(&self) -> &'static str {
        match self {
            Refusal::UnknownSession => "session gone",
            Refusal::Idle => "session idle",
            Refusal::Errored => "session errored",
            Refusal::Closed => "session closed",
            Refusal::QueueOverflow => "spawn queue full",
            Refusal::NoInputTx => "no stdin",
            Refusal::SendFailed => "stdin closed",
            Refusal::ArcRunning => "arc running",
        }
    }

    /// The stop this refusal becomes when it ends an arc.
    ///
    /// A total mapping rather than a bijection: `UnknownSession` already
    /// answers "session gone", which is `ArcStopReason::SessionGone`'s word, so
    /// it maps onto that rather than growing a duplicate.
    pub fn stop_reason(&self) -> ArcStopReason {
        match self {
            Refusal::UnknownSession => ArcStopReason::SessionGone,
            Refusal::Idle => ArcStopReason::SessionIdle,
            Refusal::Errored => ArcStopReason::SessionErrored,
            Refusal::Closed => ArcStopReason::SessionClosed,
            Refusal::QueueOverflow => ArcStopReason::SpawnQueueFull,
            Refusal::NoInputTx => ArcStopReason::NoStdin,
            Refusal::SendFailed => ArcStopReason::StdinClosed,
            Refusal::ArcRunning => ArcStopReason::ArcRunning,
        }
    }
}

/// The conductor's own state: what a card has been promised, and what it is
/// owed back.
///
/// Both maps are in memory and both are dropped by a tugcast restart, on
/// purpose. A parked rotation is a promise about the end of a turn that is in
/// flight *right now*; a restart ends that turn by killing the claude running
/// it, so a request that survived would fire into a session that never finished
/// the work it was scheduled behind.
#[derive(Default)]
pub struct ConductorState {
    /// At most one rotation per tug session id. A second request replaces the
    /// first — the natural reading of a caller changing its mind mid-turn.
    pending: StdMutex<HashMap<String, RotationRequest>>,
    /// Tug session ids owed a hand-back: a scoreless rotation onto a named
    /// model pins the card there permanently unless somebody restores the
    /// deck's own selector, and no score's ending will.
    hand_backs: StdMutex<HashSet<String>>,
}

impl ConductorState {
    /// Park `request` against its session. `true` means it replaced one.
    pub fn park(&self, request: RotationRequest) -> bool {
        let key = request.session.as_str().to_string();
        self.pending.lock().unwrap().insert(key, request).is_some()
    }

    /// Withdraw a session's pending rotation. `true` means there was one.
    pub fn withdraw(&self, session_id: &str) -> bool {
        self.pending.lock().unwrap().remove(session_id).is_some()
    }

    /// Take a session's pending rotation, leaving nothing behind.
    pub fn take(&self, session_id: &str) -> Option<RotationRequest> {
        self.pending.lock().unwrap().remove(session_id)
    }

    /// Owe `session_id` a hand-back at its next turn's end. Arming twice is
    /// arming once: the card is handed back after the last stage, not once per
    /// stage.
    pub fn arm_hand_back(&self, session_id: &str) {
        self.hand_backs.lock().unwrap().insert(session_id.to_owned());
    }

    /// Take the hand-back a session is owed. `true` means one was owed.
    pub fn take_hand_back(&self, session_id: &str) -> bool {
        self.hand_backs.lock().unwrap().remove(session_id)
    }
}

/// Whether the card `session_id` sits on is already running a score.
///
/// Read the same way the arc runner reads it: the session's dash binding names
/// a project and a dash, and that dash's arc record is live unless it is `done`
/// or `stopped`. No binding, no record, or a finished one all mean no score is
/// running, so a rotation is free to park.
pub fn score_is_running(ledger: &crate::session_ledger::SessionLedger, session_id: &str) -> bool {
    let Ok(Some(row)) = ledger.get(session_id) else {
        return false;
    };
    let Some(dash) = row.dash_name.as_deref() else {
        return false;
    };
    match tugdash_core::arc::read_arc(Path::new(&row.project_dir), dash) {
        Some(record) => !record.done && record.stopped.is_none(),
        None => false,
    }
}

/// What the drain task needs to run.
pub struct ConductorContext {
    pub supervisor: Arc<AgentSupervisor>,
    pub state: Arc<ConductorState>,
    pub cancel: CancellationToken,
}

/// Perform parked rotations, and hand cards back, on the turn-end edge.
///
/// The tick is the same idle transition base-motion and the arc runner already
/// consume, on a third sibling channel because an mpsc has one consumer.
/// Waiting for that edge is the whole placement: a rotation performed
/// mid-turn kills the claude that asked for it, and a request is *always*
/// parked — there is no perform-at-request-time path, because `turn_active`
/// reads idle for a turn tugcast did not itself open, and parking is safe under
/// a wrong reading where performing is not.
pub async fn run_conductor(ctx: ConductorContext, mut tick_rx: mpsc::Receiver<String>) {
    loop {
        tokio::select! {
            _ = ctx.cancel.cancelled() => return,
            received = tick_rx.recv() => match received {
                Some(session_id) => on_tick(&ctx, &session_id).await,
                None => return,
            },
        }
    }
}

/// One session's turn just ended.
///
/// A tick performs a rotation **or** a hand-back, never both: the rotation's
/// own turn has not ended yet, so the card it seats is owed nothing until the
/// next edge.
async fn on_tick(ctx: &ConductorContext, session_id: &str) {
    if let Some(request) = ctx.state.take(session_id) {
        // A scoreless rotation onto a named model is a one-stage score, so its
        // ending is scheduled here — nothing else will ever end it. A
        // rotation naming no model changed nothing and has nothing to restore.
        let owes_hand_back = request.model.is_some() && request.score.is_none();
        match rotate(&ctx.supervisor, &request).await {
            Ok(delivery) => {
                if owes_hand_back {
                    ctx.state.arm_hand_back(session_id);
                }
                info!(
                    session = session_id,
                    stage = %request.stage,
                    ?delivery,
                    "conductor rotated a session",
                );
            }
            // Logged and dropped rather than retried: the refusal already
            // reached the caller, who exited non-zero with it.
            Err(refusal) => warn!(
                session = session_id,
                stage = %request.stage,
                reason = refusal.reason(),
                "conductor rotation refused",
            ),
        }
        return;
    }
    if ctx.state.take_hand_back(session_id) {
        let session = TugSessionId::new(session_id.to_string());
        if let Err(refusal) = hand_back(&ctx.supervisor, &session).await {
            warn!(
                session = session_id,
                reason = refusal.reason(),
                "conductor could not hand the card back",
            );
        }
    }
}

/// The frames a rotation is made of, in the order they must be sent.
///
/// Returned as `(before, prompt)` because the two halves take different doors:
/// `before` goes to the session's stdin or its spawn queue, and the prompt goes
/// through the dispatcher so it opens a journal row and marks the turn active
/// exactly as a typed prompt would.
///
/// Model **first**, because tugcode records the selector and its next spawn
/// reuses it — a model set after the spawn would be flipped underneath a claude
/// that had already started. A rotation declaring no model sends no
/// `model_change` frame at all rather than one carrying `"default"`: omitting
/// it leaves the card on whatever it was, which is what "the account default"
/// means here.
pub fn frames_for(request: &RotationRequest) -> (Vec<Frame>, Frame) {
    let session = request.session.as_str();
    let mut frames: Vec<Frame> = Vec::with_capacity(2);
    if let Some(model) = request.model.as_deref() {
        frames.push(code_input_frame(&serde_json::json!({
            "type": "model_change",
            "tug_session_id": session,
            "model": model,
        })));
    }
    let mut stage = serde_json::json!({ "name": request.stage });
    if let Some(document) = request.document.as_deref() {
        stage["document"] = serde_json::Value::String(document.to_owned());
    }
    if let Some(score) = request.score.as_deref() {
        stage["arc"] = serde_json::Value::String(score.to_owned());
    }
    if let Some(plan) = request.plan.as_deref() {
        stage["plan"] = serde_json::Value::String(plan.to_owned());
    }
    if let Some(steps) = request.steps.as_deref() {
        stage["steps"] = serde_json::Value::String(steps.to_owned());
    }
    if let Some(effort) = request.effort.as_deref() {
        stage["effort"] = serde_json::Value::String(effort.to_owned());
    }
    // The prompt rides the command as well as its own frame: tugcode echoes it
    // on `session_stage`, which is how the deck opens the turn it is about to
    // watch.
    stage["prompt"] = serde_json::Value::String(request.prompt.clone());
    frames.push(code_input_frame(&serde_json::json!({
        "type": "session_command",
        "tug_session_id": session,
        "command": "new",
        "stage": stage,
    })));
    // The prompt itself is a `user_message` in the deck's own wire shape —
    // Anthropic content blocks — and it goes through the dispatcher like one of
    // the deck's. Only the prompt takes that door: the dispatcher reads a
    // `model_change` as the deck's own selector, which a stage's model
    // is not.
    let prompt = code_input_frame(&serde_json::json!({
        "type": "user_message",
        "tug_session_id": session,
        "content": [{ "type": "text", "text": request.prompt }],
    }));
    (frames, prompt)
}

/// Rotate a stage onto a card's own tugcode.
///
/// The frames are exactly the ones the deck sends when a user picks a model and
/// starts a fresh session with a prompt; the only new thing is who sends them.
///
/// The `SpawnState` matrix is `do_request_replay`'s, with one difference that
/// matters: this **returns its refusal** instead of logging and dropping it
/// ([L31]). A rotation that cannot happen must reach its caller with a reason
/// rather than leave it waiting for a stage that will never start.
pub async fn rotate(
    supervisor: &AgentSupervisor,
    request: &RotationRequest,
) -> Result<Delivery, Refusal> {
    let tug_session_id = &request.session;
    let entry_arc = {
        let ledger = supervisor.ledger.lock().await;
        match ledger.get(tug_session_id) {
            Some(e) => e.clone(),
            None => return Err(Refusal::UnknownSession),
        }
    };

    let (frames, prompt) = frames_for(request);

    // Branch inside the lock, exactly as `do_request_replay` does: `Spawning`
    // enqueues here; `Live` snapshots `input_tx` and sends after the lock is
    // released, so a blocking mpsc send never holds the per-session mutex.
    let snapshot = {
        let mut entry = entry_arc.lock().await;
        match entry.spawn_state {
            SpawnState::Spawning => {
                // Back-pushed in order so the stage's frames stay in the order
                // they were built once the queue drains.
                for frame in frames {
                    if entry.queue.push(frame) == QueuePush::Overflow {
                        return Err(Refusal::QueueOverflow);
                    }
                }
                drop(entry);
                // Queued in order behind the command: the dispatcher buffers
                // into the same queue while the entry spawns.
                supervisor.dispatch_one(prompt).await;
                tracing::info!(
                    target: "dev::session-lifecycle",
                    event = "conductor.stage_queued",
                    tug_session_id = %tug_session_id,
                    stage = %request.stage,
                    arc = request.score.as_deref().unwrap_or(""),
                );
                return Ok(Delivery::Queued);
            }
            SpawnState::Live => entry.input_tx.clone(),
            SpawnState::Idle => return Err(Refusal::Idle),
            SpawnState::Errored => return Err(Refusal::Errored),
            SpawnState::Closed => return Err(Refusal::Closed),
        }
    };

    // `Live` with no `input_tx` is a programming error — the worker installs
    // the sender before the bridge promotes the entry — but a client must not
    // hang on it, so it is a refusal like any other.
    let Some(tx) = snapshot else {
        return Err(Refusal::NoInputTx);
    };
    for frame in frames {
        if tx.send(frame).await.is_err() {
            return Err(Refusal::SendFailed);
        }
    }
    supervisor.dispatch_one(prompt).await;
    tracing::info!(
        target: "dev::session-lifecycle",
        event = "conductor.stage_sent",
        tug_session_id = %tug_session_id,
        stage = %request.stage,
        arc = request.score.as_deref().unwrap_or(""),
    );
    Ok(Delivery::Sent)
}

/// Hand the card back on the deck's own model.
///
/// Exactly one `model_change` frame, carrying the last selector a WebSocket
/// client sent for this session, or `"default"` when it never sent one — which
/// `handleModelChange` maps to "no `--model`". A score sends it when the score
/// ends, **before** its receipt, so the card the user is handed back is already
/// theirs.
///
/// Without it a rotation's model change is permanent: tugcode records a
/// selector on its manager and every later spawn reuses it, so a card whose
/// score ended on the implement model would stay there — including through the
/// user's own `/new`.
pub async fn hand_back(
    supervisor: &AgentSupervisor,
    tug_session_id: &TugSessionId,
) -> Result<(), Refusal> {
    let entry_arc = {
        let ledger = supervisor.ledger.lock().await;
        match ledger.get(tug_session_id) {
            Some(e) => e.clone(),
            None => return Err(Refusal::UnknownSession),
        }
    };
    let (model, snapshot) = {
        let entry = entry_arc.lock().await;
        let model = entry
            .deck_model
            .clone()
            .unwrap_or_else(|| "default".to_string());
        match entry.spawn_state {
            SpawnState::Spawning => {
                drop(entry);
                let frame = code_input_frame(&serde_json::json!({
                    "type": "model_change",
                    "tug_session_id": tug_session_id.as_str(),
                    "model": model,
                }));
                let mut entry = entry_arc.lock().await;
                if entry.queue.push(frame) == QueuePush::Overflow {
                    return Err(Refusal::QueueOverflow);
                }
                return Ok(());
            }
            SpawnState::Live => (model, entry.input_tx.clone()),
            SpawnState::Idle => return Err(Refusal::Idle),
            SpawnState::Errored => return Err(Refusal::Errored),
            SpawnState::Closed => return Err(Refusal::Closed),
        }
    };
    let Some(tx) = snapshot else {
        return Err(Refusal::NoInputTx);
    };
    let frame = code_input_frame(&serde_json::json!({
        "type": "model_change",
        "tug_session_id": tug_session_id.as_str(),
        "model": model,
    }));
    if tx.send(frame).await.is_err() {
        return Err(Refusal::SendFailed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feeds::agent_supervisor::{insert_ledger_entry_for_tests, test_minimal_supervisor};
    use tokio::sync::mpsc;

    /// Every refusal the conductor can return becomes a stop the receipt can
    /// explain. Total, not injective: `UnknownSession` and a session that is
    /// simply gone say the same thing, and they share the reason that says it.
    #[test]
    fn every_conductor_refusal_maps_to_a_stop_reason() {
        const ALL: &[Refusal] = &[
            Refusal::UnknownSession,
            Refusal::Idle,
            Refusal::Errored,
            Refusal::Closed,
            Refusal::QueueOverflow,
            Refusal::NoInputTx,
            Refusal::SendFailed,
            Refusal::ArcRunning,
        ];
        for refusal in ALL {
            assert_eq!(
                refusal.stop_reason().as_str(),
                refusal.reason(),
                "{refusal:?} maps onto a reason that spells itself differently",
            );
        }
    }

    fn request(model: Option<&str>) -> RotationRequest {
        RotationRequest::new(
            TugSessionId::new("sess-stage-live"),
            "/tugplug:plan-devise a plan for dash/some-brief.md",
            "devise",
        )
        .document(Some("dash/some-brief.md".to_string()))
        .score(Some("some-dash".to_string()))
        .model(model.map(str::to_owned))
    }

    /// The `type` of each frame, in order.
    fn frame_types(frames: &[Frame]) -> Vec<String> {
        frames
            .iter()
            .map(|f| {
                serde_json::from_slice::<serde_json::Value>(&f.payload).unwrap()["type"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect()
    }

    fn body(frame: &Frame) -> serde_json::Value {
        serde_json::from_slice(&frame.payload).unwrap()
    }

    #[test]
    fn a_named_model_puts_a_model_change_first_and_an_unnamed_one_sends_none() {
        let (with, _) = frames_for(&request(Some("opus")));
        assert_eq!(
            frame_types(&with),
            vec!["model_change", "session_command"],
            "model first — tugcode records the selector and its next spawn reuses it"
        );
        assert_eq!(body(&with[0])["model"], "opus");

        let (without, _) = frames_for(&request(None));
        assert_eq!(
            frame_types(&without),
            vec!["session_command"],
            "omitting the frame is what 'the account default' means"
        );
    }

    /// The `String` → `Option` change in `document` and `arc` is the one shape
    /// change the extraction forces. For a score's rotation both are always
    /// present, so the emitted object must be byte-identical to what the arc
    /// sent before — asserted rather than assumed.
    #[test]
    fn a_scores_stage_object_is_what_the_arc_always_sent() {
        let request = RotationRequest::new(
            TugSessionId::new("sess-1"),
            "/tugplug:dash-implement dash/some.md Steps 4-9",
            "implement",
        )
        .document(Some("dash/some-brief.md".to_string()))
        .plan(Some("dash/some.md".to_string()))
        .score(Some("some-dash".to_string()))
        .steps(Some("4-9".to_string()));
        let (frames, _) = frames_for(&request);
        let stage = &body(&frames[0])["stage"];
        assert_eq!(
            *stage,
            serde_json::json!({
                "name": "implement",
                "document": "dash/some-brief.md",
                "arc": "some-dash",
                "plan": "dash/some.md",
                "steps": "4-9",
                "prompt": "/tugplug:dash-implement dash/some.md Steps 4-9",
            })
        );
    }

    /// The invariant floor cannot be widened without editing this test: a
    /// request built from the constructor's three arguments alone emits a
    /// stage object carrying nothing but the label and the prompt.
    #[test]
    fn the_constructors_three_arguments_are_the_whole_of_a_bare_rotation() {
        let request = RotationRequest::new(TugSessionId::new("sess-1"), "hello", "review");
        let (frames, prompt) = frames_for(&request);
        assert_eq!(frame_types(&frames), vec!["session_command"]);
        assert_eq!(
            body(&frames[0])["stage"],
            serde_json::json!({ "name": "review", "prompt": "hello" })
        );
        assert_eq!(body(&prompt)["content"][0]["text"], "hello");
    }

    /// A continued implement stage carries its step range onto the wire, so
    /// the transcript's divider can say `implement, continued · steps N–M`
    /// without re-deriving a range the runner already computed.
    #[tokio::test]
    async fn a_continued_implement_stage_carries_its_step_range() {
        let (sup, _register_rx) = test_minimal_supervisor();
        let tug_id = TugSessionId::new("sess-steps");
        let entry_arc = insert_ledger_entry_for_tests(&sup, &tug_id).await;
        let (input_tx, mut input_rx) = mpsc::channel::<Frame>(8);
        {
            let mut entry = entry_arc.lock().await;
            entry.spawn_state = SpawnState::Live;
            entry.input_tx = Some(input_tx);
        }

        let request = RotationRequest::new(
            tug_id.clone(),
            "/tugplug:dash-implement dash/some.md Steps 4-9",
            "implement",
        )
        .document(Some("dash/some-brief.md".to_string()))
        .plan(Some("dash/some.md".to_string()))
        .score(Some("some-dash".to_string()))
        .steps(Some("4-9".to_string()));
        rotate(&sup, &request).await.unwrap();

        let command = input_rx.recv().await.expect("session_command frame");
        assert_eq!(body(&command)["stage"]["steps"], "4-9");

        // A first implement stage carries none, which is what tells the two
        // apart on the wire.
        let first = request.steps(None);
        rotate(&sup, &first).await.unwrap();
        let command = input_rx.recv().await.expect("session_command frame");
        assert!(body(&command)["stage"].get("steps").is_none());
    }

    #[tokio::test]
    async fn a_live_rotation_sends_exactly_the_three_frames_in_order() {
        let (sup, _register_rx) = test_minimal_supervisor();
        let tug_id = TugSessionId::new("sess-stage-live");
        let entry_arc = insert_ledger_entry_for_tests(&sup, &tug_id).await;
        let (input_tx, mut input_rx) = mpsc::channel::<Frame>(8);
        {
            let mut entry = entry_arc.lock().await;
            entry.spawn_state = SpawnState::Live;
            entry.input_tx = Some(input_tx);
        }

        let delivery = rotate(&sup, &request(Some("opus")))
            .await
            .expect("a live card takes the rotation");
        assert_eq!(delivery, Delivery::Sent);

        let mut sent = Vec::new();
        while let Ok(frame) = input_rx.try_recv() {
            sent.push(frame);
        }
        assert_eq!(
            frame_types(&sent),
            vec!["model_change", "session_command", "user_message"],
            "model first — tugcode records the selector and its next spawn reuses it"
        );

        let model = body(&sent[0]);
        assert_eq!(model["model"], "opus");
        assert_eq!(model["tug_session_id"], "sess-stage-live");

        let command = body(&sent[1]);
        assert_eq!(command["command"], "new");
        assert_eq!(command["stage"]["name"], "devise");
        assert_eq!(command["stage"]["document"], "dash/some-brief.md");
        assert_eq!(command["stage"]["arc"], "some-dash");
        assert!(
            command["stage"].get("plan").is_none(),
            "a stage with no plan yet names none"
        );
        assert_eq!(
            command["stage"]["prompt"], "/tugplug:plan-devise a plan for dash/some-brief.md",
            "the command carries the prompt for the deck's benefit"
        );

        // The prompt frame is in the deck's own wire shape: content blocks,
        // never a bare `text` — tugcode forwards `content` to claude verbatim,
        // and a frame without it arrives as an empty message.
        let prompt = body(&sent[2]);
        assert_eq!(prompt["type"], "user_message");
        assert_eq!(
            prompt["content"][0]["text"],
            "/tugplug:plan-devise a plan for dash/some-brief.md"
        );
        assert!(prompt.get("text").is_none());
    }

    #[tokio::test]
    async fn a_spawning_rotation_queues_its_frames_in_order() {
        let (sup, _register_rx) = test_minimal_supervisor();
        let tug_id = TugSessionId::new("sess-stage-spawning");
        let entry_arc = insert_ledger_entry_for_tests(&sup, &tug_id).await;
        {
            let mut entry = entry_arc.lock().await;
            entry.spawn_state = SpawnState::Spawning;
        }

        let mut request = request(Some("sonnet"));
        request.session = tug_id.clone();
        let delivery = rotate(&sup, &request)
            .await
            .expect("queued behind the spawn");
        assert_eq!(delivery, Delivery::Queued);

        let mut entry = entry_arc.lock().await;
        let mut queued = Vec::new();
        while let Some(frame) = entry.queue.pop() {
            queued.push(frame);
        }
        assert_eq!(
            frame_types(&queued),
            vec!["model_change", "session_command", "user_message"],
            "the drain order is the order they were built"
        );
    }

    #[tokio::test]
    async fn a_rotation_with_nobody_to_receive_it_returns_its_refusal() {
        // [L31]: the caller must be able to stop with a reason. A silent drop
        // here would leave a score waiting for a stage that is never going to
        // start.
        let (sup, _register_rx) = test_minimal_supervisor();

        let mut unknown = request(None);
        unknown.session = TugSessionId::new("sess-stage-nobody");
        assert_eq!(rotate(&sup, &unknown).await, Err(Refusal::UnknownSession));

        let tug_id = TugSessionId::new("sess-stage-idle");
        let entry_arc = insert_ledger_entry_for_tests(&sup, &tug_id).await;
        let mut request = request(None);
        request.session = tug_id.clone();
        for (state, expected) in [
            (SpawnState::Idle, Refusal::Idle),
            (SpawnState::Errored, Refusal::Errored),
            (SpawnState::Closed, Refusal::Closed),
        ] {
            entry_arc.lock().await.spawn_state = state;
            assert_eq!(
                rotate(&sup, &request).await,
                Err(expected),
                "an {state:?} card has no claude to rotate"
            );
        }

        // Live with no stdin installed is a programming error, but a client
        // must surface it rather than hang on it.
        {
            let mut entry = entry_arc.lock().await;
            entry.spawn_state = SpawnState::Live;
            entry.input_tx = None;
        }
        assert_eq!(rotate(&sup, &request).await, Err(Refusal::NoInputTx));

        // Every refusal carries a word a client can record and a card can show.
        for refusal in [
            Refusal::UnknownSession,
            Refusal::Idle,
            Refusal::Errored,
            Refusal::Closed,
            Refusal::QueueOverflow,
            Refusal::NoInputTx,
            Refusal::SendFailed,
        ] {
            assert!(!refusal.reason().is_empty());
        }
    }

    #[tokio::test]
    async fn only_a_deck_model_change_is_remembered_for_the_hand_back() {
        // The dispatcher is the one place every WebSocket-client frame
        // passes, and a rotation bypasses it — so what lands in `deck_model` is
        // by construction the deck's own choice.
        let (sup, _register_rx) = test_minimal_supervisor();
        let tug_id = TugSessionId::new("sess-deck-model");
        let entry_arc = insert_ledger_entry_for_tests(&sup, &tug_id).await;
        assert_eq!(entry_arc.lock().await.deck_model, None);

        sup.dispatch_one(code_input_frame(&serde_json::json!({
            "tug_session_id": "sess-deck-model",
            "type": "model_change",
            "model": "opus",
        })))
        .await;
        assert_eq!(
            entry_arc.lock().await.deck_model.as_deref(),
            Some("opus"),
            "the deck's selector is what the card goes back to when the score ends"
        );

        let (input_tx, mut input_rx) = mpsc::channel::<Frame>(8);
        {
            let mut entry = entry_arc.lock().await;
            entry.spawn_state = SpawnState::Live;
            entry.input_tx = Some(input_tx);
        }
        let mut request = request(Some("sonnet"));
        request.session = tug_id.clone();
        rotate(&sup, &request).await.expect("sent");
        assert_eq!(
            entry_arc.lock().await.deck_model.as_deref(),
            Some("opus"),
            "the stage's model is the stage's, not the card's"
        );

        // And the hand-back is that remembered selector, one frame, nothing
        // else.
        while input_rx.try_recv().is_ok() {}
        hand_back(&sup, &tug_id).await.expect("handed back");
        let frame = input_rx.recv().await.expect("model_change frame");
        assert_eq!(body(&frame)["type"], "model_change");
        assert_eq!(body(&frame)["model"], "opus");
    }

    /// The registry holds at most one request per session, and a tick performs
    /// it and nothing else. Nothing may reach the card before that tick: a
    /// rotation performed at request time would kill the claude that asked for
    /// it.
    #[tokio::test]
    async fn a_parked_request_sends_nothing_until_the_tick() {
        for turn_active in [true, false] {
            let (sup, _register_rx) = test_minimal_supervisor();
            let tug_id = TugSessionId::new("sess-parked");
            let entry_arc = insert_ledger_entry_for_tests(&sup, &tug_id).await;
            {
                let mut entry = entry_arc.lock().await;
                entry.spawn_state = SpawnState::Spawning;
                entry.turn_active = turn_active;
            }
            let ctx = ConductorContext {
                supervisor: Arc::clone(&sup),
                state: Arc::new(ConductorState::default()),
                cancel: CancellationToken::new(),
            };

            let mut request = request(Some("opus"));
            request.session = tug_id.clone();
            assert!(!ctx.state.park(request), "nothing to replace");
            assert_eq!(
                entry_arc.lock().await.queue.len(),
                0,
                "parking sends nothing, whatever `turn_active` reads ({turn_active})"
            );

            on_tick(&ctx, "sess-parked").await;
            let mut entry = entry_arc.lock().await;
            let mut queued = Vec::new();
            while let Some(frame) = entry.queue.pop() {
                queued.push(frame);
            }
            assert_eq!(
                frame_types(&queued),
                vec!["model_change", "session_command", "user_message"],
                "the tick is what performs it, with the model first"
            );
        }
    }

    /// A scoreless rotation onto a named model is a one-stage score: nothing
    /// else will ever end it, so the conductor ends it itself, one turn later.
    #[tokio::test]
    async fn a_scoreless_rotation_onto_a_model_hands_the_card_back_one_turn_later() {
        let (sup, _register_rx) = test_minimal_supervisor();
        let tug_id = TugSessionId::new("sess-handback");
        let entry_arc = insert_ledger_entry_for_tests(&sup, &tug_id).await;
        let (input_tx, mut input_rx) = mpsc::channel::<Frame>(16);
        {
            let mut entry = entry_arc.lock().await;
            entry.spawn_state = SpawnState::Live;
            entry.input_tx = Some(input_tx);
            entry.deck_model = Some("sonnet".to_string());
        }
        let ctx = ConductorContext {
            supervisor: Arc::clone(&sup),
            state: Arc::new(ConductorState::default()),
            cancel: CancellationToken::new(),
        };

        ctx.state.park(
            RotationRequest::new(tug_id.clone(), "/tugplug:plan-review dash/x.md", "review")
                .model(Some("opus".to_string())),
        );
        on_tick(&ctx, "sess-handback").await;
        while input_rx.try_recv().is_ok() {}

        // The rotation's own turn ends: now the card is owed its model back.
        on_tick(&ctx, "sess-handback").await;
        let frame = input_rx.recv().await.expect("model_change frame");
        let restored = body(&frame);
        assert_eq!(restored["type"], "model_change");
        assert_eq!(restored["model"], "sonnet");
        assert!(input_rx.try_recv().is_err(), "one frame, nothing else");

        // And once handed back, it stays handed back.
        on_tick(&ctx, "sess-handback").await;
        assert!(input_rx.try_recv().is_err());
    }

    /// A rotation that changed no model has nothing to restore, and a scored
    /// one is ended by its score.
    #[tokio::test]
    async fn a_rotation_with_no_model_and_a_scored_one_arm_no_hand_back() {
        let (sup, _register_rx) = test_minimal_supervisor();
        let ctx = ConductorContext {
            supervisor: Arc::clone(&sup),
            state: Arc::new(ConductorState::default()),
            cancel: CancellationToken::new(),
        };

        for (name, request) in [
            (
                "sess-nomodel",
                RotationRequest::new(TugSessionId::new("sess-nomodel"), "hi", "review"),
            ),
            (
                "sess-scored",
                RotationRequest::new(TugSessionId::new("sess-scored"), "hi", "review")
                    .model(Some("opus".to_string()))
                    .score(Some("some-dash".to_string())),
            ),
        ] {
            let tug_id = TugSessionId::new(name);
            let entry_arc = insert_ledger_entry_for_tests(&sup, &tug_id).await;
            entry_arc.lock().await.spawn_state = SpawnState::Spawning;
            ctx.state.park(request);
            on_tick(&ctx, name).await;
            assert!(
                !ctx.state.take_hand_back(name),
                "{name} is owed no hand-back"
            );
        }
    }

    /// An ending arms a hand-back rather than sending one, because the stage
    /// may be mid-turn. This is the mechanism it relies on: the next turn-end
    /// tick takes the arming and restores the card's own model.
    #[tokio::test]
    async fn an_armed_hand_back_fires_on_the_next_turn_end() {
        let (sup, _register_rx) = test_minimal_supervisor();
        let tug_id = TugSessionId::new("sess-armed");
        let entry_arc = insert_ledger_entry_for_tests(&sup, &tug_id).await;
        {
            let mut entry = entry_arc.lock().await;
            entry.spawn_state = SpawnState::Spawning;
            entry.deck_model = Some("sonnet".to_string());
        }
        let ctx = ConductorContext {
            supervisor: Arc::clone(&sup),
            state: Arc::new(ConductorState::default()),
            cancel: CancellationToken::new(),
        };

        ctx.state.arm_hand_back("sess-armed");
        on_tick(&ctx, "sess-armed").await;

        let frames = {
            let mut entry = entry_arc.lock().await;
            let mut out = Vec::new();
            while let Some(frame) = entry.queue.pop() {
                out.push(frame);
            }
            out
        };
        assert_eq!(frames.len(), 1, "the card gets its model back");
        let parsed: serde_json::Value = serde_json::from_slice(&frames[0].payload).unwrap();
        assert_eq!(parsed["type"], "model_change");
        assert_eq!(parsed["model"], "sonnet");
        assert!(
            !ctx.state.take_hand_back("sess-armed"),
            "and the arming is spent, so a later tick restores nothing twice",
        );
    }

    #[test]
    fn a_second_request_replaces_the_first_and_a_withdrawal_leaves_nothing() {
        let state = ConductorState::default();
        let id = TugSessionId::new("sess-registry");

        assert!(!state.park(RotationRequest::new(id.clone(), "first", "review")));
        assert!(
            state.park(RotationRequest::new(id.clone(), "second", "review")),
            "a caller changing its mind replaces rather than queues"
        );
        let taken = state.take("sess-registry").expect("one request");
        assert_eq!(taken.prompt, "second", "the last word wins");
        assert!(state.take("sess-registry").is_none(), "taking is once");

        assert!(!state.withdraw("sess-registry"), "nothing pending");
        state.park(RotationRequest::new(id, "third", "review"));
        assert!(state.withdraw("sess-registry"));
        assert!(state.take("sess-registry").is_none());
    }

    /// A withdrawn request leaves the tick with nothing to do — the promise is
    /// gone, not merely unspoken.
    #[tokio::test]
    async fn a_withdrawn_request_makes_the_tick_a_no_op() {
        let (sup, _register_rx) = test_minimal_supervisor();
        let tug_id = TugSessionId::new("sess-withdrawn");
        let entry_arc = insert_ledger_entry_for_tests(&sup, &tug_id).await;
        entry_arc.lock().await.spawn_state = SpawnState::Spawning;
        let ctx = ConductorContext {
            supervisor: Arc::clone(&sup),
            state: Arc::new(ConductorState::default()),
            cancel: CancellationToken::new(),
        };

        ctx.state
            .park(RotationRequest::new(tug_id.clone(), "hi", "review"));
        assert!(ctx.state.withdraw("sess-withdrawn"));
        on_tick(&ctx, "sess-withdrawn").await;
        assert_eq!(entry_arc.lock().await.queue.len(), 0);
    }

    /// A card runs at most one score. The check reads the session's
    /// dash binding and that dash's arc record, exactly as the arc runner does.
    #[test]
    fn a_card_running_a_live_arc_is_scored_and_a_finished_one_is_not() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".tugtool")).unwrap();
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.dash]\ndocs = \"dash\"\n",
        )
        .unwrap();

        let ledger = crate::session_ledger::SessionLedger::open_in_memory().unwrap();
        ledger
            .record_spawn(
                "claude-scored",
                "ws-test",
                &root.to_string_lossy(),
                "card-1",
                1_000,
                None,
            )
            .unwrap();

        // No binding at all: nothing is driving this card.
        assert!(!score_is_running(&ledger, "claude-scored"));

        ledger
            .set_dash_binding("claude-scored", Some(("tugdash/demo#1", "demo")))
            .unwrap();
        // Bound, but no arc record — a dash is not a score.
        assert!(!score_is_running(&ledger, "claude-scored"));

        tugdash_core::arc::append_arc_start(root, "demo", "dash/demo-brief.md").unwrap();
        assert!(score_is_running(&ledger, "claude-scored"));

        tugdash_core::arc::append_arc_done(root, "demo").unwrap();
        assert!(
            !score_is_running(&ledger, "claude-scored"),
            "a finished arc is not a score running"
        );

        // A session nobody knows about is not scored either.
        assert!(!score_is_running(&ledger, "claude-unknown"));
    }

    /// A card that never had a selector goes back to `"default"`, which
    /// `handleModelChange` maps to "no `--model`".
    #[tokio::test]
    async fn a_card_with_no_selector_hands_back_the_account_default() {
        let (sup, _register_rx) = test_minimal_supervisor();
        let tug_id = TugSessionId::new("sess-no-selector");
        let entry_arc = insert_ledger_entry_for_tests(&sup, &tug_id).await;
        let (input_tx, mut input_rx) = mpsc::channel::<Frame>(8);
        {
            let mut entry = entry_arc.lock().await;
            entry.spawn_state = SpawnState::Live;
            entry.input_tx = Some(input_tx);
        }
        hand_back(&sup, &tug_id).await.expect("handed back");
        let frame = input_rx.recv().await.expect("model_change frame");
        assert_eq!(body(&frame)["model"], "default");
    }
}
