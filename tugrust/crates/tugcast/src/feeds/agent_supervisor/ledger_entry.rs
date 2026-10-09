//! [`LedgerEntry`]: one session's row in the supervisor's ledger, and the
//! horizons its reapers read.

use super::*;

/// A segment's staged **provenance** ([P04]) — what a `session_segment`
/// announcement carried, waiting for the `session_init` that names its id.
///
/// Provenance only. Identity is the line's and the entry already knows which
/// line that is, so there is nothing here to inherit and nothing a mismatch
/// could strand.
#[derive(Debug, Clone)]
pub struct PendingSegment {
    /// The new claude session id this announcement precedes the init of.
    pub new_session_id: String,
    /// The session being left: the one a rewind forked from, the one a
    /// rotation replaced, the one a respawn re-identified away from.
    pub parent_session_id: String,
    /// What made the id change. Only `new` births a line ([P03]).
    pub kind: String,
    /// The prompt uuid of the rewind point, or `None` for a stage rotation.
    ///
    /// A stage has no branch point because nothing was copied, and the column
    /// is written `NULL` rather than given an invented value: the provenance
    /// columns are what tells a rewind from a rotation.
    pub fork_point: Option<String>,
    /// What a rotation seated this session as — the stage label the divider
    /// renders — or `None` for a rewind-fork, which seats nothing ([P10]).
    pub stage_label: Option<String>,
    /// The model the rotation seated it on, or `None` for the account default.
    pub stage_model: Option<String>,
}

/// What opened a turn — the distinction [P02] rests on.
///
/// A turn the *harness* opened is not a turn the stage was asked. A
/// backgrounded job completing re-invokes the model with a
/// `<task-notification>`, and that re-invocation ends a turn like any other;
/// six of them in a row are six turn ends and exactly one ask. The arc
/// runner's quiet-turn horizon counts answers, so it counts only the turns a
/// prompt opened, and that is the whole of what this enum is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnOpener {
    /// A `user_message` reached the dispatcher — somebody, or the wheel,
    /// asked.
    Prompt,
    /// A `wake_started` marker opened it — the harness did.
    Wake,
}

/// Per-session ledger record, keyed by [`TugSessionId`] in the supervisor.
///
/// Shape follows the supervisor ledger contract. Notably, there is no
/// `ReplayBuffer` field — the CODE_OUTPUT replay buffer stays shared at the
/// router level per [D06]; the supervisor only routes `system_metadata`
/// per-session.
pub struct LedgerEntry {
    /// Client-authoritative UUID for this session.
    pub tug_session_id: TugSessionId,
    /// Populated once `session_init` arrives from the subprocess.
    pub claude_session_id: Option<String>,
    /// Canonical `WorkspaceKey` returned by `WorkspaceRegistry::get_or_create`.
    /// Used by `do_close_session` to call `registry.release`.
    pub workspace_key: WorkspaceKey,
    /// Caller-supplied path (pre-canonicalization). Passed to
    /// `ChildSpawner::spawn_child` in `run_session_bridge` as the spawned
    /// Claude Code process's cwd, and retained for reset-session to
    /// respawn without losing the binding.
    pub project_dir: PathBuf,
    /// User's spawn-time new-vs-resume choice.
    /// Forwarded as `--session-mode new|resume` to the tugcode subprocess.
    /// Reconnects reuse this value so the tugcode side of the session
    /// doesn't flip modes mid-life.
    pub session_mode: SessionMode,
    /// Deck-wide / per-card default permission mode tugdeck resolved at the
    /// first `spawn_session` for this session, forwarded to the tugcode
    /// subprocess as `--permission-mode` so the spawned claude starts in the
    /// right mode. Set once on the fresh insert and preserved across reconnects
    /// / crash-loop respawns (like `session_mode`) so the tugcode side doesn't
    /// flip modes mid-life. `None` when tugdeck sent no mode — tugcode keeps
    /// its own default.
    pub permission_mode: Option<String>,
    /// The conversation this session forks from when a card changed its
    /// project directory ([P03], [P07]). Stamped on the fresh insert or while
    /// `Idle`, and read by the bridge on every spawn so a respawn or relaunch
    /// before the first turn re-forks. `None` for every session that did not
    /// move.
    pub relocate_from: Option<RelocateOrigin>,
    /// Provisional mnemonic tag tugdeck minted "from the drop" and sent on the
    /// first `spawn_session`. Set once on the fresh insert and preserved across
    /// reconnects (like `permission_mode`); the ledger's `record_spawn` claims
    /// or suffixes it authoritatively, and the final value rides back on
    /// `session_updated`. `None` when tugdeck sent no tag. Tug-side only — never
    /// forwarded into the child spawn args ([P07]).
    pub tag: Option<String>,
    /// The line of work this card is on ([P01]). Every segment the bridge
    /// records joins it **by reference** — the entry is asked, never the
    /// ledger — which is what makes an id change cost nothing to attach.
    ///
    /// `None` only between [`LedgerEntry::new`] and the spawn payload's
    /// arrival: `do_spawn_session` sets it from the payload (or, on a resume
    /// that carries none, from the row it is resuming), and
    /// `rebind_from_ledger` sets it from the row.
    pub line_id: Option<String>,
    /// Announced segments waiting for the `session_init` that names them
    /// ([P04]).
    ///
    /// A **queue**, not a slot: two announcements can be in flight before
    /// either init arrives, and a single slot let the second overwrite the
    /// first — which left one segment attached to nothing. Each init takes
    /// the entry whose `new_session_id` matches, so an init for anything else
    /// cannot consume one.
    pub pending_segments: std::collections::VecDeque<PendingSegment>,
    /// Lifecycle state.
    pub spawn_state: SpawnState,
    /// Whether a tugcode subprocess for this entry has ever reached `Live`
    /// **in this tugcast process**.
    ///
    /// The one fact that tells the two `Idle`s apart, and they mean opposite
    /// things to anything judging a card. An entry rebound from tugbank at
    /// startup sits `Idle` because nothing has spawned it yet — a wait, and
    /// reading it as a death would stop every in-flight arc on every relaunch
    /// ([`crate::feeds::arc_runner`]). An entry that ran here and is
    /// `Idle` again lost the child it was running: a killed claude, a reset.
    /// That is not a wait, and the ninety seconds an arc spent sitting over
    /// one is what this field exists to end.
    ///
    /// In memory on purpose, like [`Self::context_window_tokens`]: it is a
    /// claim about *this* process's own observations, so a restart clearing it
    /// is the correct reading rather than lost state.
    pub ever_live_here: bool,
    /// Whether this entry currently owns a `WorkspaceRegistry` refcount for its
    /// `workspace_key`. Exactly one refcount belongs to a live entry for its
    /// lifetime; this flag is the single authority for who releases it.
    ///
    /// A fresh spawn (or the first spawn of an entry rebound from the ledger)
    /// adopts the `get_or_create` refcount and sets this `true`; a genuine
    /// reconnect of an entry that already owns one releases the excess and
    /// leaves this `true`; `do_close_session` releases iff this is `true`.
    ///
    /// Critically, an entry rebound by `rebind_from_ledger` starts `false` — the
    /// rebind registers no workspace (lazy, to avoid a boot-time canonicalize /
    /// TCC storm) — so `!inserted` alone must NOT be read as "a refcount is
    /// held." That mis-read tore down a resumed project's workspace on restore.
    pub holds_workspace_refcount: bool,
    /// Per-session crash budget (3 crashes / 60s by convention).
    pub crash_budget: CrashBudget,
    /// CODE_INPUT buffer used during the `Spawning` window.
    pub queue: BoundedQueue<Frame>,
    /// Latest `system_metadata` payload for this session, for on-subscribe
    /// replay per [D14].
    pub latest_metadata: Option<Frame>,
    /// Latest `session_capabilities` payload for this session, for
    /// on-subscribe replay. Distinct from `latest_metadata`: capabilities
    /// (the turn-free `initialize` model list / command catalog) are
    /// broadcast once per spawn, so a card that subscribes *after* that
    /// frame flew — reconnect, HMR remount, a late-binding card — would
    /// otherwise never see the model list and the `/model` picker would
    /// have no data. Retained here and replayed on bind, the same shape
    /// `latest_metadata` uses for `system_metadata`. In-memory only (not
    /// persisted to sqlite): capabilities are re-emitted fresh on the
    /// next spawn's handshake, so they need not survive a tugcast restart.
    pub latest_capabilities: Option<Frame>,
    /// Latest `rate_limit_event` payload for this session, for
    /// on-subscribe replay. Distinct slot from `latest_metadata` /
    /// `latest_capabilities`: the per-turn quota broadcast carries the
    /// Z4B rate-limit chip's state, and a card that binds *after* the
    /// last broadcast flew (reconnect, HMR remount) would otherwise show
    /// no quota state until the next turn re-broadcasts. That tail
    /// matters most precisely when the session is hard rate-limited — the
    /// user cannot start a turn to refresh it — so the last-known frame
    /// is replayed on bind, the same shape `latest_capabilities` uses.
    /// In-memory only (not persisted to sqlite): `resetsAt` is an
    /// absolute time that self-corrects on the next live broadcast, so a
    /// stale value need not survive a tugcast restart.
    pub latest_rate_limit: Option<Frame>,
    /// OS pid of the live tugcode child, captured at spawn as the activity
    /// sampler's subtree root ([P08]). `None` between spawns (before the
    /// bridge spawns, and after the relay tears the child down).
    pub child_pid: Option<u32>,
    /// When this entry last lost its child with nothing having replaced it —
    /// `None` while a child is running, and while none has ever run.
    ///
    /// **The fact that makes a dead stage sayable.** `spawn_state` says what
    /// the *bridge* believes, and a bridge whose child crashed is retrying, so
    /// it goes on saying `Live` — correctly, for the second it takes to spawn
    /// again. What it cannot say is that the retry never came back. Driven in
    /// `at0505`: the stage's tugcode is killed, nothing replaces it, tugcast
    /// holds no child for the card at all, and the entry reads `Live`
    /// indefinitely — so `session_live` was true over a session with no
    /// process, and the arc had no reason to stop and no reason to move.
    ///
    /// A stamp rather than a flag, because the honest reading is a *duration*:
    /// a child gone for a second is a respawn in flight, and a child gone for
    /// [`CHILD_GONE_GRACE`] is a session that is not coming back. The reader
    /// is [`crate::feeds::arc_runner`]'s `session_snapshot`, which is the
    /// one place that turns this into `SessionGone`.
    ///
    /// In memory, like [`Self::context_window_tokens`]: it is a claim about
    /// this process's own observations, and a restart clearing it is the right
    /// reading rather than lost state.
    pub child_gone_at: Option<std::time::Instant>,
    /// The child's process start time (seconds since epoch), captured
    /// alongside `child_pid` as the PID-reuse guard baseline ([P20]). The
    /// sampler attributes the subtree only while the live pid's start time
    /// still matches this. `None` between spawns.
    pub child_start_time: Option<u64>,
    /// True while a turn is in flight — set by the dispatcher's inbound
    /// `user_message` intercept (and the merger's `wake_started` marker),
    /// cleared when the merger sees `turn_complete` / `turn_cancelled` or
    /// the relay tears the child down. The activity sampler attributes OS
    /// work only while this is set: The beat measures the session *working*,
    /// not the idle claude process's event-loop heartbeat.
    pub turn_active: bool,
    /// When the turn now in flight last showed it was alive — stamped at the
    /// open, and again at every edge the merger already holds this entry for
    /// (a turn end, a job opening or closing, a `task_progress` heartbeat).
    /// Read only by [`LedgerEntry::reap_stuck_turn`], and `None` between
    /// turns.
    ///
    /// Not stamped on every frame, and it does not need to be: a genuinely
    /// long turn is protected by having a live claude child under its bridge,
    /// which is the discriminator that reaper actually turns on. This is the
    /// clock for a turn that has nothing under it and is therefore not
    /// speaking to anybody.
    pub turn_last_frame_at: Option<std::time::Instant>,
    /// How many turns the claude session named by `claude_session_id` has
    /// ended — counted at the same edge that clears `turn_active`, reset
    /// when a `session_init` names a different claude session, and seeded
    /// from the ledger row on rebind. Zero is the state between a spawn and
    /// its first `turn_complete`: seated, idle, and never yet run.
    pub turns_ended: u32,
    /// What opened the turn now in flight, or `None` between turns and for a
    /// turn whose opener was never recorded ([P02]).
    ///
    /// Written `Prompt` by the dispatcher's `user_message` intercept and
    /// `Wake` by the merger's `wake_started` fold; cleared at the same edge
    /// that increments `turns_ended`. A turn tugcast inherited across a
    /// restart has none, and an absent opener counts as `Prompt` at the
    /// turn's end — today's behaviour, and the direction Risk R05 accepts.
    pub turn_opener: Option<TurnOpener>,
    /// How many of `turns_ended` were opened by a prompt — the count the arc
    /// runner's horizon, its `stage_turn_ended`, and its in-flight retirement
    /// read ([P02]). An unrecorded opener counts here.
    pub prompt_turns_ended: u32,
    /// How many of `turns_ended` were opened by a wake. Still motion for the
    /// arc's clock and still an idle edge for the settle; never an answer.
    pub wake_turns_ended: u32,
    /// The most recent turn ended in an API error (`turn_complete` with
    /// `is_api_error`) — the stage did not run. Overwritten at every turn end,
    /// reset when a `session_init` names a different claude session.
    pub turn_api_error: bool,
    /// The most recent turn was cancelled **by the user** (`turn_cancelled`
    /// with no `is_recovery` marker). Overwritten at every turn end, reset
    /// when a `session_init` names a different claude session.
    ///
    /// A user cancel only, because that reset cannot cover the other kind:
    /// tugcode's wedge recovery force-terminates claude and respawns
    /// `--resume` against the *same* claude id, so no `session_init` ever
    /// names a different one and the flag would latch on a session that is
    /// still alive and still working. The cause rides the frame instead.
    pub turn_cancelled: bool,
    /// The step this session closed (`arc step done` / `withdraw`) **in the
    /// turn now in flight**, or `None` when the turn has closed none.
    ///
    /// The turn boundary is the single most load-bearing discipline in an
    /// arc: the Wheel acts only between turns, so a stage that closes a
    /// step and keeps working locks it out of pacing, `/compact`, rotation and
    /// the idle clock alike. Enforcing that needs one fact the PreToolUse hook
    /// cannot have — the hook is a fresh process with no notion of a turn, and
    /// turns are tugcast's. So the verb reports the close here, the gate asks,
    /// and this clears at the same edge that increments `turns_ended`.
    ///
    /// In memory, like `deck_model` and `context_window_tokens`: a restart
    /// drops it, and dropping it degrades the gate **open**, which is the only
    /// direction a gate over ordinary editing may fail in.
    pub step_closed_this_turn: Option<u32>,
    /// Background jobs this session has launched and not yet seen end, from
    /// claude's `task_id` to the job's **liveness stamp** — a `Bash` or an
    /// `Agent` running with `run_in_background: true`, and the `Monitor`
    /// watchers that share their lifecycle.
    ///
    /// `turn_active` alone cannot answer whether a session is finished. A turn
    /// ends the moment the model stops speaking; work it backgrounded — a test
    /// sweep, a subagent — keeps running, and its completion wakes a *new*
    /// turn. So between the `turn_complete` and that wake there is a window
    /// where the session looks idle and is not, and this set is exactly that
    /// window. [`is_quiet`](LedgerEntry::is_quiet) is the two facts read
    /// together.
    ///
    /// Opened by `task_started`, closed by `task_updated` or `wake_started`
    /// carrying a terminal status — the wake because a job whose only terminal
    /// is claude's `task_notification` reaches this wire under no other name.
    /// Cleared wholesale when the relay tears the child down, because
    /// a job whose claude is gone will never report and a set that leaked
    /// would leave the session permanently un-quiet.
    ///
    /// **Two kinds of key live here.** A confirmed job is keyed by its
    /// `task_id`. A job that has been *launched* and not yet confirmed is
    /// keyed `launch:<tool_use_id>` — opened by the launching `tool_use`
    /// itself rather than by the `task_started` that follows it, because the
    /// window this set exists to cover starts at the launch. The incident's
    /// six background completions each opened and closed inside that window,
    /// and a latch armed only at `task_started` is a latch the runner can
    /// read around. A `task_started` naming the launch **re-keys** the entry
    /// to its `task_id`, carrying the launch's own stamp across so the reaper
    /// clocks the job from when it actually began.
    ///
    /// A provisional key is retired three ways: by the `task_started` that
    /// confirms it, by any `wake_started` (the model is speaking again, so
    /// the gap the latch covers is over), and by the reaper, which treats it
    /// exactly like any other key. That third one is what bounds Risk R02 —
    /// a `Monitor` call whose `task_started` never arrives holds the session
    /// busy until its wake or the horizon, never forever.
    ///
    /// The stamp is the guarantee layer behind those two corrections: set at
    /// the open, refreshed by `task_progress` heartbeats, and read by
    /// [`LedgerEntry::reap_stuck_jobs`] so a wire shape nothing here foresaw
    /// degrades `holders_busy` to *late*, never *forever*.
    ///
    /// **The read point is the reap point, and there are two of them**: the
    /// recompute's read of busyness ([`busy_session_ids`]) and the arc
    /// runner's read of one entry (`session_snapshot`). Both reap on their way
    /// past, so no timer task is needed and the bound holds on an arc nobody
    /// happens to be recomputing ([B04]).
    ///
    /// **A confirmed job leaves this set three ways**, not two: by its own
    /// terminal edge, by the reaper, and by the close of the step it was
    /// launched inside — [`AgentSupervisor::end_step_jobs`], because a job
    /// whose step is over has nothing left to report to (brief [B01]).
    pub open_jobs: std::collections::BTreeMap<String, OpenJob>,
    /// The Bash calls a running command's progress report may belong to,
    /// keyed by `tool_use_id` ([`OpenRun`] has the lifecycle).
    ///
    /// A report posted through `/api/session` names its session but not its
    /// call — a shell command cannot know the id of the call that ran it — so
    /// [`AgentSupervisor::publish_run_progress`] matches it against this map
    /// and attaches it to a block only when exactly one run fits. Capped at
    /// [`OPEN_RUNS_CAP`], oldest out first.
    pub open_runs: std::collections::BTreeMap<String, OpenRun>,
    /// Notified at exactly the edges where [`LedgerEntry::is_quiet`] can
    /// become true, so a waiter watches the session rather than polling it
    /// ([P05]).
    ///
    /// Three sites fire it, and they are the only three: the frame loop's
    /// turn-end arm, after `turn_active` is cleared and the counters have
    /// moved; [`AgentSupervisor::apply_job_edge`], on the transition into
    /// quiet it already reports; and the `stop_all_work_done` arm, which is
    /// the only one that can fire with several jobs open at once ([P12]).
    /// Each notifies from inside the same entry guard that wrote the fact, so
    /// a waiter cannot observe a half-applied edge.
    ///
    /// An `Arc` rather than a plain `Notify` because the stop clones the
    /// handle out and drops every guard before awaiting on it: the wait must
    /// never hold the map lock or an entry lock across an await, or the very
    /// frames that would release it cannot be folded (Risk R01).
    pub quiesced: Arc<tokio::sync::Notify>,
    /// The last `model_change` selector a **WebSocket client** sent for this
    /// session — the deck's own choice ([P15]).
    ///
    /// The arc hands the card back on this value when it ends, because
    /// tugcode records a selector on its manager and reuses it for every later
    /// spawn: a card whose arc ended on the implement model would otherwise
    /// stay there. `None` means the deck never sent one, which restores as
    /// `"default"` — the honest expression of "no `--model`".
    ///
    /// Deliberately in memory rather than in the ledger: it is a live fact
    /// about a running card, and a tugcast restart mid-arc resumes on whatever
    /// the deck sends next, which its own mount restore already handles.
    /// Frames the runner originates never write it — only the dispatcher does,
    /// and the runner bypasses the dispatcher.
    pub deck_model: Option<String>,
    /// Stdin sender when `Live`.
    pub input_tx: Option<mpsc::Sender<Frame>>,
    /// Cancels the per-session worker on `close_session`.
    pub cancel: CancellationToken,
    /// Card id this session is bound to. Set on the first
    /// `spawn_session` and preserved across lifecycle transitions
    /// (close, errored, crash-exhausted) so the persisted ledger row
    /// retains the binding for client-side restore. Liveness is encoded
    /// in `spawn_state`, not by nullity of this field; the
    /// "live-elsewhere" check in `do_spawn_session` gates on
    /// `spawn_state ∈ {Spawning, Live}` plus a card mismatch.
    pub card_id: Option<String>,
    /// Count of replay brackets currently in flight on this session's
    /// outbound stream — incremented on each `replay_started` the merger
    /// observes, saturating-decremented on each `replay_complete`. The
    /// merger's `apply_outbound_turn_intercept` skips its FIFO journal-pop
    /// work while this counter is non-zero, so replay-emitted
    /// `turn_complete` frames (from `translateJsonlSession`'s
    /// committed-turn output) don't get treated as live `turn_complete`s
    /// and don't pop the user's still-pending journal row. Mid-turn-replay
    /// [Step 5.10](arc/tugplan-dev-mid-turn-replay.md#step-5) is the
    /// post-Step-5.9 fix for the HMR-mid-stream regression.
    ///
    /// It cannot latch. Every bracket is closed by a `replay_complete`,
    /// and where tugcode will not send one the relay does: its watchdog
    /// closes a bracket left open past `REPLAY_BRACKET_DEADLINE`, and a
    /// relay that ends inside one — tugcode crashed, the relay panicked,
    /// the session was cancelled — closes it on the way out. Behind both,
    /// every end of a relay zeroes the counter outright, as does a bridge
    /// task that unwinds, so a dead bridge never leaves a count for the
    /// next one to nest into.
    ///
    /// Counter (not bool) so a stray close is a no-op:
    /// `u32::saturating_sub(1)` at zero stays zero, where a bool would
    /// need every close to be matched. The relay's own close and a late
    /// one from tugcode can both arrive for one bracket, and that is the
    /// case the shape is for. tugcode's `runReplay` re-entrancy guard
    /// prevents legitimate overlapping brackets, so in healthy operation
    /// the counter is 0 between brackets and 1 during one.
    pub replay_brackets_open: u32,
    /// The resident context window after this session's latest turn, in
    /// tokens — the four-token sum of `cost_update.usage`, which tugcode
    /// documents as exactly that figure.
    ///
    /// The persisted `context_breakdown_latest` row cannot answer this: it
    /// carries the *static* half of the breakdown (`context_max` plus the
    /// session-stable categories) and deliberately no total and no `messages`
    /// category, both of which the deck derives feed-exact. So the arc's
    /// rotation reading is this window over that row's `context_max`
    /// ([P07]).
    ///
    /// In memory, like [`Self::deck_model`]: a tugcast restart drops it, and
    /// the runner's declared fallback for a missing reading is to continue the
    /// stage rather than act on a guess. It moves *live*: every
    /// `streaming_usage` frame of the open turn overwrites it, and the
    /// turn-final `cost_update` is the authoritative last write. A
    /// `session_init` naming a different claude clears it, so a fresh session
    /// is never judged on the window of the one it replaced.
    pub context_window_tokens: Option<i64>,
    /// The session ids the most recent `request_replay` carried, oldest
    /// first, or `None` when it carried no lineage ([B02]).
    ///
    /// The `replay_complete` stamp sums `engine_turn_count` over exactly
    /// these files, so the bar's denominator counts the population its
    /// numerator was built from. Remembered rather than recomputed: what a
    /// replay *walked* is a fact about that request, and recomputing the
    /// chain at stamp time would usually agree without ever guaranteeing it.
    ///
    /// `None` on every card that is not an arc, and on any entry whose last
    /// replay predates this field — both sum the tip alone, which is the
    /// behaviour before this existed.
    ///
    /// In memory, like [`Self::context_window_tokens`]: it describes a
    /// request this process forwarded, and a restart with no replay behind it
    /// has nothing to remember.
    pub replayed_lineage: Option<Vec<String>>,
}

impl LedgerEntry {
    /// Create a fresh `Idle` entry for a newly registered session.
    pub fn new(
        tug_session_id: TugSessionId,
        workspace_key: WorkspaceKey,
        project_dir: PathBuf,
        session_mode: SessionMode,
        crash_budget: CrashBudget,
    ) -> Self {
        Self {
            tug_session_id,
            claude_session_id: None,
            workspace_key,
            project_dir,
            session_mode,
            permission_mode: None,
            relocate_from: None,
            tag: None,
            line_id: None,
            pending_segments: std::collections::VecDeque::new(),
            deck_model: None,
            context_window_tokens: None,
            replayed_lineage: None,
            spawn_state: SpawnState::Idle,
            ever_live_here: false,
            holds_workspace_refcount: false,
            crash_budget,
            queue: BoundedQueue::new(),
            latest_metadata: None,
            latest_capabilities: None,
            latest_rate_limit: None,
            child_pid: None,
            child_gone_at: None,
            child_start_time: None,
            turn_active: false,
            turn_last_frame_at: None,
            turns_ended: 0,
            turn_opener: None,
            prompt_turns_ended: 0,
            wake_turns_ended: 0,
            turn_api_error: false,
            turn_cancelled: false,
            step_closed_this_turn: None,
            open_jobs: std::collections::BTreeMap::new(),
            open_runs: std::collections::BTreeMap::new(),
            quiesced: Arc::new(tokio::sync::Notify::new()),
            input_tx: None,
            cancel: CancellationToken::new(),
            card_id: None,
            replay_brackets_open: 0,
        }
    }
}

impl LedgerEntry {
    /// Whether this session is **finished**, not merely between frames.
    ///
    /// One reading of a fact that is genuinely two: the model is not speaking
    /// *and* nothing it started is still running. Every surface that waits for
    /// a session to be done asks this rather than `turn_active` alone, because
    /// the two disagree for exactly as long as a backgrounded test sweep takes
    /// to finish — the window in which an arc would otherwise be offered for
    /// joining while its own tests were still deciding whether it works.
    ///
    /// A provisional `launch:` entry counts exactly as a confirmed job does,
    /// which is the whole of [P04]: the window opens at the launch, so the
    /// answer here has to be *busy* from the launch and not from the
    /// `task_started` that confirms it.
    pub fn is_quiet(&self) -> bool {
        !self.turn_active && self.open_jobs.is_empty()
    }

    /// Which open run a progress report belongs to, by Spec S05's rules:
    /// an exact id that names a candidate, else the one candidate, else the
    /// one candidate whose command holds a needle — else `None`, which the
    /// caller publishes card-level rather than guess.
    ///
    /// A candidate is a foreground run, or a background run whose job is
    /// still open. A background run whose job is gone leaves the map here, as
    /// it is found: this read is the one place that liveness is asked.
    pub fn attach_run(&mut self, tool_use_id: Option<&str>, needles: &[String]) -> Option<String> {
        let open_jobs = &self.open_jobs;
        self.open_runs.retain(|id, run| {
            !run.background
                || open_jobs.contains_key(&launch_key(id))
                || run
                    .task_id
                    .as_ref()
                    .is_some_and(|task| open_jobs.contains_key(task))
        });
        if let Some(id) = tool_use_id
            && self.open_runs.contains_key(id)
        {
            return Some(id.to_owned());
        }
        if self.open_runs.len() == 1 {
            return self.open_runs.keys().next().cloned();
        }
        let mut matched = self.open_runs.iter().filter(|(_, run)| {
            needles
                .iter()
                .any(|needle| !needle.is_empty() && run.command.contains(needle.as_str()))
        });
        match (matched.next(), matched.next()) {
            (Some((id, _)), None) => Some(id.clone()),
            _ => None,
        }
    }

    /// Drop every open job whose stamp has gone stale with the turn ended —
    /// the bound that turns an unforeseen wire shape from *wedged forever*
    /// into *offered late*, the one direction the busy latch is allowed to
    /// fail in. Reaping only after the turn has ended keeps a long turn's own
    /// silence off the clock, and each reaped job `warn!`s with its ids so
    /// the trace names what happened.
    ///
    /// A provisional `launch:` key is reaped like any other, and that is the
    /// bound under Risk R02: a `Monitor` call whose `task_started` never
    /// arrives holds the session busy until its wake or this horizon, and
    /// never past it.
    ///
    /// `now` is the caller's clock, injected so tests need no real one.
    pub fn reap_stuck_jobs(&mut self, now: std::time::Instant) {
        if self.turn_active {
            return;
        }
        self.open_jobs.retain(|task, job| {
            let stale = now.saturating_duration_since(job.since) > JOB_REAP_HORIZON;
            if stale {
                warn!(
                    target: "dev::ledger",
                    event = "job_reaped",
                    session_id = %self.tug_session_id,
                    task_id = %task,
                    "background job silent past the reap horizon with its turn \
                     ended — dropped so the session cannot read busy forever",
                );
            }
            !stale
        });
    }

    /// Drop a turn flag that has outlived the turn it was set for — the
    /// [`Self::reap_stuck_jobs`] doctrine extended to `turn_active` verbatim
    /// ([B02]): the latch may fail toward *offered late*, never toward
    /// *wedged forever*.
    ///
    /// Two conditions, and the second is what makes this safe. A turn is
    /// reaped only when it has shown no sign of life for
    /// [`JOB_REAP_HORIZON`] **and** its bridge has no live claude child —
    /// the `(child_pid, child_start_time)` pair
    /// [`AgentSupervisor::live_session_processes`] reports a session by. A
    /// genuinely long turn has a child under its bridge and is never touched,
    /// however quiet the wire goes; a turn with no child is one nothing can
    /// end, because the process whose `turn_complete` would end it is gone.
    ///
    /// `now` is the caller's clock, injected so tests need no real one.
    pub fn reap_stuck_turn(&mut self, now: std::time::Instant) {
        if !self.turn_active {
            return;
        }
        if self.child_pid.is_some() && self.child_start_time.is_some() {
            return;
        }
        // No stamp at all is a turn this process inherited across a restart,
        // or one a path nobody foresaw opened. Either way there is nothing to
        // age it against, so it is stamped now and reaped a horizon later —
        // late, never forever.
        let Some(since) = self.turn_last_frame_at else {
            self.turn_last_frame_at = Some(now);
            return;
        };
        if now.saturating_duration_since(since) <= JOB_REAP_HORIZON {
            return;
        }
        warn!(
            target: "dev::ledger",
            event = "turn_reaped",
            session_id = %self.tug_session_id,
            opener = match self.turn_opener {
                Some(TurnOpener::Wake) => "wake",
                Some(TurnOpener::Prompt) => "prompt",
                None => "unknown",
            },
            "a turn went silent past the reap horizon with no claude child \
             under its bridge — the latch is dropped so the session cannot \
             read busy forever",
        );
        self.turn_active = false;
        self.turn_opener = None;
        self.turn_last_frame_at = None;
        self.quiesced.notify_waiters();
    }

    /// Stamp the turn in flight as alive. A no-op between turns, so a caller
    /// on a hot path need not ask first.
    pub fn touch_turn(&mut self) {
        if self.turn_active {
            self.turn_last_frame_at = Some(std::time::Instant::now());
        }
    }

    /// Force the entry **quiet** at the close of the outermost replay bracket,
    /// and answer whether anything had to be cleared.
    ///
    /// Replay describes turns and jobs that ended with the session that ran
    /// them, so the entry a bracket closes on must read exactly as it read
    /// before the bracket opened. Every fold that could latch it is guarded on
    /// `replay_brackets_open == 0` — but a guard list is only complete until
    /// the next wire shape is added, and the incident was one missing entry in
    /// it. So the bracket's own close asserts the invariant rather than
    /// trusting the guards: whatever is still set is cleared here with a
    /// `warn!` naming the frame kind that set it ([B01]).
    ///
    /// This fails in the same direction [`Self::reap_stuck_jobs`] does, at a
    /// much shorter horizon: an unforeseen replayed shape costs a session that
    /// reads quiet a moment early, never one wedged busy forever.
    pub fn clear_replay_residue(&mut self) -> bool {
        let mut cleared = false;
        if self.turn_active {
            warn!(
                target: "dev::ledger",
                event = "replay_residue_cleared",
                session_id = %self.tug_session_id,
                field = "turn_active",
                kind = match self.turn_opener {
                    Some(TurnOpener::Wake) => "wake_started",
                    Some(TurnOpener::Prompt) => "user_message",
                    None => "unknown",
                },
                "a replayed frame opened a turn whose own replayed end was \
                 discarded — latch cleared at the bracket's close so the \
                 session cannot read busy with no turn left to end it",
            );
            self.turn_active = false;
            self.turn_opener = None;
            cleared = true;
        }
        if !self.open_jobs.is_empty() {
            let jobs: Vec<&str> = self.open_jobs.keys().map(String::as_str).collect();
            warn!(
                target: "dev::ledger",
                event = "replay_residue_cleared",
                session_id = %self.tug_session_id,
                field = "open_jobs",
                kind = "tool_use",
                jobs = ?jobs,
                "replayed frames left jobs open whose work died with the \
                 session that ran them — dropped at the bracket's close",
            );
            self.open_jobs.clear();
            cleared = true;
        }
        cleared
    }
}

/// How long an open job may sit silent — no edge, no `task_progress` — after
/// its turn has ended before the reap drops it. Generous on purpose: a
/// backgrounded bash job emits no progress frames at all, so a tight horizon
/// would reap real work and offer its join early (Risk R01's residual is a
/// silent job longer than this, accepted as the cost of never wedging).
///
/// Read at both reap points — [`busy_session_ids`], the recompute's read of
/// busyness, and the arc runner's `session_snapshot`, its read of one entry —
/// which is why it is visible past this module.
pub(crate) const JOB_REAP_HORIZON: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// How long after a client connects the orphan sweep waits before it judges
/// ([B07]).
///
/// Longer than a reconnect and shorter than a user noticing, which is the
/// whole of what the window has to be. A deck's re-announcement is a burst of
/// `spawn_session` frames landing within a second or two of the socket coming
/// up, so a minute is two orders of magnitude of headroom on the fast side;
/// and an orphan bridge is invisible until somebody goes looking for why a
/// session still reads live, which the incident shows takes hours. The one
/// session that may legitimately be held by nobody for longer — a headless
/// one, per `briefs/background-session-card-adoption-brief.md` — is excluded
/// by its card id rather than by waiting for it, so the window does not have
/// to cover that case at all.
pub(super) const BRIDGE_ORPHAN_SETTLE: std::time::Duration = std::time::Duration::from_secs(60);

#[cfg(test)]
mod tests {
    use super::*;

    /// An open job stamped `since`, of the kind most of these tests are about:
    /// a backgrounded `Bash` command. The kind is recorded at the launch
    /// ([P03]), and a test that reaches into `open_jobs` directly is standing in
    /// for that launch.
    fn bash_job(since: std::time::Instant) -> OpenJob {
        OpenJob {
            since,
            kind: JobKind::Bash,
        }
    }

    /// The whole point of the pair: a turn that ends with a test sweep still
    /// running has finished nothing.
    #[test]
    fn quiet_is_the_turn_and_the_jobs_together() {
        let mut entry = LedgerEntry::new(
            TugSessionId::new("s1".to_owned()),
            WorkspaceKey::from_test_str("/proj"),
            std::path::PathBuf::from("/proj"),
            SessionMode::New,
            CrashBudget::new(3, Duration::from_secs(60)),
        );
        assert!(entry.is_quiet(), "a seated, idle session is quiet");

        entry.turn_active = true;
        assert!(!entry.is_quiet());

        // The model stops speaking, but it backgrounded a test sweep first.
        entry
            .open_jobs
            .insert("t1".to_owned(), bash_job(std::time::Instant::now()));
        entry.turn_active = false;
        assert!(!entry.is_quiet(), "the turn ended; the work did not");

        entry.open_jobs.remove("t1");
        assert!(entry.is_quiet());
    }

    /// The bracket's close is an assertion, not a hope ([B01]). Whatever a
    /// replayed frame latched — a turn flag, an open job — is cleared when the
    /// outermost bracket closes, so a guard list that is not complete costs a
    /// session that reads quiet early rather than one wedged busy forever.
    #[test]
    fn a_bracket_close_clears_whatever_replay_latched() {
        let mut entry = LedgerEntry::new(
            TugSessionId::new("s1".to_owned()),
            WorkspaceKey::from_test_str("/proj"),
            std::path::PathBuf::from("/proj"),
            SessionMode::Resume,
            CrashBudget::new(3, Duration::from_secs(60)),
        );
        // An entry replay left alone owes nothing, and says so.
        assert!(!entry.clear_replay_residue(), "a quiet entry is untouched");

        // Some unguarded fold latched both facts `is_quiet` reads.
        entry.turn_active = true;
        entry.turn_opener = Some(TurnOpener::Wake);
        entry
            .open_jobs
            .insert("t1".to_owned(), bash_job(std::time::Instant::now()));

        assert!(entry.clear_replay_residue(), "residue is reported cleared");
        assert!(entry.is_quiet(), "the bracket closes on a quiet entry");
        assert_eq!(entry.turn_opener, None, "the opener goes with the turn");
    }

    /// The guarantee layer: whatever wire shape the fixtures have not
    /// captured, a job that goes silent past the horizon with its turn ended
    /// is dropped, so `holders_busy` degrades to *late*, never *forever*.
    #[test]
    fn a_stale_job_is_reaped_and_a_fresh_one_is_not() {
        let mut entry = LedgerEntry::new(
            TugSessionId::new("s1".to_owned()),
            WorkspaceKey::from_test_str("/proj"),
            std::path::PathBuf::from("/proj"),
            SessionMode::New,
            CrashBudget::new(3, Duration::from_secs(60)),
        );
        let now = std::time::Instant::now();
        entry.open_jobs.insert("t1".to_owned(), bash_job(now));
        entry.turn_active = false;

        // Within the horizon the job still holds the session busy.
        entry.reap_stuck_jobs(now + Duration::from_secs(60));
        assert!(!entry.is_quiet(), "a fresh job is work, not a wedge");

        // Past it, the job is gone and the session reads quiet.
        entry.reap_stuck_jobs(now + JOB_REAP_HORIZON + Duration::from_secs(1));
        assert!(entry.open_jobs.is_empty());
        assert!(entry.is_quiet(), "late, never forever");
    }

    /// **[B02].** The turn flag ages out the way a job does, and on the same
    /// terms: silent past the horizon with no claude child under its bridge.
    #[test]
    fn a_turn_with_no_child_is_reaped_past_the_horizon() {
        let mut entry = LedgerEntry::new(
            TugSessionId::new("s1".to_owned()),
            WorkspaceKey::from_test_str("/proj"),
            std::path::PathBuf::from("/proj"),
            SessionMode::Resume,
            CrashBudget::new(3, Duration::from_secs(60)),
        );
        let now = std::time::Instant::now();
        entry.turn_active = true;
        entry.turn_opener = Some(TurnOpener::Wake);
        entry.turn_last_frame_at = Some(now);

        // Inside the horizon the turn stands. A turn is a turn until it is
        // demonstrably not one.
        entry.reap_stuck_turn(now + Duration::from_secs(60));
        assert!(entry.turn_active, "a fresh turn is work, not a wedge");

        entry.reap_stuck_turn(now + JOB_REAP_HORIZON + Duration::from_secs(1));
        assert!(!entry.turn_active, "late, never forever");
        assert_eq!(entry.turn_opener, None, "the opener goes with the turn");
        assert!(entry.is_quiet());
    }

    /// And the condition that makes it safe: a turn whose bridge still has a
    /// claude child is a turn somebody is running, however quiet the wire.
    /// The incident's own audit turn ran for hours with a live child.
    #[test]
    fn a_long_turn_with_a_live_child_is_never_reaped() {
        let mut entry = LedgerEntry::new(
            TugSessionId::new("s1".to_owned()),
            WorkspaceKey::from_test_str("/proj"),
            std::path::PathBuf::from("/proj"),
            SessionMode::Resume,
            CrashBudget::new(3, Duration::from_secs(60)),
        );
        let now = std::time::Instant::now();
        entry.turn_active = true;
        entry.turn_last_frame_at = Some(now);
        entry.child_pid = Some(63836);
        entry.child_start_time = Some(1_700_000_000);

        entry.reap_stuck_turn(now + JOB_REAP_HORIZON * 20);
        assert!(
            entry.turn_active,
            "a turn with a claude child under its bridge is never reaped",
        );
    }

    /// A turn with no stamp — one inherited across a restart, or opened by a
    /// path nobody foresaw — is clocked from the first sweep that sees it
    /// rather than reaped on sight or left forever.
    #[test]
    fn an_unstamped_turn_is_clocked_before_it_is_reaped() {
        let mut entry = LedgerEntry::new(
            TugSessionId::new("s1".to_owned()),
            WorkspaceKey::from_test_str("/proj"),
            std::path::PathBuf::from("/proj"),
            SessionMode::Resume,
            CrashBudget::new(3, Duration::from_secs(60)),
        );
        let now = std::time::Instant::now();
        entry.turn_active = true;
        assert_eq!(entry.turn_last_frame_at, None);

        entry.reap_stuck_turn(now);
        assert!(
            entry.turn_active,
            "the first sweep clocks it, never reaps it"
        );
        assert_eq!(entry.turn_last_frame_at, Some(now));

        entry.reap_stuck_turn(now + JOB_REAP_HORIZON + Duration::from_secs(1));
        assert!(!entry.turn_active);
    }

    /// `touch_turn` is the clock's one writer on the hot path, and it asks
    /// nothing of its caller: between turns it does nothing at all.
    #[test]
    fn touching_a_turn_that_is_not_running_stamps_nothing() {
        let mut entry = LedgerEntry::new(
            TugSessionId::new("s1".to_owned()),
            WorkspaceKey::from_test_str("/proj"),
            std::path::PathBuf::from("/proj"),
            SessionMode::Resume,
            CrashBudget::new(3, Duration::from_secs(60)),
        );
        entry.touch_turn();
        assert_eq!(entry.turn_last_frame_at, None, "no turn, no clock");

        entry.turn_active = true;
        entry.touch_turn();
        assert!(entry.turn_last_frame_at.is_some());
    }

    /// A live turn keeps the reaper off entirely — a long turn's own silence
    /// is not a stuck job.
    #[test]
    fn the_reap_waits_for_the_turn_to_end() {
        let mut entry = LedgerEntry::new(
            TugSessionId::new("s1".to_owned()),
            WorkspaceKey::from_test_str("/proj"),
            std::path::PathBuf::from("/proj"),
            SessionMode::New,
            CrashBudget::new(3, Duration::from_secs(60)),
        );
        let now = std::time::Instant::now();
        entry.open_jobs.insert("t1".to_owned(), bash_job(now));
        entry.turn_active = true;
        entry.reap_stuck_jobs(now + JOB_REAP_HORIZON + Duration::from_secs(1));
        assert_eq!(entry.open_jobs.len(), 1, "mid-turn, nothing is reaped");
    }
}
